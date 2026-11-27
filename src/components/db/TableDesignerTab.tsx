// Table designer: columns (name, type with dialect presets, length, NULL, default, PK, auto
// increment, comment), indexes and foreign keys with referenced table/column pickers and
// ON UPDATE / ON DELETE. Generates CREATE TABLE or an ALTER diff, previewed before applying.
import { useEffect, useMemo, useState } from "react";
import { errMsg } from "../../lib/api";
import { set as setApp, toast, type Tab } from "../../store";
import { dbApi } from "../../lib/db/api";
import { bumpSchema, connById, ensureConnected, getOverview, openDbTab, useDb, withConfirm } from "../../lib/db/store";
import { alterTableDdl, createTableDdl, designFromTable, FK_ACTIONS, TYPE_PRESETS, type Design, type DesignColumn, type DesignFk, type DesignIndex } from "../../lib/db/sql";
import { askDbAi } from "../../lib/db/ai";
import { dialectOf, type SchemaOverview } from "../../lib/db/types";
import { useTabState } from "./DbTab";
import Spin from "./Spin";

const newCol = (d: string): DesignColumn => ({ orig: "", name: "", type: d === "postgres" ? "text" : d === "mysql" ? "VARCHAR" : d === "mssql" ? "NVARCHAR" : "TEXT", length: d === "mysql" || d === "mssql" ? "255" : "", nullable: true, default: "", pk: false, autoIncrement: false, comment: "" });

