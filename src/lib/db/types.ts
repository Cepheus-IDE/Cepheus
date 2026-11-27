// Database client types (mirror src-tauri/src/db/*.rs).

export type DbKind = "postgres" | "mysql" | "mariadb" | "sqlite" | "mssql";
export type Dialect = "postgres" | "mysql" | "sqlite" | "mssql";
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

/** Connection metadata stored in settings (`dbConnections`). Passwords live in the OS keychain. */
export interface DbConnection {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  database: string;
  user: string;
  /** SQLite database file */
  file: string;
  sslMode: SslMode;
  color: string;
  production: boolean;
  readOnly: boolean;
  /** Saved SSH host id (Remote panel) to tunnel through */
  ssh?: string | null;
  timeoutSecs?: number;
  trustServerCert?: boolean;
  /** UI only: a password is stored in the keychain */
  savePassword?: boolean;
}

export interface Column { name: string; type: string }

export interface ResultSet {
  index: number;
  statement: string;
  columns: Column[];
  rows: unknown[][];
  rowsAffected: number | null;
  hasMore: boolean;
  offset: number;
  durationMs: number;
  error: string | null;
  returnsRows: boolean;
}

export interface QueryResponse { results: ResultSet[]; durationMs: number; cancelled: boolean }

export interface DbObject { name: string; kind: "table" | "view" | "materialized_view" | "foreign_table" | "sequence" | "function" | "procedure" | string; rows: number | null; comment: string | null }

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  pk: boolean;
  autoIncrement: boolean;
  comment: string | null;
}
export interface IndexInfo { name: string; columns: string[]; unique: boolean; primary: boolean; definition: string | null }
export interface ForeignKey {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumns: string[];
  toSchema: string;
  toTable: string;
  toColumns: string[];
  onUpdate: string;
  onDelete: string;
}
export interface CheckInfo { name: string; definition: string }
export interface TableInfo {
  schema: string;
  name: string;
  kind: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  referencedBy: ForeignKey[];
  checks: CheckInfo[];
  ddl: string | null;
}

export interface OverviewColumn { name: string; type: string; nullable: boolean; pk: boolean }
export interface OverviewTable { name: string; kind: string; columns: OverviewColumn[] }
export interface SchemaOverview { schema: string; tables: OverviewTable[]; foreignKeys: ForeignKey[] }

export interface Sort { column: string; desc: boolean }
export interface Filter { column: string; op: string; value: unknown }
export interface TablePage { columns: ColumnInfo[]; rows: unknown[][]; total: number | null; primaryKey: string[]; sql: string; kind: string }

export interface Edit { op: "insert" | "update" | "delete"; values: Record<string, unknown>; key: Record<string, unknown> }
export interface ApplyResult { statements: string[]; affected: number[]; dryRun: boolean }

/** What a database editor tab points at. */
export interface DbTabRef {
  conn: string;
  database?: string;
  schema?: string;
  table?: string;
  /** Initial SQL for query tabs */
  sql?: string;
  /** Designer: true = new table */
  isNew?: boolean;
}

export const dialectOf = (k: DbKind | string | undefined): Dialect =>
  k === "postgres" ? "postgres" : k === "mysql" || k === "mariadb" ? "mysql" : k === "mssql" ? "mssql" : "sqlite";

export const KIND_LABEL: Record<DbKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  mssql: "SQL Server",
};

export const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlite: 0, mssql: 1433 };
