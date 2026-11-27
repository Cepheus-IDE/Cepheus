//! Higher-level database operations built on `engine` + `meta`: script execution with result
//! sets and paging, EXPLAIN, table paging with server-built filters, batched row edits, export,
//! CSV import. All identifiers are quoted per dialect and all values are bound parameters.

use super::engine::{Column, Db, Ev, Param, SqlBuf};
use super::meta::{self, ColumnInfo, TableInfo};
use super::safety::{self, qualified, quote_ident, quote_literal, Dialect};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::io::Write;
use std::time::Instant;

pub const DEFAULT_LIMIT: usize = 1000;
pub const MAX_LIMIT: usize = 100_000;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub index: usize,
    pub statement: String,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: Option<u64>,
    pub has_more: bool,
    pub offset: usize,
    pub duration_ms: u64,
    pub error: Option<String>,
    /// SELECT-like statement (the UI shows a grid even with zero rows).
    pub returns_rows: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub results: Vec<ResultSet>,
    pub duration_ms: u64,
    pub cancelled: bool,
}

pub struct Guard {
    pub production: bool,
    pub read_only: bool,
    pub confirmed: bool,
}

/// Runs a script. Errors stop the script; earlier result sets are kept and the failing statement
/// is returned as a result with `error`. Safety-guard refusals are returned as `Err`.
pub async fn run_query(db: &Db, sql: &str, limit: usize, offset: usize, query_id: Option<&str>, g: &Guard) -> Result<QueryResponse, String> {
    let d = db.dialect();
    let stmts = safety::split_statements(sql, d);
    if stmts.is_empty() {
        return Err("Nothing to run".into());
    }
    safety::guard(&stmts, d, g.production, g.read_only, g.confirmed)?;
    if offset > 0 && (stmts.len() != 1 || safety::classify(&stmts[0].sql, d).kind != safety::Kind::Read) {
        return Err("Fetching more rows is only possible for a single read-only statement".into());
    }
    let limit = limit.clamp(1, MAX_LIMIT);
    let texts: Vec<String> = stmts.iter().map(|s| s.sql.clone()).collect();
    let started = Instant::now();
    let mut results: Vec<ResultSet> = Vec::new();
    let mut cur: Option<ResultSet> = None;
    let mut skipped = 0usize;
    let mut stmt_started = Instant::now();
    let mut stmt_index = 0usize;
    let mut done_stmts = 0usize;
    let returns_rows = |s: &str| {
        let c = safety::classify(s, d);
        c.kind == safety::Kind::Read && !matches!(c.verb.as_str(), "USE")
    };
    let r = db
        .run_statements(&texts, query_id, &mut |i, ev| {
            if i != stmt_index {
                stmt_index = i;
                stmt_started = Instant::now();
                skipped = 0;
            }
            let fresh = |cols: Vec<Column>| ResultSet {
                index: i,
                statement: texts[i].clone(),
                columns: cols,
                offset,
                returns_rows: returns_rows(&texts[i]),
                ..Default::default()
            };
            match ev {
                Ev::Columns(c) => {
                    if let Some(prev) = cur.take() {
                        results.push(prev);
                    }
                    cur = Some(fresh(c));
                    skipped = 0;
                }
                Ev::Row(row) => {
                    let rs = cur.get_or_insert_with(|| fresh(vec![]));
                    if skipped < offset {
                        skipped += 1;
                        return Ok(true);
                    }
                    if rs.rows.len() >= limit {
                        rs.has_more = true;
                        return Ok(false);
                    }
                    rs.rows.push(row);
                }
                Ev::Done(n) if n == u64::MAX => {
                    done_stmts = i + 1;
                    let mut rs = cur.take().unwrap_or_else(|| fresh(vec![]));
                    rs.duration_ms = stmt_started.elapsed().as_millis() as u64;
                    // A statement that already produced a result and then only a trailing "done"
                    // (e.g. MySQL CALL) does not need an empty extra result.
                    let empty_tail = rs.columns.is_empty() && rs.rows.is_empty() && rs.rows_affected.is_none() && results.last().map(|x| x.index == i).unwrap_or(false);
                    if !empty_tail {
                        results.push(rs);
                    }
                }
                Ev::Done(n) => {
                    let rs = cur.get_or_insert_with(|| fresh(vec![]));
                    rs.rows_affected = Some(rs.rows_affected.unwrap_or(0) + n);
                }
            }
            Ok(true)
        })
        .await;
    if let Err(e) = r {
        let i = done_stmts.min(texts.len() - 1);
        if let Some(prev) = cur.take() {
            if prev.index != i || !prev.rows.is_empty() {
                results.push(prev);
            }
        }
        results.push(ResultSet {
            index: i,
            statement: texts[i].clone(),
            error: Some(e),
            duration_ms: stmt_started.elapsed().as_millis() as u64,
            offset,
            ..Default::default()
        });
    }
    Ok(QueryResponse { results, duration_ms: started.elapsed().as_millis() as u64, cancelled: false })
}

