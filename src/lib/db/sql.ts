// SQL helpers for the database client: quoting, a simple formatter, dialect keywords and type
// presets, the schema-aware Monaco completion provider, and DDL generation for the table designer.
import { monaco } from "../monaco";
import type { ColumnInfo, Dialect, ForeignKey, IndexInfo, SchemaOverview, TableInfo } from "./types";

export function quoteIdent(d: Dialect, name: string): string {
  if (d === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  if (d === "mssql") return "[" + name.replace(/]/g, "]]") + "]";
  return '"' + name.replace(/"/g, '""') + '"';
}

export function qualified(d: Dialect, schema: string | undefined, table: string): string {
  if (!schema || (d === "sqlite" && schema === "main")) return quoteIdent(d, table);
  return `${quoteIdent(d, schema)}.${quoteIdent(d, table)}`;
}

export function quoteLiteral(d: Dialect, s: string): string {
  const body = s.replace(/'/g, "''");
  if (d === "mysql") return "'" + body.replace(/\\/g, "\\\\") + "'";
  if (d === "mssql") return "N'" + body + "'";
  return "'" + body + "'";
}

export function sqlValue(d: Dialect, v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return d === "postgres" ? (v ? "TRUE" : "FALSE") : v ? "1" : "0";
  if (typeof v === "number") return String(v);
  return quoteLiteral(d, String(v));
}

// ------------------------------------------------------------------ keywords / types

const COMMON_KW = [
  "SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "EXISTS", "BETWEEN", "LIKE", "AS", "ON", "JOIN", "INNER JOIN", "LEFT JOIN",
  "RIGHT JOIN", "FULL JOIN", "CROSS JOIN", "GROUP BY", "ORDER BY", "HAVING", "DISTINCT", "UNION", "UNION ALL", "INSERT INTO", "VALUES", "UPDATE", "SET",
  "DELETE FROM", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "CREATE INDEX", "PRIMARY KEY", "FOREIGN KEY", "REFERENCES", "ON DELETE CASCADE",
  "ON DELETE SET NULL", "UNIQUE", "DEFAULT", "CHECK", "CONSTRAINT", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH", "ASC", "DESC", "COUNT", "SUM",
  "AVG", "MIN", "MAX", "COALESCE", "CAST", "BEGIN", "COMMIT", "ROLLBACK", "EXPLAIN", "ADD COLUMN", "DROP COLUMN", "RENAME TO", "TRUNCATE", "VIEW",
];
export const DIALECT_KW: Record<Dialect, string[]> = {
  postgres: ["LIMIT", "OFFSET", "RETURNING", "ILIKE", "ON CONFLICT", "DO NOTHING", "DO UPDATE SET", "GENERATED ALWAYS AS IDENTITY", "SERIAL", "JSONB", "NOW()", "EXPLAIN ANALYZE", "MATERIALIZED VIEW", "LATERAL", "FILTER", "OVER", "PARTITION BY", "string_agg", "array_agg", "jsonb_build_object", "gen_random_uuid()"],
  mysql: ["LIMIT", "OFFSET", "AUTO_INCREMENT", "ON DUPLICATE KEY UPDATE", "ENGINE=InnoDB", "DEFAULT CHARSET=utf8mb4", "SHOW TABLES", "SHOW CREATE TABLE", "DESCRIBE", "GROUP_CONCAT", "NOW()", "IFNULL", "REPLACE INTO", "STRAIGHT_JOIN"],
  sqlite: ["LIMIT", "OFFSET", "AUTOINCREMENT", "PRAGMA", "WITHOUT ROWID", "INSERT OR REPLACE", "INSERT OR IGNORE", "ON CONFLICT", "datetime('now')", "group_concat", "ifnull", "EXPLAIN QUERY PLAN", "VACUUM"],
  mssql: ["TOP", "OFFSET", "FETCH NEXT", "ROWS ONLY", "IDENTITY(1,1)", "NVARCHAR", "GETDATE()", "ISNULL", "OUTPUT INSERTED", "MERGE", "GO", "SET NOCOUNT ON", "STRING_AGG"],
};
export const keywordsFor = (d: Dialect) => [...COMMON_KW, ...DIALECT_KW[d]];

/** Type presets for the table designer (name, whether it takes a length). */
export const TYPE_PRESETS: Record<Dialect, { name: string; len?: boolean }[]> = {
  postgres: [
    { name: "bigint" }, { name: "integer" }, { name: "smallint" }, { name: "numeric", len: true }, { name: "real" }, { name: "double precision" },
    { name: "boolean" }, { name: "text" }, { name: "varchar", len: true }, { name: "char", len: true }, { name: "uuid" }, { name: "date" },
    { name: "time" }, { name: "timestamp" }, { name: "timestamptz" }, { name: "interval" }, { name: "jsonb" }, { name: "json" }, { name: "bytea" },
    { name: "inet" }, { name: "text[]" }, { name: "serial" }, { name: "bigserial" },
  ],
  mysql: [
    { name: "BIGINT" }, { name: "INT" }, { name: "SMALLINT" }, { name: "TINYINT" }, { name: "DECIMAL", len: true }, { name: "DOUBLE" }, { name: "FLOAT" },
    { name: "BOOLEAN" }, { name: "VARCHAR", len: true }, { name: "CHAR", len: true }, { name: "TEXT" }, { name: "MEDIUMTEXT" }, { name: "LONGTEXT" },
    { name: "DATE" }, { name: "TIME" }, { name: "DATETIME" }, { name: "TIMESTAMP" }, { name: "JSON" }, { name: "BLOB" }, { name: "VARBINARY", len: true },
    { name: "ENUM", len: true },
  ],
  sqlite: [{ name: "INTEGER" }, { name: "TEXT" }, { name: "REAL" }, { name: "NUMERIC" }, { name: "BLOB" }, { name: "BOOLEAN" }, { name: "DATETIME" }, { name: "VARCHAR", len: true }],
  mssql: [
    { name: "BIGINT" }, { name: "INT" }, { name: "SMALLINT" }, { name: "TINYINT" }, { name: "BIT" }, { name: "DECIMAL", len: true }, { name: "FLOAT" },
    { name: "NVARCHAR", len: true }, { name: "VARCHAR", len: true }, { name: "NCHAR", len: true }, { name: "NVARCHAR(MAX)" }, { name: "UNIQUEIDENTIFIER" },
    { name: "DATE" }, { name: "TIME" }, { name: "DATETIME2" }, { name: "DATETIMEOFFSET" }, { name: "VARBINARY", len: true },
  ],
};

// ------------------------------------------------------------------ formatter

const BREAK_BEFORE = ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION ALL", "UNION", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "RETURNING", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN", "ON CONFLICT", "WITH"];
const INDENT_BEFORE = ["AND", "OR", "ON"];
const UPPER = new Set([...COMMON_KW, "LIMIT", "OFFSET", "RETURNING", "ILIKE", "TOP", "INTO", "BY", "ALL", "ANY", "OUTER", "LEFT", "RIGHT", "INNER", "FULL", "CROSS", "GROUP", "ORDER", "TABLE", "INDEX", "KEY", "PRIMARY", "FOREIGN", "IF", "DROP", "CREATE", "ALTER", "INSERT", "DELETE", "JOIN", "UNION", "DESC", "ASC", "OVER", "PARTITION"].flatMap((k) => k.split(" ")));

interface FTok { t: "word" | "str" | "ident" | "num" | "punct" | "comment" | "ws"; v: string }

function ftokens(sql: string): FTok[] {
  const out: FTok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const rest = sql.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) { out.push({ t: "ws", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^--[^\n]*/))) { out.push({ t: "comment", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\/\*[\s\S]*?(\*\/|$)/))) { out.push({ t: "comment", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/))) { out.push({ t: "str", v: m[0] }); i += m[0].length; continue; }
    if (c === "'") { m = rest.match(/^'(?:[^']|'')*'?/); out.push({ t: "str", v: m![0] }); i += m![0].length; continue; }
    if (c === '"' || c === "`") { const re = c === '"' ? /^"(?:[^"]|"")*"?/ : /^`(?:[^`]|``)*`?/; m = rest.match(re); out.push({ t: "ident", v: m![0] }); i += m![0].length; continue; }
    if (c === "[") { m = rest.match(/^\[[^\]]*\]?/); out.push({ t: "ident", v: m![0] }); i += m![0].length; continue; }
    if ((m = rest.match(/^\d+(\.\d+)?/))) { out.push({ t: "num", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^[A-Za-z_][\w$]*/))) { out.push({ t: "word", v: m[0] }); i += m[0].length; continue; }
    if ((m = rest.match(/^(::|<=|>=|<>|!=|\|\|)/))) { out.push({ t: "punct", v: m[0] }); i += m[0].length; continue; }
    out.push({ t: "punct", v: c });
    i++;
  }
  return out;
}

