// Table data tab: paged rows (server-side sort + filters with bound parameters), inline editing
// with dirty highlighting, add / delete rows, "Save changes" that shows the generated SQL first
// and applies it in one transaction, Discard, NULL handling, export / import.
import { useEffect, useMemo, useState } from "react";
import { errMsg } from "../../lib/api";
import { toast, type Tab } from "../../store";
import { dbApi } from "../../lib/db/api";
import { connById, ensureConnected, openDbTab, useDb, withConfirm } from "../../lib/db/store";
import { qualified } from "../../lib/db/sql";
import { dialectOf, type Filter, type TablePage } from "../../lib/db/types";
import ResultGrid from "./ResultGrid";
import { useTabState } from "./DbTab";
import { askConfirm, showExport, showImport } from "./DbDialogs";
import Spin from "./Spin";

const PAGE = 200;

/** Filter-row text → backend filter: "abc" contains · "= 5" · "> 3" · "IS NULL" · "IN a,b" · "LIKE a%". */
export function parseFilter(column: string, text: string): Filter | null {
  const t = text.trim();
  if (!t) return null;
  if (/^is\s+null$/i.test(t)) return { column, op: "is null", value: null };
  if (/^is\s+not\s+null$/i.test(t)) return { column, op: "is not null", value: null };
  let m = t.match(/^(not\s+in|in)\s+(.+)$/i);
  if (m) return { column, op: m[1].toLowerCase().replace(/\s+/, " "), value: m[2].replace(/^\(|\)$/g, "") };
  m = t.match(/^(not\s+like|like)\s+(.+)$/i);
  if (m) return { column, op: m[1].toLowerCase().replace(/\s+/, " "), value: m[2] };
  m = t.match(/^(<=|>=|<>|!=|=|<|>)\s*(.*)$/);
  if (m) return { column, op: m[1], value: m[2].replace(/^'(.*)'$/, "$1") };
  return { column, op: "contains", value: t };
}

interface Pending {
  /** row index (in page.rows) → changed values */
  updates: Record<number, Record<string, unknown>>;
  inserts: Record<string, unknown>[];
  deletes: number[];
}
const EMPTY: Pending = { updates: {}, inserts: [], deletes: [] };

