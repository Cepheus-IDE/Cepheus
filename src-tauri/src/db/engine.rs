//! Driver layer: opening pools (sqlx for Postgres/MySQL/SQLite, tiberius for SQL Server), running
//! statements with streaming row sinks, safe value conversion to JSON, parameter binding and
//! transactions, and query cancellation.

use super::safety::Dialect;
use futures_util::{StreamExt, TryStreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode, PgValueFormat};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions, SqliteRow};
use sqlx::{Column as _, Either, Row, TypeInfo, ValueRef};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

pub type MsClient = tiberius::Client<Compat<tokio::net::TcpStream>>;

/// A bound parameter.
#[derive(Clone, Debug, PartialEq)]
pub enum Param {
    Null,
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl Param {
    pub fn from_json(v: &Value) -> Param {
        match v {
            Value::Null => Param::Null,
            Value::Bool(b) => Param::Bool(*b),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Param::Int(i)
                } else if let Some(f) = n.as_f64() {
                    Param::Float(f)
                } else {
                    Param::Str(n.to_string())
                }
            }
            Value::String(s) => Param::Str(s.clone()),
            other => Param::Str(other.to_string()),
        }
    }
    /// Literal form for SQL previews.
    pub fn literal(&self, d: Dialect) -> String {
        match self {
            Param::Null => "NULL".into(),
            Param::Str(s) => super::safety::quote_literal(d, s),
            Param::Int(i) => i.to_string(),
            Param::Float(f) => f.to_string(),
            Param::Bool(b) => match d {
                Dialect::Postgres => if *b { "TRUE".into() } else { "FALSE".into() },
                _ => if *b { "1".into() } else { "0".into() },
            },
        }
    }
    fn as_text(&self) -> Param {
        match self {
            Param::Int(i) => Param::Str(i.to_string()),
            Param::Float(f) => Param::Str(f.to_string()),
            Param::Bool(b) => Param::Str(b.to_string()),
            other => other.clone(),
        }
    }
}

/// SQL text plus bound parameters, with a literal preview for display.
#[derive(Clone, Debug)]
pub struct SqlBuf {
    pub d: Dialect,
    pub sql: String,
    pub params: Vec<Param>,
    pub preview: String,
}

impl SqlBuf {
    pub fn new(d: Dialect) -> Self {
        SqlBuf { d, sql: String::new(), params: Vec::new(), preview: String::new() }
    }
    pub fn push(&mut self, s: &str) -> &mut Self {
        self.sql.push_str(s);
        self.preview.push_str(s);
        self
    }
    /// Appends a placeholder. On Postgres a known column type becomes `CAST($n AS type)` with the
    /// value bound as text, so any value converts like a literal would.
    pub fn bind(&mut self, p: Param, pg_type: Option<&str>) -> &mut Self {
        self.preview.push_str(&p.literal(self.d));
        let n = self.params.len() + 1;
        match self.d {
            Dialect::Postgres => match pg_type.filter(|t| super::safety::safe_type_name(t)) {
                Some(t) if p != Param::Null => {
                    self.sql.push_str(&format!("CAST(${n} AS {t})"));
                    self.params.push(p.as_text());
                    return self;
                }
                _ => self.sql.push_str(&format!("${n}")),
            },
            Dialect::MsSql => self.sql.push_str(&format!("@P{n}")),
            _ => self.sql.push('?'),
        }
        self.params.push(p);
        self
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
}

/// Streaming events from a running statement.
pub enum Ev {
    Columns(Vec<Column>),
    Row(Vec<Value>),
    /// End of one result (rows affected for DML).
    Done(u64),
}


// ---------------------------------------------------------------------------------------------
// SQL Server connection
// ---------------------------------------------------------------------------------------------

pub struct MsConn {
    cfg: tiberius::Config,
    timeout: Duration,
    client: tokio::sync::Mutex<Option<MsClient>>,
    /// Set when a query was cancelled mid-stream: the client is replaced before the next use.
    poisoned: AtomicBool,
}

async fn ms_connect(cfg: &tiberius::Config, timeout: Duration) -> Result<MsClient, String> {
    let mut cfg = cfg.clone();
    for _ in 0..2 {
        let tcp = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(cfg.get_addr()))
            .await
            .map_err(|_| format!("Timed out connecting to {}", cfg.get_addr()))?
            .map_err(|e| format!("Cannot connect to {}: {e}", cfg.get_addr()))?;
        tcp.set_nodelay(true).ok();
        match tokio::time::timeout(timeout, tiberius::Client::connect(cfg.clone(), tcp.compat_write())).await {
            Err(_) => return Err("Timed out during SQL Server login".into()),
            Ok(Ok(c)) => return Ok(c),
            Ok(Err(tiberius::error::Error::Routing { host, port })) => {
                cfg.host(&host);
                cfg.port(port);
            }
            Ok(Err(e)) => return Err(format!("SQL Server: {e}")),
        }
    }
    Err("SQL Server redirected the connection too many times".into())
}

