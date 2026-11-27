// Database client state: connections (settings.dbConnections, synced to the backend), live
// connection status, schema caches, query history, editor tabs, guard confirmations and the
// agent hook that refreshes trees/diagrams after `db_execute`.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { get as getApp, set as setApp, toast, useStore, type Tab } from "../../store";
import { errMsg } from "../api";
import { dbApi, confirmRequired } from "./api";
import { dialectOf, type DbConnection, type DbTabRef, type SchemaOverview } from "./types";

interface DbUi {
  connected: Record<string, string>; // id -> server version
  connecting: Record<string, boolean>;
  /** Bumped when a schema may have changed (DDL, agent db_execute, refresh). */
  version: number;
  overviews: Record<string, SchemaOverview>;
  /** Tree selection, used as Ask-AI context. */
  selection: { conn?: string; database?: string; schema?: string; table?: string };
}

export const useDb = create<DbUi>(() => ({ connected: {}, connecting: {}, version: 0, overviews: {}, selection: {} }));

export const connections = (): DbConnection[] => ((getApp().settings as any).dbConnections ?? []) as DbConnection[];
export const connById = (id: string | undefined) => connections().find((c) => c.id === id);
export const dialectFor = (id: string | undefined) => dialectOf(connById(id)?.kind);

export function bumpSchema() {
  useDb.setState((s) => ({ version: s.version + 1, overviews: {} }));
}

// ------------------------------------------------------------------ settings sync

let lastSynced = "";
function sync() {
  const list = connections().map(({ savePassword: _sp, ...c }) => c);
  const key = JSON.stringify(list);
  if (key === lastSynced) return;
  lastSynced = key;
  dbApi.setConnections(list as DbConnection[]).catch(() => {});
}

let initialized = false;
/** Called once when the database module loads (Sidebar imports the view at startup). */
export function initDb() {
  if (initialized) return;
  initialized = true;
  sync();
  useStore.subscribe((s, p) => {
    if ((s.settings as any).dbConnections !== (p.settings as any).dbConnections) sync();
  });
  dbApi.status().then((ids) => useDb.setState({ connected: Object.fromEntries(ids.map((i) => [i, ""])) })).catch(() => {});
  // Refresh trees / ER diagrams after the agent changes a database.
  listen<any>("agent-event", ({ payload: ev }) => {
    if (ev?.type === "toolResult" && ev.name === "db_execute") {
      bumpSchema();
      if (!ev.isError) toast("Database changed by the agent — refreshed");
    }
  }).catch(() => {});
}

export async function saveConnections(list: DbConnection[]) {
  const { saveSettings } = await import("../workspace");
  await saveSettings({ ...getApp().settings, dbConnections: list } as any);
}

export async function saveConnection(c: DbConnection, password?: string | null) {
  const list = connections();
  const next = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
  if (password != null) {
    try {
      await dbApi.savePassword(c.id, c.savePassword ? password : "");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }
  await saveConnections(next);
  sync();
}

export async function deleteConnection(id: string) {
  await dbApi.disconnect(id).catch(() => {});
  await dbApi.deletePassword(id).catch(() => {});
  useDb.setState((s) => {
    const connected = { ...s.connected };
    delete connected[id];
    return { connected };
  });
  await saveConnections(connections().filter((c) => c.id !== id));
}

// ------------------------------------------------------------------ connect

export async function ensureConnected(id: string, force = false): Promise<boolean> {
  if (!force && id in useDb.getState().connected) return true;
  const c = connById(id);
  if (!c) return false;
  sync();
  useDb.setState((s) => ({ connecting: { ...s.connecting, [id]: true } }));
  try {
    let password: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const info = await dbApi.connect(id, password);
        useDb.setState((s) => ({ connected: { ...s.connected, [id]: info.serverVersion } }));
        return true;
      } catch (e) {
        const msg = errMsg(e);
        if (msg.startsWith("NOT_CONNECTED:") && c.ssh) {
          const host = getApp().settings.sshHosts.find((h) => h.id === c.ssh);
          if (!host) throw new Error(`SSH host for the tunnel was not found. Edit the connection.`);
          const { connectHost } = await import("../../components/RemotePanel");
          try {
            await connectHost(host);
          } catch (se) {
            throw new Error(`Connect "${host.label || host.host}" in the Remote panel first (${errMsg(se)}).`);
          }
          continue;
        }
        if (msg.startsWith("PASSWORD_REQUIRED") || (password === null && /password|authentication/i.test(msg) && c.kind !== "sqlite")) {
          const r = await promptPassword(c, attempt > 0 ? msg.replace(/^PASSWORD_REQUIRED:\s*/, "") : "");
          if (!r) return false;
          password = r.password;
          if (r.save) await dbApi.savePassword(id, r.password).catch((err) => toast(errMsg(err), "error"));
          continue;
        }
        throw e;
      }
    }
    return false;
  } catch (e) {
    toast(`${c.name}: ${errMsg(e)}`, "error");
    return false;
  } finally {
    useDb.setState((s) => ({ connecting: { ...s.connecting, [id]: false } }));
  }
}

