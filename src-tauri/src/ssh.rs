//! Remote development over SSH (pure Rust, via russh).
//!
//! One SSH connection per host carries everything: SFTP for files, `exec` channels for git /
//! search / agent commands, and PTY shell channels for terminals. Remote paths are addressed as
//! `ssh://<connId>/<absolute posix path>` throughout the app.

use crate::proc_util::err;
use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, RwLock};

pub const REMOTE_TERM_BASE: u32 = 1_000_000;

pub struct Conn {
    pub id: String,
    pub label: String,
    pub home: String,
    handle: Handle<Client>,
    pub sftp: SftpSession,
}

struct RemoteTerm {
    writer: ChannelWriteHalf<Msg>,
}

#[derive(Default)]
pub struct SshState {
    conns: RwLock<HashMap<String, Arc<Conn>>>,
    terms: Mutex<HashMap<u32, RemoteTerm>>,
    next_term: AtomicU32,
}

pub static SSH: LazyLock<SshState> = LazyLock::new(SshState::default);

pub async fn conn(id: &str) -> Result<Arc<Conn>, String> {
    SSH.conns
        .read()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| format!("NOT_CONNECTED:{id}: SSH host is not connected. Open the Remote panel to connect."))
}

// ---------------------------------------------------------------------------------------------
// Host key verification (trust on first use, like OpenSSH's known_hosts)
// ---------------------------------------------------------------------------------------------

struct Client {
    expected: Option<String>,
    seen: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &russh::keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        *self.seen.lock().unwrap() = Some(fp.clone());
        Ok(self.expected.as_deref() == Some(fp.as_str()))
    }
}

fn known_hosts_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let d = app.path().app_data_dir().map_err(err)?;
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d.join("known_hosts.json"))
}