impl MsConn {
    async fn lock(&self) -> Result<tokio::sync::MutexGuard<'_, Option<MsClient>>, String> {
        let mut g = self.client.lock().await;
        if self.poisoned.swap(false, Ordering::SeqCst) || g.is_none() {
            *g = Some(ms_connect(&self.cfg, self.timeout).await?);
        }
        Ok(g)
    }
}

// ---------------------------------------------------------------------------------------------
// Db handle
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
pub enum Db {
    Pg(PgPool),
    My(MySqlPool),
    Lite(SqlitePool),
    Ms(Arc<MsConn>),
}

/// Everything needed to open one database of a connection.
pub struct OpenParams {
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    pub file: String,
    pub ssl_mode: String,
    pub timeout: Duration,
    pub trust_server_cert: bool,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub async fn open(p: &OpenParams) -> Result<Db, String> {
    let t = p.timeout;
    match Dialect::from_kind(&p.kind) {
        Dialect::Postgres => {
            let mut o = PgConnectOptions::new()
                .host(&p.host)
                .port(p.port)
                .username(&p.user)
                .database(if p.database.is_empty() { "postgres" } else { &p.database })
                .application_name("Cepheus IDE")
                .ssl_mode(match p.ssl_mode.as_str() {
                    "disable" => PgSslMode::Disable,
                    "require" => PgSslMode::Require,
                    "verify-ca" => PgSslMode::VerifyCa,
                    "verify-full" => PgSslMode::VerifyFull,
                    "allow" => PgSslMode::Allow,
                    _ => PgSslMode::Prefer,
                });
            if !p.password.is_empty() {
                o = o.password(&p.password);
            }
            let pool = Box::pin(PgPoolOptions::new().max_connections(5).acquire_timeout(t).connect_with(o));
            let pool = tokio::time::timeout(t, pool).await.map_err(|_| format!("Timed out connecting to {}:{}", p.host, p.port))?.map_err(err)?;
            Ok(Db::Pg(pool))
        }
        Dialect::MySql => {
            let mut o = MySqlConnectOptions::new()
                .host(&p.host)
                .port(p.port)
                .username(&p.user)
                .charset("utf8mb4")
                .ssl_mode(match p.ssl_mode.as_str() {
                    "disable" => MySqlSslMode::Disabled,
                    "require" => MySqlSslMode::Required,
                    "verify-ca" => MySqlSslMode::VerifyCa,
                    "verify-full" => MySqlSslMode::VerifyIdentity,
                    _ => MySqlSslMode::Preferred,
                });
            if !p.password.is_empty() {
                o = o.password(&p.password);
            }
            if !p.database.is_empty() {
                o = o.database(&p.database);
            }
            let pool = Box::pin(MySqlPoolOptions::new().max_connections(5).acquire_timeout(t).connect_with(o));
            let pool = tokio::time::timeout(t, pool).await.map_err(|_| format!("Timed out connecting to {}:{}", p.host, p.port))?.map_err(err)?;
            Ok(Db::My(pool))
        }
        Dialect::Sqlite => {
            let path = if p.file.is_empty() { p.database.clone() } else { p.file.clone() };
            if path.trim().is_empty() {
                return Err("Choose a SQLite database file".into());
            }
            let o = SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true)
                .foreign_keys(true)
                .busy_timeout(Duration::from_secs(5));
            let pool = Box::pin(SqlitePoolOptions::new().max_connections(4).acquire_timeout(t).connect_with(o)).await.map_err(err)?;
            Ok(Db::Lite(pool))
        }
        Dialect::MsSql => {
            let mut cfg = tiberius::Config::new();
            cfg.host(&p.host);
            cfg.port(p.port);
            cfg.application_name("Cepheus IDE");
            cfg.authentication(tiberius::AuthMethod::sql_server(&p.user, &p.password));
            if !p.database.is_empty() {
                cfg.database(&p.database);
            }
            match p.ssl_mode.as_str() {
                "disable" => cfg.encryption(tiberius::EncryptionLevel::NotSupported),
                "require" => cfg.encryption(tiberius::EncryptionLevel::Required),
                "verify-ca" | "verify-full" => cfg.encryption(tiberius::EncryptionLevel::Required),
                _ => cfg.encryption(tiberius::EncryptionLevel::Off),
            }
            if p.trust_server_cert || !matches!(p.ssl_mode.as_str(), "verify-ca" | "verify-full") {
                cfg.trust_cert();
            }
            let client = Box::pin(ms_connect(&cfg, t)).await?;
            Ok(Db::Ms(Arc::new(MsConn { cfg, timeout: t, client: tokio::sync::Mutex::new(Some(client)), poisoned: AtomicBool::new(false) })))
        }
    }
}

