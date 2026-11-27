//! Minimal Model Context Protocol client: JSON-RPC 2.0 over stdio (newline-delimited JSON) or
//! streamable HTTP (POST, JSON or SSE response). Only the tool surface is used:
//! `initialize`, `tools/list`, `tools/call`.
//!
//! Servers come from `<workspace>/.cepheus/mcp.json` and the `mcpServers` setting
//! (name → `{command, args, env}` or `{url, headers}`); workspace entries win on name clashes.
//! Tools are exposed to the model as `mcp__<server>__<tool>`.

use super::providers::ToolDef;
use crate::vfs;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;

const PROTOCOL_VERSION: &str = "2025-06-18";
const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const CALL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct StdioConn {
    stdin: Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>,
    pending: Pending,
    pid: Option<u32>,
    child: Mutex<Option<tokio::process::Child>>,
    stderr_tail: Arc<Mutex<String>>,
    alive: Arc<AtomicBool>,
}

struct HttpConn {
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    session_id: Mutex<Option<String>>,
    initialized: AtomicBool,
}

enum Transport {
    Stdio(StdioConn),
    Http(HttpConn),
}

pub struct Client {
    transport: Transport,
    next_id: AtomicU64,
}

fn str_map(v: Option<&Value>) -> Vec<(String, String)> {
    v.and_then(|v| v.as_object())
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect())
        .unwrap_or_default()
}