fn load_known(app: &AppHandle) -> HashMap<String, String> {
    known_hosts_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_known(app: &AppHandle, map: &HashMap<String, String>) {
    if let Ok(p) = known_hosts_path(app) {
        let _ = std::fs::write(p, serde_json::to_string_pretty(map).unwrap_or_default());
    }
}

// ---------------------------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshParams {
    /// Stable id chosen by the UI (the saved host id) so `ssh://` paths survive reconnects.
    pub conn_id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// "auto" | "password" | "key" | "agent"
    pub auth: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    /// Fingerprint the user explicitly accepted (first connection or changed key).
    pub trust_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnected {
    conn_id: String,
    home: String,
    fingerprint: String,
}

fn default_keys(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let Ok(home) = app.path().home_dir() else { return vec![] };
    ["id_ed25519", "id_ecdsa", "id_rsa"].iter().map(|k| home.join(".ssh").join(k)).filter(|p| p.exists()).collect()
}

async fn try_key(handle: &mut Handle<Client>, user: &str, path: &std::path::Path, pass: Option<&str>) -> Result<bool, String> {
    let key = russh::keys::load_secret_key(path, pass).map_err(|e| {
        let m = e.to_string();
        if m.to_lowercase().contains("encrypted") || m.to_lowercase().contains("passphrase") {
            format!("KEY_PASSPHRASE: {} is protected by a passphrase", path.display())
        } else {
            format!("Cannot read key {}: {m}", path.display())
        }
    })?;
    let hash = handle.best_supported_rsa_hash().await.map_err(err)?.flatten();
    let res = handle
        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(err)?;
    Ok(res.success())
}

async fn try_agent(handle: &mut Handle<Client>, user: &str) -> Result<bool, String> {
    #[cfg(windows)]
    let mut agent = russh::keys::agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
        .await
        .map_err(|e| format!("ssh-agent not available: {e}"))?;
    #[cfg(not(windows))]
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| format!("ssh-agent not available: {e}"))?;
    let ids = agent.request_identities().await.map_err(err)?;
    let hash = handle.best_supported_rsa_hash().await.map_err(err)?.flatten();
    for id in ids {
        let pk = id.public_key().into_owned();
        if let Ok(r) = handle.authenticate_publickey_with(user, pk, hash, &mut agent).await {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn ssh_connect(app: AppHandle, params: SshParams) -> Result<SshConnected, String> {
    if params.conn_id.is_empty() || !params.conn_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid connection id".into());
    }
    let host_key = format!("{}:{}", params.host, params.port);
    let mut known = load_known(&app);
    let previously = known.get(&host_key).cloned();
    let seen = Arc::new(std::sync::Mutex::new(None));
    let handler = Client { expected: params.trust_fingerprint.clone().or(previously.clone()), seen: seen.clone() };
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 6,
        ..Default::default()
    });

    let connect = client::connect(config, (params.host.as_str(), params.port), handler);
    let mut handle = match tokio::time::timeout(Duration::from_secs(20), connect).await {
        Err(_) => return Err(format!("Timed out connecting to {host_key}")),
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            if let Some(fp) = seen.lock().unwrap().clone() {
                return Err(match previously {
                    None => format!("HOSTKEY_UNKNOWN:{fp}"),
                    Some(old) if old != fp => format!("HOSTKEY_CHANGED:{fp}"),
                    _ => format!("SSH handshake failed: {e}"),
                });
            }
            return Err(format!("Cannot connect to {host_key}: {e}"));
        }
    };
    let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();

    // Authenticate.
    let user = params.user.as_str();
    let mut ok = false;
    let mut last_err = String::new();
    let password = params.password.as_deref().filter(|p| !p.is_empty());
    match params.auth.as_str() {
        "password" => {
            let pw = password.ok_or("PASSWORD_REQUIRED")?;
            ok = handle.authenticate_password(user, pw).await.map_err(err)?.success();
        }
        "key" => {
            let path = params.key_path.clone().filter(|k| !k.is_empty()).ok_or("Choose a private key file")?;
            ok = try_key(&mut handle, user, std::path::Path::new(&path), params.passphrase.as_deref()).await?;
        }
        "agent" => ok = try_agent(&mut handle, user).await?,
        _ => {
            // auto: agent → default keys → password
            match try_agent(&mut handle, user).await {
                Ok(true) => ok = true,
                Ok(false) => {}
                Err(e) => last_err = e,
            }
            if !ok {
                let keys = params.key_path.clone().filter(|k| !k.is_empty()).map(|k| vec![k.into()]).unwrap_or_else(|| default_keys(&app));
                for k in keys {
                    match try_key(&mut handle, user, &k, params.passphrase.as_deref()).await {
                        Ok(true) => {
                            ok = true;
                            break;
                        }
                        Ok(false) => {}
                        Err(e) => last_err = e,
                    }
                }
            }
            if !ok {
                if let Some(pw) = password {
                    ok = handle.authenticate_password(user, pw).await.map_err(err)?.success();
                } else {
                    return Err(if last_err.starts_with("KEY_PASSPHRASE") { last_err } else { "PASSWORD_REQUIRED".into() });
                }
            }
        }
    }
    if !ok {
        return Err(format!("Authentication failed for {user}@{}{}", params.host, if last_err.is_empty() { String::new() } else { format!(" ({last_err})") }));
    }

    // Remember the host key only after a successful login.
    if previously.as_deref() != Some(fingerprint.as_str()) {
        known.insert(host_key, fingerprint.clone());
        save_known(&app, &known);
    }

    // SFTP subsystem.
    let ch = handle.channel_open_session().await.map_err(err)?;
    ch.request_subsystem(true, "sftp").await.map_err(err)?;
    let sftp = SftpSession::new(ch.into_stream()).await.map_err(|e| format!("SFTP is not available on this server: {e}"))?;
    let home = sftp.canonicalize(".").await.map_err(err)?;

    let c = Arc::new(Conn { id: params.conn_id.clone(), label: params.label.clone(), home: home.clone(), handle, sftp });
    if let Some(old) = SSH.conns.write().await.insert(params.conn_id.clone(), c) {
        let _ = old.handle.disconnect(russh::Disconnect::ByApplication, "reconnect", "en").await;
    }
    Ok(SshConnected { conn_id: params.conn_id, home, fingerprint })
}

#[tauri::command]
pub async fn ssh_disconnect(conn_id: String) -> Result<(), String> {
    if let Some(c) = SSH.conns.write().await.remove(&conn_id) {
        let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "bye", "en").await;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    conn_id: String,
    label: String,
    home: String,
}

#[tauri::command]
pub async fn ssh_list() -> Vec<ConnInfo> {
    SSH.conns
        .read()
        .await
        .values()
        .filter(|c| !c.handle.is_closed())
        .map(|c| ConnInfo { conn_id: c.id.clone(), label: c.label.clone(), home: c.home.clone() })
        .collect()
}

/// Opens a `direct-tcpip` channel (local port forwarding) to `host:port` as seen from the SSH
/// server. Used by the database client's SSH tunnels (src/db/tunnel.rs).
pub async fn open_direct_tcpip(conn_id: &str, host: &str, port: u16) -> Result<russh::ChannelStream<Msg>, String> {
    let c = conn(conn_id).await?;
    let ch = c
        .handle
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| format!("SSH tunnel to {host}:{port} failed: {e}"))?;
    Ok(ch.into_stream())
}

// ---------------------------------------------------------------------------------------------
// exec
// ---------------------------------------------------------------------------------------------

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

