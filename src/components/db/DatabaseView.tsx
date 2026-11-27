// Database activity-bar view: connections (color dot, production badge), lazy tree
// connection → databases → schemas → tables / views / functions, context menus (open data,
// design, new query, copy name, drop / truncate with typed confirmation, export, import CSV,
// dump / restore), and an "Ask AI" box that starts an agent task with the selection as context.
import { useEffect, useState } from "react";
import { errMsg } from "../../lib/api";
import { toast, useStore } from "../../store";
import { dbApi } from "../../lib/db/api";
import { bumpSchema, connById, deleteConnection, disconnect, ensureConnected, initDb, openDbTab, saveConnection, useDb } from "../../lib/db/store";
import { qualified } from "../../lib/db/sql";
import { askDbAi } from "../../lib/db/ai";
import { dialectOf, KIND_LABEL, type DbConnection, type DbObject } from "../../lib/db/types";
import ContextMenu, { MenuItem } from "../ContextMenu";
import ConnectionDialog, { blankConnection } from "./ConnectionDialog";
import { askConfirm, showDump, showExport, showImport } from "./DbDialogs";
import Spin from "./Spin";

initDb();

type Children = { kind: "list"; items: string[] } | { kind: "objects"; items: DbObject[] };
const GROUPS: { kind: string; label: string; icon: string }[] = [
  { kind: "table", label: "Tables", icon: "table" },
  { kind: "view", label: "Views", icon: "eye" },
  { kind: "materialized_view", label: "Materialized views", icon: "eye" },
  { kind: "foreign_table", label: "Foreign tables", icon: "link-external" },
  { kind: "function", label: "Functions", icon: "symbol-method" },
  { kind: "procedure", label: "Procedures", icon: "symbol-event" },
  { kind: "sequence", label: "Sequences", icon: "symbol-numeric" },
];

function fmtRows(n: number | null): string {
  if (n == null || n < 0) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e4) return Math.round(n / 1e3) + "K";
  return String(n);
}