export default function TableDataTab({ tab }: { tab: Tab }) {
  const ref = tab.db!;
  const c = connById(ref.conn);
  const d = dialectOf(c?.kind);
  const schema = ref.schema ?? "";
  const table = ref.table ?? "";
  const [offset, setOffset] = useTabState(tab.id, "offset", 0);
  const [sort, setSort] = useTabState<{ col: number; desc: boolean } | null>(tab.id, "sort", null);
  const [filterText, setFilterText] = useTabState<Record<number, string>>(tab.id, "filters", {});
  const [showFilters, setShowFilters] = useTabState(tab.id, "showFilters", false);
  const [page, setPage] = useTabState<TablePage | null>(tab.id, "page", null);
  const [pending, setPending] = useTabState<Pending>(tab.id, "pending", EMPTY);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSql, setShowSql] = useState(false);
  const version = useDb((s) => s.version);

  const filters = useMemo(() => {
    if (!page) return [];
    return Object.entries(filterText).map(([i, t]) => parseFilter(page.columns[Number(i)]?.name ?? "", t)).filter((f): f is Filter => !!f && !!f.column);
  }, [filterText, page?.columns]);

  const load = async (keepPending = false) => {
    if (!(await ensureConnected(ref.conn))) return;
    setBusy(true);
    setError("");
    try {
      const cols = page?.columns;
      const p = await dbApi.tableRows({
        id: ref.conn,
        database: ref.database,
        schema,
        table,
        offset,
        limit: PAGE,
        sort: sort && cols?.[sort.col] ? [{ column: cols[sort.col].name, desc: sort.desc }] : [],
        filters,
        count: true,
      });
      setPage(p);
      if (!keepPending) setPending(EMPTY);
      setSelected(new Set());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, sort?.col, sort?.desc, JSON.stringify(filters), version]);

  const pkCols = page?.primaryKey ?? [];
  const editable = !!page && pkCols.length > 0 && page.kind === "table";
  const columns = page?.columns ?? [];
  const baseRows = page?.rows ?? [];
  const nBase = baseRows.length;

  const rows = useMemo(() => {
    const out = baseRows.map((r, i) => {
      const u = pending.updates[i];
      return u ? columns.map((col, j) => (col.name in u ? u[col.name] : r[j])) : r;
    });
    for (const ins of pending.inserts) out.push(columns.map((col) => (col.name in ins ? ins[col.name] : null)));
    return out;
  }, [baseRows, pending, columns]);

  const dirty = useMemo(() => {
    const s = new Set<string>();
    for (const [r, u] of Object.entries(pending.updates)) for (const k of Object.keys(u)) s.add(`${r}:${columns.findIndex((x) => x.name === k)}`);
    pending.inserts.forEach((ins, i) => Object.keys(ins).forEach((k) => s.add(`${nBase + i}:${columns.findIndex((x) => x.name === k)}`)));
    return s;
  }, [pending, columns, nBase]);

  const changeCount = Object.keys(pending.updates).length + pending.inserts.length + pending.deletes.length;

  const onEdit = (r: number, col: number, value: unknown) => {
    const name = columns[col].name;
    setPending((p) => {
      if (r >= nBase) {
        const inserts = p.inserts.map((x, i) => (i === r - nBase ? { ...x, [name]: value } : x));
        return { ...p, inserts };
      }
      const orig = baseRows[r][col];
      const u = { ...(p.updates[r] ?? {}) };
      if (value === orig || (value !== null && orig !== null && String(value) === String(orig))) delete u[name];
      else u[name] = value;
      const updates = { ...p.updates };
      if (Object.keys(u).length) updates[r] = u;
      else delete updates[r];
      return { ...p, updates };
    });
  };

  const addRow = () => {
    setPending((p) => ({ ...p, inserts: [...p.inserts, {}] }));
  };

  const deleteSelected = () => {
    if (!selected.size) return toast("Select rows first (click the row numbers).");
    setPending((p) => {
      const inserts = p.inserts.filter((_, i) => !selected.has(nBase + i));
      const deletes = [...new Set([...p.deletes, ...[...selected].filter((r) => r < nBase)])];
      return { ...p, inserts, deletes };
    });
    setSelected(new Set());
  };

  const buildEdits = () => {
    const key = (r: number) => Object.fromEntries(pkCols.map((k) => [k, baseRows[r][columns.findIndex((x) => x.name === k)]]));
    return [
      ...Object.entries(pending.updates).filter(([r]) => !pending.deletes.includes(Number(r))).map(([r, values]) => ({ op: "update" as const, values, key: key(Number(r)) })),
      ...pending.inserts.map((values) => ({ op: "insert" as const, values, key: {} })),
      ...pending.deletes.map((r) => ({ op: "delete" as const, values: {}, key: key(r) })),
    ];
  };

  const save = async () => {
    const edits = buildEdits();
    if (!edits.length) return;
    try {
      const dry = await dbApi.applyEdits({ id: ref.conn, database: ref.database, schema, table, edits, dryRun: true });
      const ok = await askConfirm({ title: `Save ${edits.length} change${edits.length === 1 ? "" : "s"} to ${table}`, message: "These statements run in one transaction:", sql: dry.statements.join(";\n") + ";", confirmLabel: "Run in transaction", danger: pending.deletes.length > 0 });
      if (!ok) return;
      setBusy(true);
      const res = await withConfirm((confirmed) => dbApi.applyEdits({ id: ref.conn, database: ref.database, schema, table, edits, dryRun: false, confirmed }), c?.name);
      if (res) {
        toast(`Saved: ${res.affected.reduce((a, b) => a + b, 0)} row(s) affected`);
        await load();
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const total = page?.total ?? null;
  const rowState = (r: number) => (r >= nBase ? "new" : pending.deletes.includes(r) ? "deleted" : undefined);

  return (
    <div className="db-tab db-table-tab">
      <div className="db-toolbar">
        {c?.color && <span className="db-color-bar" style={{ background: c.color }} />}
        <span className="db-title" title={`${c?.name} · ${ref.database ?? ""} ${schema}.${table}`}><i className="codicon codicon-table" /> {schema && d !== "sqlite" ? `${schema}.` : ""}{table}</span>
        {c?.production && <span className="db-prod">PROD</span>}
        {page && page.kind !== "table" && <span className="db-ro">{page.kind.replace("_", " ")}</span>}
        <button className="icon-btn small" title="Refresh" onClick={() => load(true)}>{busy ? <Spin /> : <i className="codicon codicon-refresh" />}</button>
        <button className={`icon-btn small ${showFilters ? "on" : ""}`} title="Filter row" aria-pressed={showFilters} onClick={() => setShowFilters(!showFilters)}><i className="codicon codicon-filter" /></button>
        <span className="db-sep" />
        <button className="btn small" disabled={!editable} onClick={addRow} title={editable ? "Add a row" : "Editing needs a primary key"}><i className="codicon codicon-add" /> Row</button>
        <button className="btn small" disabled={!editable || !selected.size} onClick={deleteSelected}><i className="codicon codicon-trash" /> Delete</button>
        <button className="btn small primary" disabled={!changeCount || busy} onClick={save}><i className="codicon codicon-save" /> Save{changeCount ? ` (${changeCount})` : ""}</button>
        <button className="btn small" disabled={!changeCount} onClick={() => setPending(EMPTY)}>Discard</button>
        <span className="db-sep" />
        <button className="btn small" title="Show the SELECT used for this page" onClick={() => setShowSql(!showSql)}>SQL</button>
        <button className="icon-btn small" title="Open in a query tab" onClick={() => openDbTab("dbquery", { conn: ref.conn, database: ref.database, schema, sql: `SELECT * FROM ${qualified(d, schema, table)}${d === "mssql" ? "" : " LIMIT 100"};` })}><i className="codicon codicon-database" /></button>
        <button className="icon-btn small" title="Design table" onClick={() => openDbTab("dbdesign", { conn: ref.conn, database: ref.database, schema, table })}><i className="codicon codicon-symbol-structure" /></button>
        <button className="icon-btn small" title="Export…" onClick={() => showExport({ conn: ref.conn, database: ref.database, schema, table })}><i className="codicon codicon-export" /></button>
        <button className="icon-btn small" title="Import CSV…" disabled={page?.kind !== "table"} onClick={() => showImport({ conn: ref.conn, database: ref.database, schema, table })}><i className="codicon codicon-cloud-upload" /></button>
        <span className="grow" />
        <div className="db-pager">
          <button className="icon-btn small" disabled={offset === 0 || busy} title="Previous page" onClick={() => setOffset(Math.max(0, offset - PAGE))}><i className="codicon codicon-chevron-left" /></button>
          <span className="small">{nBase ? `${offset + 1}–${offset + nBase}` : "0"}{total != null ? ` of ${total.toLocaleString()}` : ""}</span>
          <button className="icon-btn small" disabled={busy || nBase < PAGE || (total != null && offset + nBase >= total)} title="Next page" onClick={() => setOffset(offset + PAGE)}><i className="codicon codicon-chevron-right" /></button>
        </div>
      </div>
      {!editable && page && page.kind === "table" && <div className="db-notice small"><i className="codicon codicon-info" /> {table} has no primary key: rows cannot be identified safely, so editing is disabled.</div>}
      {showSql && page && <pre className="db-sql-preview small">{page.sql}</pre>}
      {error && <pre className="tb-error db-tab-error">{error}</pre>}
      <ResultGrid
        columns={columns.map((x) => ({ name: x.name, type: x.dataType, pk: x.pk, nullable: x.nullable, auto: x.autoIncrement }))}
        rows={rows}
        dialect={d}
        tableName={qualified(d, schema, table)}
        editable={editable}
        dirty={dirty}
        rowState={rowState}
        onEdit={onEdit}
        sort={sort}
        onSort={(col) => setSort(sort?.col === col ? (sort.desc ? null : { col, desc: true }) : { col, desc: false })}
        filters={showFilters ? filterText : undefined}
        onFilter={showFilters ? (col, v) => { setFilterText({ ...filterText, [col]: v }); setOffset(0); } : undefined}
        selected={selected}
        onSelect={setSelected}
        rowOffset={offset}
        emptyText={busy ? "Loading…" : "No rows"}
      />
    </div>
  );
}
