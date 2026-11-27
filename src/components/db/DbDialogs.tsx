// Database dialogs: imperative confirm / password / SQL-preview prompts (rendered into their own
// root so tabs and the sidebar can both use them), plus Export, Import CSV and Dump/Restore.
import { ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { errMsg } from "../../lib/api";
import { toast } from "../../store";
import { dbApi } from "../../lib/db/api";
import { bumpSchema, connById, withConfirm } from "../../lib/db/store";
import type { DbConnection, TableInfo } from "../../lib/db/types";

/** Renders a modal into a detached root and resolves with its result. */
function mount<T>(render: (done: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: T) => {
      resolve(v);
      setTimeout(() => {
        root.unmount();
        host.remove();
      }, 0);
    };
    root.render(<>{render(done)}</>);
  });
}

export function Modal({ title, children, onClose, wide, footer }: { title: ReactNode; children: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input:not([type=checkbox]), textarea, select, button.primary");
    (first ?? el)?.focus();
  }, []);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal db-modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}><i className="codicon codicon-close" /></button>
        </div>
        <div className="modal-body db-modal-body">{children}</div>
        {footer && <div className="db-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOpts {
  title: string;
  message: ReactNode;
  sql?: string;
  danger?: boolean;
  /** Text the user must type to enable the button (typed confirmation). */
  typed?: string;
  confirmLabel?: string;
}

function ConfirmBox({ o, done }: { o: ConfirmOpts; done: (v: boolean) => void }) {
  const [text, setText] = useState("");
  const ok = !o.typed || text.trim() === o.typed;
  return (
    <Modal
      title={<><i className={`codicon codicon-${o.danger ? "warning" : "question"}`} /> {o.title}</>}
      onClose={() => done(false)}
      wide={!!o.sql}
      footer={
        <>
          <button className="btn small" onClick={() => done(false)}>Cancel</button>
          <button className={`btn small ${o.danger ? "danger" : "primary"}`} disabled={!ok} onClick={() => done(true)}>{o.confirmLabel ?? "Confirm"}</button>
        </>
      }
    >
      <div className="db-confirm-msg">{typeof o.message === "string" ? <pre className="db-pre-wrap">{o.message}</pre> : o.message}</div>
      {o.sql && <pre className="db-sql-preview">{o.sql}</pre>}
      {o.typed && (
        <label className="db-field">
          <span>Type <b className="mono">{o.typed}</b> to confirm</span>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && ok) done(true); }} spellCheck={false} />
        </label>
      )}
    </Modal>
  );
}

export const askConfirm = (o: ConfirmOpts) => mount<boolean>((done) => <ConfirmBox o={o} done={done} />);

function PasswordBox({ c, error, done }: { c: DbConnection; error: string; done: (v: { password: string; save: boolean } | null) => void }) {
  const [pw, setPw] = useState("");
  const [save, setSave] = useState(true);
  return (
    <Modal
      title={<>Password for {c.name}</>}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn small" onClick={() => done(null)}>Cancel</button>
          <button className="btn small primary" onClick={() => done({ password: pw, save })}>Connect</button>
        </>
      }
    >
      <p className="muted small">{c.user ? `${c.user}@` : ""}{c.host}{c.port ? `:${c.port}` : ""}</p>
      {error && <pre className="tb-error">{error}</pre>}
      <label className="db-field">
        <span>Password</span>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") done({ password: pw, save }); }} />
      </label>
      <label className="check small"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save in the system keychain</label>
    </Modal>
  );
}

export const askPassword = (c: DbConnection, error: string) => mount<{ password: string; save: boolean } | null>((done) => <PasswordBox c={c} error={error} done={done} />);

function TextBox({ title, label, initial, done }: { title: string; label: string; initial: string; done: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <Modal title={title} onClose={() => done(null)} footer={<><button className="btn small" onClick={() => done(null)}>Cancel</button><button className="btn small primary" onClick={() => done(v)}>OK</button></>}>
      <label className="db-field"><span>{label}</span><input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") done(v); }} /></label>
    </Modal>
  );
}
export const askText = (title: string, label: string, initial = "") => mount<string | null>((done) => <TextBox title={title} label={label} initial={initial} done={done} />);

// ------------------------------------------------------------------ export

export interface ExportTarget { conn: string; database?: string; schema?: string; table?: string; sql?: string }

