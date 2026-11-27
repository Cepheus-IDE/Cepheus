//! Agent harnesses: runs the Claude Code CLI (`claude -p --output-format stream-json`) or the
//! Codex CLI (`codex exec --json`) headless in the workspace and translates their JSON event
//! streams into Cepheus `agent-event`s, so they render in the same chat UI as the built-in agent.
//! The CLI's own session id is reported back (`harness-session`) and passed on follow-ups to keep
//! the conversation going.

use crate::proc_util::{std_cmd, tokio_cmd};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessReq {
    pub session_id: String,
    /// "claude-code" | "codex"
    pub harness: String,
    pub workspace: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<String>,
    /// The CLI's session/thread id from the previous turn (conversation continuity).
    #[serde(default)]
    pub resume_id: Option<String>,
    /// "ask" | "auto-edit" | "turbo"
    #[serde(default)]
    pub approval_mode: String,
    #[serde(default)]
    pub model: Option<String>,
}

struct Running {
    pid: Option<u32>,
    cancelled: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<HashMap<String, Running>> {
    static R: OnceLock<Mutex<HashMap<String, Running>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Full path of a CLI on PATH, preferring a real executable over npm's shims.
fn resolve(exe: &str) -> Option<String> {
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = std_cmd(finder).arg(exe).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let paths: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if !cfg!(windows) {
        return paths.into_iter().next();
    }
    let by_ext = |ext: &str| paths.iter().find(|p| p.to_lowercase().ends_with(ext)).cloned();
    by_ext(".exe").or_else(|| by_ext(".cmd")).or_else(|| by_ext(".bat"))
}

/// Only plain tokens go on the command line (the prompt goes through stdin), so `.cmd` shims
/// can't be confused by shell metacharacters.
fn safe_token(s: &str) -> bool {
    !s.is_empty() && s.len() < 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/[]@".contains(c))
}

fn install_hint(harness: &str) -> &'static str {
    match harness {
        "claude-code" => "Install Claude Code (npm install -g @anthropic-ai/claude-code, or the native installer from claude.com/claude-code), run `claude` once to sign in, then restart Cepheus.",
        _ => "Install the Codex CLI (npm install -g @openai/codex), run `codex` once to sign in, then restart Cepheus.",
    }
}

fn harness_name(harness: &str) -> &'static str {
    if harness == "claude-code" { "Claude Code" } else { "Codex" }
}

fn build_args(req: &HarnessReq) -> Vec<String> {
    let s = |x: &str| x.to_string();
    let model = req.model.as_deref().map(str::trim).filter(|m| safe_token(m) && *m != "default");
    let resume = req.resume_id.as_deref().filter(|r| safe_token(r));
    let mut a: Vec<String> = Vec::new();
    if req.harness == "claude-code" {
        a.extend([s("-p"), s("--output-format"), s("stream-json"), s("--verbose")]);
        match req.approval_mode.as_str() {
            "auto-edit" => a.extend([s("--permission-mode"), s("acceptEdits")]),
            "turbo" => a.extend([s("--permission-mode"), s("bypassPermissions")]),
            _ => {} // headless default: tools needing approval are denied and reported
        }
        if let Some(m) = model {
            a.extend([s("--model"), s(m)]);
        }
        if let Some(r) = resume {
            a.extend([s("--resume"), s(r)]);
        }
    } else {
        a.extend([s("exec"), s("--json"), s("--skip-git-repo-check")]);
        match req.approval_mode.as_str() {
            "auto-edit" => a.push(s("--full-auto")),
            "turbo" => a.push(s("--dangerously-bypass-approvals-and-sandbox")),
            _ => a.extend([s("--sandbox"), s("read-only")]),
        }
        if let Some(m) = model {
            a.extend([s("--model"), s(m)]);
        }
        if let Some(r) = resume {
            a.extend([s("resume"), s(r)]);
        }
        a.push(s("-")); // read the prompt from stdin
    }
    a
}

/// Translates one CLI's JSON lines into chat events.
struct Translator {
    app: AppHandle,
    sid: String,
    harness: String,
    workspace: String,
    model: String,
    texts: usize,
    tool_names: HashMap<String, String>,
    got_result: bool,
}

impl Translator {
    fn ev(&self, mut v: Value) {
        v["sessionId"] = json!(self.sid);
        let _ = self.app.emit("agent-event", v);
    }

    fn text(&mut self, t: &str) {
        if !t.trim().is_empty() {
            self.texts += 1;
            self.ev(json!({"type": "text", "text": t}));
        }
    }

    fn resume_id(&self, id: &str) {
        let _ = self.app.emit("harness-session", json!({"sessionId": self.sid, "harness": self.harness, "resumeId": id, "model": self.model}));
    }

