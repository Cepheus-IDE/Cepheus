//! Database client: PostgreSQL, MySQL/MariaDB, SQLite (sqlx, rustls, bundled SQLite) and SQL Server
//! (tiberius, rustls). Connection metadata lives in settings (`dbConnections`, synced here with
//! `db_set_connections`); passwords live in the OS keychain (`keyring`), never in settings.json.
//!
//! Every database of a connection gets its own pool, keyed by connection id + database name.
//! Optional SSH tunnels forward through an existing Remote-panel SSH connection.
//!
//! Safety: production / read-only connections reject non-SELECT statements unless the call carries
//! `confirmed: true`; destructive statements (DROP, TRUNCATE, ALTER … DROP, DELETE/UPDATE without
//! WHERE) need `confirmed: true` on every connection (see `safety`).

pub mod agent;
pub mod engine;
pub mod meta;
pub mod ops;
pub mod safety;
pub mod tunnel;
#[cfg(test)]
mod tests;

use engine::{Db, OpenParams};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const KEYRING_SERVICE: &str = "Cepheus IDE Database";

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    /// postgres | mysql | mariadb | sqlite | mssql
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    /// SQLite database file.
    pub file: String,
    /// disable | prefer | require | verify-ca | verify-full
    pub ssl_mode: String,
    pub color: String,
    pub production: bool,
    pub read_only: bool,
    /// Id of a saved SSH host (Remote panel) to tunnel through.
    pub ssh: Option<String>,
    pub timeout_secs: u64,
    /// SQL Server: accept self-signed certificates.
    pub trust_server_cert: bool,
}

impl ConnConfig {
    pub fn dialect(&self) -> safety::Dialect {
        safety::Dialect::from_kind(&self.kind)
    }
    fn timeout(&self) -> Duration {
        Duration::from_secs(if self.timeout_secs == 0 { 15 } else { self.timeout_secs.clamp(1, 300) })
    }
    fn default_port(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        match self.dialect() {
            safety::Dialect::Postgres => 5432,
            safety::Dialect::MySql => 3306,
            safety::Dialect::MsSql => 1433,
            safety::Dialect::Sqlite => 0,
        }
    }
}

static CONFIGS: LazyLock<RwLock<HashMap<String, ConnConfig>>> = LazyLock::new(Default::default);

struct Live {
    cfg: ConnConfig,
    password: String,
    host: String,
    port: u16,
    dbs: HashMap<String, Db>,
    _tunnel: Option<tunnel::Tunnel>,
}

static LIVE: LazyLock<tokio::sync::Mutex<HashMap<String, Live>>> = LazyLock::new(Default::default);

pub fn configs() -> Vec<ConnConfig> {
    let mut v: Vec<ConnConfig> = CONFIGS.read().unwrap().values().cloned().collect();
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    v
}

pub fn config(id: &str) -> Result<ConnConfig, String> {
    CONFIGS.read().unwrap().get(id).cloned().ok_or_else(|| format!("Unknown database connection '{id}'"))
}

/// Registers a config directly (tests and `db_test`).
#[cfg(test)]
pub fn register_config(c: ConnConfig) {
    CONFIGS.write().unwrap().insert(c.id.clone(), c);
}

// ---------------------------------------------------------------------------------------------
// keychain
// ---------------------------------------------------------------------------------------------

async fn secret_get(id: &str) -> Option<String> {
    let id = id.to_string();
    tokio::task::spawn_blocking(move || keyring::Entry::new(KEYRING_SERVICE, &id).ok()?.get_password().ok())
        .await
        .ok()
        .flatten()
}

