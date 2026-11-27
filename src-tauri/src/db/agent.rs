//! Agent tools for the database client: `db_list_connections`, `db_schema`, `db_query`
//! (read-only) and `db_execute` (DDL/DML, always approved by the user except in Turbo mode on
//! non-production connections). Wired in `agent/tools.rs` and `agent/mod.rs`.

use super::{cell_text, configs, meta, safety, ConnConfig, QueryReq};
use crate::agent::providers::ToolDef;
use serde_json::{json, Value};

pub const TOOL_NAMES: &[&str] = &["db_list_connections", "db_schema", "db_query", "db_execute"];

pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "db_list_connections",
            description: "List the database connections configured in the IDE's Database view (name, engine, host, database, production/read-only flags, connected state).",
            schema: json!({"type": "object", "properties": {}}),
        },
        ToolDef {
            name: "db_schema",
            description: "Describe a database schema compactly: every table/view with its columns (type, NOT NULL, * = primary key) and all foreign keys. Use it before writing queries or DDL.",
            schema: json!({"type": "object", "properties": {
                "connection": {"type": "string", "description": "Connection name or id (see db_list_connections)"},
                "database": {"type": "string", "description": "Database name (optional; defaults to the connection's database)"},
                "schema": {"type": "string", "description": "Schema (Postgres: public by default; SQL Server: dbo; MySQL: the database; SQLite: main)"},
                "table": {"type": "string", "description": "Optional: one table, to get its full definition (indexes, checks, DDL)"}
            }, "required": ["connection"]}),
        },
        ToolDef {
            name: "db_query",
            description: "Run a READ-ONLY statement (SELECT, WITH … SELECT, EXPLAIN, SHOW, DESCRIBE, read-only PRAGMA) on a database connection and get the rows as text. Anything that writes is refused: use db_execute for that.",
            schema: json!({"type": "object", "properties": {
                "connection": {"type": "string", "description": "Connection name or id"},
                "sql": {"type": "string", "description": "The read-only SQL to run"},
                "database": {"type": "string", "description": "Database name (optional)"},
                "limit": {"type": "integer", "description": "Max rows to return (default 100, max 1000)"}
            }, "required": ["connection", "sql"]}),
        },
        ToolDef {
            name: "db_execute",
            description: "Run DDL/DML (CREATE/ALTER/DROP TABLE, CREATE INDEX, INSERT/UPDATE/DELETE, …) on a database connection. The user sees the full SQL and must approve it (except in Turbo mode on non-production connections). Several statements separated by ';' run in order on one session; wrap related changes in BEGIN/COMMIT where the dialect supports transactional DDL.",
            schema: json!({"type": "object", "properties": {
                "connection": {"type": "string", "description": "Connection name or id"},
                "sql": {"type": "string", "description": "The SQL to execute (shown to the user verbatim)"},
                "database": {"type": "string", "description": "Database name (optional)"},
                "reason": {"type": "string", "description": "One sentence: what this changes and why"}
            }, "required": ["connection", "sql"]}),
        },
    ]
}

/// Read-only tools that may run in Plan mode.
pub fn is_read_only(name: &str) -> bool {
    matches!(name, "db_list_connections" | "db_schema" | "db_query")
}