impl Db {
    pub fn dialect(&self) -> Dialect {
        match self {
            Db::Pg(_) => Dialect::Postgres,
            Db::My(_) => Dialect::MySql,
            Db::Lite(_) => Dialect::Sqlite,
            Db::Ms(_) => Dialect::MsSql,
        }
    }

    pub async fn close(&self) {
        match self {
            Db::Pg(p) => p.close().await,
            Db::My(p) => p.close().await,
            Db::Lite(p) => p.close().await,
            Db::Ms(m) => {
                if let Some(c) = m.client.lock().await.take() {
                    let _ = c.close().await;
                }
            }
        }
    }

    /// Runs a parameterized query and returns all rows (binary protocol, typed decoding).
    pub async fn fetch(&self, sql: &str, params: &[Param]) -> Result<(Vec<Column>, Vec<Vec<Value>>), String> {
        let mut cols: Vec<Column> = Vec::new();
        let mut rows: Vec<Vec<Value>> = Vec::new();
        macro_rules! go {
            ($pool:expr, $decode:expr) => {{
                let q = bind_sqlx!(sqlx::query(sql), params);
                let mut s = q.fetch($pool);
                while let Some(row) = s.try_next().await.map_err(err)? {
                    if cols.is_empty() {
                        cols = sqlx_columns(&row);
                    }
                    rows.push((0..row.len()).map(|i| $decode(&row, i)).collect());
                }
            }};
        }
        match self {
            Db::Pg(p) => go!(p, pg_val),
            Db::My(p) => go!(p, |r: &MySqlRow, i| my_val(r, i, false)),
            Db::Lite(p) => go!(p, lite_val),
            Db::Ms(m) => {
                let mut g = m.lock().await?;
                let client = g.as_mut().unwrap();
                let mut q = tiberius::Query::new(sql.to_string());
                bind_ms(&mut q, params);
                let mut s = q.query(client).await.map_err(err)?;
                while let Some(item) = s.try_next().await.map_err(err)? {
                    match item {
                        tiberius::QueryItem::Metadata(md) if cols.is_empty() => cols = ms_columns(md.columns()),
                        tiberius::QueryItem::Row(r) => rows.push(ms_row(&r)),
                        _ => {}
                    }
                }
            }
        }
        Ok((cols, rows))
    }

    /// Rows as maps keyed by lower-cased column name (for catalog queries).
    pub async fn fetch_maps(&self, sql: &str, params: &[Param]) -> Result<Vec<HashMap<String, Value>>, String> {
        let (cols, rows) = self.fetch(sql, params).await?;
        Ok(rows
            .into_iter()
            .map(|r| cols.iter().zip(r).map(|(c, v)| (c.name.to_lowercase(), v)).collect())
            .collect())
    }

    /// Runs statements in one transaction; returns rows affected per statement.
    pub async fn transaction(&self, stmts: &[SqlBuf]) -> Result<Vec<u64>, String> {
        let mut out = Vec::new();
        macro_rules! go {
            ($pool:expr) => {{
                let mut tx = $pool.begin().await.map_err(err)?;
                for (i, s) in stmts.iter().enumerate() {
                    let q = bind_sqlx!(sqlx::query(&s.sql), &s.params);
                    match q.execute(&mut *tx).await {
                        Ok(r) => out.push(r.rows_affected()),
                        Err(e) => {
                            let _ = tx.rollback().await;
                            return Err(format!("Statement {} failed, transaction rolled back: {e}\n{}", i + 1, s.preview));
                        }
                    }
                }
                tx.commit().await.map_err(err)?;
            }};
        }
        match self {
            Db::Pg(p) => go!(p),
            Db::My(p) => go!(p),
            Db::Lite(p) => go!(p),
            Db::Ms(m) => {
                let mut g = m.lock().await?;
                let client = g.as_mut().unwrap();
                client.simple_query("BEGIN TRANSACTION").await.map_err(err)?.into_results().await.map_err(err)?;
                for (i, s) in stmts.iter().enumerate() {
                    let mut q = tiberius::Query::new(s.sql.clone());
                    bind_ms(&mut q, &s.params);
                    match q.execute(client).await {
                        Ok(r) => out.push(r.total()),
                        Err(e) => {
                            if let Ok(st) = client.simple_query("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION").await {
                                let _ = st.into_results().await;
                            }
                            return Err(format!("Statement {} failed, transaction rolled back: {e}\n{}", i + 1, s.preview));
                        }
                    }
                }
                client.simple_query("COMMIT TRANSACTION").await.map_err(err)?.into_results().await.map_err(err)?;
            }
        }
        Ok(out)
    }