/** A small, predictable SQL formatter: one clause per line, AND/OR indented, keywords upper-cased. */
export function formatSql(sql: string): string {
  const toks = ftokens(sql).filter((t) => t.t !== "ws");
  const lines: string[] = [];
  let line = "";
  let depth = 0;
  const pad = () => "  ".repeat(Math.max(0, depth));
  const flush = () => { if (line.trim()) lines.push(line.replace(/\s+$/, "")); line = pad(); };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    const up = tk.t === "word" ? tk.v.toUpperCase() : tk.v;
    const two = tk.t === "word" && toks[i + 1]?.t === "word" ? `${up} ${toks[i + 1].v.toUpperCase()}` : "";
    if (tk.t === "comment") { flush(); lines.push(pad() + tk.v); line = pad(); continue; }
    if (tk.v === ";") { line += ";"; flush(); lines.push(""); depth = 0; line = ""; continue; }
    if (tk.t === "word" && (BREAK_BEFORE.includes(two) || BREAK_BEFORE.includes(up))) {
      const kw = BREAK_BEFORE.includes(two) ? two : up;
      if (kw === two) i++;
      flush();
      line = pad() + kw + " ";
      continue;
    }
    if (tk.t === "word" && INDENT_BEFORE.includes(up) && !(up === "ON" && /\b(CONFLICT|DELETE|UPDATE)\s*$/i.test(line))) {
      flush();
      line = pad() + "  " + up + " ";
      continue;
    }
    if (tk.v === "(") { line += "("; depth++; continue; }
    if (tk.v === ")") { depth = Math.max(0, depth - 1); line = line.replace(/\s+$/, "") + ") "; continue; }
    if (tk.v === ",") { line = line.replace(/\s+$/, "") + ", "; continue; }
    if (tk.v === "." || tk.v === "::") { line = line.replace(/\s+$/, "") + tk.v; continue; }
    const prev = line[line.length - 1];
    const glue = prev === "." || prev === "(" || (prev === ":" && line.endsWith("::"));
    const text = tk.t === "word" && UPPER.has(up) ? up : tk.v;
    line += (glue || !line.trim() ? "" : line.endsWith(" ") ? "" : " ") + text + " ";
  }
  flush();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Statement under the cursor (split on `;` outside strings/comments). */
