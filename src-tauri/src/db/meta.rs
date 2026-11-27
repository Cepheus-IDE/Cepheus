//! Catalog introspection per dialect: databases, schemas, objects (with row estimates), table
//! structure (columns, indexes, foreign keys in/out, checks, DDL) and a schema overview used by
//! the ER diagram, SQL completion and the agent's `db_schema` tool.

use super::engine::{Db, Param};
use super::safety::{qualified, quote_ident, tokenize, Dialect, Tok};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

type Map = HashMap<String, Value>;

fn s(m: &Map, k: &str) -> String {
    match m.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string(),
    }
}
fn os(m: &Map, k: &str) -> Option<String> {
    match m.get(k) {
        Some(Value::Null) | None => None,
        Some(Value::String(x)) => Some(x.clone()),
        Some(v) => Some(v.to_string()),
    }
}
fn b(m: &Map, k: &str) -> bool {
    match m.get(k) {
        Some(Value::Bool(x)) => *x,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::String(x)) => matches!(x.to_ascii_lowercase().as_str(), "t" | "true" | "1" | "yes" | "y"),
        _ => false,
    }
}
fn oi(m: &Map, k: &str) -> Option<i64> {
    match m.get(k) {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(Value::String(x)) => x.parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}
fn list(v: &str) -> Vec<String> {
    v.split(',').map(|x| x.trim().trim_matches('"').to_string()).filter(|x| !x.is_empty()).collect()
}
fn p(v: &str) -> Param {
    Param::Str(v.to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub name: String,
    /// table | view | materialized_view | foreign_table | sequence | function | procedure
    pub kind: String,
    pub rows: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub pk: bool,
    pub auto_increment: bool,
    pub comment: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub definition: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub from_schema: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_schema: String,
    pub to_table: String,
    pub to_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CheckInfo {
    pub name: String,
    pub definition: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKey>,
    pub referenced_by: Vec<ForeignKey>,
    pub checks: Vec<CheckInfo>,
    pub ddl: Option<String>,
}

impl TableInfo {
    pub fn pk(&self) -> Vec<&ColumnInfo> {
        self.columns.iter().filter(|c| c.pk).collect()
    }
    pub fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|c| c.name == name)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverviewColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub data_type: String,
    pub nullable: bool,
    pub pk: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OverviewTable {
    pub name: String,
    pub kind: String,
    pub columns: Vec<OverviewColumn>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SchemaOverview {
    pub schema: String,
    pub tables: Vec<OverviewTable>,
    pub foreign_keys: Vec<ForeignKey>,
}

fn pg_action(c: &str) -> String {
    match c {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .into()
}

fn fk_from(m: &Map, d: Dialect) -> ForeignKey {
    let act = |k: &str| {
        let v = s(m, k);
        if d == Dialect::Postgres { pg_action(&v) } else { v.replace('_', " ").to_uppercase() }
    };
    ForeignKey {
        name: s(m, "name"),
        from_schema: s(m, "from_schema"),
        from_table: s(m, "from_table"),
        from_columns: list(&s(m, "from_columns")),
        to_schema: s(m, "to_schema"),
        to_table: s(m, "to_table"),
        to_columns: list(&s(m, "to_columns")),
        on_update: act("on_update"),
        on_delete: act("on_delete"),
    }
}

// ---------------------------------------------------------------------------------------------
// databases / schemas / objects
// ---------------------------------------------------------------------------------------------

pub async fn list_databases(db: &Db, current: &str) -> Result<Vec<String>, String> {
    let sql = match db.dialect() {
        Dialect::Postgres => "SELECT datname AS name FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY 1",
        Dialect::MySql => "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY 1",
        Dialect::MsSql => "SELECT name FROM sys.databases WHERE state = 0 ORDER BY name",
        Dialect::Sqlite => return Ok(vec![if current.is_empty() { "main".into() } else { current.to_string() }]),
    };
    Ok(db.fetch_maps(sql, &[]).await?.iter().map(|m| s(m, "name")).collect())
}

pub async fn list_schemas(db: &Db, database: &str) -> Result<Vec<String>, String> {
    match db.dialect() {
        Dialect::Postgres => Ok(db
            .fetch_maps("SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY (nspname <> 'public'), 1", &[])
            .await?
            .iter()
            .map(|m| s(m, "name"))
            .collect()),
        Dialect::MySql => {
            if !database.is_empty() {
                return Ok(vec![database.to_string()]);
            }
            let r = db.fetch_maps("SELECT DATABASE() AS name", &[]).await?;
            Ok(r.iter().map(|m| s(m, "name")).filter(|x| !x.is_empty()).collect())
        }
        Dialect::Sqlite => Ok(db
            .fetch_maps("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq", &[])
            .await?
            .iter()
            .map(|m| s(m, "name"))
            .collect()),
        Dialect::MsSql => Ok(db
            .fetch_maps("SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND name NOT LIKE 'db[_]%' ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name", &[])
            .await?
            .iter()
            .map(|m| s(m, "name"))
            .collect()),
    }
}

pub async fn list_objects(db: &Db, schema: &str) -> Result<Vec<DbObject>, String> {
    let d = db.dialect();
    let mut out = Vec::new();
    match d {
        Dialect::Postgres => {
            for m in db
                .fetch_maps(
                    "SELECT c.relname AS name, c.relkind::text AS kind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows, \
                     obj_description(c.oid, 'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','S','f') ORDER BY 1",
                    &[p(schema)],
                )
                .await?
            {
                let kind = match s(&m, "kind").as_str() {
                    "v" => "view",
                    "m" => "materialized_view",
                    "S" => "sequence",
                    "f" => "foreign_table",
                    _ => "table",
                };
                out.push(DbObject { name: s(&m, "name"), kind: kind.into(), rows: oi(&m, "rows"), comment: os(&m, "comment") });
            }
            if let Ok(rows) = db
                .fetch_maps(
                    "SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name, \
                     CASE WHEN p.prokind = 'p' THEN 'procedure' ELSE 'function' END AS kind \
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY 1",
                    &[p(schema)],
                )
                .await
            {
                out.extend(rows.iter().map(|m| DbObject { name: s(m, "name"), kind: s(m, "kind"), rows: None, comment: None }));
            }
        }
        Dialect::MySql => {
            for m in db
                .fetch_maps(
                    "SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, TABLE_ROWS AS `rows`, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
                    &[p(schema)],
                )
                .await?
            {
                let kind = if s(&m, "kind").contains("VIEW") { "view" } else { "table" };
                out.push(DbObject { name: s(&m, "name"), kind: kind.into(), rows: oi(&m, "rows"), comment: os(&m, "comment").filter(|c| !c.is_empty()) });
            }
            if let Ok(rows) = db
                .fetch_maps("SELECT ROUTINE_NAME AS name, LOWER(ROUTINE_TYPE) AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME", &[p(schema)])
                .await
            {
                out.extend(rows.iter().map(|m| DbObject { name: s(m, "name"), kind: s(m, "kind"), rows: None, comment: None }));
            }
        }
        Dialect::Sqlite => {
            let sql = format!(
                "SELECT name, type AS kind FROM {}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
                quote_ident(d, schema)
            );
            for m in db.fetch_maps(&sql, &[]).await? {
                out.push(DbObject { name: s(&m, "name"), kind: s(&m, "kind"), rows: None, comment: None });
            }
            // Row estimates when ANALYZE has run (sqlite_stat1), otherwise none.
            let stat = format!("SELECT tbl, stat FROM {}.sqlite_stat1 WHERE idx IS NULL OR idx = tbl", quote_ident(d, schema));
            if let Ok(rows) = db.fetch_maps(&stat, &[]).await {
                for m in rows {
                    let n = s(&m, "stat").split_whitespace().next().and_then(|x| x.parse::<i64>().ok());
                    if let Some(o) = out.iter_mut().find(|o| o.name == s(&m, "tbl")) {
                        o.rows = n;
                    }
                }
            }
        }
        Dialect::MsSql => {
            for m in db
                .fetch_maps(
                    "SELECT o.name, RTRIM(o.type) AS kind, (SELECT SUM(pa.rows) FROM sys.partitions pa WHERE pa.object_id = o.object_id AND pa.index_id IN (0,1)) AS [rows], \
                     CAST(ep.value AS nvarchar(4000)) AS comment \
                     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id \
                     LEFT JOIN sys.extended_properties ep ON ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' \
                     WHERE s.name = @P1 AND o.type IN ('U','V','P','FN','IF','TF','SO') AND o.is_ms_shipped = 0 ORDER BY o.name",
                    &[p(schema)],
                )
                .await?
            {
                let kind = match s(&m, "kind").as_str() {
                    "U" => "table",
                    "V" => "view",
                    "P" => "procedure",
                    "SO" => "sequence",
                    _ => "function",
                };
                out.push(DbObject { name: s(&m, "name"), kind: kind.into(), rows: oi(&m, "rows"), comment: os(&m, "comment") });
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// describe table
// ---------------------------------------------------------------------------------------------

pub async fn describe_table(db: &Db, schema: &str, table: &str) -> Result<TableInfo, String> {
    let d = db.dialect();
    let mut t = TableInfo {
        schema: schema.to_string(),
        name: table.to_string(),
        kind: "table".into(),
        columns: vec![],
        indexes: vec![],
        foreign_keys: vec![],
        referenced_by: vec![],
        checks: vec![],
        ddl: None,
    };
    match d {
        // One boxed future per dialect keeps each poll frame small (debug builds otherwise need
        // several MB of stack for this function).
        Dialect::Postgres => Box::pin(describe_pg(db, schema, table, &mut t)).await?,
        Dialect::MySql => Box::pin(describe_my(db, schema, table, &mut t)).await?,
        Dialect::Sqlite => Box::pin(describe_lite(db, schema, table, &mut t)).await?,
        Dialect::MsSql => Box::pin(describe_ms(db, schema, table, &mut t)).await?,
    }
    Ok(t)
}

async fn describe_pg(db: &Db, schema: &str, table: &str, t: &mut TableInfo) -> Result<(), String> {
    let d = Dialect::Postgres;
    let cols = db
        .fetch_maps(
            "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, \
             pg_get_expr(ad.adbin, ad.adrelid) AS dflt, col_description(c.oid, a.attnum) AS comment, a.attidentity::text AS ident, \
             coalesce((SELECT true FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) AS pk, \
             c.relkind::text AS relkind \
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            &[p(schema), p(table)],
        )
        .await?;
    if cols.is_empty() {
        return Err(format!("Table {schema}.{table} was not found"));
    }
    t.kind = match s(&cols[0], "relkind").as_str() {
        "v" => "view",
        "m" => "materialized_view",
        _ => "table",
    }
    .into();
    for m in &cols {
        let dflt = os(m, "dflt");
        let ident = s(m, "ident");
        t.columns.push(ColumnInfo {
            name: s(m, "name"),
            data_type: s(m, "type"),
            nullable: b(m, "nullable"),
            auto_increment: !ident.trim().is_empty() || dflt.as_deref().map(|x| x.starts_with("nextval(")).unwrap_or(false),
            default: dflt,
            pk: b(m, "pk"),
            comment: os(m, "comment"),
        });
    }
    for m in db
        .fetch_maps(
            "SELECT ic.relname AS name, i.indisunique AS uniq, i.indisprimary AS prim, pg_get_indexdef(i.indexrelid) AS def, \
             array_to_string(ARRAY(SELECT pg_get_indexdef(i.indexrelid, k + 1, true) FROM generate_subscripts(i.indkey, 1) k ORDER BY k), ',') AS columns \
             FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 ORDER BY i.indisprimary DESC, 1",
            &[p(schema), p(table)],
        )
        .await?
    {
        t.indexes.push(IndexInfo { name: s(&m, "name"), columns: list(&s(&m, "columns")), unique: b(&m, "uniq"), primary: b(&m, "prim"), definition: os(&m, "def") });
    }
    for m in db.fetch_maps(&pg_fk_sql(true), &[p(schema), p(table)]).await? {
        let fk = fk_from(&m, d);
        if fk.from_schema == schema && fk.from_table == table {
            t.foreign_keys.push(fk.clone());
        }
        if fk.to_schema == schema && fk.to_table == table {
            t.referenced_by.push(fk);
        }
    }
    for m in db
        .fetch_maps(
            "SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE con.contype = 'c' AND n.nspname = $1 AND c.relname = $2 ORDER BY 1",
            &[p(schema), p(table)],
        )
        .await?
    {
        t.checks.push(CheckInfo { name: s(&m, "name"), definition: s(&m, "def") });
    }
    if t.kind == "table" {
        let cons = db
            .fetch_maps(
                "SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 \
                 ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END, 1",
                &[p(schema), p(table)],
            )
            .await
            .unwrap_or_default();
        t.ddl = Some(generated_ddl(d, &t, &cons.iter().map(|m| (s(m, "name"), s(m, "def"))).collect::<Vec<_>>()));
    } else {
        let v = db
            .fetch_maps(
                "SELECT pg_get_viewdef(c.oid, true) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2",
                &[p(schema), p(table)],
            )
            .await?;
        let kw = if t.kind == "materialized_view" { "MATERIALIZED VIEW" } else { "VIEW" };
        t.ddl = v.first().map(|m| format!("CREATE {kw} {} AS\n{}", qualified(d, schema, table), s(m, "def")));
    }
    Ok(())
}

async fn describe_my(db: &Db, schema: &str, table: &str, t: &mut TableInfo) -> Result<(), String> {
    let d = Dialect::MySql;
    let cols = db
        .fetch_maps(
            "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment \
             FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
            &[p(schema), p(table)],
        )
        .await?;
    if cols.is_empty() {
        return Err(format!("Table {schema}.{table} was not found"));
    }
    for m in &cols {
        t.columns.push(ColumnInfo {
            name: s(m, "name"),
            data_type: s(m, "type"),
            nullable: s(m, "nullable") == "YES",
            default: os(m, "dflt"),
            pk: s(m, "ckey") == "PRI",
            auto_increment: s(m, "extra").to_lowercase().contains("auto_increment"),
            comment: os(m, "comment").filter(|c| !c.is_empty()),
        });
    }
    let kind = db.fetch_maps("SELECT TABLE_TYPE AS kind FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", &[p(schema), p(table)]).await?;
    if kind.first().map(|m| s(m, "kind").contains("VIEW")).unwrap_or(false) {
        t.kind = "view".into();
    }
    for m in db
        .fetch_maps(
            "SELECT INDEX_NAME AS name, MIN(NON_UNIQUE) AS non_unique, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns \
             FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME",
            &[p(schema), p(table)],
        )
        .await?
    {
        let name = s(&m, "name");
        t.indexes.push(IndexInfo { primary: name == "PRIMARY", unique: !b(&m, "non_unique"), columns: list(&s(&m, "columns")), name, definition: None });
    }
    for m in db.fetch_maps(&my_fk_sql(true), &[p(schema), p(table), p(schema), p(table)]).await? {
        let fk = fk_from(&m, d);
        if fk.from_schema == schema && fk.from_table == table {
            t.foreign_keys.push(fk.clone());
        }
        if fk.to_schema == schema && fk.to_table == table {
            t.referenced_by.push(fk);
        }
    }
    if let Ok(rows) = db
        .fetch_maps(
            "SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS def FROM information_schema.CHECK_CONSTRAINTS cc \
             JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME \
             WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'",
            &[p(schema), p(table)],
        )
        .await
    {
        t.checks = rows.iter().map(|m| CheckInfo { name: s(m, "name"), definition: s(m, "def") }).collect();
    }
    // SHOW CREATE through the statement runner (text protocol).
    let mut ddl = None;
    let stmt = format!("SHOW CREATE {} {}", if t.kind == "view" { "VIEW" } else { "TABLE" }, qualified(d, schema, table));
    let _ = db
        .run_statements(&[stmt], None, &mut |_, ev| {
            if let super::engine::Ev::Row(r) = ev {
                ddl = r.get(1).and_then(|v| v.as_str().map(String::from));
            }
            Ok(true)
        })
        .await;
    t.ddl = ddl;
    Ok(())
}

async fn describe_lite(db: &Db, schema: &str, table: &str, t: &mut TableInfo) -> Result<(), String> {
    let d = Dialect::Sqlite;
    let qs = quote_ident(d, schema);
    let master = db
        .fetch_maps(&format!("SELECT type, sql FROM {qs}.sqlite_master WHERE name = ?1"), &[p(table)])
        .await?;
    let Some(mm) = master.first() else { return Err(format!("Table {table} was not found")) };
    t.kind = s(mm, "type");
    let create_sql = s(mm, "sql");
    let cols = db.fetch_maps("SELECT * FROM pragma_table_xinfo(?1, ?2) WHERE hidden IN (0, 2, 3)", &[p(table), p(schema)]).await?;
    let pk_count = cols.iter().filter(|m| oi(m, "pk").unwrap_or(0) > 0).count();
    let has_autoinc = tokenize(&create_sql, d).iter().any(|x| x.tok.is_word("AUTOINCREMENT"));
    let mut pk_cols: Vec<(i64, String)> = Vec::new();
    for m in &cols {
        let pk = oi(m, "pk").unwrap_or(0);
        let ty = s(m, "type");
        if pk > 0 {
            pk_cols.push((pk, s(m, "name")));
        }
        t.columns.push(ColumnInfo {
            name: s(m, "name"),
            nullable: !b(m, "notnull") && pk == 0,
            default: os(m, "dflt_value"),
            pk: pk > 0,
            auto_increment: pk > 0 && pk_count == 1 && (ty.eq_ignore_ascii_case("INTEGER") || has_autoinc),
            data_type: ty,
            comment: None,
        });
    }
    if cols.is_empty() {
        return Err(format!("Table {table} has no columns"));
    }
    let mut ddl = create_sql.clone();
    let idx = db.fetch_maps("SELECT * FROM pragma_index_list(?1, ?2)", &[p(table), p(schema)]).await?;
    for m in idx {
        let name = s(&m, "name");
        let icols = db.fetch_maps("SELECT name FROM pragma_index_info(?1, ?2) ORDER BY seqno", &[p(&name), p(schema)]).await.unwrap_or_default();
        t.indexes.push(IndexInfo {
            primary: s(&m, "origin") == "pk",
            unique: b(&m, "unique"),
            columns: icols.iter().map(|c| s(c, "name")).collect(),
            definition: None,
            name,
        });
    }
    if !pk_cols.is_empty() && !t.indexes.iter().any(|i| i.primary) {
        pk_cols.sort();
        t.indexes.insert(0, IndexInfo { name: "PRIMARY KEY".into(), columns: pk_cols.into_iter().map(|x| x.1).collect(), unique: true, primary: true, definition: None });
    }
    for m in db.fetch_maps(&format!("SELECT sql FROM {qs}.sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL"), &[p(table)]).await? {
        let sql = s(&m, "sql");
        for i in t.indexes.iter_mut() {
            if sql.contains(&i.name) {
                i.definition = Some(sql.clone());
            }
        }
        ddl.push_str(";\n");
        ddl.push_str(&sql);
    }
    ddl.push(';');
    t.ddl = Some(ddl);
    let all = sqlite_fks(db, schema).await?;
    for fk in all {
        if fk.from_table == table {
            t.foreign_keys.push(fk.clone());
        }
        if fk.to_table == table {
            t.referenced_by.push(fk);
        }
    }
    t.checks = sqlite_checks(&create_sql);
    Ok(())
}

async fn describe_ms(db: &Db, schema: &str, table: &str, t: &mut TableInfo) -> Result<(), String> {
    let d = Dialect::MsSql;
    let cols = db
        .fetch_maps(
            "SELECT c.name, TYPE_NAME(c.user_type_id) + CASE \
               WHEN TYPE_NAME(c.user_type_id) IN ('varchar','char','varbinary','binary') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')' \
               WHEN TYPE_NAME(c.user_type_id) IN ('nvarchar','nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')' \
               WHEN TYPE_NAME(c.user_type_id) IN ('decimal','numeric') THEN '(' + CAST(c.precision AS varchar(5)) + ',' + CAST(c.scale AS varchar(5)) + ')' \
               WHEN TYPE_NAME(c.user_type_id) IN ('datetime2','time','datetimeoffset') THEN '(' + CAST(c.scale AS varchar(5)) + ')' \
               ELSE '' END AS type, \
             c.is_nullable AS nullable, dc.definition AS dflt, c.is_identity AS auto, \
             CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk, \
             CAST(ep.value AS nvarchar(4000)) AS comment, o.type AS otype \
             FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id \
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
             LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' \
             WHERE s.name = @P1 AND o.name = @P2 ORDER BY c.column_id",
            &[p(schema), p(table)],
        )
        .await?;
    if cols.is_empty() {
        return Err(format!("Table {schema}.{table} was not found"));
    }
    if s(&cols[0], "otype").trim() == "V" {
        t.kind = "view".into();
    }
    for m in &cols {
        t.columns.push(ColumnInfo {
            name: s(m, "name"),
            data_type: s(m, "type"),
            nullable: b(m, "nullable"),
            default: os(m, "dflt"),
            pk: b(m, "pk"),
            auto_increment: b(m, "auto"),
            comment: os(m, "comment"),
        });
    }
    for m in db
        .fetch_maps(
            "SELECT i.name, i.is_unique AS uniq, i.is_primary_key AS prim, STUFF((SELECT ',' + c.name FROM sys.index_columns ic \
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 ORDER BY ic.key_ordinal FOR XML PATH('')), 1, 1, '') AS columns \
             FROM sys.indexes i JOIN sys.objects o ON o.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.name = @P2 AND i.name IS NOT NULL ORDER BY i.is_primary_key DESC, i.name",
            &[p(schema), p(table)],
        )
        .await?
    {
        t.indexes.push(IndexInfo { name: s(&m, "name"), columns: list(&s(&m, "columns")), unique: b(&m, "uniq"), primary: b(&m, "prim"), definition: None });
    }
    for m in db.fetch_maps(&ms_fk_sql(true), &[p(schema), p(table)]).await? {
        let fk = fk_from(&m, d);
        if fk.from_schema == schema && fk.from_table == table {
            t.foreign_keys.push(fk.clone());
        }
        if fk.to_schema == schema && fk.to_table == table {
            t.referenced_by.push(fk);
        }
    }
    for m in db
        .fetch_maps(
            "SELECT cc.name, cc.definition AS def FROM sys.check_constraints cc JOIN sys.objects o ON o.object_id = cc.parent_object_id \
             JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @P1 AND o.name = @P2",
            &[p(schema), p(table)],
        )
        .await?
    {
        t.checks.push(CheckInfo { name: s(&m, "name"), definition: s(&m, "def") });
    }
    if t.kind == "view" {
        let v = db.fetch_maps("SELECT OBJECT_DEFINITION(OBJECT_ID(@P1)) AS def", &[p(&qualified(d, schema, table))]).await?;
        t.ddl = v.first().and_then(|m| os(m, "def"));
    } else {
        let mut cons: Vec<(String, String)> = Vec::new();
        for i in t.indexes.iter().filter(|i| i.primary) {
            cons.push((i.name.clone(), format!("PRIMARY KEY ({})", i.columns.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", "))));
        }
        for fk in &t.foreign_keys {
            cons.push((fk.name.clone(), fk_def(d, fk)));
        }
        for c in &t.checks {
            cons.push((c.name.clone(), format!("CHECK {}", c.definition)));
        }
        t.ddl = Some(generated_ddl(d, &t, &cons));
    }
    Ok(())
}

pub fn fk_def(d: Dialect, fk: &ForeignKey) -> String {
    let cols = |v: &[String]| v.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", ");
    let mut s = format!(
        "FOREIGN KEY ({}) REFERENCES {} ({})",
        cols(&fk.from_columns),
        qualified(d, if d == Dialect::Sqlite { "" } else { &fk.to_schema }, &fk.to_table),
        cols(&fk.to_columns)
    );
    if !fk.on_update.is_empty() && fk.on_update != "NO ACTION" {
        s.push_str(&format!(" ON UPDATE {}", fk.on_update));
    }
    if !fk.on_delete.is_empty() && fk.on_delete != "NO ACTION" {
        s.push_str(&format!(" ON DELETE {}", fk.on_delete));
    }
    s
}

/// CREATE TABLE text for dialects without a built-in (Postgres, SQL Server).
fn generated_ddl(d: Dialect, t: &TableInfo, constraints: &[(String, String)]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for c in &t.columns {
        let mut l = format!("  {} {}", quote_ident(d, &c.name), c.data_type);
        if c.auto_increment && d == Dialect::MsSql {
            l.push_str(" IDENTITY(1,1)");
        }
        if c.auto_increment && d == Dialect::Postgres && c.default.is_none() {
            l.push_str(" GENERATED BY DEFAULT AS IDENTITY");
        }
        if !c.nullable {
            l.push_str(" NOT NULL");
        }
        if let Some(df) = &c.default {
            l.push_str(&format!(" DEFAULT {df}"));
        }
        lines.push(l);
    }
    for (name, def) in constraints {
        lines.push(format!("  CONSTRAINT {} {}", quote_ident(d, name), def));
    }
    let mut out = format!("CREATE TABLE {} (\n{}\n);", qualified(d, &t.schema, &t.name), lines.join(",\n"));
    for i in &t.indexes {
        if i.primary {
            continue;
        }
        if let Some(def) = &i.definition {
            // Postgres: skip indexes that back UNIQUE constraints (already in the table body).
            if constraints.iter().any(|(n, _)| n == &i.name) {
                continue;
            }
            out.push_str(&format!("\n{def};"));
        } else if d == Dialect::MsSql {
            if constraints.iter().any(|(n, _)| n == &i.name) {
                continue;
            }
            out.push_str(&format!(
                "\nCREATE {}INDEX {} ON {} ({});",
                if i.unique { "UNIQUE " } else { "" },
                quote_ident(d, &i.name),
                qualified(d, &t.schema, &t.name),
                i.columns.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", ")
            ));
        }
    }
    if d == Dialect::Postgres {
        for c in &t.columns {
            if let Some(cm) = &c.comment {
                out.push_str(&format!(
                    "\nCOMMENT ON COLUMN {}.{} IS {};",
                    qualified(d, &t.schema, &t.name),
                    quote_ident(d, &c.name),
                    super::safety::quote_literal(d, cm)
                ));
            }
        }
    }
    out
}

/// CHECK (...) clauses from a SQLite CREATE TABLE statement.
pub fn sqlite_checks(create_sql: &str) -> Vec<CheckInfo> {
    let toks = tokenize(create_sql, Dialect::Sqlite);
    let mut out = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        if toks[i].tok.is_word("CHECK") && matches!(toks.get(i + 1).map(|t| &t.tok), Some(Tok::Punct('('))) {
            let name = if i >= 2 && toks[i - 2].tok.is_word("CONSTRAINT") {
                match &toks[i - 1].tok {
                    Tok::Word(w) | Tok::Ident(w) => w.clone(),
                    _ => String::new(),
                }
            } else {
                String::new()
            };
            let start = toks[i + 1].start;
            let mut depth = 0;
            let mut j = i + 1;
            while j < toks.len() {
                match toks[j].tok {
                    Tok::Punct('(') => depth += 1,
                    Tok::Punct(')') => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            let end = toks.get(j).map(|t| t.end).unwrap_or(create_sql.len());
            out.push(CheckInfo { name: if name.is_empty() { format!("check_{}", out.len() + 1) } else { name }, definition: create_sql[start..end].to_string() });
            i = j;
        }
        i += 1;
    }
    out
}

async fn sqlite_fks(db: &Db, schema: &str) -> Result<Vec<ForeignKey>, String> {
    let qs = quote_ident(Dialect::Sqlite, schema);
    let rows = db
        .fetch_maps(
            &format!("SELECT m.name AS tbl, f.* FROM {qs}.sqlite_master m JOIN pragma_foreign_key_list(m.name, ?1) f WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq"),
            &[p(schema)],
        )
        .await?;
    let mut grouped: BTreeMap<(String, i64), ForeignKey> = BTreeMap::new();
    for m in rows {
        let key = (s(&m, "tbl"), oi(&m, "id").unwrap_or(0));
        let e = grouped.entry(key.clone()).or_insert_with(|| ForeignKey {
            name: format!("fk_{}_{}", key.0, key.1),
            from_schema: schema.to_string(),
            from_table: key.0.clone(),
            from_columns: vec![],
            to_schema: schema.to_string(),
            to_table: s(&m, "table"),
            to_columns: vec![],
            on_update: s(&m, "on_update"),
            on_delete: s(&m, "on_delete"),
        });
        e.from_columns.push(s(&m, "from"));
        if let Some(to) = os(&m, "to") {
            e.to_columns.push(to);
        }
    }
    let mut out: Vec<ForeignKey> = grouped.into_values().collect();
    // `REFERENCES t` without columns points at t's primary key.
    for fk in out.iter_mut() {
        if fk.to_columns.is_empty() {
            if let Ok(pk) = db.fetch_maps("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk", &[p(&fk.to_table), p(schema)]).await {
                fk.to_columns = pk.iter().map(|m| s(m, "name")).collect();
            }
        }
    }
    Ok(out)
}

fn pg_fk_sql(for_table: bool) -> String {
    let filter = if for_table {
        "((n1.nspname = $1 AND c1.relname = $2) OR (n2.nspname = $1 AND c2.relname = $2))"
    } else {
        "n1.nspname = $1"
    };
    format!(
        "SELECT con.conname AS name, n1.nspname AS from_schema, c1.relname AS from_table, \
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(con.conkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = x.attnum) AS from_columns, \
         n2.nspname AS to_schema, c2.relname AS to_table, \
         (SELECT string_agg(a.attname, ',' ORDER BY x.ord) FROM unnest(con.confkey) WITH ORDINALITY x(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = x.attnum) AS to_columns, \
         con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete \
         FROM pg_constraint con JOIN pg_class c1 ON c1.oid = con.conrelid JOIN pg_namespace n1 ON n1.oid = c1.relnamespace \
         JOIN pg_class c2 ON c2.oid = con.confrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace \
         WHERE con.contype = 'f' AND {filter} ORDER BY 1"
    )
}

fn my_fk_sql(for_table: bool) -> String {
    let filter = if for_table {
        "((k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?) OR (k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?))"
    } else {
        "k.TABLE_SCHEMA = ?"
    };
    format!(
        "SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS from_schema, k.TABLE_NAME AS from_table, \
         GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',') AS from_columns, \
         k.REFERENCED_TABLE_SCHEMA AS to_schema, k.REFERENCED_TABLE_NAME AS to_table, \
         GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ',') AS to_columns, \
         r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete \
         FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME \
         WHERE k.REFERENCED_TABLE_NAME IS NOT NULL AND {filter} \
         GROUP BY k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, r.UPDATE_RULE, r.DELETE_RULE ORDER BY 1"
    )
}

fn ms_fk_sql(for_table: bool) -> String {
    let filter = if for_table {
        "((SCHEMA_NAME(tp.schema_id) = @P1 AND tp.name = @P2) OR (SCHEMA_NAME(tr.schema_id) = @P1 AND tr.name = @P2))"
    } else {
        "SCHEMA_NAME(tp.schema_id) = @P1"
    };
    format!(
        "SELECT fk.name, SCHEMA_NAME(tp.schema_id) AS from_schema, tp.name AS from_table, \
         STUFF((SELECT ',' + c.name FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id \
           WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 1, '') AS from_columns, \
         SCHEMA_NAME(tr.schema_id) AS to_schema, tr.name AS to_table, \
         STUFF((SELECT ',' + c.name FROM sys.foreign_key_columns fkc JOIN sys.columns c ON c.object_id = fkc.referenced_object_id AND c.column_id = fkc.referenced_column_id \
           WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id FOR XML PATH('')), 1, 1, '') AS to_columns, \
         fk.update_referential_action_desc AS on_update, fk.delete_referential_action_desc AS on_delete \
         FROM sys.foreign_keys fk JOIN sys.tables tp ON tp.object_id = fk.parent_object_id JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id \
         WHERE {filter} ORDER BY fk.name"
    )
}

// ---------------------------------------------------------------------------------------------
// schema overview
// ---------------------------------------------------------------------------------------------

pub async fn schema_overview(db: &Db, schema: &str) -> Result<SchemaOverview, String> {
    let d = db.dialect();
    let (sql, params, fk_sql, fk_params): (String, Vec<Param>, Option<String>, Vec<Param>) = match d {
        Dialect::Postgres => (
            "SELECT c.relname AS tbl, c.relkind::text AS kind, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, \
             coalesce((SELECT true FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)), false) AS pk \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid \
             WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum"
                .into(),
            vec![p(schema)],
            Some(pg_fk_sql(false)),
            vec![p(schema)],
        ),
        Dialect::MySql => (
            "SELECT c.TABLE_NAME AS tbl, t.TABLE_TYPE AS kind, c.COLUMN_NAME AS name, c.COLUMN_TYPE AS type, c.IS_NULLABLE = 'YES' AS nullable, c.COLUMN_KEY = 'PRI' AS pk \
             FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME \
             WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION"
                .into(),
            vec![p(schema)],
            Some(my_fk_sql(false)),
            vec![p(schema)],
        ),
        Dialect::Sqlite => (
            format!(
                "SELECT m.name AS tbl, m.type AS kind, c.name AS name, c.type AS type, NOT c.\"notnull\" AND c.pk = 0 AS nullable, c.pk > 0 AS pk \
                 FROM {}.sqlite_master m JOIN pragma_table_info(m.name, ?1) c WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, c.cid",
                quote_ident(d, schema)
            ),
            vec![p(schema)],
            None,
            vec![],
        ),
        Dialect::MsSql => (
            "SELECT o.name AS tbl, RTRIM(o.type) AS kind, c.name, TYPE_NAME(c.user_type_id) AS type, c.is_nullable AS nullable, \
             CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
               WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk \
             FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name, c.column_id"
                .into(),
            vec![p(schema)],
            Some(ms_fk_sql(false)),
            vec![p(schema)],
        ),
    };
    let rows = db.fetch_maps(&sql, &params).await?;
    let mut tables: Vec<OverviewTable> = Vec::new();
    for m in rows {
        let tbl = s(&m, "tbl");
        if tables.last().map(|t| t.name != tbl).unwrap_or(true) {
            let k = s(&m, "kind");
            let kind = match k.as_str() {
                "v" | "VIEW" | "SYSTEM VIEW" | "V" | "view" => "view",
                "m" => "materialized_view",
                _ => "table",
            };
            tables.push(OverviewTable { name: tbl.clone(), kind: kind.into(), columns: vec![] });
        }
        tables.last_mut().unwrap().columns.push(OverviewColumn { name: s(&m, "name"), data_type: s(&m, "type"), nullable: b(&m, "nullable"), pk: b(&m, "pk") });
    }
    let foreign_keys = match fk_sql {
        Some(q) => db.fetch_maps(&q, &fk_params).await?.iter().map(|m| fk_from(m, d)).collect(),
        None => sqlite_fks(db, schema).await?,
    };
    Ok(SchemaOverview { schema: schema.to_string(), tables, foreign_keys })
}

/// Compact text form for the agent.
pub fn overview_text(o: &SchemaOverview, d: Dialect) -> String {
    let mut out = format!("Schema {} ({:?}): {} tables/views\n", o.schema, d, o.tables.len());
    for t in &o.tables {
        let cols: Vec<String> = t
            .columns
            .iter()
            .map(|c| format!("{}{} {}{}", if c.pk { "*" } else { "" }, c.name, c.data_type, if c.nullable { "" } else { " NOT NULL" }))
            .collect();
        out.push_str(&format!("{}{}({})\n", t.name, if t.kind != "table" { format!(" [{}]", t.kind) } else { String::new() }, cols.join(", ")));
    }
    if !o.foreign_keys.is_empty() {
        out.push_str("Foreign keys:\n");
        for f in &o.foreign_keys {
            out.push_str(&format!(
                "{}({}) -> {}({}){}\n",
                f.from_table,
                f.from_columns.join(","),
                f.to_table,
                f.to_columns.join(","),
                if f.on_delete.is_empty() || f.on_delete == "NO ACTION" { String::new() } else { format!(" ON DELETE {}", f.on_delete) }
            ));
        }
    }
    out.push_str("(* = primary key)");
    out
}