export async function disconnect(id: string) {
  await dbApi.disconnect(id).catch(() => {});
  useDb.setState((s) => {
    const connected = { ...s.connected };
    delete connected[id];
    return { connected };
  });
}

export async function getOverview(conn: string, database: string | undefined, schema: string, force = false): Promise<SchemaOverview | null> {
  const key = `${conn}|${database ?? ""}|${schema}`;
  const cached = useDb.getState().overviews[key];
  if (cached && !force) return cached;
  try {
    const o = await dbApi.overview(conn, database, schema);
    useDb.setState((s) => ({ overviews: { ...s.overviews, [key]: o } }));
    return o;
  } catch {
    return null;
  }
}

/** Default schema for a connection/database. */
export async function defaultSchema(conn: string, database?: string): Promise<string> {
  const d = dialectFor(conn);
  if (d === "sqlite") return "main";
  if (d === "mysql") return database || connById(conn)?.database || "";
  try {
    const s = await dbApi.listSchemas(conn, database);
    return s.includes(d === "mssql" ? "dbo" : "public") ? (d === "mssql" ? "dbo" : "public") : s[0] ?? "";
  } catch {
    return d === "mssql" ? "dbo" : "public";
  }
}

// ------------------------------------------------------------------ guard confirmations

/** Runs `fn(false)`; when the backend guard asks for confirmation, shows it and retries with `true`. */
export async function withConfirm<T>(fn: (confirmed: boolean) => Promise<T>, connName?: string): Promise<T | null> {
  try {
    return await fn(false);
  } catch (e) {
    const c = confirmRequired(e);
    if (!c) throw e;
    const { askConfirm } = await import("../../components/db/DbDialogs");
    const ok = await askConfirm({
      title: c.reason === "destructive" ? "Destructive statement" : c.reason === "production" ? "Production connection" : "Read-only connection",
      message: c.message,
      danger: true,
      typed: c.reason === "production" || c.reason === "destructive" ? connName || "CONFIRM" : undefined,
      confirmLabel: "Run anyway",
    });
    if (!ok) return null;
    return await fn(true);
  }
}

async function promptPassword(c: DbConnection, error: string): Promise<{ password: string; save: boolean } | null> {
  const { askPassword } = await import("../../components/db/DbDialogs");
  return askPassword(c, error);
}

// ------------------------------------------------------------------ tabs

let tabSeq = 0;
export type DbTabKind = "dbquery" | "dbtable" | "dbdesign" | "dber";

export function openDbTab(kind: DbTabKind, ref: DbTabRef, title?: string) {
  const c = connById(ref.conn);
  const id = kind === "dbquery" || ref.isNew ? `${kind}:${Date.now().toString(36)}${++tabSeq}` : `${kind}:${ref.conn}:${ref.database ?? ""}:${ref.schema ?? ""}:${ref.table ?? ""}`;
  const label = title ?? (kind === "dbquery" ? `Query · ${c?.name ?? "SQL"}` : kind === "dber" ? `ER · ${ref.schema || ref.database || c?.name}` : kind === "dbdesign" ? `Design · ${ref.table ?? "new table"}` : ref.table ?? "table");
  const tab = { id, kind, path: `db://${c?.name ?? ref.conn}/${[ref.database, ref.schema, ref.table].filter(Boolean).join("/")}`, title: label, db: ref } as unknown as Tab;
  setApp((s) => ({ tabs: s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, tab], activeId: id, view: "editor" }));
  return id;
}

export function renameDbTab(id: string, title: string) {
  setApp((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }));
}

// ------------------------------------------------------------------ history

export interface HistoryItem { sql: string; ts: number; ok: boolean; ms: number }
const HKEY = (id: string) => `cepheus.db.history.${id}`;

export function loadHistory(conn: string): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem(HKEY(conn)) || "[]");
  } catch {
    return [];
  }
}
export function addHistory(conn: string, item: HistoryItem) {
  try {
    const list = loadHistory(conn).filter((h) => h.sql !== item.sql);
    list.unshift(item);
    localStorage.setItem(HKEY(conn), JSON.stringify(list.slice(0, 200)));
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ ER layouts (settings.dbErLayouts)

export type ErLayout = Record<string, { x: number; y: number }>;
export function loadErLayout(key: string): ErLayout | null {
  return ((getApp().settings as any).dbErLayouts ?? {})[key] ?? null;
}
export async function saveErLayout(key: string, layout: ErLayout) {
  const { saveSettings } = await import("../workspace");
  const s = getApp().settings as any;
  await saveSettings({ ...s, dbErLayouts: { ...(s.dbErLayouts ?? {}), [key]: layout } });
}