export function statementAt(sql: string, offset: number): { text: string; start: number; end: number } {
  let start = 0;
  let pos = 0;
  for (const tk of ftokens(sql)) {
    const end = pos + tk.v.length;
    if (tk.t === "punct" && tk.v === ";") {
      if (offset <= end) return { text: sql.slice(start, pos).trim(), start, end: pos };
      start = end;
    }
    pos = end;
  }
  return { text: sql.slice(start).trim(), start, end: sql.length };
}

// ------------------------------------------------------------------ completion

export interface CompletionCtx { dialect: Dialect; schema?: string; overview: () => SchemaOverview | null }
const ctxByModel = new Map<string, CompletionCtx>();
let registered = false;

export function setCompletionContext(model: monaco.editor.ITextModel, ctx: CompletionCtx | null) {
  if (ctx) ctxByModel.set(model.uri.toString(), ctx);
  else ctxByModel.delete(model.uri.toString());
  if (!registered) {
    registered = true;
    monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: [".", " "],
      provideCompletionItems(model, position) {
        const ctx = ctxByModel.get(model.uri.toString());
        if (!ctx) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const K = monaco.languages.CompletionItemKind;
        const ov = ctx.overview();
        const before = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, word.startColumn));
        const dot = before.match(/([\w$"`\]\[]+)\.\s*$/);
        const unq = (s: string) => s.replace(/^["`[]|["`\]]$/g, "");
        const suggestions: monaco.languages.CompletionItem[] = [];
        if (dot && ov) {
          // alias.column or table.column: resolve aliases from the whole text ("FROM users u").
          const name = unq(dot[1]);
          const text = model.getValue();
          const alias = new RegExp(`([\\w$."\`\\]\\[]+)\\s+(?:AS\\s+)?${name.replace(/[$]/g, "\\$")}\\b`, "i").exec(text);
          const tname = [name, alias ? unq(alias[1].split(".").pop() || "") : ""].map((x) => x.toLowerCase());
          const t = ov.tables.find((x) => tname.includes(x.name.toLowerCase()));
          if (t) {
            for (const c of t.columns) suggestions.push({ label: c.name, kind: K.Field, detail: `${c.type}${c.pk ? " · PK" : ""}`, insertText: c.name, range, sortText: "0" + c.name });
            return { suggestions };
          }
          if (ov.schema.toLowerCase() === name.toLowerCase()) {
            for (const t2 of ov.tables) suggestions.push({ label: t2.name, kind: K.Struct, detail: t2.kind, insertText: t2.name, range });
            return { suggestions };
          }
        }
        if (ov) {
          for (const t of ov.tables) {
            suggestions.push({ label: t.name, kind: t.kind === "table" ? K.Struct : K.Interface, detail: `${t.kind} · ${t.columns.length} columns`, insertText: t.name, range, sortText: "1" + t.name });
          }
          // Columns of tables mentioned in the query.
          const text = model.getValue().toLowerCase();
          const seen = new Set<string>();
          for (const t of ov.tables) {
            if (!text.includes(t.name.toLowerCase())) continue;
            for (const c of t.columns) {
              if (seen.has(c.name)) continue;
              seen.add(c.name);
              suggestions.push({ label: c.name, kind: K.Field, detail: `${t.name}.${c.name} ${c.type}`, insertText: c.name, range, sortText: "0" + c.name });
            }
          }
        }
        for (const k of keywordsFor(ctx.dialect)) suggestions.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: "2" + k });
        return { suggestions };
      },
    });
  }
}