    /// Runs a script's statements on ONE connection (session state carries over), streaming every
    /// result to `sink(statement_index, event)`. Registers `query_id` for cancellation.
    pub async fn run_statements(
        &self,
        stmts: &[String],
        query_id: Option<&str>,
        sink: &mut (dyn FnMut(usize, Ev) -> Result<bool, String> + Send),
    ) -> Result<(), String> {
        match self {
            Db::Pg(pool) => {
                let mut conn = pool.acquire().await.map_err(err)?;
                if let Some(q) = query_id {
                    if let Ok(pid) = sqlx::query_scalar::<_, i32>("SELECT pg_backend_pid()").fetch_one(&mut *conn).await {
                        register(q, CancelKind::Pg(pid, pool.clone()));
                    }
                }
                let r = async {
                    for (i, st) in stmts.iter().enumerate() {
                        stream_sqlx!(&mut *conn, st, pg_val, |r: &sqlx::postgres::PgQueryResult| r.rows_affected(), |e| sink(i, e));
                        sink(i, Ev::Done(u64::MAX))?;
                    }
                    Ok::<(), String>(())
                }
                .await;
                if let Some(q) = query_id {
                    unregister(q);
                }
                r
            }
            Db::My(pool) => {
                let mut conn = pool.acquire().await.map_err(err)?;
                if let Some(q) = query_id {
                    if let Ok(id) = sqlx::query_scalar::<_, u64>("SELECT CONNECTION_ID()").fetch_one(&mut *conn).await {
                        register(q, CancelKind::My(id, pool.clone()));
                    }
                }
                let r = async {
                    for (i, st) in stmts.iter().enumerate() {
                        stream_sqlx!(&mut *conn, st, |r: &MySqlRow, c| my_val(r, c, true), |r: &sqlx::mysql::MySqlQueryResult| r.rows_affected(), |e| sink(i, e));
                        sink(i, Ev::Done(u64::MAX))?;
                    }
                    Ok::<(), String>(())
                }
                .await;
                if let Some(q) = query_id {
                    unregister(q);
                }
                r
            }
            Db::Lite(pool) => {
                let mut conn = pool.acquire().await.map_err(err)?;
                if let Some(q) = query_id {
                    if let Ok(mut h) = conn.lock_handle().await {
                        let ptr = h.as_raw_handle().as_ptr() as usize;
                        drop(h);
                        register(q, CancelKind::Lite(ptr));
                    }
                }
                let r = async {
                    for (i, st) in stmts.iter().enumerate() {
                        stream_sqlx!(&mut *conn, st, lite_val, |r: &sqlx::sqlite::SqliteQueryResult| r.rows_affected(), |e| sink(i, e));
                        sink(i, Ev::Done(u64::MAX))?;
                    }
                    Ok::<(), String>(())
                }
                .await;
                if let Some(q) = query_id {
                    unregister(q); // before the connection goes back to the pool
                }
                r
            }
            Db::Ms(m) => {
                if let Some(q) = query_id {
                    register(q, CancelKind::Ms(m.clone()));
                }
                let r = async {
                    let mut g = m.lock().await?;
                    let client = g.as_mut().unwrap();
                    for (i, st) in stmts.iter().enumerate() {
                        let c = super::safety::classify(st, Dialect::MsSql);
                        let dml = matches!(c.verb.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE") && !st.to_ascii_uppercase().contains("OUTPUT");
                        if dml {
                            let r = client.execute(st.as_str(), &[]).await.map_err(err)?;
                            sink(i, Ev::Done(r.total()))?;
                        } else {
                            let mut s = client.simple_query(st.as_str()).await.map_err(err)?;
                            let mut stop = false;
                            while let Some(item) = s.try_next().await.map_err(err)? {
                                match item {
                                    tiberius::QueryItem::Metadata(md) => {
                                        if !stop {
                                            sink(i, Ev::Columns(ms_columns(md.columns())))?;
                                        }
                                    }
                                    tiberius::QueryItem::Row(r) => {
                                        if !stop && !sink(i, Ev::Row(ms_row(&r)))? {
                                            stop = true; // keep draining so the connection stays usable
                                        }
                                    }
                                }
                            }
                        }
                        sink(i, Ev::Done(u64::MAX))?;
                    }
                    Ok::<(), String>(())
                }
                .await;
                if let Some(q) = query_id {
                    unregister(q);
                }
                r
            }
        }
    }

    /// SQL Server EXPLAIN equivalent: SHOWPLAN_TEXT on the same session.
    pub async fn ms_showplan(&self, sql: &str) -> Result<(Vec<Column>, Vec<Vec<Value>>), String> {
        let Db::Ms(m) = self else { return Err("not SQL Server".into()) };
        let mut g = m.lock().await?;
        let client = g.as_mut().unwrap();
        client.simple_query("SET SHOWPLAN_TEXT ON").await.map_err(err)?.into_results().await.map_err(err)?;
        let res = async {
            let s = client.simple_query(sql).await.map_err(err)?;
            let results = s.into_results().await.map_err(err)?;
            let mut cols = vec![Column { name: "plan".into(), type_name: "text".into() }];
            let mut rows = Vec::new();
            for set in results {
                for r in set {
                    if let Some(c) = r.columns().first() {
                        cols[0].name = c.name().to_string();
                    }
                    rows.push(ms_row(&r).into_iter().take(1).collect());
                }
            }
            Ok::<_, String>((cols, rows))
        }
        .await;
        if let Ok(s) = client.simple_query("SET SHOWPLAN_TEXT OFF").await {
            let _ = s.into_results().await;
        }
        res
    }
}

macro_rules! bind_sqlx {
    ($q:expr, $params:expr) => {{
        let mut q = $q;
        for p in $params.iter() {
            q = match p {
                Param::Null => q.bind(None::<String>),
                Param::Str(s) => q.bind(s.clone()),
                Param::Int(n) => q.bind(*n),
                Param::Float(f) => q.bind(*f),
                Param::Bool(b) => q.bind(*b),
            };
        }
        q
    }};
}
use bind_sqlx;

/// Streams one statement through the text/simple protocol (no parameters).
macro_rules! stream_sqlx {
    ($ex:expr, $sql:expr, $decode:expr, $ra:expr, $sink:expr) => {{
        let mut s = sqlx::raw_sql($sql).fetch_many($ex);
        let mut sent_cols = false;
        let mut stop = false;
        while let Some(item) = s.next().await {
            match item.map_err(err)? {
                Either::Left(r) => {
                    sent_cols = false;
                    if !stop {
                        ($sink)(Ev::Done(($ra)(&r)))?;
                    }
                }
                Either::Right(row) => {
                    if stop {
                        continue;
                    }
                    if !sent_cols {
                        ($sink)(Ev::Columns(sqlx_columns(&row)))?;
                        sent_cols = true;
                    }
                    let vals: Vec<Value> = (0..row.len()).map(|i| ($decode)(&row, i)).collect();
                    if !($sink)(Ev::Row(vals))? {
                        stop = true;
                        break;
                    }
                }
            }
        }
        drop(s);
        let _ = stop;
    }};
}
use stream_sqlx;

fn bind_ms<'a>(q: &mut tiberius::Query<'a>, params: &[Param]) {
    for p in params {
        match p {
            Param::Null => q.bind(Option::<&str>::None),
            Param::Str(s) => q.bind(s.clone()),
            Param::Int(n) => q.bind(*n),
            Param::Float(f) => q.bind(*f),
            Param::Bool(b) => q.bind(*b),
        }
    }
}

