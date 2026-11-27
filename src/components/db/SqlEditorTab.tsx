// SQL query tab: Monaco "sql" editor with schema-aware completion, connection/database/schema
// pickers, run all / selection / current statement, cancel, explain, format, per-connection
// history, Ask AI, and a results area with one tab per result set.
import { useEffect, useMemo, useRef, useState } from "react";
import { monaco } from "../../lib/monaco";
import { errMsg } from "../../lib/api";
import { get, toast, useStore, type Tab } from "../../store";
import { dbApi } from "../../lib/db/api";
import { addHistory, bumpSchema, connById, connections, defaultSchema, ensureConnected, getOverview, loadHistory, renameDbTab, useDb, withConfirm } from "../../lib/db/store";
import { formatSql, setCompletionContext, statementAt } from "../../lib/db/sql";
import { askDbAi } from "../../lib/db/ai";
import { dialectOf, type QueryResponse, type ResultSet, type SchemaOverview } from "../../lib/db/types";
import ResultGrid from "./ResultGrid";
import { onTabClosed, useTabState } from "./DbTab";
import { showExport } from "./DbDialogs";
import Spin from "./Spin";

const models = new Map<string, monaco.editor.ITextModel>();
const LIMIT = 1000;

function modelFor(tabId: string, initial: string) {
  let m = models.get(tabId);
  if (!m || m.isDisposed()) {
    m = monaco.editor.createModel(initial, "sql");
    models.set(tabId, m);
    onTabClosed(tabId, () => {
      setCompletionContext(m!, null);
      m!.dispose();
      models.delete(tabId);
    });
  }
  return m;
}