function starter(d: string, schema: string): Design {
  const idType = d === "postgres" ? "bigint" : d === "mysql" ? "BIGINT UNSIGNED" : d === "mssql" ? "BIGINT" : "INTEGER";
  return {
    schema,
    name: "",
    columns: [
      { orig: "", name: "id", type: idType, length: "", nullable: false, default: "", pk: true, autoIncrement: true, comment: "" },
      { orig: "", name: "created_at", type: d === "postgres" ? "timestamptz" : d === "mysql" ? "DATETIME" : d === "mssql" ? "DATETIME2" : "TEXT", length: "", nullable: false, default: d === "postgres" ? "now()" : d === "mssql" ? "SYSUTCDATETIME()" : "CURRENT_TIMESTAMP", pk: false, autoIncrement: false, comment: "" },
    ],
    indexes: [],
    fks: [],
  };
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export default function TableDesignerTab({ tab }: { tab: Tab }) {
  const ref = tab.db!;
  const c = connById(ref.conn);
  const d = dialectOf(c?.kind);
  const schema = ref.schema ?? (d === "sqlite" ? "main" : "");
  const isNew = !ref.table;
  const [orig, setOrig] = useTabState<Design | null>(tab.id, "orig", null);
  const [g, setG] = useTabState<Design | null>(tab.id, "design", isNew ? starter(d, schema) : null);
  const [ov, setOv] = useState<SchemaOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState("");
  const version = useDb((s) => s.version);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await ensureConnected(ref.conn))) return;
      getOverview(ref.conn, ref.database, schema).then((o) => alive && setOv(o));
      if (isNew || g) return;
      try {
        const t = await dbApi.describeTable(ref.conn, ref.database, schema, ref.table!);
        if (!alive) return;
        const des = designFromTable(t);
        setOrig(des);
        setG(structuredClone(des));
      } catch (e) {
        setError(errMsg(e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.conn, ref.table, version]);

  const ddl = useMemo(() => {
    if (!g) return { sql: "", warnings: [] as string[] };
    const problems: string[] = [];
    if (!g.name.trim()) problems.push("Name the table.");
    const names = g.columns.map((x) => x.name.trim());
    if (names.some((n) => !n)) problems.push("Every column needs a name.");
    if (new Set(names).size !== names.length) problems.push("Column names must be unique.");
    if (!g.columns.some((x) => x.pk)) problems.push("No primary key: rows of this table cannot be edited in the data grid.");
    for (const f of g.fks) if (f.columns.length && f.refTable && f.columns.length !== f.refColumns.length) problems.push(`Foreign key ${f.name || f.columns.join(",")}: column counts differ.`);
    for (const f of g.fks) {
      if (f.columns.length && !g.indexes.some((i) => i.columns[0] === f.columns[0]) && !g.columns.find((x) => x.name === f.columns[0])?.pk) problems.push(`Tip: index the foreign-key column ${f.columns.join(", ")}.`);
    }
    if (isNew || !orig) return { sql: g.name.trim() ? createTableDdl(d, g) : "", warnings: problems };
    const a = alterTableDdl(d, orig, g);
    return { sql: a.sql, warnings: [...problems, ...a.warnings] };
  }, [g, orig, d, isNew]);

  if (!g) {
    return <div className="db-tab"><div className="db-results-empty muted small">{error ? <pre className="tb-error">{error}</pre> : <><Spin /> Loading table…</>}</div></div>;
  }

  const upCol = (i: number, p: Partial<DesignColumn>) => setG({ ...g, columns: g.columns.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const moveCol = (i: number, dir: -1 | 1) => {
    const cols = [...g.columns];
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    [cols[i], cols[j]] = [cols[j], cols[i]];
    setG({ ...g, columns: cols });
  };
  const upIdx = (i: number, p: Partial<DesignIndex>) => setG({ ...g, indexes: g.indexes.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const upFk = (i: number, p: Partial<DesignFk>) => setG({ ...g, fks: g.fks.map((x, j) => (j === i ? { ...x, ...p } : x)) });
  const refTable = (name: string) => ov?.tables.find((t) => t.name === name);
  const colNames = g.columns.map((x) => x.name).filter(Boolean);

  const apply = async () => {
    if (!ddl.sql.trim()) return;
    if (!g.name.trim()) return setError("Name the table.");
    setBusy(true);
    setError("");
    try {
      const r = await withConfirm((confirmed) => dbApi.query({ id: ref.conn, database: ref.database, sql: ddl.sql, confirmed }), c?.name);
      if (!r) return;
      const err = r.results.find((x) => x.error);
      if (err) throw new Error(`${err.error}\n\n${err.statement}`);
      toast(isNew ? `Created ${g.name}` : `Altered ${g.name}`);
      bumpSchema();
      const newRef = { ...ref, table: g.name, isNew: false };
      setOrig(null);
      setG(null);
      setApp((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, title: `Design · ${g.name}`, db: newRef } : t)) }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const typeList = `db-types-${d}`;
  return (
    <div className="db-tab db-design-tab">
      <div className="db-toolbar">
        {c?.color && <span className="db-color-bar" style={{ background: c.color }} />}
        <i className="codicon codicon-symbol-structure" />
        <input className="db-design-name" aria-label="Table name" placeholder="table_name" value={g.name} onChange={(e) => setG({ ...g, name: e.target.value })} spellCheck={false} />
        <span className="muted small">{c?.name}{ref.database ? ` / ${ref.database}` : ""}{schema && d !== "sqlite" ? ` / ${schema}` : ""}</span>
        <span className="grow" />
        {!isNew && <button className="btn small" onClick={() => openDbTab("dbtable", { ...ref, isNew: false })}><i className="codicon codicon-table" /> Data</button>}
        <button className="btn small" onClick={() => { if (orig) setG(structuredClone(orig)); else setG(starter(d, schema)); }}>Reset</button>
        <button className="btn small primary" disabled={busy || !ddl.sql.trim()} onClick={apply}>{busy ? <Spin /> : <i className="codicon codicon-check" />} {isNew ? "Create table" : "Apply changes"}</button>
      </div>
      <datalist id={typeList}>{TYPE_PRESETS[d].map((t) => <option key={t.name} value={t.name} />)}</datalist>
      <datalist id={`db-cols-${tab.id}`}>{colNames.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="db-design-body">
        <section>
          <h3>Columns</h3>
          <table className="db-design-grid">
            <thead><tr><th /><th>Name</th><th>Type</th><th>Length</th><th title="Allow NULL">NULL</th><th>Default</th><th title="Primary key">PK</th><th title="Auto increment / identity">Auto</th><th>Comment</th><th /></tr></thead>
            <tbody>
              {g.columns.map((col, i) => (
                <tr key={i}>
                  <td className="db-design-move">
                    <button className="icon-btn small" title="Move up" onClick={() => moveCol(i, -1)}><i className="codicon codicon-arrow-up" /></button>
                    <button className="icon-btn small" title="Move down" onClick={() => moveCol(i, 1)}><i className="codicon codicon-arrow-down" /></button>
                  </td>
                  <td><input aria-label="Column name" value={col.name} onChange={(e) => upCol(i, { name: e.target.value })} spellCheck={false} /></td>
                  <td><input aria-label="Type" list={typeList} value={col.type} onChange={(e) => upCol(i, { type: e.target.value })} spellCheck={false} /></td>
                  <td><input aria-label="Length" className="narrow" value={col.length} onChange={(e) => upCol(i, { length: e.target.value })} /></td>
                  <td><input type="checkbox" aria-label="Nullable" checked={col.nullable} disabled={col.pk} onChange={(e) => upCol(i, { nullable: e.target.checked })} /></td>
                  <td><input aria-label="Default" value={col.default} placeholder="expression" onChange={(e) => upCol(i, { default: e.target.value })} spellCheck={false} /></td>
                  <td><input type="checkbox" aria-label="Primary key" checked={col.pk} onChange={(e) => upCol(i, { pk: e.target.checked, nullable: e.target.checked ? false : col.nullable })} /></td>
                  <td><input type="checkbox" aria-label="Auto increment" checked={col.autoIncrement} onChange={(e) => upCol(i, { autoIncrement: e.target.checked })} /></td>
                  <td><input aria-label="Comment" value={col.comment} onChange={(e) => upCol(i, { comment: e.target.value })} disabled={d === "sqlite" || d === "mssql"} title={d === "sqlite" || d === "mssql" ? "Column comments are not supported here" : ""} /></td>
                  <td><button className="icon-btn small" title="Remove column" onClick={() => setG({ ...g, columns: g.columns.filter((_, j) => j !== i) })}><i className="codicon codicon-trash" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn small" onClick={() => setG({ ...g, columns: [...g.columns, newCol(d)] })}><i className="codicon codicon-add" /> Column</button>
        </section>
        <section>
          <h3>Indexes</h3>
          {g.indexes.map((ix, i) => (
            <div className="db-design-row" key={i}>
              <input aria-label="Index name" placeholder={`ix_${g.name || "table"}_…`} value={ix.name} onChange={(e) => upIdx(i, { name: e.target.value })} spellCheck={false} />
              <input aria-label="Index columns" list={`db-cols-${tab.id}`} className="grow" placeholder="col1, col2" value={ix.columns.join(", ")} onChange={(e) => upIdx(i, { columns: list(e.target.value) })} spellCheck={false} />
              <label className="check small"><input type="checkbox" checked={ix.unique} onChange={(e) => upIdx(i, { unique: e.target.checked })} /> Unique</label>
              <button className="icon-btn small" title="Remove index" onClick={() => setG({ ...g, indexes: g.indexes.filter((_, j) => j !== i) })}><i className="codicon codicon-trash" /></button>
            </div>
          ))}
          <button className="btn small" onClick={() => setG({ ...g, indexes: [...g.indexes, { orig: "", name: "", columns: [], unique: false }] })}><i className="codicon codicon-add" /> Index</button>
        </section>
        <section>
          <h3>Foreign keys</h3>
          {g.fks.map((f, i) => {
            const rt = refTable(f.refTable);
            return (
              <div className="db-design-row" key={i}>
                <input aria-label="Constraint name" placeholder={`fk_${g.name || "table"}_…`} value={f.name} onChange={(e) => upFk(i, { name: e.target.value })} spellCheck={false} />
                <input aria-label="Columns" list={`db-cols-${tab.id}`} placeholder="user_id" value={f.columns.join(", ")} onChange={(e) => upFk(i, { columns: list(e.target.value) })} spellCheck={false} />
                <span className="muted">→</span>
                <select aria-label="Referenced table" value={f.refTable} onChange={(e) => { const t = refTable(e.target.value); upFk(i, { refTable: e.target.value, refColumns: t ? t.columns.filter((x) => x.pk).map((x) => x.name) : [] }); }}>
                  <option value="">table…</option>
                  {ov?.tables.filter((t) => t.kind === "table").map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                  {f.refTable && !rt && <option value={f.refTable}>{f.refTable}</option>}
                </select>
                <select aria-label="Referenced column" value={f.refColumns.join(", ")} onChange={(e) => upFk(i, { refColumns: list(e.target.value) })}>
                  {!rt && <option value={f.refColumns.join(", ")}>{f.refColumns.join(", ") || "column…"}</option>}
                  {rt && rt.columns.filter((x) => x.pk).length > 1 && <option value={rt.columns.filter((x) => x.pk).map((x) => x.name).join(", ")}>{rt.columns.filter((x) => x.pk).map((x) => x.name).join(", ")} (PK)</option>}
                  {rt?.columns.map((x) => <option key={x.name} value={x.name}>{x.name}{x.pk ? " (PK)" : ""}</option>)}
                </select>
                <label className="db-inline small">ON UPDATE <select value={f.onUpdate} onChange={(e) => upFk(i, { onUpdate: e.target.value })}>{FK_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></label>
                <label className="db-inline small">ON DELETE <select value={f.onDelete} onChange={(e) => upFk(i, { onDelete: e.target.value })}>{FK_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></label>
                <button className="icon-btn small" title="Remove foreign key" onClick={() => setG({ ...g, fks: g.fks.filter((_, j) => j !== i) })}><i className="codicon codicon-trash" /></button>
              </div>
            );
          })}
          <button className="btn small" onClick={() => setG({ ...g, fks: [...g.fks, { orig: "", name: "", columns: [], refTable: "", refColumns: [], onUpdate: "NO ACTION", onDelete: "NO ACTION" }] })}><i className="codicon codicon-add" /> Foreign key</button>
        </section>
        <section>
          <h3>{isNew ? "CREATE TABLE" : "ALTER statements"} preview</h3>
          {ddl.warnings.map((w, i) => <div key={i} className="db-notice small"><i className="codicon codicon-warning" /> {w}</div>)}
          <pre className="db-sql-preview">{ddl.sql || (isNew ? "-- name the table" : "-- no changes")}</pre>
          {error && <pre className="tb-error">{error}</pre>}
          <form className="db-ask" onSubmit={(e) => { e.preventDefault(); askDbAi(`${ask}\n\nI'm designing the table "${g.name || "(unnamed)"}". Current draft DDL:\n${ddl.sql || "(none)"}`, { conn: ref.conn, database: ref.database, schema }); setAsk(""); }}>
            <i className="codicon codicon-sparkle" />
            <input aria-label="Ask AI about this table design" placeholder="Ask AI: add soft delete, suggest indexes, design tables for…" value={ask} onChange={(e) => setAsk(e.target.value)} />
          </form>
        </section>
      </div>
    </div>
  );
}