#[tauri::command]
pub async fn db_save_password(id: String, password: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let e = keyring::Entry::new(KEYRING_SERVICE, &id).map_err(|e| e.to_string())?;
        if password.is_empty() {
            let _ = e.delete_credential();
            Ok(())
        } else {
            e.set_password(&password).map_err(|e| format!("Could not save the password in the system keychain: {e}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn db_delete_password(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &id) {
            let _ = e.delete_credential();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_has_password(id: String) -> bool {
    secret_get(&id).await.is_some()
}

// ---------------------------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn db_set_connections(connections: Vec<ConnConfig>) -> Result<(), String> {
    let ids: Vec<String> = connections.iter().map(|c| c.id.clone()).collect();
    let mut changed: Vec<String> = Vec::new();
    {
        let mut m = CONFIGS.write().unwrap();
        for c in &connections {
            if let Some(old) = m.get(&c.id) {
                if serde_json::to_string(old).ok() != serde_json::to_string(c).ok() {
                    changed.push(c.id.clone());
                }
            }
        }
        m.clear();
        for c in connections {
            m.insert(c.id.clone(), c);
        }
    }
    // Close connections that were removed or whose settings changed.
    let mut live = LIVE.lock().await;
    let stale: Vec<String> = live.keys().filter(|k| !ids.contains(k) || changed.contains(k)).cloned().collect();
    for k in stale {
        if let Some(l) = live.remove(&k) {
            for db in l.dbs.values() {
                db.close().await;
            }
        }
    }
    Ok(())
}

async fn open_live(cfg: &ConnConfig, password: Option<String>) -> Result<Live, String> {
    let password = match password {
        Some(p) => p,
        None if cfg.dialect() == safety::Dialect::Sqlite => String::new(),
        None => secret_get(&cfg.id).await.unwrap_or_default(),
    };
    let mut host = cfg.host.clone();
    let mut port = cfg.default_port();
    let mut tun = None;
    if let Some(ssh) = cfg.ssh.as_deref().filter(|s| !s.is_empty()) {
        if cfg.dialect() != safety::Dialect::Sqlite {
            let t = tunnel::start(ssh, if host.is_empty() { "127.0.0.1" } else { &host }, port).await?;
            host = "127.0.0.1".into();
            port = t.local_port;
            tun = Some(t);
        }
    }
    let db_name = cfg.database.clone();
    let db = Box::pin(engine::open(&open_params(cfg, &password, &host, port, &db_name))).await.map_err(|e| friendly(cfg, e))?;
    let mut dbs = HashMap::new();
    dbs.insert(db_name, db);
    Ok(Live { cfg: cfg.clone(), password, host, port, dbs, _tunnel: tun })
}

fn open_params(cfg: &ConnConfig, password: &str, host: &str, port: u16, database: &str) -> OpenParams {
    OpenParams {
        kind: cfg.kind.clone(),
        host: if host.is_empty() { "localhost".into() } else { host.to_string() },
        port,
        user: cfg.user.clone(),
        password: password.to_string(),
        database: database.to_string(),
        file: cfg.file.clone(),
        ssl_mode: cfg.ssl_mode.clone(),
        timeout: cfg.timeout(),
        trust_server_cert: cfg.trust_server_cert,
    }
}

fn friendly(cfg: &ConnConfig, e: String) -> String {
    let l = e.to_lowercase();
    if (l.contains("password authentication failed") || l.contains("access denied") || l.contains("login failed")) && cfg.dialect() != safety::Dialect::Sqlite {
        return format!("PASSWORD_REQUIRED: {e}");
    }
    e
}

/// The database handle for `id` (+ optional database), connecting on demand.
pub async fn get_db(id: &str, database: Option<&str>) -> Result<(Db, ConnConfig), String> {
    let cfg = config(id)?;
    let mut live = LIVE.lock().await;
    if !live.contains_key(id) {
        let l = Box::pin(open_live(&cfg, None)).await?;
        live.insert(id.to_string(), l);
    }
    let l = live.get_mut(id).unwrap();
    let want = database.filter(|d| !d.is_empty()).unwrap_or(&l.cfg.database).to_string();
    if cfg.dialect() == safety::Dialect::Sqlite {
        let db = l.dbs.values().next().cloned().ok_or("SQLite connection is closed")?;
        return Ok((db, cfg));
    }
    if let Some(db) = l.dbs.get(&want) {
        return Ok((db.clone(), cfg));
    }
    let db = Box::pin(engine::open(&open_params(&l.cfg, &l.password, &l.host, l.port, &want))).await?;
    l.dbs.insert(want, db.clone());
    Ok((db, cfg))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    server_version: String,
    database: String,
}

async fn server_version(db: &Db) -> String {
    let q = match db.dialect() {
        safety::Dialect::Postgres => "SELECT version() AS v",
        safety::Dialect::MySql => "SELECT VERSION() AS v",
        safety::Dialect::Sqlite => "SELECT 'SQLite ' || sqlite_version() AS v",
        safety::Dialect::MsSql => "SELECT CAST(@@VERSION AS nvarchar(400)) AS v",
    };
    match db.fetch(q, &[]).await {
        Ok((_, rows)) => rows.first().and_then(|r| r.first()).and_then(|v| v.as_str()).unwrap_or("").lines().next().unwrap_or("").to_string(),
        Err(e) => format!("(version unavailable: {e})"),
    }
}

#[tauri::command]
pub async fn db_connect(id: String, password: Option<String>) -> Result<ConnectInfo, String> {
    let cfg = config(&id)?;
    {
        let mut live = LIVE.lock().await;
        if let Some(old) = live.remove(&id) {
            for db in old.dbs.values() {
                db.close().await;
            }
        }
        let l = Box::pin(open_live(&cfg, password)).await?;
        live.insert(id.clone(), l);
    }
    let (db, cfg) = get_db(&id, None).await?;
    Ok(ConnectInfo { server_version: server_version(&db).await, database: cfg.database })
}

#[tauri::command]
pub async fn db_disconnect(id: String) -> Result<(), String> {
    if let Some(l) = LIVE.lock().await.remove(&id) {
        for db in l.dbs.values() {
            db.close().await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn db_status() -> Vec<String> {
    LIVE.lock().await.keys().cloned().collect()
}

/// Tests a (possibly unsaved) configuration. `password: None` uses the saved keychain entry.
#[tauri::command]
pub async fn db_test(config: ConnConfig, password: Option<String>) -> Result<String, String> {
    let l = Box::pin(open_live(&config, password)).await?;
    let db = l.dbs.values().next().cloned().ok_or("no database")?;
    let v = server_version(&db).await;
    db.close().await;
    Ok(v)
}

// ---------------------------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn db_list_databases(id: String) -> Result<Vec<String>, String> {
    let (db, cfg) = get_db(&id, None).await?;
    meta::list_databases(&db, &cfg.database).await
}

#[tauri::command]
pub async fn db_list_schemas(id: String, database: Option<String>) -> Result<Vec<String>, String> {
    let (db, _) = get_db(&id, database.as_deref()).await?;
    meta::list_schemas(&db, database.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub async fn db_list_objects(id: String, database: Option<String>, schema: String) -> Result<Vec<meta::DbObject>, String> {
    let (db, _) = get_db(&id, database.as_deref()).await?;
    meta::list_objects(&db, &schema).await
}

#[tauri::command]
pub async fn db_describe_table(id: String, database: Option<String>, schema: String, table: String) -> Result<meta::TableInfo, String> {
    let (db, _) = get_db(&id, database.as_deref()).await?;
    meta::describe_table(&db, &schema, &table).await
}

#[tauri::command]
pub async fn db_schema_overview(id: String, database: Option<String>, schema: String) -> Result<meta::SchemaOverview, String> {
    let (db, _) = get_db(&id, database.as_deref()).await?;
    meta::schema_overview(&db, &schema).await
}

// ---------------------------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub sql: String,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
    #[serde(default)]
    pub query_id: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
}

pub async fn query(req: QueryReq) -> Result<ops::QueryResponse, String> {
    let (db, cfg) = get_db(&req.id, req.database.as_deref()).await?;
    let guard = ops::Guard { production: cfg.production, read_only: cfg.read_only, confirmed: req.confirmed };
    let qid = req.query_id.clone();
    let task = tokio::spawn(async move {
        ops::run_query(&db, &req.sql, req.limit.unwrap_or(ops::DEFAULT_LIMIT), req.offset.unwrap_or(0), req.query_id.as_deref(), &guard).await
    });
    if let Some(q) = &qid {
        engine::attach_abort(q, task.abort_handle());
    }
    let res = task.await;
    if let Some(q) = &qid {
        engine::unregister(q);
    }
    match res {
        Ok(r) => r,
        Err(e) if e.is_cancelled() => Ok(ops::QueryResponse { cancelled: true, ..Default::default() }),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn db_query(req: QueryReq) -> Result<ops::QueryResponse, String> {
    query(req).await
}

#[tauri::command]
pub async fn db_cancel(query_id: String) -> Result<bool, String> {
    engine::cancel(&query_id).await
}

#[tauri::command]
pub async fn db_explain(id: String, database: Option<String>, sql: String, analyze: Option<bool>) -> Result<ops::ResultSet, String> {
    let (db, cfg) = get_db(&id, database.as_deref()).await?;
    // EXPLAIN ANALYZE executes the statement: never for writes on guarded connections.
    let analyze = analyze.unwrap_or(false) && (safety::all_read_only(&sql, cfg.dialect()) || !(cfg.production || cfg.read_only));
    ops::explain(&db, &sql, analyze).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowsReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub sort: Vec<ops::Sort>,
    #[serde(default)]
    pub filters: Vec<ops::Filter>,
    #[serde(default)]
    pub count: bool,
}

#[tauri::command]
pub async fn db_table_rows(req: TableRowsReq) -> Result<ops::TablePage, String> {
    let (db, _) = get_db(&req.id, req.database.as_deref()).await?;
    ops::table_rows(&db, &req.schema, &req.table, req.offset, req.limit.unwrap_or(200), &req.sort, &req.filters, req.count).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditsReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub schema: String,
    pub table: String,
    pub edits: Vec<ops::Edit>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[tauri::command]
pub async fn db_apply_edits(req: EditsReq) -> Result<ops::ApplyResult, String> {
    let (db, cfg) = get_db(&req.id, req.database.as_deref()).await?;
    if !req.dry_run && (cfg.production || cfg.read_only) && !req.confirmed {
        let label = if cfg.read_only { "read-only" } else { "production" };
        return Err(format!("CONFIRM_REQUIRED:{label}:EDIT: this connection is marked {label}. Confirm to save the changes."));
    }
    ops::apply_edits(&db, &req.schema, &req.table, &req.edits, req.dry_run).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    /// csv | tsv | json | sql
    pub format: String,
    pub path: String,
}

#[tauri::command]
pub async fn db_export(req: ExportReq) -> Result<u64, String> {
    let (db, _) = get_db(&req.id, req.database.as_deref()).await?;
    let d = db.dialect();
    let (sql, target) = match (&req.sql, &req.table) {
        (Some(s), _) if !s.trim().is_empty() => (s.clone(), req.table.clone().map(|t| safety::qualified(d, req.schema.as_deref().unwrap_or(""), &t)).unwrap_or_default()),
        (_, Some(t)) => {
            let q = safety::qualified(d, req.schema.as_deref().unwrap_or(""), t);
            (format!("SELECT * FROM {q}"), q)
        }
        _ => return Err("Nothing to export".into()),
    };
    ops::export(&db, &sql, &req.format, &req.path, &target).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub schema: String,
    pub table: String,
    pub path: String,
    pub mapping: Vec<ops::Mapping>,
    #[serde(default)]
    pub header: bool,
    #[serde(default)]
    pub delimiter: Option<String>,
    #[serde(default)]
    pub empty_as_null: bool,
    #[serde(default)]
    pub confirmed: bool,
}

fn delim(d: &Option<String>) -> char {
    match d.as_deref() {
        Some("\\t") | Some("tab") => '\t',
        Some(s) => s.chars().next().unwrap_or(','),
        None => ',',
    }
}

#[tauri::command]
pub async fn db_import_csv(req: ImportReq) -> Result<u64, String> {
    let (db, cfg) = get_db(&req.id, req.database.as_deref()).await?;
    if (cfg.production || cfg.read_only) && !req.confirmed {
        let label = if cfg.read_only { "read-only" } else { "production" };
        return Err(format!("CONFIRM_REQUIRED:{label}:IMPORT: this connection is marked {label}. Confirm to import."));
    }
    ops::import_csv(&db, &req.schema, &req.table, &req.path, &req.mapping, req.header, delim(&req.delimiter), req.empty_as_null).await
}

/// First rows of a CSV file for the import column mapper.
#[tauri::command]
pub async fn db_csv_preview(path: String, delimiter: Option<String>) -> Result<Vec<Vec<String>>, String> {
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Cannot read {path}: {e}"))?;
    let head = &bytes[..bytes.len().min(256 * 1024)];
    let text = String::from_utf8_lossy(head);
    let mut rows = ops::parse_csv(&text, delim(&delimiter));
    rows.truncate(21);
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------
// dump / restore (external tools; SQLite uses VACUUM INTO / script execution)
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DumpReq {
    pub id: String,
    #[serde(default)]
    pub database: Option<String>,
    pub path: String,
    pub job_id: String,
    #[serde(default)]
    pub confirmed: bool,
}

fn progress(app: &AppHandle, job: &str, line: &str, done: Option<bool>) {
    let _ = app.emit("db-progress", json!({ "jobId": job, "line": line, "done": done.is_some(), "ok": done.unwrap_or(false) }));
}

async fn run_tool(app: &AppHandle, job: &str, program: &str, args: &[String], env: &[(&str, String)], stdin_file: Option<&str>) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    let mut cmd = crate::proc_util::tokio_cmd(program);
    cmd.args(args).kill_on_drop(true).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    for (k, v) in env {
        cmd.env(k, v);
    }
    if let Some(f) = stdin_file {
        let file = std::fs::File::open(f).map_err(|e| format!("Cannot read {f}: {e}"))?;
        cmd.stdin(std::process::Stdio::from(file));
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{program} was not found on PATH. Install the {program} client tools to use dump/restore.")
        } else {
            format!("Cannot start {program}: {e}")
        }
    })?;
    progress(app, job, &format!("$ {program} {}", args.join(" ")), None);
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let (a1, j1) = (app.clone(), job.to_string());
    let t1 = tokio::spawn(async move {
        if let Some(e) = stderr {
            let mut lines = tokio::io::BufReader::new(e).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                progress(&a1, &j1, &l, None);
            }
        }
    });
    let (a2, j2) = (app.clone(), job.to_string());
    let t2 = tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut lines = tokio::io::BufReader::new(o).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                progress(&a2, &j2, &l, None);
            }
        }
    });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = tokio::join!(t1, t2);
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())))
    }
}