function ExportBox({ t, done }: { t: ExportTarget; done: (v: null) => void }) {
  const [format, setFormat] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    const base = (t.table || "query").replace(/[^\w.-]+/g, "_");
    const path = await saveDialog({ defaultPath: `${base}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      const n = await dbApi.exportData({ id: t.conn, database: t.database, schema: t.schema, table: t.table, sql: t.sql, format, path });
      toast(`Exported ${n} row${n === 1 ? "" : "s"} to ${path}`);
      done(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={<>Export {t.table ?? "query result"}</>} onClose={() => done(null)} footer={<><button className="btn small" onClick={() => done(null)}>Cancel</button><button className="btn small primary" disabled={busy} onClick={run}>{busy ? "Exporting…" : "Choose file and export"}</button></>}>
      <div className="db-seg" role="radiogroup" aria-label="Format">
        {[["csv", "CSV"], ["tsv", "TSV"], ["json", "JSON"], ["sql", "SQL INSERTs"]].map(([v, l]) => (
          <button key={v} role="radio" aria-checked={format === v} className={`btn small ${format === v ? "on" : ""}`} onClick={() => setFormat(v)}>{l}</button>
        ))}
      </div>
      {t.sql && <pre className="db-sql-preview small">{t.sql}</pre>}
      <p className="muted small">All rows are streamed to the file (no row limit).</p>
      {error && <pre className="tb-error">{error}</pre>}
    </Modal>
  );
}
export const showExport = (t: ExportTarget) => mount<null>((done) => <ExportBox t={t} done={done} />);

// ------------------------------------------------------------------ import CSV

function ImportBox({ t, info, done }: { t: ExportTarget & { schema: string; table: string }; info: TableInfo; done: (v: null) => void }) {
  const [path, setPath] = useState("");
  const [delim, setDelim] = useState(",");
  const [header, setHeader] = useState(true);
  const [emptyNull, setEmptyNull] = useState(false);
  const [preview, setPreview] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (p: string, d: string) => {
    try {
      const rows = await dbApi.csvPreview(p, d);
      setPreview(rows);
      const head = rows[0] ?? [];
      const m: Record<number, string> = {};
      head.forEach((h, i) => {
        const hit = info.columns.find((c) => c.name.toLowerCase() === h.trim().toLowerCase()) ?? (!header ? info.columns[i] : undefined);
        if (hit) m[i] = hit.name;
      });
      setMap(m);
      setError("");
    } catch (e) {
      setError(errMsg(e));
    }
  };
  const pick = async () => {
    const p = await openDialog({ multiple: false, filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
    if (typeof p === "string") {
      setPath(p);
      if (p.toLowerCase().endsWith(".tsv")) setDelim("\\t");
      load(p, p.toLowerCase().endsWith(".tsv") ? "\\t" : delim);
    }
  };
  const run = async () => {
    const mapping = Object.entries(map).filter(([, c]) => c).map(([s, c]) => ({ source: Number(s), column: c }));
    if (!mapping.length) return setError("Map at least one column.");
    setBusy(true);
    setError("");
    try {
      const n = await withConfirm((confirmed) => dbApi.importCsv({ id: t.conn, database: t.database, schema: t.schema, table: t.table, path, mapping, header, delimiter: delim, emptyAsNull: emptyNull, confirmed }), connById(t.conn)?.name);
      if (n !== null) {
        toast(`Imported ${n} row${n === 1 ? "" : "s"} into ${t.table}`);
        bumpSchema();
        done(null);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const width = Math.max(0, ...preview.map((r) => r.length));
  return (
    <Modal wide title={<>Import CSV into {t.table}</>} onClose={() => done(null)} footer={<><button className="btn small" onClick={() => done(null)}>Cancel</button><button className="btn small primary" disabled={busy || !path} onClick={run}>{busy ? "Importing…" : "Import in one transaction"}</button></>}>
      <div className="db-row-fields">
        <button className="btn small" onClick={pick}><i className="codicon codicon-folder-opened" /> Choose file…</button>
        <span className="ellipsis grow mono small" title={path}>{path || "No file chosen"}</span>
        <label className="db-inline">Delimiter
          <select value={delim} onChange={(e) => { setDelim(e.target.value); if (path) load(path, e.target.value); }}>
            <option value=",">,</option><option value=";">;</option><option value="\t">Tab</option><option value="|">|</option>
          </select>
        </label>
        <label className="check small"><input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> First row is a header</label>
        <label className="check small"><input type="checkbox" checked={emptyNull} onChange={(e) => setEmptyNull(e.target.checked)} /> Empty = NULL</label>
      </div>
      {preview.length > 0 && (
        <div className="db-import-grid">
          <table>
            <thead>
              <tr>
                {Array.from({ length: width }, (_, i) => (
                  <th key={i}>
                    <select aria-label={`Target column for CSV column ${i + 1}`} value={map[i] ?? ""} onChange={(e) => setMap({ ...map, [i]: e.target.value })}>
                      <option value="">(skip)</option>
                      {info.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.slice(0, 12).map((r, ri) => (
                <tr key={ri} className={ri === 0 && header ? "hdr" : ""}>
                  {Array.from({ length: width }, (_, i) => <td key={i}>{r[i] ?? ""}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <pre className="tb-error">{error}</pre>}
    </Modal>
  );
}

export async function showImport(t: ExportTarget & { schema: string; table: string }) {
  try {
    const info = await dbApi.describeTable(t.conn, t.database, t.schema, t.table);
    await mount<null>((done) => <ImportBox t={t} info={info} done={done} />);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ------------------------------------------------------------------ dump / restore

function DumpBox({ t, mode, done }: { t: ExportTarget; mode: "dump" | "restore"; done: (v: null) => void }) {
  const c = connById(t.conn);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"" | "ok" | "fail">("");
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
  const tool = c?.kind === "postgres" ? (mode === "dump" ? "pg_dump" : "psql") : c?.kind === "sqlite" ? (mode === "dump" ? "VACUUM INTO (built in)" : "SQL script (built in)") : c?.kind === "mssql" ? "not available" : mode === "dump" ? "mysqldump" : "mysql";
  const run = async () => {
    const path = mode === "dump"
      ? await saveDialog({ defaultPath: `${t.database || c?.database || c?.name || "dump"}.${c?.kind === "sqlite" ? "db" : "sql"}` })
      : await openDialog({ multiple: false });
    if (typeof path !== "string" || !path) return;
    if (mode === "restore" && !(await askConfirm({ title: "Restore dump", message: `Run ${path} against ${c?.name}${t.database ? ` / ${t.database}` : ""}? Existing objects may be replaced.`, danger: true, typed: c?.name, confirmLabel: "Restore" }))) return;
    const jobId = `job${Date.now().toString(36)}`;
    setLines([]);
    setState("");
    setBusy(true);
    const un = await listen<any>("db-progress", ({ payload }) => {
      if (payload.jobId !== jobId) return;
      setLines((l) => [...l.slice(-400), payload.line]);
    });
    try {
      if (mode === "dump") await dbApi.dump({ id: t.conn, database: t.database, path, jobId });
      else await dbApi.restore({ id: t.conn, database: t.database, path, jobId, confirmed: true });
      setState("ok");
      if (mode === "restore") bumpSchema();
    } catch (e) {
      setLines((l) => [...l, errMsg(e)]);
      setState("fail");
    } finally {
      un();
      setBusy(false);
    }
  };
  return (
    <Modal wide title={<>{mode === "dump" ? "Dump" : "Restore"} · {c?.name}{t.database ? ` / ${t.database}` : ""}</>} onClose={() => !busy && done(null)} footer={<><button className="btn small" disabled={busy} onClick={() => done(null)}>Close</button><button className="btn small primary" disabled={busy || c?.kind === "mssql"} onClick={run}>{busy ? "Running…" : mode === "dump" ? "Choose file and dump" : "Choose dump and restore"}</button></>}>
      <p className="muted small">Uses <code>{tool}</code>{c?.kind === "postgres" || c?.kind === "mysql" || c?.kind === "mariadb" ? " from your PATH; the password is passed through the environment, never on the command line." : "."}</p>
      {(lines.length > 0 || state) && <pre ref={box} className={`dk-progress db-progress ${state === "fail" ? "fail" : ""}`}>{lines.join("\n")}{state === "ok" ? "\n✓ Done" : ""}</pre>}
    </Modal>
  );
}
export const showDump = (t: ExportTarget, mode: "dump" | "restore") => mount<null>((done) => <DumpBox t={t} mode={mode} done={done} />);