fn resolve(args: &Value) -> Result<ConnConfig, String> {
    let want = args.get("connection").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let all = configs();
    if all.is_empty() {
        return Err("No database connections are configured. Ask the user to add one in the Database view (activity bar).".into());
    }
    if want.is_empty() && all.len() == 1 {
        return Ok(all[0].clone());
    }
    all.iter()
        .find(|c| c.id == want)
        .or_else(|| all.iter().find(|c| c.name.eq_ignore_ascii_case(&want)))
        .cloned()
        .ok_or_else(|| format!("Unknown connection '{want}'. Available: {}", all.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")))
}

/// Approval rules: `db_query` asks only in "ask" mode; `db_execute` always asks except in Turbo,
/// and on production connections it asks even in Turbo.
pub fn needs_approval(name: &str, args: &Value, mode: &str) -> bool {
    match name {
        "db_query" => mode != "turbo" && mode != "auto-edit",
        "db_execute" => {
            if mode != "turbo" {
                return true;
            }
            resolve(args).map(|c| c.production).unwrap_or(true)
        }
        _ => false,
    }
}

/// Database section for the system prompt (only when connections exist).
pub fn system_prompt() -> Option<String> {
    let all = configs();
    if all.is_empty() {
        return None;
    }
    let list: Vec<String> = all
        .iter()
        .map(|c| {
            format!(
                "- {} ({}{}{}{})",
                c.name,
                c.kind,
                if c.database.is_empty() { String::new() } else { format!(", db {}", c.database) },
                if c.production { ", PRODUCTION" } else { "" },
                if c.read_only { ", read-only" } else { "" }
            )
        })
        .collect();
    Some(format!(
        "\n\n# Databases\nThe IDE has a database client. Connections:\n{}\n\
Tools: db_list_connections, db_schema (tables, columns, foreign keys), db_query (read-only SELECT/EXPLAIN/SHOW), \
db_execute (DDL/DML; the user approves the exact SQL).\n\
- Inspect with db_schema before writing SQL; use the connection's dialect (Postgres, MySQL/MariaDB, SQLite or SQL Server).\n\
- To explain a slow query, run EXPLAIN through db_query and point at sequential scans, missing indexes and bad join orders.\n\
- You can design schemas: every table gets a primary key (identity/auto-increment or UUID), foreign keys with explicit \
ON DELETE rules (CASCADE for owned children, SET NULL or RESTRICT otherwise), an index on every foreign-key column, \
NOT NULL and sensible defaults, UNIQUE where natural keys exist, and types that fit the dialect (Postgres: bigint identity, text, \
timestamptz, jsonb, boolean; MySQL: BIGINT UNSIGNED AUTO_INCREMENT, VARCHAR(n), DATETIME(6), JSON, InnoDB + utf8mb4; SQLite: INTEGER PRIMARY KEY, \
TEXT, REAL; SQL Server: BIGINT IDENTITY, NVARCHAR(n), DATETIME2, BIT). Use join tables for many-to-many.\n\
- Show the DDL in your reply and explain it briefly. If the project has a migration tool (Prisma, Drizzle, Knex, Alembic, \
Laravel, Rails, TypeORM, Flyway…), write a migration file with the project's conventions instead of changing the database \
directly; otherwise run the DDL with db_execute.\n\
- Never run destructive statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE) unless the user asked for exactly that.",
        list.join("\n")
    ))
}

fn table_text(rs: &super::ops::ResultSet, max_cell: usize) -> String {
    let mut out = String::new();
    if !rs.columns.is_empty() {
        out.push_str(&rs.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join("\t"));
        out.push('\n');
        for r in &rs.rows {
            let cells: Vec<String> = r
                .iter()
                .map(|v| {
                    let s = cell_text(v).replace(['\t', '\n', '\r'], " ");
                    if s.chars().count() > max_cell { format!("{}…", s.chars().take(max_cell).collect::<String>()) } else { s }
                })
                .collect();
            out.push_str(&cells.join("\t"));
            out.push('\n');
        }
        out.push_str(&format!("({} row{}{})\n", rs.rows.len(), if rs.rows.len() == 1 { "" } else { "s" }, if rs.has_more { ", more available — add LIMIT/filters" } else { "" }));
    } else if rs.returns_rows {
        out.push_str("(0 rows)\n");
    } else if let Some(n) = rs.rows_affected {
        out.push_str(&format!("OK, {n} row(s) affected\n"));
    } else if rs.error.is_none() {
        out.push_str("OK\n");
    }
    if let Some(e) = &rs.error {
        out.push_str(&format!("ERROR: {e}\n"));
    }
    out
}

pub async fn execute(name: &str, args: &Value) -> Result<String, String> {
    let database = args.get("database").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
    match name {
        "db_list_connections" => {
            let live = super::db_status().await;
            let all = configs();
            if all.is_empty() {
                return Ok("No database connections configured. The user can add one in the Database view.".into());
            }
            Ok(all
                .iter()
                .map(|c| {
                    let target = if c.dialect() == safety::Dialect::Sqlite { c.file.clone() } else { format!("{}:{}", c.host, c.port) };
                    format!(
                        "{} [{}] {} db={}{}{}{}",
                        c.name,
                        c.kind,
                        target,
                        if c.database.is_empty() { "-" } else { &c.database },
                        if c.production { " PRODUCTION" } else { "" },
                        if c.read_only { " read-only" } else { "" },
                        if live.contains(&c.id) { " (connected)" } else { "" }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "db_schema" => {
            let c = resolve(args)?;
            let (db, _) = super::get_db(&c.id, database.as_deref()).await?;
            let d = db.dialect();
            let schema = match args.get("schema").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                Some(s) => s.to_string(),
                None => meta::list_schemas(&db, database.as_deref().unwrap_or(&c.database)).await?.into_iter().next().unwrap_or_default(),
            };
            if let Some(t) = args.get("table").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                let info = meta::describe_table(&db, &schema, t).await?;
                let mut out = format!("{}.{} ({})\n", info.schema, info.name, info.kind);
                for col in &info.columns {
                    out.push_str(&format!(
                        "  {}{} {}{}{}{}\n",
                        if col.pk { "*" } else { "" },
                        col.name,
                        col.data_type,
                        if col.nullable { "" } else { " NOT NULL" },
                        col.default.as_ref().map(|d| format!(" DEFAULT {d}")).unwrap_or_default(),
                        if col.auto_increment { " auto" } else { "" }
                    ));
                }
                for i in &info.indexes {
                    out.push_str(&format!("  index {}{} ({})\n", i.name, if i.unique { " unique" } else { "" }, i.columns.join(", ")));
                }
                for f in &info.foreign_keys {
                    out.push_str(&format!("  fk {} ({}) -> {}({}) on delete {}\n", f.name, f.from_columns.join(","), f.to_table, f.to_columns.join(","), f.on_delete));
                }
                for f in &info.referenced_by {
                    out.push_str(&format!("  referenced by {}({})\n", f.from_table, f.from_columns.join(",")));
                }
                if let Some(ddl) = &info.ddl {
                    out.push_str(&format!("DDL:\n{ddl}\n"));
                }
                return Ok(crate::agent::tools::truncate(out));
            }
            let o = meta::schema_overview(&db, &schema).await?;
            Ok(crate::agent::tools::truncate(meta::overview_text(&o, d)))
        }
        "db_query" => {
            let c = resolve(args)?;
            let sql = args.get("sql").and_then(|v| v.as_str()).ok_or("Missing 'sql'")?;
            if !safety::all_read_only(sql, c.dialect()) {
                return Err("db_query only runs read-only statements (SELECT, EXPLAIN, SHOW…). Use db_execute for changes.".into());
            }
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(100).clamp(1, 1000) as usize;
            let r = super::query(QueryReq { id: c.id.clone(), database, sql: sql.to_string(), limit: Some(limit), offset: None, query_id: None, confirmed: false }).await?;
            let mut out = String::new();
            for rs in &r.results {
                if r.results.len() > 1 {
                    out.push_str(&format!("-- statement {}\n", rs.index + 1));
                }
                out.push_str(&table_text(rs, 200));
            }
            out.push_str(&format!("({} ms)", r.duration_ms));
            Ok(crate::agent::tools::truncate(out))
        }
        "db_execute" => {
            let c = resolve(args)?;
            let sql = args.get("sql").and_then(|v| v.as_str()).ok_or("Missing 'sql'")?;
            // The user approved this exact SQL (or Turbo on a non-production connection).
            let r = super::query(QueryReq { id: c.id.clone(), database, sql: sql.to_string(), limit: Some(50), offset: None, query_id: None, confirmed: true }).await?;
            let mut out = String::new();
            let mut failed = false;
            for rs in &r.results {
                out.push_str(&format!("-- statement {}: {}\n", rs.index + 1, rs.statement.lines().next().unwrap_or("").chars().take(120).collect::<String>()));
                out.push_str(&table_text(rs, 120));
                failed |= rs.error.is_some();
            }
            out.push_str(&format!("({} ms)", r.duration_ms));
            if failed {
                Err(crate::agent::tools::truncate(out))
            } else {
                Ok(crate::agent::tools::truncate(out))
            }
        }
        other => Err(format!("Unknown database tool '{other}'")),
    }
}