// ------------------------------------------------------------------ table designer DDL

export interface DesignColumn {
  /** Original name when editing an existing column ("" = new) */
  orig: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  default: string;
  pk: boolean;
  autoIncrement: boolean;
  comment: string;
}
export interface DesignIndex { orig: string; name: string; columns: string[]; unique: boolean }
export interface DesignFk { orig: string; name: string; columns: string[]; refTable: string; refColumns: string[]; onUpdate: string; onDelete: string }
export interface Design { schema: string; name: string; columns: DesignColumn[]; indexes: DesignIndex[]; fks: DesignFk[]; comment?: string }

export function splitType(t: string): { type: string; length: string } {
  const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*(.*)$/);
  if (!m) return { type: t, length: "" };
  return { type: (m[1] + (m[3] ? " " + m[3] : "")).trim(), length: m[2] };
}

export function designFromTable(t: TableInfo): Design {
  return {
    schema: t.schema,
    name: t.name,
    columns: t.columns.map((c: ColumnInfo) => {
      const { type, length } = splitType(c.dataType);
      return { orig: c.name, name: c.name, type, length, nullable: c.nullable, default: c.default ?? "", pk: c.pk, autoIncrement: c.autoIncrement, comment: c.comment ?? "" };
    }),
    indexes: t.indexes.filter((i: IndexInfo) => !i.primary).map((i) => ({ orig: i.name, name: i.name, columns: [...i.columns], unique: i.unique })),
    fks: t.foreignKeys.map((f: ForeignKey) => ({ orig: f.name, name: f.name, columns: [...f.fromColumns], refTable: f.toTable, refColumns: [...f.toColumns], onUpdate: f.onUpdate || "NO ACTION", onDelete: f.onDelete || "NO ACTION" })),
  };
}