export default function DatabaseView() {
  const conns = useStore((s) => ((s.settings as any).dbConnections ?? []) as DbConnection[]);
  const connected = useDb((s) => s.connected);
  const connecting = useDb((s) => s.connecting);
  const version = useDb((s) => s.version);
  const selection = useDb((s) => s.selection);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, Children | { kind: "error"; message: string } | "loading">>({});
  const [edit, setEdit] = useState<DbConnection | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [ask, setAsk] = useState("");
  const [filter, setFilter] = useState("");

  // Schema changed somewhere (DDL, agent db_execute): reload every open node.
  useEffect(() => {
    setKids({});
    for (const k of open) load(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const load = async (key: string) => {
    const [kind, rest] = [key[0], key.slice(2)];
    const [id, db, schema] = rest.split("|");
    setKids((k) => ({ ...k, [key]: "loading" }));
    try {
      let ch: Children;
      if (kind === "c") {
        if (!(await ensureConnected(id))) {
          setOpen((o) => { const n = new Set(o); n.delete(key); return n; });
          setKids((k) => { const n = { ...k }; delete n[key]; return n; });
          return;
        }
        const d = dialectOf(connById(id)?.kind);
        ch = { kind: "list", items: d === "sqlite" ? await dbApi.listSchemas(id, null) : await dbApi.listDatabases(id) };
      } else if (kind === "d") {
        const d = dialectOf(connById(id)?.kind);
        ch = d === "mysql" ? { kind: "objects", items: await dbApi.listObjects(id, db, db) } : { kind: "list", items: await dbApi.listSchemas(id, db) };
      } else {
        ch = { kind: "objects", items: await dbApi.listObjects(id, db || null, schema) };
      }
      setKids((k) => ({ ...k, [key]: ch }));
    } catch (e) {
      setKids((k) => ({ ...k, [key]: { kind: "error", message: errMsg(e) } }));
    }
  };

  const toggle = (key: string) => {
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else {
        n.add(key);
        if (!kids[key] || (kids[key] as any).kind === "error") load(key);
      }
      return n;
    });
  };

  const refresh = (key?: string) => {
    if (key) load(key);
    else bumpSchema();
  };

  const select = (conn: string, database?: string, schema?: string, table?: string) => useDb.setState({ selection: { conn, database, schema, table } });

  // ---------------------------------------------------------------- actions

  const dropOrTruncate = async (c: DbConnection, db: string | undefined, schema: string, o: DbObject, mode: "drop" | "truncate") => {
    const d = dialectOf(c.kind);
    const q = qualified(d, schema, o.name);
    const what = o.kind === "view" ? "VIEW" : o.kind === "materialized_view" ? "MATERIALIZED VIEW" : o.kind === "sequence" ? "SEQUENCE" : o.kind === "function" ? "FUNCTION" : o.kind === "procedure" ? "PROCEDURE" : "TABLE";
    const fnName = o.kind === "function" || o.kind === "procedure" ? (d === "postgres" ? `${schema ? `"${schema.replace(/"/g, '""')}".` : ""}${o.name}` : q) : q;
    const sql = mode === "drop" ? `DROP ${what} ${fnName};` : d === "sqlite" ? `DELETE FROM ${q};` : `TRUNCATE TABLE ${q};`;
    const ok = await askConfirm({
      title: mode === "drop" ? `Drop ${o.kind.replace("_", " ")} ${o.name}` : `Truncate ${o.name}`,
      message: mode === "drop" ? `This permanently removes ${o.name}${o.kind === "table" ? " and all its rows" : ""}.` : `This deletes every row of ${o.name}.`,
      sql,
      danger: true,
      typed: o.name,
      confirmLabel: mode === "drop" ? "Drop" : "Truncate",
    });
    if (!ok) return;
    try {
      const r = await dbApi.query({ id: c.id, database: db, sql, confirmed: true });
      const err = r.results.find((x) => x.error);
      if (err) throw new Error(err.error!);
      toast(mode === "drop" ? `Dropped ${o.name}` : `Truncated ${o.name}`);
      bumpSchema();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const connMenu = (e: React.MouseEvent, c: DbConnection) => {
    e.preventDefault();
    e.stopPropagation();
    const live = c.id in connected;
    const db = c.database || undefined;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        live ? { label: "Disconnect", icon: "debug-disconnect", onClick: () => { disconnect(c.id); setOpen((o) => new Set([...o].filter((k) => !k.includes(c.id)))); } } : { label: "Connect", icon: "plug", onClick: () => toggle(`c:${c.id}`) },
        { label: "New query", icon: "new-file", onClick: () => openDbTab("dbquery", { conn: c.id, database: db }) },
        { label: "ER diagram", icon: "type-hierarchy", onClick: () => openDbTab("dber", { conn: c.id, database: db }) },
        { label: "Refresh", icon: "refresh", onClick: () => refresh() },
        { label: "", separator: true, onClick: () => {} },
        { label: "Edit connection…", icon: "edit", onClick: () => setEdit(c) },
        { label: "Duplicate", icon: "copy", onClick: () => saveConnection({ ...c, id: blankConnection().id, name: `${c.name} copy` }) },
        { label: "Dump…", icon: "cloud-download", onClick: () => showDump({ conn: c.id, database: db }, "dump") },
        { label: "Restore…", icon: "cloud-upload", onClick: () => showDump({ conn: c.id, database: db }, "restore") },
        { label: "", separator: true, onClick: () => {} },
        { label: "Delete connection", icon: "trash", danger: true, onClick: async () => { if (await askConfirm({ title: "Delete connection", message: `Remove "${c.name}" and its saved password? The database itself is not touched.`, danger: true, confirmLabel: "Delete" })) deleteConnection(c.id); } },
      ],
    });
  };

  const dbMenu = (e: React.MouseEvent, c: DbConnection, db: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New query", icon: "new-file", onClick: () => openDbTab("dbquery", { conn: c.id, database: db }) },
        { label: "ER diagram", icon: "type-hierarchy", onClick: () => openDbTab("dber", { conn: c.id, database: db, schema: dialectOf(c.kind) === "mysql" ? db : undefined }) },
        ...(dialectOf(c.kind) === "mysql" ? [{ label: "New table…", icon: "add", onClick: () => openDbTab("dbdesign", { conn: c.id, database: db, schema: db, isNew: true }) }] : []),
        { label: "Refresh", icon: "refresh", onClick: () => refresh(`d:${c.id}|${db}`) },
        { label: "Copy name", icon: "copy", onClick: () => navigator.clipboard.writeText(db) },
        { label: "Dump…", icon: "cloud-download", onClick: () => showDump({ conn: c.id, database: db }, "dump") },
        { label: "Restore…", icon: "cloud-upload", onClick: () => showDump({ conn: c.id, database: db }, "restore") },
      ],
    });
  };

  const schemaMenu = (e: React.MouseEvent, c: DbConnection, db: string | undefined, schema: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New query", icon: "new-file", onClick: () => openDbTab("dbquery", { conn: c.id, database: db, schema }) },
        { label: "New table…", icon: "add", onClick: () => openDbTab("dbdesign", { conn: c.id, database: db, schema, isNew: true }) },
        { label: "ER diagram", icon: "type-hierarchy", onClick: () => openDbTab("dber", { conn: c.id, database: db, schema }) },
        { label: "Refresh", icon: "refresh", onClick: () => refresh(`s:${c.id}|${db ?? ""}|${schema}`) },
        { label: "Copy name", icon: "copy", onClick: () => navigator.clipboard.writeText(schema) },
      ],
    });
  };

  const objMenu = (e: React.MouseEvent, c: DbConnection, db: string | undefined, schema: string, o: DbObject) => {
    e.preventDefault();
    e.stopPropagation();
    const d = dialectOf(c.kind);
    const q = qualified(d, schema, o.name);
    const isRel = ["table", "view", "materialized_view", "foreign_table"].includes(o.kind);
    const items: MenuItem[] = [];
    if (isRel) {
      items.push({ label: "Open data", icon: "table", onClick: () => openDbTab("dbtable", { conn: c.id, database: db, schema, table: o.name }) });
      if (o.kind === "table") items.push({ label: "Design table", icon: "symbol-structure", onClick: () => openDbTab("dbdesign", { conn: c.id, database: db, schema, table: o.name }) });
      items.push({ label: "New query (SELECT)", icon: "new-file", onClick: () => openDbTab("dbquery", { conn: c.id, database: db, schema, sql: d === "mssql" ? `SELECT TOP 100 * FROM ${q};` : `SELECT * FROM ${q} LIMIT 100;` }) });
    } else {
      items.push({ label: "New query", icon: "new-file", onClick: () => openDbTab("dbquery", { conn: c.id, database: db, schema, sql: o.kind === "sequence" ? (d === "postgres" ? `SELECT last_value FROM ${q};` : `SELECT * FROM sys.sequences WHERE name = '${o.name.replace(/'/g, "''")}';`) : `-- ${o.kind} ${o.name}\n` }) });
    }
    items.push({ label: "Copy name", icon: "copy", onClick: () => navigator.clipboard.writeText(o.name) });
    items.push({ label: "Copy qualified name", icon: "copy", onClick: () => navigator.clipboard.writeText(q) });
    if (isRel) {
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Export…", icon: "export", onClick: () => showExport({ conn: c.id, database: db, schema, table: o.name }) });
      if (o.kind === "table") items.push({ label: "Import CSV…", icon: "cloud-upload", onClick: () => showImport({ conn: c.id, database: db, schema, table: o.name }) });
      items.push({ label: "Ask AI about this table", icon: "sparkle", onClick: () => askDbAi(`Explain the table ${o.name}: what it stores, its relationships, and any indexing or design issues.`, { conn: c.id, database: db, schema, table: o.name }) });
    }
    items.push({ label: "", separator: true, onClick: () => {} });
    if (o.kind === "table") items.push({ label: "Truncate…", icon: "clear-all", danger: true, onClick: () => dropOrTruncate(c, db, schema, o, "truncate") });
    items.push({ label: `Drop ${o.kind.replace("_", " ")}…`, icon: "trash", danger: true, onClick: () => dropOrTruncate(c, db, schema, o, "drop") });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---------------------------------------------------------------- render

  const pad = (depth: number) => ({ paddingLeft: 8 + depth * 12 });
  const chevron = (key: string) => <i className={`codicon codicon-chevron-${open.has(key) ? "down" : "right"}`} />;
  const status = (key: string, depth: number) => {
    const k = kids[key];
    if (k === "loading") return <div className="tree-row db-tree-msg" style={pad(depth)}><Spin /> Loading…</div>;
    if (k && (k as any).kind === "error") return <div className="tree-row db-tree-msg err" style={pad(depth)} title={(k as any).message}><i className="codicon codicon-error" /> <span className="name">{(k as any).message}</span></div>;
    return null;
  };
  const f = filter.trim().toLowerCase();

  const renderObjects = (c: DbConnection, db: string | undefined, schema: string, items: DbObject[], depth: number, keyBase: string) => {
    return GROUPS.map((g) => {
      const list = items.filter((o) => (g.kind === "function" ? o.kind === "function" : o.kind === g.kind) && (!f || o.name.toLowerCase().includes(f)));
      if (!list.length && !(g.kind === "table" && !f)) return null;
      const gk = `g:${keyBase}|${g.kind}`;
      const isOpen = open.has(gk) || (!!f && list.length > 0) || (g.kind === "table" && !open.has(gk + "!closed") && !open.has(gk));
      const flip = () => setOpen((o) => {
        const n = new Set(o);
        if (g.kind === "table") {
          if (n.has(gk + "!closed")) n.delete(gk + "!closed");
          else n.add(gk + "!closed");
        } else if (n.has(gk)) n.delete(gk);
        else n.add(gk);
        return n;
      });
      return (
        <div key={g.kind}>
          <div
            className="tree-row db-group"
            style={pad(depth)}
            onClick={flip}
            onContextMenu={g.kind === "table" ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: [{ label: "New table…", icon: "add", onClick: () => openDbTab("dbdesign", { conn: c.id, database: db, schema, isNew: true }) }, { label: "ER diagram", icon: "type-hierarchy", onClick: () => openDbTab("dber", { conn: c.id, database: db, schema }) }] }); } : undefined}
          >
            <i className={`codicon codicon-chevron-${isOpen ? "down" : "right"}`} />
            <i className={`codicon codicon-${g.icon}`} />
            <span className="name">{g.label}</span>
            <span className="muted small">{list.length}</span>
            {g.kind === "table" && (
              <span className="row-actions">
                <button title="New table" onClick={(e) => { e.stopPropagation(); openDbTab("dbdesign", { conn: c.id, database: db, schema, isNew: true }); }}><i className="codicon codicon-add" /></button>
              </span>
            )}
          </div>
          {isOpen && list.map((o) => {
            const isRel = ["table", "view", "materialized_view", "foreign_table"].includes(o.kind);
            const active = selection.conn === c.id && selection.table === o.name && selection.schema === schema;
            return (
              <div
                key={o.kind + o.name}
                className={`tree-row db-obj ${active ? "active" : ""}`}
                style={pad(depth + 1)}
                title={`${o.name}${o.comment ? `\n${o.comment}` : ""}${o.rows != null ? `\n≈ ${o.rows.toLocaleString()} rows` : ""}`}
                onClick={() => select(c.id, db, schema, o.name)}
                onDoubleClick={() => isRel && openDbTab("dbtable", { conn: c.id, database: db, schema, table: o.name })}
                onKeyDown={(e) => { if (e.key === "Enter" && isRel) openDbTab("dbtable", { conn: c.id, database: db, schema, table: o.name }); }}
                tabIndex={0}
                onContextMenu={(e) => { select(c.id, db, schema, o.name); objMenu(e, c, db, schema, o); }}
              >
                <i className={`codicon codicon-${GROUPS.find((x) => x.kind === o.kind)?.icon ?? "symbol-misc"}`} />
                <span className="name">{o.name}</span>
                <span className="muted small db-rows">{fmtRows(o.rows)}</span>
                {isRel && (
                  <span className="row-actions">
                    <button title="Open data" onClick={(e) => { e.stopPropagation(); openDbTab("dbtable", { conn: c.id, database: db, schema, table: o.name }); }}><i className="codicon codicon-table" /></button>
                    {o.kind === "table" && <button title="Design" onClick={(e) => { e.stopPropagation(); openDbTab("dbdesign", { conn: c.id, database: db, schema, table: o.name }); }}><i className="codicon codicon-symbol-structure" /></button>}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      );
    });
  };

  const renderSchema = (c: DbConnection, db: string | undefined, schema: string, depth: number) => {
    const key = `s:${c.id}|${db ?? ""}|${schema}`;
    const k = kids[key];
    return (
      <div key={key}>
        <div className="tree-row" style={pad(depth)} onClick={() => { toggle(key); select(c.id, db, schema); }} onContextMenu={(e) => { select(c.id, db, schema); schemaMenu(e, c, db, schema); }}>
          {chevron(key)}
          <i className="codicon codicon-symbol-namespace" />
          <span className="name">{schema}</span>
        </div>
        {open.has(key) && (status(key, depth + 1) ?? (k && (k as Children).kind === "objects" ? renderObjects(c, db, schema, (k as any).items, depth + 1, key.slice(2)) : null))}
      </div>
    );
  };

  const renderDb = (c: DbConnection, db: string, depth: number) => {
    const d = dialectOf(c.kind);
    const key = `d:${c.id}|${db}`;
    const k = kids[key] as any;
    return (
      <div key={key}>
        <div className={`tree-row ${db === c.database ? "db-default" : ""}`} style={pad(depth)} onClick={() => { toggle(key); select(c.id, db, d === "mysql" ? db : undefined); }} onContextMenu={(e) => { select(c.id, db); dbMenu(e, c, db); }}>
          {chevron(key)}
          <i className="codicon codicon-database" />
          <span className="name">{db}</span>
        </div>
        {open.has(key) && (status(key, depth + 1) ?? (k?.kind === "objects" ? renderObjects(c, db, db, k.items, depth + 1, key.slice(2)) : k?.kind === "list" ? (k.items as string[]).map((s) => renderSchema(c, db, s, depth + 1)) : null))}
      </div>
    );
  };

  return (
    <div className="panel db-view">
      <div className="panel-header">
        <span>DATABASE</span>
        <div className="actions">
          <button title="New connection" onClick={() => setEdit(blankConnection())}><i className="codicon codicon-add" /></button>
          <button title="New query" disabled={!conns.length} onClick={() => { const id = selection.conn ?? conns[0]?.id; if (id) openDbTab("dbquery", { conn: id, database: selection.database, schema: selection.schema }); }}><i className="codicon codicon-new-file" /></button>
          <button title="Refresh" onClick={() => refresh()}><i className="codicon codicon-refresh" /></button>
          <button title="Collapse all" onClick={() => setOpen(new Set())}><i className="codicon codicon-collapse-all" /></button>
        </div>
      </div>
      {conns.length > 0 && (
        <div className="db-view-tools">
          <input aria-label="Filter objects" placeholder="Filter tables…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="db-tree" role="tree">
        {!conns.length && (
          <div className="empty-state">
            <p>Connect to PostgreSQL, MySQL / MariaDB, SQLite or SQL Server to browse tables, run SQL, edit data and design schemas with the agent.</p>
            <button className="btn primary small" onClick={() => setEdit(blankConnection())}><i className="codicon codicon-add" /> New connection</button>
            <button className="btn small" onClick={() => setEdit(blankConnection("sqlite"))}>Open a SQLite file…</button>
          </div>
        )}
        {conns.map((c) => {
          const key = `c:${c.id}`;
          const live = c.id in connected;
          const k = kids[key] as any;
          const d = dialectOf(c.kind);
          return (
            <div key={c.id} className="db-conn">
              <div
                className={`tree-row db-conn-row ${selection.conn === c.id && !selection.table ? "active" : ""}`}
                style={pad(0)}
                onClick={() => { toggle(key); select(c.id, c.database || undefined); }}
                onContextMenu={(e) => connMenu(e, c)}
                title={`${KIND_LABEL[c.kind]} · ${c.kind === "sqlite" ? c.file : `${c.user ? c.user + "@" : ""}${c.host}:${c.port}`}${connected[c.id] ? `\n${connected[c.id]}` : ""}`}
              >
                {chevron(key)}
                <span className={`db-dot ${live ? "live" : ""}`} style={{ background: c.color || undefined }} aria-label={live ? "connected" : "disconnected"} />
                <span className="name">{c.name}</span>
                {c.production && <span className="db-prod" title="Production">PROD</span>}
                {c.readOnly && <span className="db-ro" title="Read-only">RO</span>}
                <span className="muted small">{connecting[c.id] ? <Spin /> : KIND_LABEL[c.kind]}</span>
                <span className="row-actions">
                  <button title="New query" onClick={(e) => { e.stopPropagation(); openDbTab("dbquery", { conn: c.id, database: c.database || undefined }); }}><i className="codicon codicon-new-file" /></button>
                  <button title="Edit connection" onClick={(e) => { e.stopPropagation(); setEdit(c); }}><i className="codicon codicon-edit" /></button>
                </span>
              </div>
              {open.has(key) && (status(key, 1) ?? (k?.kind === "list" ? (k.items as string[]).map((x) => (d === "sqlite" ? renderSchema(c, undefined, x, 1) : renderDb(c, x, 1))) : null))}
            </div>
          );
        })}
      </div>
      <form className="db-ask db-ask-side" onSubmit={(e) => { e.preventDefault(); askDbAi(ask, { conn: selection.conn ?? conns[0]?.id, database: selection.database, schema: selection.schema, table: selection.table }); setAsk(""); }}>
        <i className="codicon codicon-sparkle" />
        <textarea
          aria-label="Ask AI about the selected database"
          rows={2}
          placeholder={conns.length ? `Ask AI about ${connById(selection.conn)?.name ?? conns[0].name}: "create tables for a blog with users, posts, comments and tags"` : "Add a connection, then ask AI to design or query it"}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
        />
      </form>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {edit && <ConnectionDialog initial={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
