// Tauri command wrappers for the database client (src-tauri/src/db/mod.rs).
import { invoke } from "@tauri-apps/api/core";
import type { ApplyResult, DbConnection, DbObject, Edit, Filter, QueryResponse, ResultSet, SchemaOverview, Sort, TableInfo, TablePage } from "./types";

type Db = string | null | undefined;
const db = (d: Db) => (d ? d : null);

export const dbApi = {
  setConnections: (connections: DbConnection[]) => invoke<void>("db_set_connections", { connections }),
  savePassword: (id: string, password: string) => invoke<void>("db_save_password", { id, password }),
  deletePassword: (id: string) => invoke<void>("db_delete_password", { id }),
  hasPassword: (id: string) => invoke<boolean>("db_has_password", { id }),
  connect: (id: string, password?: string | null) => invoke<{ serverVersion: string; database: string }>("db_connect", { id, password: password ?? null }),
  disconnect: (id: string) => invoke<void>("db_disconnect", { id }),
  status: () => invoke<string[]>("db_status"),
  test: (config: DbConnection, password?: string | null) => invoke<string>("db_test", { config, password: password ?? null }),

  listDatabases: (id: string) => invoke<string[]>("db_list_databases", { id }),
  listSchemas: (id: string, database: Db) => invoke<string[]>("db_list_schemas", { id, database: db(database) }),
  listObjects: (id: string, database: Db, schema: string) => invoke<DbObject[]>("db_list_objects", { id, database: db(database), schema }),
  describeTable: (id: string, database: Db, schema: string, table: string) => invoke<TableInfo>("db_describe_table", { id, database: db(database), schema, table }),
  overview: (id: string, database: Db, schema: string) => invoke<SchemaOverview>("db_schema_overview", { id, database: db(database), schema }),

  query: (req: { id: string; database?: Db; sql: string; limit?: number; offset?: number; queryId?: string; confirmed?: boolean }) =>
    invoke<QueryResponse>("db_query", { req: { ...req, database: db(req.database) } }),
  cancel: (queryId: string) => invoke<boolean>("db_cancel", { queryId }),
  explain: (id: string, database: Db, sql: string, analyze = false) => invoke<ResultSet>("db_explain", { id, database: db(database), sql, analyze }),
  tableRows: (req: { id: string; database?: Db; schema: string; table: string; offset: number; limit: number; sort: Sort[]; filters: Filter[]; count: boolean }) =>
    invoke<TablePage>("db_table_rows", { req: { ...req, database: db(req.database) } }),
  applyEdits: (req: { id: string; database?: Db; schema: string; table: string; edits: Edit[]; dryRun: boolean; confirmed?: boolean }) =>
    invoke<ApplyResult>("db_apply_edits", { req: { ...req, database: db(req.database) } }),
  exportData: (req: { id: string; database?: Db; sql?: string; schema?: string; table?: string; format: string; path: string }) =>
    invoke<number>("db_export", { req: { ...req, database: db(req.database) } }),
  importCsv: (req: { id: string; database?: Db; schema: string; table: string; path: string; mapping: { source: number; column: string }[]; header: boolean; delimiter: string; emptyAsNull: boolean; confirmed?: boolean }) =>
    invoke<number>("db_import_csv", { req: { ...req, database: db(req.database) } }),
  csvPreview: (path: string, delimiter: string) => invoke<string[][]>("db_csv_preview", { path, delimiter }),
  dump: (req: { id: string; database?: Db; path: string; jobId: string }) => invoke<void>("db_dump", { req: { ...req, database: db(req.database) } }),
  restore: (req: { id: string; database?: Db; path: string; jobId: string; confirmed: boolean }) => invoke<void>("db_restore", { req: { ...req, database: db(req.database) } }),
  saveBytes: (path: string, base64: string) => invoke<void>("db_save_bytes", { path, base64 }),
};

/** Parses a `CONFIRM_REQUIRED:<reason>:<what>: message` refusal from the backend guard. */
export function confirmRequired(e: unknown): { reason: string; what: string; message: string } | null {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const m = s.match(/^CONFIRM_REQUIRED:([^:]+):([^:]*):\s*([\s\S]*)$/);
  return m ? { reason: m[1], what: m[2], message: m[3] } : null;
}