/// Finds an executable on PATH (with PATHEXT on Windows). `.cmd`/`.bat` shims need cmd.exe.
fn resolve_exe(command: &str) -> Option<std::path::PathBuf> {
    let p = std::path::Path::new(command);
    if p.components().count() > 1 && p.exists() {
        return Some(p.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into()).split(';').map(|s| s.to_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if cfg!(windows) && p.extension().is_some() {
            let c = dir.join(command);
            if c.is_file() {
                return Some(c);
            }
        }
        for e in &exts {
            let c = dir.join(format!("{command}{e}"));
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

fn win_quote(s: &str) -> String {
    if !s.is_empty() && !s.contains([' ', '\t', '"', '&', '|', '<', '>', '^', '(', ')']) {
        s.to_string()
    } else {
        format!("\"{}\"", s.replace('"', "\\\""))
    }
}

fn build_command(command: &str, args: &[String]) -> tokio::process::Command {
    let exe = resolve_exe(command);
    let direct = match &exe {
        Some(p) => !cfg!(windows) || p.extension().map(|e| matches!(e.to_string_lossy().to_lowercase().as_str(), "exe" | "com")).unwrap_or(false),
        None => !cfg!(windows),
    };
    if direct {
        let mut c = crate::proc_util::tokio_cmd(&exe.map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| command.to_string()));
        c.args(args);
        return c;
    }
    // Windows `.cmd` shims (npx, uvx installed via npm, ...) must run through cmd.exe.
    let line = std::iter::once(command.to_string()).chain(args.iter().cloned()).map(|a| win_quote(&a)).collect::<Vec<_>>().join(" ");
    #[allow(unused_mut)]
    let mut c = crate::proc_util::tokio_cmd("cmd.exe");
    #[cfg(windows)]
    {
        c.raw_arg("/D /S /C \"").raw_arg(&line).raw_arg("\"");
    }
    #[cfg(not(windows))]
    {
        c.arg("-c").arg(&line);
    }
    c
}

fn rpc_error(e: &Value) -> String {
    let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error");
    match e.get("code") {
        Some(c) => format!("MCP error {c}: {msg}"),
        None => format!("MCP error: {msg}"),
    }
}

impl Client {
    /// Connects and runs the `initialize` handshake.
    pub async fn connect(config: &Value, cwd: Option<&str>) -> Result<Client, String> {
        let transport = if let Some(url) = config.get("url").and_then(|u| u.as_str()) {
            Transport::Http(HttpConn {
                client: crate::net::builder().connect_timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?,
                url: url.to_string(),
                headers: str_map(config.get("headers")),
                session_id: Mutex::new(None),
                initialized: AtomicBool::new(false),
            })
        } else {
            let command = config.get("command").and_then(|c| c.as_str()).filter(|c| !c.trim().is_empty()).ok_or("Server config needs `command` or `url`")?;
            let args: Vec<String> = config
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| a.iter().map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).collect())
                .unwrap_or_default();
            let mut cmd = build_command(command, &args);
            cmd.envs(str_map(config.get("env")));
            if let Some(d) = config.get("cwd").and_then(|c| c.as_str()).or(cwd).filter(|d| !d.is_empty() && !vfs::is_remote(d)) {
                cmd.current_dir(d);
            }
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            let mut child = cmd.spawn().map_err(|e| format!("Failed to start `{command}`: {e}"))?;
            let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().ok_or("no stdin")?));
            let stdout = child.stdout.take().ok_or("no stdout")?;
            let mut stderr = child.stderr.take().ok_or("no stderr")?;
            let pending: Pending = Arc::default();
            let stderr_tail: Arc<Mutex<String>> = Arc::default();
            let alive = Arc::new(AtomicBool::new(true));

            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if t.len() > 4000 {
                        let mut cut = t.len() - 4000;
                        while !t.is_char_boundary(cut) {
                            cut += 1;
                        }
                        *t = t[cut..].to_string();
                    }
                }
            });

            let (p2, w2, a2, t2) = (pending.clone(), stdin.clone(), alive.clone(), stderr_tail.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    let msgs = if let Value::Array(a) = msg { a } else { vec![msg] };
                    for m in msgs {
                        handle_incoming(&m, &p2, Some(&w2)).await;
                    }
                }
                a2.store(false, Ordering::SeqCst);
                let detail = t2.lock().unwrap().trim().to_string();
                let err = if detail.is_empty() { "MCP server exited".to_string() } else { format!("MCP server exited: {detail}") };
                for (_, tx) in p2.lock().unwrap().drain() {
                    let _ = tx.send(Err(err.clone()));
                }
            });
            Transport::Stdio(StdioConn { stdin, pending, pid: child.id(), child: Mutex::new(Some(child)), stderr_tail, alive })
        };
        let client = Client { transport, next_id: AtomicU64::new(1) };
        let init = client
            .request_timeout(
                "initialize",
                json!({"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": {"name": "cepheus-ide", "version": env!("CARGO_PKG_VERSION")}}),
                INIT_TIMEOUT,
            )
            .await;
        if let Err(e) = init {
            client.close().await;
            return Err(e);
        }
        if let Transport::Http(h) = &client.transport {
            h.initialized.store(true, Ordering::SeqCst);
        }
        client.notify("notifications/initialized", json!({})).await?;
        Ok(client)
    }

    pub fn is_alive(&self) -> bool {
        match &self.transport {
            Transport::Stdio(s) => s.alive.load(Ordering::SeqCst),
            Transport::Http(_) => true,
        }
    }

    async fn request_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let fut = async {
            match &self.transport {
                Transport::Stdio(s) => {
                    if !s.alive.load(Ordering::SeqCst) {
                        return Err(format!("MCP server is not running. {}", s.stderr_tail.lock().unwrap().trim()));
                    }
                    let (tx, rx) = oneshot::channel();
                    s.pending.lock().unwrap().insert(id, tx);
                    let line = format!("{msg}\n");
                    s.stdin.lock().await.write_all(line.as_bytes()).await.map_err(|e| format!("MCP write failed: {e}"))?;
                    rx.await.map_err(|_| "MCP server closed the connection".to_string())?
                }
                Transport::Http(h) => {
                    let v = http_post(h, &msg, Some(id)).await?.ok_or("MCP server returned no response")?;
                    match v.get("error") {
                        Some(e) => Err(rpc_error(e)),
                        None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                    }
                }
            }
        };
        match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r,
            Err(_) => {
                if let Transport::Stdio(s) = &self.transport {
                    s.pending.lock().unwrap().remove(&id);
                }
                Err(format!("MCP request `{method}` timed out after {}s", timeout.as_secs()))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({"jsonrpc": "2.0", "method": method, "params": params});
        match &self.transport {
            Transport::Stdio(s) => s.stdin.lock().await.write_all(format!("{msg}\n").as_bytes()).await.map_err(|e| e.to_string()),
            Transport::Http(h) => http_post(h, &msg, None).await.map(|_| ()),
        }
    }

    pub async fn list_tools(&self) -> Result<Vec<ToolInfo>, String> {
        let mut out = vec![];
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let r = self.request_timeout("tools/list", params, INIT_TIMEOUT).await?;
            for t in r.get("tools").and_then(|t| t.as_array()).cloned().unwrap_or_default() {
                let Some(name) = t.get("name").and_then(|n| n.as_str()) else { continue };
                out.push(ToolInfo {
                    name: name.to_string(),
                    description: t.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(json!({"type": "object"})),
                });
            }
            cursor = r.get("nextCursor").and_then(|c| c.as_str()).map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Calls a tool and flattens its content into text. Returns (text, is_error).
    pub async fn call_tool(&self, name: &str, args: &Value) -> Result<(String, bool), String> {
        let args = if args.is_object() { args.clone() } else { json!({}) };
        let r = self.request_timeout("tools/call", json!({"name": name, "arguments": args}), CALL_TIMEOUT).await?;
        let is_error = r.get("isError").and_then(|b| b.as_bool()).unwrap_or(false);
        let mut parts = vec![];
        for c in r.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default() {
            match c.get("type").and_then(|t| t.as_str()) {
                Some("text") => parts.push(c.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string()),
                Some("resource") => {
                    let res = c.get("resource").cloned().unwrap_or_default();
                    match res.get("text").and_then(|t| t.as_str()) {
                        Some(t) => parts.push(t.to_string()),
                        None => parts.push(format!("[resource {}]", res.get("uri").and_then(|u| u.as_str()).unwrap_or(""))),
                    }
                }
                Some("resource_link") => parts.push(format!("[resource {}]", c.get("uri").and_then(|u| u.as_str()).unwrap_or(""))),
                Some(t) => parts.push(format!("[{t} content: {}]", c.get("mimeType").and_then(|m| m.as_str()).unwrap_or("binary"))),
                None => {}
            }
        }
        if parts.is_empty() {
            if let Some(s) = r.get("structuredContent") {
                parts.push(s.to_string());
            }
        }
        Ok((if parts.is_empty() { "(no output)".into() } else { parts.join("\n") }, is_error))
    }

    pub async fn close(&self) {
        match &self.transport {
            Transport::Stdio(s) => {
                s.alive.store(false, Ordering::SeqCst);
                // cmd.exe shims leave the real server as a grandchild: kill the whole tree.
                #[cfg(windows)]
                if let Some(pid) = s.pid {
                    let _ = crate::proc_util::std_cmd("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
                }
                let child = s.child.lock().unwrap().take();
                if let Some(mut c) = child {
                    let _ = c.start_kill();
                }
            }
            Transport::Http(h) => {
                let sid = h.session_id.lock().unwrap().clone();
                if let Some(sid) = sid {
                    let mut rb = h.client.delete(&h.url).header("Mcp-Session-Id", sid);
                    for (k, v) in &h.headers {
                        rb = rb.header(k, v);
                    }
                    let _ = tokio::time::timeout(Duration::from_secs(5), rb.send()).await;
                }
            }
        }
    }
}

/// Routes a message from the server: responses resolve pending requests; server requests
/// (`ping`, `roots/list`, ...) get a minimal reply so servers don't stall.
async fn handle_incoming(m: &Value, pending: &Pending, writer: Option<&Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>>) {
    let id = m.get("id");
    if let Some(method) = m.get("method").and_then(|x| x.as_str()) {
        if let (Some(id), Some(w)) = (id, writer) {
            let reply = match method {
                "ping" => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
                "roots/list" => json!({"jsonrpc": "2.0", "id": id, "result": {"roots": []}}),
                _ => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not supported by client"}}),
            };
            let _ = w.lock().await.write_all(format!("{reply}\n").as_bytes()).await;
        }
        return;
    }
    let Some(id) = id.and_then(|i| i.as_u64()) else { return };
    let Some(tx) = pending.lock().unwrap().remove(&id) else { return };
    let _ = tx.send(match m.get("error") {
        Some(e) => Err(rpc_error(e)),
        None => Ok(m.get("result").cloned().unwrap_or(Value::Null)),
    });
}

fn find_response(v: Value, id: u64) -> Option<Value> {
    match v {
        Value::Array(a) => a.into_iter().find_map(|x| find_response(x, id)),
        v if v.get("id").and_then(|i| i.as_u64()) == Some(id) && v.get("method").is_none() => Some(v),
        _ => None,
    }
}

/// Streamable HTTP transport: one POST per message; the reply is JSON or an SSE stream.
async fn http_post(h: &HttpConn, msg: &Value, expect: Option<u64>) -> Result<Option<Value>, String> {
    let mut rb = h
        .client
        .post(&h.url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    if h.initialized.load(Ordering::SeqCst) {
        rb = rb.header("MCP-Protocol-Version", PROTOCOL_VERSION);
    }
    if let Some(sid) = h.session_id.lock().unwrap().clone() {
        rb = rb.header("Mcp-Session-Id", sid);
    }
    for (k, v) in &h.headers {
        rb = rb.header(k, v);
    }
    let mut resp = rb.body(msg.to_string()).send().await.map_err(|e| format!("MCP HTTP error: {e}"))?;
    if let Some(sid) = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *h.session_id.lock().unwrap() = Some(sid.to_string());
    }
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("MCP HTTP {}: {}", status.as_u16(), text.chars().take(500).collect::<String>()));
    }
    let Some(id) = expect else { return Ok(None) };
    let ct = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    if ct.starts_with("text/event-stream") {
        let mut buf = String::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("MCP stream error: {e}"))? {
            buf.push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
            while let Some(end) = buf.find("\n\n") {
                let event: String = buf.drain(..end + 2).collect();
                if let Some(v) = parse_sse_event(&event).and_then(|v| find_response(v, id)) {
                    return Ok(Some(v));
                }
            }
        }
        if let Some(v) = parse_sse_event(&buf).and_then(|v| find_response(v, id)) {
            return Ok(Some(v));
        }
        return Err("MCP SSE stream ended without a response".into());
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Bad JSON from MCP server: {e}"))?;
    Ok(find_response(v, id))
}