async fn tool_target(id: &str, database: Option<&str>) -> Result<(ConnConfig, String, String, u16, String), String> {
    get_db(id, database).await?; // connects (and opens the tunnel) if needed
    let live = LIVE.lock().await;
    let l = live.get(id).ok_or("not connected")?;
    let db = database.filter(|d| !d.is_empty()).unwrap_or(&l.cfg.database).to_string();
    Ok((l.cfg.clone(), l.password.clone(), l.host.clone(), l.port, db))
}

#[tauri::command]
pub async fn db_dump(app: AppHandle, req: DumpReq) -> Result<(), String> {
    let (cfg, pw, host, port, database) = tool_target(&req.id, req.database.as_deref()).await?;
    let res = match cfg.dialect() {
        safety::Dialect::Postgres => {
            let args: Vec<String> = vec!["-h".into(), host, "-p".into(), port.to_string(), "-U".into(), cfg.user.clone(), "-d".into(), database, "--verbose".into(), "--no-password".into(), "-f".into(), req.path.clone()];
            run_tool(&app, &req.job_id, "pg_dump", &args, &[("PGPASSWORD", pw)], None).await
        }
        safety::Dialect::MySql => {
            let args: Vec<String> = vec!["-h".into(), host, "-P".into(), port.to_string(), "-u".into(), cfg.user.clone(), "--single-transaction".into(), "--routines".into(), "--triggers".into(), "--verbose".into(), format!("--result-file={}", req.path), database];
            run_tool(&app, &req.job_id, "mysqldump", &args, &[("MYSQL_PWD", pw)], None).await
        }
        safety::Dialect::Sqlite => {
            let (db, _) = get_db(&req.id, None).await?;
            progress(&app, &req.job_id, &format!("VACUUM INTO {}", req.path), None);
            let _ = std::fs::remove_file(&req.path);
            db.fetch(&format!("VACUUM INTO {}", safety::quote_literal(safety::Dialect::Sqlite, &req.path)), &[]).await.map(|_| ())
        }
        safety::Dialect::MsSql => Err("SQL Server dumps need server-side BACKUP DATABASE (run it in a query tab); no client dump tool is bundled.".into()),
    };
    match &res {
        Ok(()) => progress(&app, &req.job_id, &format!("Done: {}", req.path), Some(true)),
        Err(e) => progress(&app, &req.job_id, e, Some(false)),
    }
    res
}