/// EXPLAIN for the dialect. `analyze` only applies to read-only statements.
pub async fn explain(db: &Db, sql: &str, analyze: bool) -> Result<ResultSet, String> {
    let d = db.dialect();
    let stmts = safety::split_statements(sql, d);
    let stmt = stmts.first().ok_or("Nothing to explain")?.sql.clone();
    let read = safety::classify(&stmt, d).kind == safety::Kind::Read;
    let started = Instant::now();
    if d == Dialect::MsSql {
        let (columns, rows) = db.ms_showplan(&stmt).await?;
        return Ok(ResultSet { statement: stmt, columns, rows, returns_rows: true, duration_ms: started.elapsed().as_millis() as u64, ..Default::default() });
    }
    let q = match d {
        Dialect::Postgres if analyze && read => format!("EXPLAIN (ANALYZE, BUFFERS) {stmt}"),
        Dialect::Postgres => format!("EXPLAIN {stmt}"),
        Dialect::MySql if analyze && read => format!("EXPLAIN ANALYZE {stmt}"),
        Dialect::MySql => format!("EXPLAIN {stmt}"),
        _ => format!("EXPLAIN QUERY PLAN {stmt}"),
    };
    let r = run_query(db, &q, 5000, 0, None, &Guard { production: false, read_only: false, confirmed: true }).await?;
    let mut rs = r.results.into_iter().next().unwrap_or_default();
    if let Some(e) = rs.error.take() {
        return Err(e);
    }
    rs.statement = q;
    Ok(rs)
}

// ---------------------------------------------------------------------------------------------
// table paging
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    #[serde(default)]
    pub desc: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    /// = <> < > <= >= like "not like" contains starts ends "is null" "is not null" in
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Value>>,
    pub total: Option<i64>,
    pub primary_key: Vec<String>,
    pub sql: String,
    pub kind: String,
}

fn col_type<'a>(t: &'a TableInfo, name: &str) -> Result<&'a ColumnInfo, String> {
    t.column(name).ok_or_else(|| format!("Unknown column '{name}' in {}", t.name))
}

fn text_cast(d: Dialect, col: &str) -> String {
    match d {
        Dialect::Postgres => format!("CAST({col} AS text)"),
        Dialect::MsSql => format!("CAST({col} AS nvarchar(max))"),
        _ => col.to_string(),
    }
}

/// Appends ` WHERE …` for the filters (nothing when empty).
pub fn build_where(buf: &mut SqlBuf, t: &TableInfo, filters: &[Filter]) -> Result<(), String> {
    let d = buf.d;
    let mut first = true;
    for f in filters {
        let c = col_type(t, &f.column)?;
        let qc = quote_ident(d, &c.name);
        let op = f.op.to_lowercase();
        buf.push(if first { " WHERE " } else { " AND " });
        first = false;
        let val = || Param::from_json(&f.value);
        let sval = || match &f.value {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        };
        match op.as_str() {
            "is null" => {
                buf.push(&format!("{qc} IS NULL"));
            }
            "is not null" => {
                buf.push(&format!("{qc} IS NOT NULL"));
            }
            "=" | "<>" | "!=" | "<" | ">" | "<=" | ">=" => {
                let o = if op == "!=" { "<>" } else { op.as_str() };
                buf.push(&format!("{qc} {o} "));
                buf.bind(val(), Some(&c.data_type));
            }
            "like" | "not like" | "contains" | "starts" | "ends" | "not contains" => {
                let pat = match op.as_str() {
                    "contains" | "not contains" => format!("%{}%", sval()),
                    "starts" => format!("{}%", sval()),
                    "ends" => format!("%{}", sval()),
                    _ => sval(),
                };
                let neg = op.starts_with("not");
                let like = if d == Dialect::Postgres && !neg && op != "like" { "ILIKE" } else { "LIKE" };
                buf.push(&format!("{} {}{} ", text_cast(d, &qc), if neg { "NOT " } else { "" }, like));
                buf.bind(Param::Str(pat), None);
            }
            "in" | "not in" => {
                let items: Vec<String> = match &f.value {
                    Value::Array(a) => a.iter().map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).collect(),
                    _ => sval().split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
                };
                if items.is_empty() {
                    buf.push(if op == "in" { "1 = 0" } else { "1 = 1" });
                    continue;
                }
                buf.push(&format!("{qc} {} (", if op == "in" { "IN" } else { "NOT IN" }));
                for (i, it) in items.into_iter().enumerate() {
                    if i > 0 {
                        buf.push(", ");
                    }
                    buf.bind(Param::Str(it), Some(&c.data_type));
                }
                buf.push(")");
            }
            other => return Err(format!("Unsupported filter operator '{other}'")),
        }
    }
    Ok(())
}