fn sqlx_columns<R: Row>(row: &R) -> Vec<Column> {
    row.columns().iter().map(|c| Column { name: c.name().to_string(), type_name: c.type_info().name().to_string() }).collect()
}

// ---------------------------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------------------------

const MAX_SAFE: i64 = 9_007_199_254_740_991;

fn int_json(i: i64) -> Value {
    if (-MAX_SAFE..=MAX_SAFE).contains(&i) { json!(i) } else { Value::String(i.to_string()) }
}
fn float_json(f: f64) -> Value {
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or_else(|| Value::String(f.to_string()))
}
pub fn hex(b: &[u8], prefix: &str) -> String {
    let mut s = String::with_capacity(prefix.len() + b.len() * 2);
    s.push_str(prefix);
    for x in b.iter().take(1 << 20) {
        s.push_str(&format!("{x:02x}"));
    }
    if b.len() > 1 << 20 {
        s.push('…');
    }
    s
}
fn bytes_json(b: &[u8], prefix: &str) -> Value {
    match std::str::from_utf8(b) {
        Ok(s) if !s.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) => Value::String(s.to_string()),
        _ => Value::String(hex(b, prefix)),
    }
}

/// Converts a text-protocol value by its type name.
fn text_json(ty: &str, s: &str) -> Value {
    let t = ty.to_ascii_uppercase();
    let base = t.split_whitespace().next().unwrap_or("");
    match base {
        "INT2" | "INT4" | "INT8" | "SMALLINT" | "INT" | "INTEGER" | "BIGINT" | "TINYINT" | "MEDIUMINT" | "YEAR" | "OID" | "SMALLSERIAL" | "SERIAL" | "BIGSERIAL" => {
            s.parse::<i64>().map(int_json).unwrap_or_else(|_| Value::String(s.to_string()))
        }
        "FLOAT4" | "FLOAT8" | "FLOAT" | "DOUBLE" | "REAL" => s.parse::<f64>().map(float_json).unwrap_or_else(|_| Value::String(s.to_string())),
        "BOOL" | "BOOLEAN" => match s {
            "t" | "true" | "1" => Value::Bool(true),
            "f" | "false" | "0" => Value::Bool(false),
            _ => Value::String(s.to_string()),
        },
        _ => Value::String(s.to_string()),
    }
}