export default function SqlEditorTab({ tab }: { tab: Tab }) {
  const ref = tab.db!;
  const [conn, setConn] = useTabState(tab.id, "conn", ref.conn);
  const [database, setDatabase] = useTabState<string>(tab.id, "database", ref.database ?? connById(ref.conn)?.database ?? "");
  const [schema, setSchema] = useTabState<string>(tab.id, "schema", ref.schema ?? "");
  const [resp, setResp] = useTabState<QueryResponse | null>(tab.id, "resp", null);
  const [active, setActive] = useTabState(tab.id, "activeResult", 0);
  const [split, setSplit] = useTabState(tab.id, "split", 0.5);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [ask, setAsk] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const overview = useRef<SchemaOverview | null>(null);
  const runRef = useRef<(mode: "all" | "statement") => void>(() => {});
  const fontSize = useStore((s) => s.settings.fontSize);
  const fontFamily = useStore((s) => s.settings.fontFamily);
  const version = useDb((s) => s.version);
  const c = connById(conn);
  const d = dialectOf(c?.kind);
  const all = connections();

  // Editor.
  useEffect(() => {
    const model = modelFor(tab.id, ref.sql ?? "");
    const ed = monaco.editor.create(host.current!, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: get().settings.fontSize,
      fontFamily: get().settings.fontFamily,
      scrollBeyondLastLine: false,
      padding: { top: 6 },
      wordWrap: "on",
      renderLineHighlight: "line",
      fixedOverflowWidgets: true,
    });
    editor.current = ed;
    ed.addAction({ id: "db.runAll", label: "Run SQL (selection or all)", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => runRef.current("all") });
    ed.addAction({ id: "db.runStatement", label: "Run current statement", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => runRef.current("statement") });
    ed.addAction({ id: "db.format", label: "Format SQL", keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF], run: () => format() });
    requestAnimationFrame(() => ed.focus());
    return () => {
      ed.dispose();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => editor.current?.updateOptions({ fontSize, fontFamily }), [fontSize, fontFamily]);

  // Connection → databases → schema; completion context.
  useEffect(() => {
    let alive = true;
    const model = models.get(tab.id);
    if (model) setCompletionContext(model, { dialect: d, schema, overview: () => overview.current });
    (async () => {
      if (!(await ensureConnected(conn))) return;
      if (d !== "sqlite") dbApi.listDatabases(conn).then((l) => alive && setDatabases(l)).catch(() => {});
      const ss = d === "mysql" ? [database || c?.database || ""].filter(Boolean) : await dbApi.listSchemas(conn, database).catch(() => [] as string[]);
      if (!alive) return;
      setSchemas(ss);
      let sc = schema;
      if (!sc || (ss.length && !ss.includes(sc))) {
        sc = await defaultSchema(conn, database);
        if (alive) setSchema(sc);
      }
      if (sc) overview.current = await getOverview(conn, database, sc, true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, database, schema, version]);

  const format = () => {
    const ed = editor.current;
    const m = ed?.getModel();
    if (!ed || !m) return;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) ed.executeEdits("format", [{ range: sel, text: formatSql(m.getValueInRange(sel)).trimEnd() }]);
    else ed.executeEdits("format", [{ range: m.getFullModelRange(), text: formatSql(m.getValue()) }]);
  };

  const sqlToRun = (mode: "all" | "statement") => {
    const ed = editor.current;
    const m = ed?.getModel();
    if (!ed || !m) return "";
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) return m.getValueInRange(sel);
    if (mode === "statement") return statementAt(m.getValue(), m.getOffsetAt(ed.getPosition()!)).text;
    return m.getValue();
  };

  const run = async (mode: "all" | "statement") => {
    const sql = sqlToRun(mode);
    if (!sql.trim() || running) return;
    if (!(await ensureConnected(conn))) return;
    const qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setRunning(qid);
    const t0 = performance.now();
    try {
      const r = await withConfirm((confirmed) => dbApi.query({ id: conn, database, sql, limit: LIMIT, queryId: qid, confirmed }), c?.name);
      if (!r) return;
      setResp(r);
      const firstErr = r.results.findIndex((x) => x.error);
      const firstGrid = r.results.findIndex((x) => x.columns.length || x.returnsRows);
      setActive(firstErr >= 0 ? firstErr : firstGrid >= 0 ? firstGrid : 0);
      addHistory(conn, { sql: sql.trim(), ts: Date.now(), ok: firstErr < 0 && !r.cancelled, ms: Math.round(performance.now() - t0) });
      if (r.cancelled) toast("Query cancelled");
      if (/\b(create|alter|drop|rename|truncate)\b/i.test(sql)) bumpSchema();
    } catch (e) {
      const msg = errMsg(e);
      setResp({ results: [{ index: 0, statement: sql, columns: [], rows: [], rowsAffected: null, hasMore: false, offset: 0, durationMs: 0, error: msg, returnsRows: false }], durationMs: 0, cancelled: false });
      setActive(0);
      addHistory(conn, { sql: sql.trim(), ts: Date.now(), ok: false, ms: 0 });
    } finally {
      setRunning(null);
    }
  };
  runRef.current = run;

  const cancel = async () => {
    if (!running) return;
    try {
      await dbApi.cancel(running);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const explain = async (analyze: boolean) => {
    const sql = sqlToRun("statement");
    if (!sql.trim()) return;
    if (!(await ensureConnected(conn))) return;
    setRunning("explain");
    try {
      const rs = await dbApi.explain(conn, database, sql, analyze);
      setResp({ results: [{ ...rs, statement: rs.statement || sql }], durationMs: rs.durationMs, cancelled: false });
      setActive(0);
    } catch (e) {
      setResp({ results: [{ index: 0, statement: sql, columns: [], rows: [], rowsAffected: null, hasMore: false, offset: 0, durationMs: 0, error: errMsg(e), returnsRows: false }], durationMs: 0, cancelled: false });
    } finally {
      setRunning(null);
    }
  };

  const fetchMore = async (i: number) => {
    const rs = resp?.results[i];
    if (!rs || !resp) return;
    setRunning("more");
    try {
      const r = await dbApi.query({ id: conn, database, sql: rs.statement, limit: LIMIT, offset: rs.offset + rs.rows.length });
      const more = r.results[0];
      if (more?.error) throw new Error(more.error);
      const merged: ResultSet = { ...rs, rows: [...rs.rows, ...(more?.rows ?? [])], hasMore: !!more?.hasMore };
      setResp({ ...resp, results: resp.results.map((x, j) => (j === i ? merged : x)) });
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setRunning(null);
    }
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const move = (ev: MouseEvent) => setSplit(Math.min(0.85, Math.max(0.12, (ev.clientY - box.top) / box.height)));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const pickConn = (id: string) => {
    const nc = connById(id);
    setConn(id);
    setDatabase(nc?.database ?? "");
    setSchema("");
    renameDbTab(tab.id, `Query · ${nc?.name ?? "SQL"}`);
  };

  const history = useMemo(() => (showHistory ? loadHistory(conn) : []), [showHistory, conn]);
  const results = resp?.results ?? [];
  const cur = results[Math.min(active, results.length - 1)];
  const lastError = results.find((r) => r.error)?.error ?? undefined;

  return (
    <div className="db-tab db-query-tab">
      <div className="db-toolbar">
        {c?.color && <span className="db-color-bar" style={{ background: c.color }} />}
        <select aria-label="Connection" value={conn} onChange={(e) => pickConn(e.target.value)} className="db-pick">
          {all.map((x) => <option key={x.id} value={x.id}>{x.production ? "● " : ""}{x.name}</option>)}
        </select>
        {d !== "sqlite" && (
          <select aria-label="Database" value={database} onChange={(e) => { setDatabase(e.target.value); setSchema(""); }} className="db-pick">
            {!databases.includes(database) && <option value={database}>{database || "(default)"}</option>}
            {databases.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        {d !== "mysql" && schemas.length > 1 && (
          <select aria-label="Schema" value={schema} onChange={(e) => setSchema(e.target.value)} className="db-pick">
            {schemas.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        )}
        {c?.production && <span className="db-prod" title="Production connection: writes need confirmation">PROD</span>}
        {c?.readOnly && <span className="db-ro" title="Read-only connection">READ-ONLY</span>}
        <span className="db-sep" />
        {running && running !== "explain" && running !== "more" ? (
          <button className="btn small danger" onClick={cancel} title="Cancel the running query"><i className="codicon codicon-debug-stop" /> Cancel</button>
        ) : (
          <button className="btn small primary" disabled={!!running} onClick={() => run("all")} title="Run selection or whole script (Ctrl+Enter)"><i className="codicon codicon-play" /> Run</button>
        )}
        <button className="btn small" disabled={!!running} onClick={() => run("statement")} title="Run the statement at the cursor (Ctrl+Shift+Enter)"><i className="codicon codicon-run-below" /> Statement</button>
        <button className="btn small" disabled={!!running} onClick={() => explain(false)} title="EXPLAIN the statement at the cursor"><i className="codicon codicon-graph" /> Explain</button>
        {d !== "sqlite" && d !== "mssql" && <button className="btn small" disabled={!!running} onClick={() => explain(true)} title="EXPLAIN ANALYZE (executes read-only statements)">Analyze</button>}
        <button className="btn small" onClick={format} title="Format SQL (Shift+Alt+F)"><i className="codicon codicon-list-flat" /> Format</button>
        <div className="db-history-wrap">
          <button className={`btn small ${showHistory ? "on" : ""}`} onClick={() => setShowHistory(!showHistory)} aria-expanded={showHistory}><i className="codicon codicon-history" /> History</button>
          {showHistory && (
            <div className="db-history" role="listbox" onMouseLeave={() => setShowHistory(false)}>
              {!history.length && <div className="muted small db-history-empty">No queries yet for this connection.</div>}
              {history.map((h, i) => (
                <button
                  key={i}
                  role="option"
                  className="db-history-item"
                  title={h.sql}
                  onClick={() => {
                    const ed = editor.current;
                    const m = ed?.getModel();
                    if (ed && m) ed.executeEdits("history", [{ range: m.getFullModelRange(), text: h.sql }]);
                    setShowHistory(false);
                    ed?.focus();
                  }}
                >
                  <i className={`codicon codicon-${h.ok ? "pass" : "error"}`} />
                  <span className="mono ellipsis grow">{h.sql.replace(/\s+/g, " ")}</span>
                  <span className="muted small">{new Date(h.ts).toLocaleString()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <form className="db-ask" onSubmit={(e) => { e.preventDefault(); askDbAi(ask, { conn, database, schema, sql: editor.current?.getModel()?.getValue(), error: lastError }); setAsk(""); }}>
          <i className="codicon codicon-sparkle" />
          <input aria-label="Ask AI about this query" placeholder="Ask AI: write a query for…, why is this slow?" value={ask} onChange={(e) => setAsk(e.target.value)} />
        </form>
      </div>
      <div className="db-split">
        <div className="db-editor" ref={host} style={{ flexBasis: `${split * 100}%` }} />
        <div className="db-splitter" onMouseDown={startDrag} role="separator" aria-orientation="horizontal" />
        <div className="db-results">
          {results.length > 0 && (
            <div className="db-result-tabs" role="tablist">
              {results.map((r, i) => (
                <button key={i} role="tab" aria-selected={i === active} className={`db-result-tab ${i === active ? "on" : ""} ${r.error ? "err" : ""}`} onClick={() => setActive(i)} title={r.statement}>
                  <i className={`codicon codicon-${r.error ? "error" : r.columns.length || r.returnsRows ? "table" : "check"}`} />
                  {r.error ? "Error" : r.columns.length || r.returnsRows ? `Result ${results.filter((x, j) => j <= i && (x.columns.length || x.returnsRows)).length}` : `Statement ${r.index + 1}`}
                </button>
              ))}
              <span className="grow" />
              {cur && cur.columns.length > 0 && (
                <button className="icon-btn small" title="Export this result (re-runs the statement without a row limit)" onClick={() => showExport({ conn, database, sql: cur.statement })}><i className="codicon codicon-export" /></button>
              )}
            </div>
          )}
          {!resp && <div className="db-results-empty muted small">Run a query with <kbd>Ctrl</kbd>+<kbd>Enter</kbd>. Results appear here.</div>}
          {cur && cur.error && (
            <div className="db-error-box">
              <pre className="tb-error">{cur.error}</pre>
              <pre className="db-sql-preview small">{cur.statement}</pre>
              <button className="btn small" onClick={() => askDbAi("Explain this database error and fix the SQL.", { conn, database, schema, sql: cur.statement, error: cur.error ?? undefined })}><i className="codicon codicon-sparkle" /> Ask AI to fix</button>
            </div>
          )}
          {cur && !cur.error && (cur.columns.length > 0 || cur.returnsRows) && (
            <ResultGrid columns={cur.columns.map((x) => ({ name: x.name, type: x.type }))} rows={cur.rows} dialect={d} onScrollEnd={cur.hasMore && !running ? () => fetchMore(Math.min(active, results.length - 1)) : undefined} emptyText="0 rows" />
          )}
          {cur && !cur.error && !cur.columns.length && !cur.returnsRows && (
            <div className="db-results-empty small">
              <i className="codicon codicon-check" /> {cur.rowsAffected != null ? `${cur.rowsAffected} row${cur.rowsAffected === 1 ? "" : "s"} affected` : "Statement executed"}
              <pre className="db-sql-preview small">{cur.statement}</pre>
            </div>
          )}
          {cur && (
            <div className="db-status">
              {cur.columns.length > 0 && <span>{cur.rows.length}{cur.hasMore ? "+" : ""} row{cur.rows.length === 1 ? "" : "s"}</span>}
              <span>{cur.durationMs} ms</span>
              {resp && results.length > 1 && <span>total {resp.durationMs} ms · {results.length} results</span>}
              {cur.hasMore && <button className="btn small" disabled={!!running} onClick={() => fetchMore(Math.min(active, results.length - 1))}>Fetch {LIMIT} more</button>}
              {running && <span className="muted"><Spin /> running…</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