#[tauri::command]
pub async fn db_restore(app: AppHandle, req: DumpReq) -> Result<(), String> {
    if !req.confirmed {
        return Err("CONFIRM_REQUIRED:destructive:RESTORE: restoring a dump can overwrite data. Confirm to continue.".into());
    }
    let (cfg, pw, host, port, database) = tool_target(&req.id, req.database.as_deref()).await?;
    let res = match cfg.dialect() {
        safety::Dialect::Postgres => {
            let args: Vec<String> = vec!["-h".into(), host, "-p".into(), port.to_string(), "-U".into(), cfg.user.clone(), "-d".into(), database, "--no-password".into(), "-v".into(), "ON_ERROR_STOP=1".into(), "-f".into(), req.path.clone()];
            run_tool(&app, &req.job_id, "psql", &args, &[("PGPASSWORD", pw)], None).await
        }
        safety::Dialect::MySql => {
            let args: Vec<String> = vec!["-h".into(), host, "-P".into(), port.to_string(), "-u".into(), cfg.user.clone(), "--verbose".into(), database];
            run_tool(&app, &req.job_id, "mysql", &args, &[("MYSQL_PWD", pw)], Some(&req.path)).await
        }
        safety::Dialect::Sqlite => {
            let bytes = std::fs::read(&req.path).map_err(|e| e.to_string())?;
            if bytes.starts_with(b"SQLite format 3\0") {
                Err("This is a SQLite database file, not a SQL script: add it as a new SQLite connection instead.".into())
            } else {
                let sql = String::from_utf8_lossy(&bytes).to_string();
                progress(&app, &req.job_id, "Running script…", None);
                let (db, _) = get_db(&req.id, None).await?;
                let r = ops::run_query(&db, &sql, 1, 0, None, &ops::Guard { production: false, read_only: false, confirmed: true }).await?;
                match r.results.iter().find_map(|x| x.error.clone()) {
                    Some(e) => Err(e),
                    None => {
                        progress(&app, &req.job_id, &format!("{} statements executed", r.results.len()), None);
                        Ok(())
                    }
                }
            }
        }
        safety::Dialect::MsSql => Err("SQL Server restores need server-side RESTORE DATABASE; no client tool is bundled.".into()),
    };
    match &res {
        Ok(()) => progress(&app, &req.job_id, "Restore finished", Some(true)),
        Err(e) => progress(&app, &req.job_id, e, Some(false)),
    }
    res
}

/// Value helper for agent output.
pub fn cell_text(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Writes base64 data to a file the user picked (ER diagram PNG export).
#[tauri::command]
pub async fn db_save_bytes(path: String, base64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64.trim()).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes).await.map_err(|e| format!("Cannot write {path}: {e}"))
}