fn fmt_ndt(d: chrono::NaiveDateTime) -> String {
    d.format("%Y-%m-%d %H:%M:%S%.f").to_string()
}

fn pg_val(row: &PgRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(e) => return Value::String(format!("<error: {e}>")),
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_string();
    if raw.format() == PgValueFormat::Text {
        return match raw.as_str() {
            Ok(s) => text_json(&ty, s),
            Err(_) => Value::String(raw.as_bytes().map(|b| hex(b, "\\x")).unwrap_or_default()),
        };
    }
    macro_rules! get {
        ($t:ty) => {
            row.try_get_unchecked::<$t, _>(i)
        };
    }
    let fallback = || -> Value {
        match get!(String) {
            Ok(s) if !s.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) => Value::String(s),
            _ => Value::String(format!("<{}>", ty.to_lowercase())),
        }
    };
    let arr = |v: Vec<String>| Value::String(format!("{{{}}}", v.join(",")));
    match ty.as_str() {
        "BOOL" => get!(bool).map(Value::Bool).unwrap_or_else(|_| fallback()),
        "INT2" => get!(i16).map(|v| json!(v)).unwrap_or_else(|_| fallback()),
        "INT4" => get!(i32).map(|v| json!(v)).unwrap_or_else(|_| fallback()),
        "INT8" => get!(i64).map(int_json).unwrap_or_else(|_| fallback()),
        "OID" => get!(sqlx::postgres::types::Oid).map(|v| json!(v.0)).unwrap_or_else(|_| fallback()),
        "FLOAT4" => get!(f32).map(|v| float_json(v as f64)).unwrap_or_else(|_| fallback()),
        "FLOAT8" => get!(f64).map(float_json).unwrap_or_else(|_| fallback()),
        "NUMERIC" => get!(rust_decimal::Decimal).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| Value::String("<numeric out of range>".into())),
        "UUID" => get!(uuid::Uuid).map(|u| Value::String(u.to_string())).unwrap_or_else(|_| fallback()),
        "JSON" | "JSONB" => get!(serde_json::Value).map(|j| Value::String(j.to_string())).unwrap_or_else(|_| fallback()),
        "DATE" => get!(chrono::NaiveDate).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| fallback()),
        "TIME" => get!(chrono::NaiveTime).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| fallback()),
        "TIMESTAMP" => get!(chrono::NaiveDateTime).map(|d| Value::String(fmt_ndt(d))).unwrap_or_else(|_| fallback()),
        "TIMESTAMPTZ" => get!(chrono::DateTime<chrono::Utc>).map(|d| Value::String(d.format("%Y-%m-%d %H:%M:%S%.f+00").to_string())).unwrap_or_else(|_| fallback()),
        "BYTEA" => get!(Vec<u8>).map(|b| Value::String(hex(&b, "\\x"))).unwrap_or_else(|_| fallback()),
        "_TEXT" | "_VARCHAR" | "_BPCHAR" | "_NAME" => get!(Vec<String>).map(arr).unwrap_or_else(|_| fallback()),
        "_INT2" => get!(Vec<i16>).map(|v| arr(v.iter().map(|x| x.to_string()).collect())).unwrap_or_else(|_| fallback()),
        "_INT4" => get!(Vec<i32>).map(|v| arr(v.iter().map(|x| x.to_string()).collect())).unwrap_or_else(|_| fallback()),
        "_INT8" => get!(Vec<i64>).map(|v| arr(v.iter().map(|x| x.to_string()).collect())).unwrap_or_else(|_| fallback()),
        "_FLOAT8" => get!(Vec<f64>).map(|v| arr(v.iter().map(|x| x.to_string()).collect())).unwrap_or_else(|_| fallback()),
        "_BOOL" => get!(Vec<bool>).map(|v| arr(v.iter().map(|x| if *x { "t".into() } else { "f".into() }).collect())).unwrap_or_else(|_| fallback()),
        "_UUID" => get!(Vec<uuid::Uuid>).map(|v| arr(v.iter().map(|x| x.to_string()).collect())).unwrap_or_else(|_| fallback()),
        _ => fallback(),
    }
}