pub async fn table_rows(db: &Db, schema: &str, table: &str, offset: usize, limit: usize, sort: &[Sort], filters: &[Filter], count: bool) -> Result<TablePage, String> {
    let d = db.dialect();
    let t = meta::describe_table(db, schema, table).await?;
    let q = qualified(d, schema, table);
    let limit = limit.clamp(1, 10_000);
    let mut buf = SqlBuf::new(d);
    buf.push(&format!("SELECT * FROM {q}"));
    build_where(&mut buf, &t, filters)?;
    let mut order: Vec<String> = Vec::new();
    for s in sort {
        let c = col_type(&t, &s.column)?;
        order.push(format!("{}{}", quote_ident(d, &c.name), if s.desc { " DESC" } else { "" }));
    }
    if order.is_empty() {
        order = t.pk().iter().map(|c| quote_ident(d, &c.name)).collect();
    }
    match d {
        Dialect::MsSql => {
            buf.push(&format!(" ORDER BY {}", if order.is_empty() { "(SELECT NULL)".into() } else { order.join(", ") }));
            buf.push(&format!(" OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY"));
        }
        _ => {
            if !order.is_empty() {
                buf.push(&format!(" ORDER BY {}", order.join(", ")));
            }
            buf.push(&format!(" LIMIT {limit} OFFSET {offset}"));
        }
    }
    let (cols, rows) = db.fetch(&buf.sql, &buf.params).await?;
    // Re-order values to the described column order (SELECT * already matches; be defensive).
    let rows = if cols.len() == t.columns.len() && cols.iter().zip(&t.columns).all(|(a, b)| a.name == b.name) || cols.is_empty() {
        rows
    } else {
        let idx: Vec<Option<usize>> = t.columns.iter().map(|c| cols.iter().position(|x| x.name == c.name)).collect();
        rows.into_iter().map(|r| idx.iter().map(|i| i.and_then(|i| r.get(i).cloned()).unwrap_or(Value::Null)).collect()).collect()
    };
    let total = if count {
        let mut cb = SqlBuf::new(d);
        cb.push(&format!("SELECT COUNT(*) AS n FROM {q}"));
        build_where(&mut cb, &t, filters)?;
        db.fetch(&cb.sql, &cb.params).await.ok().and_then(|(_, r)| r.first().and_then(|x| x.first()).and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
    } else {
        None
    };
    Ok(TablePage {
        primary_key: t.pk().iter().map(|c| c.name.clone()).collect(),
        kind: t.kind.clone(),
        columns: t.columns,
        rows,
        total,
        sql: buf.preview,
    })
}

// ---------------------------------------------------------------------------------------------
// row edits
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    /// insert | update | delete
    pub op: String,
    #[serde(default)]
    pub values: Map<String, Value>,
    #[serde(default)]
    pub key: Map<String, Value>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub statements: Vec<String>,
    pub affected: Vec<u64>,
    pub dry_run: bool,
}