function colType(d: Dialect, c: DesignColumn): string {
  let t = c.type.trim() || (d === "postgres" ? "text" : "TEXT");
  if (c.length.trim()) t = `${t}(${c.length.trim()})`;
  if (c.autoIncrement) {
    if (d === "postgres" && /^(bigint|integer|int|smallint|int8|int4)$/i.test(c.type.trim())) return `${t} GENERATED BY DEFAULT AS IDENTITY`;
    if (d === "mssql") return `${t} IDENTITY(1,1)`;
  }
  return t;
}

function colDef(d: Dialect, c: DesignColumn, inlinePk: boolean): string {
  let s = `${quoteIdent(d, c.name)} ${colType(d, c)}`;
  if (inlinePk) s += " PRIMARY KEY" + (c.autoIncrement && d === "sqlite" ? " AUTOINCREMENT" : "");
  if (!c.nullable && !inlinePk) s += " NOT NULL";
  if (c.autoIncrement && d === "mysql") s += " AUTO_INCREMENT";
  if (c.default.trim()) s += ` DEFAULT ${c.default.trim()}`;
  if (c.comment.trim() && d === "mysql") s += ` COMMENT ${quoteLiteral(d, c.comment.trim())}`;
  return s;
}

function fkClause(d: Dialect, schema: string, f: DesignFk): string {
  let s = `FOREIGN KEY (${f.columns.map((c) => quoteIdent(d, c)).join(", ")}) REFERENCES ${qualified(d, schema, f.refTable)} (${f.refColumns.map((c) => quoteIdent(d, c)).join(", ")})`;
  if (f.onUpdate && f.onUpdate !== "NO ACTION") s += ` ON UPDATE ${f.onUpdate}`;
  if (f.onDelete && f.onDelete !== "NO ACTION") s += ` ON DELETE ${f.onDelete}`;
  return s;
}

function commentStmts(d: Dialect, t: string, cols: DesignColumn[], prev?: Map<string, DesignColumn>): string[] {
  if (d !== "postgres") return [];
  return cols
    .filter((c) => c.comment.trim() !== (prev?.get(c.orig)?.comment ?? "").trim() && (c.comment.trim() || prev))
    .map((c) => `COMMENT ON COLUMN ${t}.${quoteIdent(d, c.name)} IS ${c.comment.trim() ? quoteLiteral(d, c.comment.trim()) : "NULL"};`);
}