pub struct ExecOutput {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// Runs `command` through the remote login shell (`sh -c`), optionally in `cwd`.
pub async fn exec(conn_id: &str, cwd: Option<&str>, command: &str, timeout: Duration) -> Result<ExecOutput, String> {
    let c = conn(conn_id).await?;
    let full = match cwd {
        Some(d) => format!("cd {} && {}", shell_quote(d), command),
        None => command.to_string(),
    };
    let run = async {
        let mut ch = c.handle.channel_open_session().await.map_err(err)?;
        ch.exec(true, full.as_bytes()).await.map_err(err)?;
        let mut out = ExecOutput { code: -1, stdout: Vec::new(), stderr: Vec::new() };
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => out.stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => out.code = exit_status as i32,
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, String>(out)
    };
    tokio::time::timeout(timeout, run).await.map_err(|_| format!("Remote command timed out after {}s", timeout.as_secs()))?
}

// ---------------------------------------------------------------------------------------------
// Remote terminals (same `term-data` / `term-exit` events as local PTYs)
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct TermData {
    id: u32,
    data: String,
}

#[tauri::command]
pub async fn ssh_term_spawn(app: AppHandle, conn_id: String, cwd: Option<String>, cols: u32, rows: u32) -> Result<u32, String> {
    let c = conn(&conn_id).await?;
    let ch = c.handle.channel_open_session().await.map_err(err)?;
    ch.request_pty(true, "xterm-256color", cols.max(2), rows.max(2), 0, 0, &[]).await.map_err(err)?;
    ch.request_shell(true).await.map_err(err)?;
    let (mut reader, writer) = ch.split();
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        let _ = writer.data_bytes(format!("cd {} && clear\n", shell_quote(&d)).into_bytes()).await;
    }
    let id = REMOTE_TERM_BASE + SSH.next_term.fetch_add(1, Ordering::SeqCst) + 1;
    SSH.terms.lock().await.insert(id, RemoteTerm { writer });

    tauri::async_runtime::spawn(async move {
        let mut pending: Vec<u8> = Vec::new();
        while let Some(msg) = reader.wait().await {
            let bytes = match msg {
                ChannelMsg::Data { data } => data.to_vec(),
                ChannelMsg::ExtendedData { data, .. } => data.to_vec(),
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => continue,
            };
            pending.extend_from_slice(&bytes);
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => pending.len(),
            };
            if valid == 0 {
                continue;
            }
            let s = String::from_utf8_lossy(&pending[..valid]).to_string();
            pending.drain(..valid);
            let _ = app.emit("term-data", TermData { id, data: s });
        }
        SSH.terms.lock().await.remove(&id);
        let _ = app.emit("term-exit", id);
    });
    Ok(id)
}

#[tauri::command]
pub async fn ssh_term_write(id: u32, data: String) -> Result<(), String> {
    let terms = SSH.terms.lock().await;
    let t = terms.get(&id).ok_or("terminal not found")?;
    t.writer.data_bytes(data.into_bytes()).await.map_err(err)
}

#[tauri::command]
pub async fn ssh_term_resize(id: u32, cols: u32, rows: u32) -> Result<(), String> {
    let terms = SSH.terms.lock().await;
    let t = terms.get(&id).ok_or("terminal not found")?;
    t.writer.window_change(cols.max(2), rows.max(2), 0, 0).await.map_err(err)
}

#[tauri::command]
pub async fn ssh_term_kill(id: u32) -> Result<(), String> {
    if let Some(t) = SSH.terms.lock().await.remove(&id) {
        let _ = t.writer.eof().await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// ~/.ssh/config import
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    alias: String,
    host_name: String,
    user: String,
    port: u16,
    identity_file: String,
}

#[tauri::command]
pub fn ssh_config_hosts(app: AppHandle) -> Vec<ConfigHost> {
    let Ok(home) = app.path().home_dir() else { return vec![] };
    let Ok(text) = std::fs::read_to_string(home.join(".ssh").join("config")) else { return vec![] };
    let mut out: Vec<ConfigHost> = Vec::new();
    let mut cur: Vec<ConfigHost> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim().trim_matches('"').to_string()),
            None => continue,
        };
        match k.as_str() {
            "host" => {
                out.append(&mut cur);
                cur = v
                    .split_whitespace()
                    .filter(|a| !a.contains('*') && !a.contains('?'))
                    .map(|a| ConfigHost { alias: a.into(), host_name: a.into(), port: 22, ..Default::default() })
                    .collect();
            }
            "hostname" => cur.iter_mut().for_each(|h| h.host_name = v.clone()),
            "user" => cur.iter_mut().for_each(|h| h.user = v.clone()),
            "port" => cur.iter_mut().for_each(|h| h.port = v.parse().unwrap_or(22)),
            "identityfile" => {
                let p = if let Some(rest) = v.strip_prefix("~/") { home.join(rest).to_string_lossy().to_string() } else { v.clone() };
                cur.iter_mut().for_each(|h| h.identity_file = p.clone())
            }
            _ => {}
        }
    }
    out.append(&mut cur);
    out
}