    fn usage(&self, input: u64, output: u64, cache_read: u64, cache_write: u64) {
        self.ev(json!({"type": "usage", "inputTokens": input, "outputTokens": output}));
        let _ = self.app.emit(
            "model-usage",
            json!({
                "sessionId": self.sid, "provider": self.harness, "source": self.harness,
                "model": if self.model.is_empty() { self.harness.clone() } else { self.model.clone() },
                "inputTokens": input, "outputTokens": output, "cacheRead": cache_read, "cacheWrite": cache_write,
                "unavailable": [],
            }),
        );
    }

    /// Workspace-relative path with forward slashes (the chat's tool items expect that).
    fn rel(&self, p: &str) -> String {
        let norm = |s: &str| s.replace('\\', "/");
        let (p2, ws) = (norm(p), norm(&self.workspace));
        let ws = ws.trim_end_matches('/');
        let rest = if !ws.is_empty() && p2.to_lowercase().starts_with(&ws.to_lowercase()) { &p2[ws.len()..] } else { &p2[..] };
        let r = rest.trim_start_matches('/');
        if r.is_empty() { ".".into() } else { r.to_string() }
    }

    fn plan(&self, items: Vec<Value>) {
        self.ev(json!({"type": "plan", "items": items}));
    }

    fn tool_call(&mut self, id: &str, name: &str, args: Value) {
        self.tool_names.insert(id.to_string(), name.to_string());
        self.ev(json!({"type": "toolCall", "callId": id, "name": name, "args": args}));
    }

    fn tool_result(&self, id: &str, output: &str, is_error: bool) {
        let name = self.tool_names.get(id).cloned().unwrap_or_default();
        let mut out: String = output.chars().take(20000).collect();
        if output.len() > out.len() {
            out.push_str("\n…");
        }
        self.ev(json!({"type": "toolResult", "callId": id, "name": name, "output": out, "isError": is_error}));
    }

    // ----------------------------------------------------------------- Claude Code (stream-json)

    fn claude_tool(&self, name: &str, input: &Value) -> (String, Value) {
        let path = |k: &str| json!(self.rel(input[k].as_str().unwrap_or("")));
        match name {
            "Bash" => ("run_command".into(), json!({"command": input["command"]})),
            "Read" => ("read_file".into(), json!({"path": path("file_path")})),
            "Edit" => ("edit_file".into(), json!({"path": path("file_path"), "old_str": input["old_string"], "new_str": input["new_string"]})),
            "MultiEdit" | "NotebookEdit" => ("edit_file".into(), json!({"path": path(if name == "MultiEdit" { "file_path" } else { "notebook_path" })})),
            "Write" => ("write_file".into(), json!({"path": path("file_path"), "content": input["content"]})),
            "Glob" => ("find_files".into(), json!({"pattern": input["pattern"]})),
            "Grep" => ("search".into(), json!({"query": input["pattern"]})),
            "LS" => ("list_dir".into(), json!({"path": path("path")})),
            other => (other.to_string(), input.clone()),
        }
    }