export function createTableDdl(d: Dialect, g: Design): string {
  const t = qualified(d, g.schema, g.name);
  const pks = g.columns.filter((c) => c.pk);
  const inline = d === "sqlite" && pks.length === 1 && pks[0].autoIncrement;
  const body = g.columns.map((c) => "  " + colDef(d, c, inline && c.pk));
  if (pks.length && !inline) body.push(`  CONSTRAINT ${quoteIdent(d, `pk_${g.name}`)} PRIMARY KEY (${pks.map((c) => quoteIdent(d, c.name)).join(", ")})`);
  for (const f of g.fks.filter((f) => f.columns.length && f.refTable)) body.push(`  CONSTRAINT ${quoteIdent(d, f.name || `fk_${g.name}_${f.columns.join("_")}`)} ${fkClause(d, g.schema, f)}`);
  let out = `CREATE TABLE ${t} (\n${body.join(",\n")}\n)${d === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : ""};`;
  for (const i of g.indexes.filter((i) => i.columns.length)) {
    out += `\nCREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(d, i.name || `ix_${g.name}_${i.columns.join("_")}`)} ON ${t} (${i.columns.map((c) => quoteIdent(d, c)).join(", ")});`;
  }
  const cm = commentStmts(d, t, g.columns);
  if (cm.length) out += "\n" + cm.join("\n");
  return out;
}