fn my_val(row: &MySqlRow, i: usize, text: bool) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(e) => return Value::String(format!("<error: {e}>")),
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_ascii_uppercase();
    macro_rules! get {
        ($t:ty) => {
            row.try_get_unchecked::<$t, _>(i)
        };
    }
    let binary = ty.contains("BLOB") || ty.contains("BINARY") || ty == "BIT" || ty == "GEOMETRY";
    if text {
        if binary {
            return get!(Vec<u8>).map(|b| bytes_json(&b, "0x")).unwrap_or(Value::Null);
        }
        return match get!(String) {
            Ok(s) => text_json(&ty, &s),
            Err(_) => get!(Vec<u8>).map(|b| bytes_json(&b, "0x")).unwrap_or(Value::Null),
        };
    }
    let unsigned = ty.contains("UNSIGNED");
    let base = ty.split_whitespace().next().unwrap_or("").to_string();
    let fallback = || get!(String).map(Value::String).or_else(|_| get!(Vec<u8>).map(|b| bytes_json(&b, "0x"))).unwrap_or(Value::Null);
    match base.as_str() {
        "BOOLEAN" => get!(bool).map(Value::Bool).unwrap_or_else(|_| fallback()),
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" | "YEAR" => {
            if unsigned {
                get!(u64).map(|v| if v <= MAX_SAFE as u64 { json!(v) } else { Value::String(v.to_string()) }).unwrap_or_else(|_| fallback())
            } else {
                get!(i64).map(int_json).unwrap_or_else(|_| fallback())
            }
        }
        "FLOAT" => get!(f32).map(|v| float_json(v as f64)).unwrap_or_else(|_| fallback()),
        "DOUBLE" => get!(f64).map(float_json).unwrap_or_else(|_| fallback()),
        "DECIMAL" => get!(rust_decimal::Decimal).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| fallback()),
        "DATE" => get!(chrono::NaiveDate).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| fallback()),
        "TIME" => get!(chrono::NaiveTime).map(|d| Value::String(d.to_string())).unwrap_or_else(|_| Value::String("<time>".into())),
        "DATETIME" => get!(chrono::NaiveDateTime).map(|d| Value::String(fmt_ndt(d))).unwrap_or_else(|_| fallback()),
        "TIMESTAMP" => get!(chrono::DateTime<chrono::Utc>).map(|d| Value::String(fmt_ndt(d.naive_utc()))).unwrap_or_else(|_| fallback()),
        "JSON" => get!(serde_json::Value).map(|j| Value::String(j.to_string())).unwrap_or_else(|_| fallback()),
        _ if binary => get!(Vec<u8>).map(|b| bytes_json(&b, "0x")).unwrap_or(Value::Null),
        _ => fallback(),
    }
}