    fn claude(&mut self, v: &Value) {
        match v["type"].as_str() {
            Some("system") if v["subtype"] == "init" => {
                if let Some(m) = v["model"].as_str() {
                    self.model = m.to_string();
                }
                if let Some(id) = v["session_id"].as_str() {
                    self.resume_id(id);
                }
            }
            Some("assistant") => {
                if let Some(m) = v.pointer("/message/model").and_then(|m| m.as_str()) {
                    self.model = m.to_string();
                }
                for b in v.pointer("/message/content").and_then(|c| c.as_array()).into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => self.text(b["text"].as_str().unwrap_or("")),
                        Some("thinking") => {
                            if let Some(t) = b["thinking"].as_str().filter(|t| !t.trim().is_empty()) {
                                self.ev(json!({"type": "thinking", "text": t}));
                            }
                        }
                        Some("tool_use") => {
                            let id = b["id"].as_str().unwrap_or_default().to_string();
                            let name = b["name"].as_str().unwrap_or_default();
                            if name == "TodoWrite" {
                                let items: Vec<Value> = b.pointer("/input/todos").and_then(|t| t.as_array()).into_iter().flatten().map(|t| {
                                    let st = match t["status"].as_str() { Some("completed") => "done", Some("in_progress") => "in_progress", _ => "pending" };
                                    json!({"text": t["content"].as_str().unwrap_or(""), "status": st})
                                }).collect();
                                self.plan(items);
                                self.tool_names.insert(id, "update_plan".into());
                                continue;
                            }
                            let (n, args) = self.claude_tool(name, &b["input"]);
                            self.tool_call(&id, &n, args);
                        }
                        _ => {}
                    }
                }
            }
            Some("user") => {
                for b in v.pointer("/message/content").and_then(|c| c.as_array()).into_iter().flatten() {
                    if b["type"] != "tool_result" {
                        continue;
                    }
                    let id = b["tool_use_id"].as_str().unwrap_or_default();
                    if self.tool_names.get(id).map(|n| n == "update_plan").unwrap_or(false) {
                        continue;
                    }
                    let out = match &b["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    self.tool_result(id, &out, b["is_error"].as_bool().unwrap_or(false));
                }
            }
            Some("result") => {
                self.got_result = true;
                if let Some(id) = v["session_id"].as_str() {
                    self.resume_id(id);
                }
                let u = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(|x| x.as_u64()).unwrap_or(0);
                let (cr, cw) = (u("cache_read_input_tokens"), u("cache_creation_input_tokens"));
                self.usage(u("input_tokens") + cr + cw, u("output_tokens"), cr, cw);
                let result = v["result"].as_str().unwrap_or("");
                if v["is_error"].as_bool() == Some(true) || v["subtype"].as_str().map(|s| s != "success").unwrap_or(false) {
                    let msg = if result.is_empty() { format!("Claude Code stopped: {}", v["subtype"].as_str().unwrap_or("error")) } else { result.to_string() };
                    self.ev(json!({"type": "error", "message": msg}));
                } else if self.texts == 0 {
                    self.text(result);
                }
                if let Some(d) = v["permission_denials"].as_array().filter(|d| !d.is_empty()) {
                    let names: Vec<&str> = d.iter().filter_map(|x| x["tool_name"].as_str()).collect();
                    self.ev(json!({"type": "warning", "message": format!(
                        "Claude Code was not allowed to use {} tool call(s) ({}). Headless runs can't ask for approval: switch the review policy to Auto-edit or Turbo to let it edit files and run commands.",
                        d.len(), names.join(", "))}));
                }
            }
            _ => {}
        }
    }

    // ----------------------------------------------------------------- Codex (exec --json)

    fn codex(&mut self, v: &Value) {
        let item = &v["item"];
        let id = item["id"].as_str().unwrap_or_default().to_string();
        match (v["type"].as_str().unwrap_or(""), item["type"].as_str().unwrap_or("")) {
            ("thread.started", _) => {
                if let Some(t) = v["thread_id"].as_str() {
                    self.resume_id(t);
                }
            }
            ("item.started", "command_execution") => self.tool_call(&id, "run_command", json!({"command": item["command"]})),
            (_, "todo_list") => {
                let items = item["items"].as_array().into_iter().flatten().map(|t| {
                    json!({"text": t["text"].as_str().unwrap_or(""), "status": if t["completed"].as_bool() == Some(true) { "done" } else { "pending" }})
                }).collect();
                self.plan(items);
            }
            ("item.completed", kind) => match kind {
                "agent_message" => self.text(item["text"].as_str().unwrap_or("")),
                "reasoning" => {
                    if let Some(t) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                        self.ev(json!({"type": "thinking", "text": t}));
                    }
                }
                "command_execution" => {
                    if !self.tool_names.contains_key(&id) {
                        self.tool_call(&id, "run_command", json!({"command": item["command"]}));
                    }
                    let failed = item["exit_code"].as_i64().map(|c| c != 0).unwrap_or(false) || item["status"] == "failed";
                    self.tool_result(&id, item["aggregated_output"].as_str().unwrap_or(""), failed);
                }
                "file_change" => {
                    for (i, ch) in item["changes"].as_array().into_iter().flatten().enumerate() {
                        let cid = format!("{id}-{i}");
                        let name = if ch["kind"] == "add" { "write_file" } else { "edit_file" };
                        self.tool_call(&cid, name, json!({"path": self.rel(ch["path"].as_str().unwrap_or(""))}));
                        self.tool_result(&cid, ch["kind"].as_str().unwrap_or("update"), item["status"] == "failed");
                    }
                }
                "mcp_tool_call" => {
                    let name = format!("{}.{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or("tool"));
                    self.tool_call(&id, &name, item["arguments"].clone());
                    self.tool_result(&id, &item["result"].to_string(), item["status"] == "failed");
                }
                "web_search" => {
                    self.tool_call(&id, "web_search", json!({"query": item["query"]}));
                    self.tool_result(&id, "", false);
                }
                "error" => self.ev(json!({"type": "warning", "message": item["message"].as_str().unwrap_or("Codex reported an error")})),
                _ => {}
            },
            ("turn.completed", _) => {
                self.got_result = true;
                let u = |k: &str| v.pointer(&format!("/usage/{k}")).and_then(|x| x.as_u64()).unwrap_or(0);
                self.usage(u("input_tokens"), u("output_tokens"), u("cached_input_tokens"), 0);
            }
            ("turn.failed", _) => {
                self.got_result = true;
                let m = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("Codex turn failed");
                self.ev(json!({"type": "error", "message": m}));
            }
            ("error", _) => {
                let m = v["message"].as_str().unwrap_or("Codex error");
                self.ev(json!({"type": "error", "message": m}));
            }
            _ => {}
        }
    }
}