pub fn build_edits(d: Dialect, t: &TableInfo, edits: &[Edit]) -> Result<Vec<SqlBuf>, String> {
    let pk = t.pk();
    if pk.is_empty() {
        return Err(format!("{} has no primary key; rows cannot be identified safely, so editing is disabled.", t.name));
    }
    let q = qualified(d, &t.schema, &t.name);
    let mut out = Vec::new();
    let where_pk = |buf: &mut SqlBuf, key: &Map<String, Value>| -> Result<(), String> {
        buf.push(" WHERE ");
        for (i, c) in pk.iter().enumerate() {
            let v = key.get(&c.name).ok_or_else(|| format!("Missing primary key value for '{}'", c.name))?;
            if v.is_null() {
                return Err(format!("Primary key '{}' is NULL", c.name));
            }
            if i > 0 {
                buf.push(" AND ");
            }
            buf.push(&format!("{} = ", quote_ident(d, &c.name)));
            buf.bind(Param::from_json(v), Some(&c.data_type));
        }
        Ok(())
    };
    for e in edits {
        let mut buf = SqlBuf::new(d);
        match e.op.as_str() {
            "insert" => {
                let cols: Vec<(&String, &Value)> = e.values.iter().collect();
                for (c, _) in &cols {
                    col_type(t, c)?;
                }
                if cols.is_empty() {
                    buf.push(&format!(
                        "INSERT INTO {q} {}",
                        if d == Dialect::MySql { "() VALUES ()" } else { "DEFAULT VALUES" }
                    ));
                } else {
                    buf.push(&format!("INSERT INTO {q} ({}) VALUES (", cols.iter().map(|(c, _)| quote_ident(d, c)).collect::<Vec<_>>().join(", ")));
                    for (i, (c, v)) in cols.iter().enumerate() {
                        if i > 0 {
                            buf.push(", ");
                        }
                        let ty = col_type(t, c)?.data_type.clone();
                        buf.bind(Param::from_json(v), Some(&ty));
                    }
                    buf.push(")");
                }
            }
            "update" => {
                if e.values.is_empty() {
                    continue;
                }
                buf.push(&format!("UPDATE {q} SET "));
                for (i, (c, v)) in e.values.iter().enumerate() {
                    let ci = col_type(t, c)?;
                    if i > 0 {
                        buf.push(", ");
                    }
                    buf.push(&format!("{} = ", quote_ident(d, &ci.name)));
                    buf.bind(Param::from_json(v), Some(&ci.data_type));
                }
                where_pk(&mut buf, &e.key)?;
            }
            "delete" => {
                buf.push(&format!("DELETE FROM {q}"));
                where_pk(&mut buf, &e.key)?;
            }
            other => return Err(format!("Unknown edit operation '{other}'")),
        }
        out.push(buf);
    }
    Ok(out)
}

pub async fn apply_edits(db: &Db, schema: &str, table: &str, edits: &[Edit], dry_run: bool) -> Result<ApplyResult, String> {
    let d = db.dialect();
    let t = meta::describe_table(db, schema, table).await?;
    let stmts = build_edits(d, &t, edits)?;
    let statements: Vec<String> = stmts.iter().map(|s| s.preview.clone()).collect();
    if dry_run {
        return Ok(ApplyResult { statements, affected: vec![], dry_run: true });
    }
    let affected = db.transaction(&stmts).await?;
    Ok(ApplyResult { statements, affected, dry_run: false })
}

// ---------------------------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------------------------

fn csv_field(v: &Value, delim: char) -> String {
    let s = match v {
        Value::Null => return String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    };
    if s.contains(delim) || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

pub fn sql_value(d: Dialect, v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => Param::Bool(*b).literal(d),
        Value::Number(n) => n.to_string(),
        Value::String(s) => quote_literal(d, s),
        other => quote_literal(d, &other.to_string()),
    }
}