fn lite_val(row: &SqliteRow, i: usize) -> Value {
    let raw = match row.try_get_raw(i) {
        Ok(r) => r,
        Err(e) => return Value::String(format!("<error: {e}>")),
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info().name().to_string();
    match ty.as_str() {
        "INTEGER" | "BOOLEAN" => row.try_get_unchecked::<i64, _>(i).map(int_json).unwrap_or(Value::Null),
        "REAL" | "NUMERIC" => row.try_get_unchecked::<f64, _>(i).map(float_json).unwrap_or(Value::Null),
        "BLOB" => row.try_get_unchecked::<Vec<u8>, _>(i).map(|b| Value::String(format!("x'{}'", hex(&b, "")))).unwrap_or(Value::Null),
        _ => row
            .try_get_unchecked::<String, _>(i)
            .map(Value::String)
            .or_else(|_| row.try_get_unchecked::<Vec<u8>, _>(i).map(|b| bytes_json(&b, "x")))
            .unwrap_or(Value::Null),
    }
}

fn ms_columns(cols: &[tiberius::Column]) -> Vec<Column> {
    cols.iter().map(|c| Column { name: c.name().to_string(), type_name: format!("{:?}", c.column_type()) }).collect()
}

fn ms_row(r: &tiberius::Row) -> Vec<Value> {
    use tiberius::ColumnData as D;
    let mut out = Vec::with_capacity(r.len());
    for (i, (_, d)) in r.cells().enumerate() {
        let v = match d {
            D::U8(v) => v.map(|x| json!(x)),
            D::I16(v) => v.map(|x| json!(x)),
            D::I32(v) => v.map(|x| json!(x)),
            D::I64(v) => v.map(int_json),
            D::F32(v) => v.map(|x| float_json(x as f64)),
            D::F64(v) => v.map(float_json),
            D::Bit(v) => v.map(Value::Bool),
            D::String(v) => v.as_ref().map(|s| Value::String(s.to_string())),
            D::Guid(v) => v.map(|u| Value::String(u.to_string())),
            D::Binary(v) => v.as_ref().map(|b| Value::String(hex(b, "0x"))),
            D::Numeric(v) => v.map(|n| Value::String(n.to_string())),
            D::Xml(v) => v.as_ref().map(|x| Value::String(x.to_string())),
            D::DateTime(_) | D::SmallDateTime(_) | D::DateTime2(_) => {
                r.try_get::<chrono::NaiveDateTime, _>(i).ok().flatten().map(|d| Value::String(fmt_ndt(d)))
            }
            D::Date(_) => r.try_get::<chrono::NaiveDate, _>(i).ok().flatten().map(|d| Value::String(d.to_string())),
            D::Time(_) => r.try_get::<chrono::NaiveTime, _>(i).ok().flatten().map(|d| Value::String(d.to_string())),
            D::DateTimeOffset(_) => r.try_get::<chrono::DateTime<chrono::FixedOffset>, _>(i).ok().flatten().map(|d| Value::String(d.to_rfc3339())),
        };
        out.push(v.unwrap_or(Value::Null));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------------

enum CancelKind {
    Pg(i32, PgPool),
    My(u64, MySqlPool),
    /// Raw `sqlite3*` of the connection running the query (valid while registered).
    Lite(usize),
    Ms(Arc<MsConn>),
}

struct Running {
    kind: CancelKind,
    abort: Option<tokio::task::AbortHandle>,
}

static RUNNING: LazyLock<Mutex<HashMap<String, Running>>> = LazyLock::new(Default::default);

fn register(id: &str, kind: CancelKind) {
    let mut m = RUNNING.lock().unwrap();
    let abort = m.remove(id).and_then(|r| r.abort);
    m.insert(id.to_string(), Running { kind, abort });
}

/// Attaches the spawned task's abort handle (used for SQL Server and as a last resort).
pub fn attach_abort(id: &str, h: tokio::task::AbortHandle) {
    let mut m = RUNNING.lock().unwrap();
    match m.get_mut(id) {
        Some(r) => r.abort = Some(h),
        None => {
            m.insert(id.to_string(), Running { kind: CancelKind::Lite(0), abort: Some(h) });
        }
    }
}

pub fn unregister(id: &str) {
    RUNNING.lock().unwrap().remove(id);
}

/// Cancels a running query: pg_cancel_backend / KILL QUERY / sqlite3_interrupt / drop the
/// SQL Server connection. Returns false when the query is not running any more.
pub async fn cancel(id: &str) -> Result<bool, String> {
    let info = {
        let m = RUNNING.lock().unwrap();
        let Some(r) = m.get(id) else { return Ok(false) };
        match &r.kind {
            CancelKind::Lite(ptr) => {
                if *ptr != 0 {
                    // SAFETY: the pointer belongs to a pool connection that is held by the running
                    // query; the entry is removed (under this lock) before the connection is released.
                    unsafe { libsqlite3_sys::sqlite3_interrupt(*ptr as *mut libsqlite3_sys::sqlite3) };
                    return Ok(true);
                }
                if let Some(a) = &r.abort {
                    a.abort();
                }
                return Ok(true);
            }
            CancelKind::Ms(m2) => {
                m2.poisoned.store(true, Ordering::SeqCst);
                if let Some(a) = &r.abort {
                    a.abort();
                }
                return Ok(true);
            }
            CancelKind::Pg(pid, pool) => Either::Left((*pid, pool.clone())),
            CancelKind::My(cid, pool) => Either::Right((*cid, pool.clone())),
        }
    };
    match info {
        Either::Left((pid, pool)) => {
            sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(&pool).await.map_err(err)?;
        }
        Either::Right((cid, pool)) => {
            sqlx::query(&format!("KILL QUERY {cid}")).execute(&pool).await.map_err(err)?;
        }
    }
    Ok(true)
}