fn status(app: &AppHandle, sid: &str, st: &str) {
    let _ = app.emit("agent-event", json!({"type": "status", "sessionId": sid, "status": st}));
}

#[tauri::command]
pub async fn harness_send(app: AppHandle, req: HarnessReq) -> Result<(), String> {
    if req.harness != "claude-code" && req.harness != "codex" {
        return Err(format!("Unknown agent harness '{}'", req.harness));
    }
    if req.workspace.trim().is_empty() {
        return Err("Open a folder first.".into());
    }
    if running().lock().unwrap().contains_key(&req.session_id) {
        return Err("This agent is still working. Stop it first or wait for it to finish.".into());
    }
    let name = harness_name(&req.harness);
    let exe = if req.harness == "claude-code" { "claude" } else { "codex" };
    let path = tokio::task::spawn_blocking(move || resolve(exe))
        .await
        .ok()
        .flatten()
        .ok_or_else(|| format!("The {name} CLI (`{exe}`) was not found on PATH. {}", install_hint(&req.harness)))?;

    let mut prompt = req.message.clone();
    if let Some(ctx) = req.context.as_deref().filter(|c| !c.trim().is_empty()) {
        prompt.push_str("\n\n<editor_context>\n");
        prompt.push_str(ctx);
        prompt.push_str("\n</editor_context>");
    }

    let mut cmd = tokio_cmd(&path);
    cmd.args(build_args(&req))
        .current_dir(&req.workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {name}: {e}. {}", install_hint(&req.harness)))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| format!("Could not send the prompt to {name}: {e}"))?;
        drop(stdin); // EOF: the CLI starts working
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    running().lock().unwrap().insert(req.session_id.clone(), Running { pid: child.id(), cancelled: cancelled.clone() });

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let sid = req.session_id.clone();
    status(&app, &sid, "running");
    tauri::async_runtime::spawn(async move {
        let err_tail = Arc::new(Mutex::new(String::new()));
        let err_task = {
            let tail = err_tail.clone();
            tauri::async_runtime::spawn(async move {
                let Some(mut e) = stderr else { return };
                let mut buf = [0u8; 4096];
                while let Ok(n) = e.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let mut t = tail.lock().unwrap();
                    t.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if t.len() > 4000 {
                        let cut = t.len() - 4000;
                        let cut = (cut..t.len()).find(|i| t.is_char_boundary(*i)).unwrap_or(t.len());
                        t.drain(..cut);
                    }
                }
            })
        };
        let mut tr = Translator {
            app: app.clone(),
            sid: sid.clone(),
            harness: req.harness.clone(),
            workspace: req.workspace.clone(),
            model: req.model.clone().filter(|m| m != "default").unwrap_or_default(),
            texts: 0,
            tool_names: HashMap::new(),
            got_result: false,
        };
        if let Some(out) = stdout {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                if tr.harness == "claude-code" { tr.claude(&v) } else { tr.codex(&v) }
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = err_task.await;
        running().lock().unwrap().remove(&sid);
        if cancelled.load(Ordering::SeqCst) {
            status(&app, &sid, "stopped");
            return;
        }
        if code != Some(0) && !tr.got_result {
            let tail = err_tail.lock().unwrap().trim().to_string();
            let hint = if tail.to_lowercase().contains("login") || tail.to_lowercase().contains("auth") {
                format!(" Run `{exe}` in a terminal once to sign in.")
            } else {
                String::new()
            };
            let msg = format!(
                "{name} exited with code {}.{hint}{}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                if tail.is_empty() { String::new() } else { format!("\n{tail}") }
            );
            let _ = app.emit("agent-event", json!({"type": "error", "sessionId": sid, "message": msg}));
            status(&app, &sid, "error");
        } else {
            status(&app, &sid, "idle");
        }
    });
    Ok(())
}

#[tauri::command]
pub fn harness_cancel(session_id: String) {
    let Some((pid, cancelled)) = running().lock().unwrap().get(&session_id).map(|r| (r.pid, r.cancelled.clone())) else { return };
    cancelled.store(true, Ordering::SeqCst);
    if let Some(pid) = pid {
        // Kill the whole tree: npm shims spawn node, which spawns the agent's own tools.
        if cfg!(windows) {
            let _ = std_cmd("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        } else {
            let _ = std_cmd("kill").args(["-TERM", &pid.to_string()]).output();
        }
    }
}