fn parse_sse_event(event: &str) -> Option<Value> {
    let data: Vec<&str> = event
        .lines()
        .filter_map(|l| l.strip_prefix("data:"))
        .map(|d| d.strip_prefix(' ').unwrap_or(d))
        .collect();
    if data.is_empty() {
        return None;
    }
    serde_json::from_str(&data.join("\n")).ok()
}

// ---------------------------------------------------------------------------------------------
// Manager: configured servers, lifecycle, tool routing
// ---------------------------------------------------------------------------------------------

struct Entry {
    config: Value,
    #[allow(dead_code)]
    source: String,
    status: String,
    error: Option<String>,
    client: Option<Arc<Client>>,
    tools: Vec<ToolInfo>,
    /// Set by an explicit Stop; keeps `ensure` from restarting it.
    user_stopped: bool,
}

#[derive(Default)]
pub struct McpManager {
    servers: tokio::sync::Mutex<HashMap<String, Entry>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub name: String,
    pub source: String,
    pub status: String,
    pub error: Option<String>,
    pub tools: Vec<ToolInfo>,
    pub config: Value,
    pub transport: String,
}

fn servers_of(v: &Value) -> Vec<(String, Value)> {
    let obj = v.get("servers").or_else(|| v.get("mcpServers")).unwrap_or(v);
    obj.as_object()
        .map(|o| {
            o.iter()
                .filter(|(_, c)| c.is_object() && !c.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false))
                .map(|(k, c)| (k.clone(), c.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Global servers from settings plus `<ws>/.cepheus/mcp.json` (workspace wins).
pub async fn configured(ws: &str, global: Option<&Value>) -> Vec<(String, Value, String)> {
    let mut out: Vec<(String, Value, String)> = global.map(servers_of).unwrap_or_default().into_iter().map(|(n, c)| (n, c, "user".into())).collect();
    if !ws.is_empty() {
        let p = vfs::join(&vfs::join(ws, ".cepheus"), "mcp.json");
        if vfs::exists(&p).await {
            if let Ok(text) = vfs::read_text(&p).await {
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => {
                        for (n, c) in servers_of(&v) {
                            out.retain(|(x, _, _)| x != &n);
                            out.push((n, c, "workspace".into()));
                        }
                    }
                    Err(e) => out.push(("mcp.json".into(), json!({"error": format!(".cepheus/mcp.json: {e}")}), "workspace".into())),
                }
            }
        }
    }
    out
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

pub fn exposed_name(server: &str, tool: &str) -> String {
    let mut n = format!("mcp__{}__{}", sanitize(server), sanitize(tool));
    n.truncate(64); // OpenAI-style tool name limit
    n
}

/// ToolDef needs `&'static str`; MCP names are dynamic, so intern them (bounded by distinct names).
fn intern(s: String) -> &'static str {
    static POOL: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let mut pool = POOL.get_or_init(Default::default).lock().unwrap();
    if let Some(x) = pool.get(s.as_str()) {
        return x;
    }
    let leaked: &'static str = Box::leak(s.into_boxed_str());
    pool.insert(leaked);
    leaked
}

fn clean_schema(s: &Value) -> Value {
    let mut s = if s.is_object() { s.clone() } else { json!({"type": "object"}) };
    if let Some(o) = s.as_object_mut() {
        o.remove("$schema");
        o.entry("type").or_insert(json!("object"));
        if o.get("type") == Some(&json!("object")) {
            o.entry("properties").or_insert(json!({}));
        }
    }
    s
}

impl McpManager {
    async fn start_one(&self, name: &str, config: Value, source: String, cwd: Option<String>) {
        {
            let mut map = self.servers.lock().await;
            map.insert(
                name.to_string(),
                Entry { config: config.clone(), source: source.clone(), status: "starting".into(), error: None, client: None, tools: vec![], user_stopped: false },
            );
        }
        let res = if !crate::policy::mcp_allowed(name) {
            Err("Blocked by your organization's policy (allowedMcpServers).".to_string())
        } else if let Some(e) = config.get("error").and_then(|e| e.as_str()) {
            Err(e.to_string())
        } else {
            match Client::connect(&config, cwd.as_deref()).await {
                Ok(c) => match c.list_tools().await {
                    Ok(t) => Ok((Arc::new(c), t)),
                    Err(e) => {
                        c.close().await;
                        Err(e)
                    }
                },
                Err(e) => Err(e),
            }
        };
        let mut map = self.servers.lock().await;
        let Some(entry) = map.get_mut(name) else { return };
        match res {
            Ok((c, tools)) => {
                entry.status = "running".into();
                entry.client = Some(c);
                entry.tools = tools;
            }
            Err(e) => {
                entry.status = "error".into();
                entry.error = Some(e);
            }
        }
    }

    /// Starts configured servers that are not running yet (skips ones the user stopped or
    /// that failed with the same config), restarts ones whose config changed, and stops
    /// servers that were removed from the config.
    pub async fn ensure(&self, ws: &str, global: Option<&Value>) {
        let cfgs = configured(ws, global).await;
        let names: HashSet<String> = cfgs.iter().map(|(n, _, _)| n.clone()).collect();
        let removed: Vec<Arc<Client>> = {
            let mut map = self.servers.lock().await;
            let gone: Vec<String> = map.keys().filter(|k| !names.contains(*k)).cloned().collect();
            gone.iter().filter_map(|k| map.remove(k)).filter_map(|e| e.client).collect()
        };
        for c in removed {
            c.close().await;
        }
        let cwd = (!vfs::is_remote(ws) && !ws.is_empty()).then(|| ws.to_string());
        for (name, config, source) in cfgs {
            let action = {
                let map = self.servers.lock().await;
                match map.get(&name) {
                    None => true,
                    Some(e) if e.config != config => true,
                    Some(e) if e.user_stopped || e.status == "error" || e.status == "starting" => false,
                    Some(e) => e.client.as_ref().map(|c| !c.is_alive()).unwrap_or(true),
                }
            };
            if action {
                let old = self.servers.lock().await.remove(&name).and_then(|e| e.client);
                if let Some(c) = old {
                    c.close().await;
                }
                self.start_one(&name, config, source, cwd.clone()).await;
            }
        }
    }

    pub async fn start(&self, ws: &str, global: Option<&Value>, name: &str) -> Result<(), String> {
        let (_, config, source) = configured(ws, global).await.into_iter().find(|(n, _, _)| n == name).ok_or_else(|| format!("No MCP server named '{name}'"))?;
        self.stop(name).await;
        let cwd = (!vfs::is_remote(ws) && !ws.is_empty()).then(|| ws.to_string());
        self.start_one(name, config, source, cwd).await;
        let map = self.servers.lock().await;
        match map.get(name) {
            Some(e) if e.status == "error" => Err(e.error.clone().unwrap_or_default()),
            _ => Ok(()),
        }
    }

    pub async fn stop(&self, name: &str) {
        let client = {
            let mut map = self.servers.lock().await;
            let Some(e) = map.get_mut(name) else { return };
            e.user_stopped = true;
            e.status = "stopped".into();
            e.tools.clear();
            e.error = None;
            e.client.take()
        };
        if let Some(c) = client {
            c.close().await;
        }
    }

    pub async fn status(&self, ws: &str, global: Option<&Value>) -> Vec<ServerStatus> {
        let cfgs = configured(ws, global).await;
        let map = self.servers.lock().await;
        cfgs.into_iter()
            .map(|(name, config, source)| {
                let e = map.get(&name).filter(|e| e.config == config);
                let alive = e.and_then(|e| e.client.as_ref()).map(|c| c.is_alive()).unwrap_or(true);
                ServerStatus {
                    transport: if config.get("url").is_some() { "http".into() } else { "stdio".into() },
                    status: match e {
                        Some(e) if e.status == "running" && !alive => "error".into(),
                        Some(e) => e.status.clone(),
                        None => "stopped".into(),
                    },
                    error: e.and_then(|e| e.error.clone()).or_else(|| (!alive).then(|| "Server process exited".to_string())),
                    tools: e.map(|e| e.tools.clone()).unwrap_or_default(),
                    name,
                    source,
                    config,
                }
            })
            .collect()
    }

    /// Tool definitions for every running server.
    pub async fn tool_defs(&self) -> Vec<ToolDef> {
        let map = self.servers.lock().await;
        let mut out = vec![];
        for (server, e) in map.iter().filter(|(_, e)| e.status == "running") {
            for t in &e.tools {
                let desc = format!("[MCP server '{server}'] {}", t.description);
                out.push(ToolDef { name: intern(exposed_name(server, &t.name)), description: intern(desc), schema: clean_schema(&t.input_schema) });
            }
        }
        out.sort_by(|a, b| a.name.cmp(b.name));
        out
    }

    pub async fn call(&self, exposed: &str, args: &Value) -> Result<(String, bool), String> {
        let (client, tool) = {
            let map = self.servers.lock().await;
            map.iter()
                .filter(|(_, e)| e.status == "running")
                .find_map(|(s, e)| e.tools.iter().find(|t| exposed_name(s, &t.name) == exposed).map(|t| (e.client.clone(), t.name.clone())))
                .ok_or_else(|| format!("MCP tool '{exposed}' is not available (server stopped?)"))?
        };
        let client = client.ok_or("MCP server is not running")?;
        client.call_tool(&tool, args).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake stdio MCP server (Node): answers initialize, tools/list (paginated), tools/call,
    /// and sends a server->client ping before replying to the first call.
    const FAKE_SERVER: &str = r#"
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let pinged = false;
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  else if (m.method === 'tools/list' && !m.params.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], nextCursor: 'p2' } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'fail', description: 'Always fails' }] } });
  else if (m.method === 'tools/call') {
    if (!pinged) { pinged = true; send({ jsonrpc: '2.0', id: 'srv1', method: 'ping' }); }
    if (m.params.name === 'echo') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo: ' + m.params.arguments.text }] } });
    else if (m.params.name === 'fail') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
  } else if (m.id === 'srv1') { /* pong from client */ }
});
"#;

    #[tokio::test]
    async fn stdio_client_against_fake_server() {
        if resolve_exe("node").is_none() {
            eprintln!("node not found; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cepheus-mcp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-mcp.js");
        std::fs::write(&script, FAKE_SERVER).unwrap();
        let cfg = json!({"command": "node", "args": [script.to_string_lossy()]});

        let mgr = McpManager::default();
        let global = json!({"fake": cfg});
        mgr.ensure("", Some(&global)).await;
        let st = mgr.status("", Some(&global)).await;
        assert_eq!(st[0].status, "running", "{:?}", st[0].error);
        assert_eq!(st[0].tools.len(), 2);
        let defs = mgr.tool_defs().await;
        assert_eq!(defs.iter().map(|d| d.name).collect::<Vec<_>>(), vec!["mcp__fake__echo", "mcp__fake__fail"]);
        assert_eq!(mgr.call("mcp__fake__echo", &json!({"text": "hi"})).await.unwrap(), ("echo: hi".to_string(), false));
        assert_eq!(mgr.call("mcp__fake__fail", &json!({})).await.unwrap(), ("boom".to_string(), true));
        mgr.stop("fake").await;
        assert!(mgr.call("mcp__fake__echo", &json!({})).await.is_err());
        let st = mgr.status("", Some(&global)).await;
        assert_eq!(st[0].status, "stopped");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sse_parsing() {
        let v = parse_sse_event("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}\n\n").unwrap();
        assert!(find_response(v, 3).is_some());
        assert_eq!(exposed_name("my server", "do.it"), "mcp__my_server__do_it");
    }
}