/// Exports the rows of `sql` to `path` as csv | tsv | json | sql. Returns the row count.
pub async fn export(db: &Db, sql: &str, format: &str, path: &str, insert_table: &str) -> Result<u64, String> {
    let d = db.dialect();
    if !safety::all_read_only(sql, d) {
        return Err("Export runs read-only queries only (SELECT …)".into());
    }
    let stmts: Vec<String> = safety::split_statements(sql, d).into_iter().map(|s| s.sql).collect();
    if stmts.len() != 1 {
        return Err("Export one statement at a time".into());
    }
    let file = std::fs::File::create(path).map_err(|e| format!("Cannot write {path}: {e}"))?;
    let mut w = std::io::BufWriter::new(file);
    let mut cols: Vec<Column> = Vec::new();
    let mut n: u64 = 0;
    let fmt = format.to_lowercase();
    let delim = if fmt == "tsv" { '\t' } else { ',' };
    let target = if insert_table.trim().is_empty() { quote_ident(d, "exported") } else { insert_table.to_string() };
    let mut io_err: Option<String> = None;
    if fmt == "json" {
        let _ = w.write_all(b"[\n");
    }
    db.run_statements(&stmts, None, &mut |_, ev| {
        let r: std::io::Result<()> = (|| {
            match ev {
                Ev::Columns(c) => {
                    cols = c;
                    if fmt == "csv" || fmt == "tsv" {
                        let h: Vec<String> = cols.iter().map(|c| csv_field(&Value::String(c.name.clone()), delim)).collect();
                        writeln!(w, "{}", h.join(&delim.to_string()))?;
                    }
                }
                Ev::Row(row) => {
                    match fmt.as_str() {
                        "json" => {
                            let mut obj = Map::new();
                            for (c, v) in cols.iter().zip(row) {
                                obj.insert(c.name.clone(), v);
                            }
                            if n > 0 {
                                w.write_all(b",\n")?;
                            }
                            w.write_all(b"  ")?;
                            w.write_all(serde_json::to_string(&Value::Object(obj)).unwrap_or_default().as_bytes())?;
                        }
                        "sql" => {
                            let names: Vec<String> = cols.iter().map(|c| quote_ident(d, &c.name)).collect();
                            let vals: Vec<String> = row.iter().map(|v| sql_value(d, v)).collect();
                            writeln!(w, "INSERT INTO {target} ({}) VALUES ({});", names.join(", "), vals.join(", "))?;
                        }
                        _ => {
                            let vals: Vec<String> = row.iter().map(|v| csv_field(v, delim)).collect();
                            writeln!(w, "{}", vals.join(&delim.to_string()))?;
                        }
                    }
                    n += 1;
                }
                Ev::Done(_) => {}
            }
            Ok(())
        })();
        if let Err(e) = r {
            io_err = Some(e.to_string());
            return Ok(false);
        }
        Ok(true)
    })
    .await?;
    if fmt == "json" {
        let _ = w.write_all(b"\n]\n");
    }
    w.flush().map_err(|e| e.to_string())?;
    if let Some(e) = io_err {
        return Err(format!("Writing {path} failed: {e}"));
    }
    Ok(n)
}

// ---------------------------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------------------------

/// RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF/LF, embedded newlines).
pub fn parse_csv(text: &str, delim: char) -> Vec<Vec<String>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut in_q = false;
    let mut chars = text.chars().peekable();
    let mut any = false;
    while let Some(c) = chars.next() {
        any = true;
        if in_q {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_q = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => in_q = true,
            c if c == delim => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                any = false;
            }
            c => field.push(c),
        }
    }
    if any || !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    rows
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub source: usize,
    pub column: String,
}

pub async fn import_csv(db: &Db, schema: &str, table: &str, path: &str, mapping: &[Mapping], header: bool, delim: char, empty_as_null: bool) -> Result<u64, String> {
    let d = db.dialect();
    let t = meta::describe_table(db, schema, table).await?;
    if mapping.is_empty() {
        return Err("Map at least one CSV column to a table column".into());
    }
    let mut cols: Vec<&ColumnInfo> = Vec::new();
    for m in mapping {
        cols.push(col_type(&t, &m.column)?);
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut rows = parse_csv(&text, delim);
    if header && !rows.is_empty() {
        rows.remove(0);
    }
    let max_params = match d {
        Dialect::MsSql => 2000,
        Dialect::Sqlite => 30000,
        _ => 30000,
    };
    let per = (max_params / cols.len()).clamp(1, 500);
    let q = qualified(d, schema, table);
    let names = cols.iter().map(|c| quote_ident(d, &c.name)).collect::<Vec<_>>().join(", ");
    let mut stmts = Vec::new();
    for chunk in rows.chunks(per) {
        let mut buf = SqlBuf::new(d);
        buf.push(&format!("INSERT INTO {q} ({names}) VALUES "));
        for (ri, r) in chunk.iter().enumerate() {
            if ri > 0 {
                buf.push(", ");
            }
            buf.push("(");
            for (ci, (m, c)) in mapping.iter().zip(&cols).enumerate() {
                if ci > 0 {
                    buf.push(", ");
                }
                let v = r.get(m.source).cloned().unwrap_or_default();
                let p = if v.is_empty() && (empty_as_null || c.nullable && !c.data_type.to_lowercase().contains("char") && !c.data_type.to_lowercase().contains("text")) {
                    Param::Null
                } else {
                    Param::Str(v)
                };
                buf.bind(p, Some(&c.data_type));
            }
            buf.push(")");
        }
        // Previews of huge batches are not useful.
        if buf.preview.len() > 4000 {
            buf.preview = format!("{}… ({} rows)", &buf.preview[..buf.preview.char_indices().take(4000).last().map(|x| x.0).unwrap_or(0)], chunk.len());
        }
        stmts.push(buf);
    }
    if stmts.is_empty() {
        return Ok(0);
    }
    db.transaction(&stmts).await?;
    Ok(rows.len() as u64)
}