/** ALTER statements turning `before` into `after`. SQLite only supports a subset (add/rename/drop column). */
export function alterTableDdl(d: Dialect, before: Design, after: Design): { sql: string; warnings: string[] } {
  const warnings: string[] = [];
  const t = qualified(d, after.schema, after.name);
  const tq = qualified(d, before.schema, before.name);
  const out: string[] = [];
  if (before.name !== after.name) {
    if (d === "mssql") out.push(`EXEC sp_rename ${quoteLiteral(d, `${before.schema}.${before.name}`)}, ${quoteLiteral(d, after.name)};`);
    else out.push(`ALTER TABLE ${tq} RENAME TO ${quoteIdent(d, after.name)};`);
  }
  const prev = new Map(before.columns.map((c) => [c.orig, c]));
  const kept = new Set(after.columns.filter((c) => c.orig).map((c) => c.orig));
  // drops
  for (const c of before.columns) {
    if (!kept.has(c.orig)) out.push(`ALTER TABLE ${t} DROP COLUMN ${quoteIdent(d, c.orig)};`);
  }
  for (const c of after.columns) {
    const p = c.orig ? prev.get(c.orig) : undefined;
    if (!p) {
      out.push(`ALTER TABLE ${t} ADD ${d === "mssql" ? "" : "COLUMN "}${colDef(d, c, false)};`);
      continue;
    }
    if (p.name !== c.name) {
      if (d === "mssql") out.push(`EXEC sp_rename ${quoteLiteral(d, `${after.schema}.${after.name}.${p.name}`)}, ${quoteLiteral(d, c.name)}, 'COLUMN';`);
      else out.push(`ALTER TABLE ${t} RENAME COLUMN ${quoteIdent(d, p.name)} TO ${quoteIdent(d, c.name)};`);
    }
    const typeChanged = p.type !== c.type || p.length !== c.length;
    const nullChanged = p.nullable !== c.nullable;
    const defChanged = p.default.trim() !== c.default.trim();
    const qc = quoteIdent(d, c.name);
    if (d === "sqlite") {
      if (typeChanged || nullChanged || defChanged || p.autoIncrement !== c.autoIncrement) warnings.push(`SQLite cannot alter column "${c.name}" in place (type/NULL/default). Recreate the table to change it.`);
      continue;
    }
    if (d === "postgres") {
      if (typeChanged) out.push(`ALTER TABLE ${t} ALTER COLUMN ${qc} TYPE ${colType(d, { ...c, autoIncrement: false })} USING ${qc}::${colType(d, { ...c, autoIncrement: false })};`);
      if (nullChanged) out.push(`ALTER TABLE ${t} ALTER COLUMN ${qc} ${c.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`);
      if (defChanged) out.push(c.default.trim() ? `ALTER TABLE ${t} ALTER COLUMN ${qc} SET DEFAULT ${c.default.trim()};` : `ALTER TABLE ${t} ALTER COLUMN ${qc} DROP DEFAULT;`);
    } else if (d === "mysql") {
      if (typeChanged || nullChanged || defChanged || p.autoIncrement !== c.autoIncrement || p.comment !== c.comment) out.push(`ALTER TABLE ${t} MODIFY COLUMN ${colDef(d, c, false)};`);
    } else if (d === "mssql") {
      if (typeChanged || nullChanged) out.push(`ALTER TABLE ${t} ALTER COLUMN ${qc} ${colType(d, { ...c, autoIncrement: false })}${c.nullable ? " NULL" : " NOT NULL"};`);
      if (defChanged) warnings.push(`SQL Server defaults are named constraints: drop the old default constraint of "${c.name}" and add a new one manually.`);
    }
  }
  // primary key
  const pkB = before.columns.filter((c) => c.pk).map((c) => c.orig).join(",");
  const pkA = after.columns.filter((c) => c.pk).map((c) => c.orig || c.name).join(",");
  if (pkB !== pkA) {
    if (d === "sqlite") warnings.push("SQLite cannot change the primary key of an existing table.");
    else {
      if (pkB) out.push(d === "mysql" ? `ALTER TABLE ${t} DROP PRIMARY KEY;` : `ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(d, `pk_${before.name}`)}; -- check the actual constraint name`);
      const cols = after.columns.filter((c) => c.pk);
      if (cols.length) out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(d, `pk_${after.name}`)} PRIMARY KEY (${cols.map((c) => quoteIdent(d, c.name)).join(", ")});`);
    }
  }
  // indexes
  const sameIdx = (a: DesignIndex, b: DesignIndex) => a.name === b.name && a.unique === b.unique && a.columns.join() === b.columns.join();
  for (const i of before.indexes) {
    const now = after.indexes.find((x) => x.orig === i.orig);
    if (!now || !sameIdx(i, now)) {
      out.push(d === "mysql" ? `DROP INDEX ${quoteIdent(d, i.orig)} ON ${t};` : d === "mssql" ? `DROP INDEX ${quoteIdent(d, i.orig)} ON ${t};` : `DROP INDEX ${qualified(d, after.schema, i.orig)};`);
    }
  }
  for (const i of after.indexes.filter((i) => i.columns.length)) {
    const was = before.indexes.find((x) => x.orig === i.orig && i.orig);
    if (was && sameIdx(was, i)) continue;
    out.push(`CREATE ${i.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(d, i.name || `ix_${after.name}_${i.columns.join("_")}`)} ON ${t} (${i.columns.map((c) => quoteIdent(d, c)).join(", ")});`);
  }
  // foreign keys
  const sameFk = (a: DesignFk, b: DesignFk) => a.columns.join() === b.columns.join() && a.refTable === b.refTable && a.refColumns.join() === b.refColumns.join() && a.onDelete === b.onDelete && a.onUpdate === b.onUpdate;
  for (const f of before.fks) {
    const now = after.fks.find((x) => x.orig === f.orig);
    if (!now || !sameFk(f, now)) {
      if (d === "sqlite") warnings.push(`SQLite cannot drop or change foreign key "${f.orig}" without recreating the table.`);
      else out.push(d === "mysql" ? `ALTER TABLE ${t} DROP FOREIGN KEY ${quoteIdent(d, f.orig)};` : `ALTER TABLE ${t} DROP CONSTRAINT ${quoteIdent(d, f.orig)};`);
    }
  }
  for (const f of after.fks.filter((f) => f.columns.length && f.refTable)) {
    const was = before.fks.find((x) => x.orig === f.orig && f.orig);
    if (was && sameFk(was, f)) continue;
    if (d === "sqlite") {
      warnings.push(`SQLite cannot add foreign key on (${f.columns.join(", ")}) to an existing table; recreate the table.`);
      continue;
    }
    out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${quoteIdent(d, f.name || `fk_${after.name}_${f.columns.join("_")}`)} ${fkClause(d, after.schema, f)};`);
  }
  out.push(...commentStmts(d, t, after.columns.filter((c) => c.orig), prev));
  out.push(...commentStmts(d, t, after.columns.filter((c) => !c.orig)));
  return { sql: out.join("\n"), warnings };
}

export const FK_ACTIONS = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];
