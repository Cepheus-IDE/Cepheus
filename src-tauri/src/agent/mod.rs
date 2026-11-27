//! Cepheus agent: a tool-using coding agent loop that runs locally against the open workspace.
//! Several sessions can run concurrently (the "Agent Manager" view); each streams progress to the
//! UI through `agent-event` events.
//!
//! Per run the loop assembles: workspace instruction files, skills, an optional custom agent
//! (instructions + tool allowlist + model), hooks and MCP tools (see `customize` / `mcp`).
//! Messages sent while a run is in progress are queued and injected at the next model turn.

pub mod checks;
pub mod customize;
pub mod mcp;
pub mod persist;
pub mod providers;
pub mod tools;

use customize::Customizations;
use providers::{ProviderConfig, ToolOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{oneshot, Notify};

const MAX_STEPS: usize = 60;
const MAX_CHECK_ROUNDS: u32 = 3;

pub struct Session {
    provider: String,
    history: tokio::sync::Mutex<Vec<Value>>,
    cancel: AtomicBool,
    cancel_notify: Notify,
    running: AtomicBool,
    /// Steering messages sent mid-run, injected before the next model call.
    queue: Mutex<Vec<String>>,
    /// Workspace-relative files the agent touched (drives `applyTo` instruction globs).
    touched: Mutex<HashSet<String>>,
}

impl Session {
    fn new(provider: &str, history: Vec<Value>) -> Self {
        Session {
            provider: provider.to_string(),
            history: tokio::sync::Mutex::new(history),
            cancel: AtomicBool::new(false),
            cancel_notify: Notify::new(),
            running: AtomicBool::new(false),
            queue: Mutex::new(Vec::new()),
            touched: Mutex::new(HashSet::new()),
        }
    }
}

#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    approvals: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    client: once_client::Client,
    mcp: Arc<mcp::McpManager>,
}

mod once_client {
    use std::sync::OnceLock;
    #[derive(Default)]
    pub struct Client(OnceLock<reqwest::Client>);
    impl Client {
        pub fn get(&self) -> reqwest::Client {
            self.0
                .get_or_init(|| {
                    crate::net::builder() // proxy + trusted CAs
                        .timeout(std::time::Duration::from_secs(600))
                        .connect_timeout(std::time::Duration::from_secs(20))
                        .build()
                        .expect("http client")
                })
                .clone()
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Status { session_id: String, status: String },
    Text { session_id: String, text: String },
    Thinking { session_id: String, text: String },
    ToolCall { session_id: String, call_id: String, name: String, args: Value },
    ToolResult { session_id: String, call_id: String, name: String, output: String, is_error: bool },
    ApprovalRequest { session_id: String, approval_id: String, call_id: String, name: String, args: Value },
    Plan { session_id: String, items: Value },
    FileChanged { session_id: String, path: String, before: Option<String>, after: String },
    Warning { session_id: String, message: String },
    Error { session_id: String, message: String },
    Usage { session_id: String, input_tokens: u64, output_tokens: u64 },
    /// A queued steering message was injected into the conversation.
    Steered { session_id: String, text: String },
    /// Customizations in effect for this run (shown as chips in the chat).
    Context { session_id: String, instructions: Vec<String>, skills: Vec<String>, agent: Option<String>, mcp_tools: usize, plan_mode: bool },
    /// One entry for the session's debug log.
    Debug { session_id: String, entry: Value },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunReq {
    pub session_id: String,
    pub workspace: String,
    pub message: String,
    pub config: ProviderConfig,
    /// "ask" | "auto-edit" | "turbo"
    pub approval_mode: String,
    /// Optional editor context (active file, selection) appended to the user's message.
    pub context: Option<String>,
    #[serde(default)]
    pub custom_instructions: Option<String>,
    /// "plan" = read-only research that ends with a plan; anything else = normal.
    #[serde(default)]
    pub mode: Option<String>,
    /// Custom agent name from `.cepheus/agents/*.md`.
    #[serde(default)]
    pub agent: Option<String>,
    /// Run the workspace's checks after the agent finishes and feed failures back.
    #[serde(default)]
    pub verify: bool,
    /// Workspace-relative paths of the open editors (for `applyTo` globs).
    #[serde(default)]
    pub open_files: Vec<String>,
    /// Global MCP servers from settings (`mcpServers`).
    #[serde(default)]
    pub mcp_servers: Option<Value>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn system_prompt(workspace: &str, custom: Option<&str>) -> String {
    let os = if cfg!(windows) { "Windows (commands run in PowerShell)" } else { std::env::consts::OS };
    let mut s = format!(
        "You are Cepheus, an expert software engineering agent built into the Cepheus IDE. \
You work directly in the user's workspace using the tools provided.\n\n\
Workspace root: {workspace}\nOperating system: {os}\n\n\
How to work:\n\
- Explore before changing: use list_dir, find_files, search and read_file to understand the relevant code.\n\
- For tasks with more than two steps, publish a plan with update_plan first and keep it updated as you go.\n\
- Make focused changes with edit_file; use write_file for new files or full rewrites. Match the existing code style.\n\
- Verify your work when practical (build, run tests, or lint with run_command) and fix what you broke.\n\
- All paths are relative to the workspace root.\n\
- The user may send extra messages while you work (marked as sent during the task); take them into account right away.\n\
- When done, reply with a short summary of what you changed and anything the user should check. \
Use Markdown. Answer in the same language the user writes in.\n\
- If the request is only a question, answer it without modifying files."
    );
    if let Some(c) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        s.push_str("\n\nUser's custom instructions:\n");
        s.push_str(c);
    }
    s
}

const PLAN_MODE_PROMPT: &str = "\n\n# PLAN MODE\nYou are in Plan mode. Research the codebase with the read-only tools \
(list_dir, find_files, read_file, search) and DO NOT modify anything: no file writes, no commands. \
When you understand the task, publish the implementation plan with update_plan (all steps `pending`) \
and reply with a concise Markdown plan: the goal, the files to change and how, risks/open questions. \
The user will review it and then click \"Start implementation\".";

fn emit(app: &AppHandle, ev: AgentEvent) {
    let _ = app.emit("agent-event", ev);
}

fn debug(app: &AppHandle, sid: &str, mut entry: Value) {
    entry["ts"] = json!(now_ms());
    emit(app, AgentEvent::Debug { session_id: sid.to_string(), entry });
}

/// Providers that can run without a user-entered key (local OpenAI-compatible servers, NVIDIA free tier).
fn missing_key(c: &providers::ProviderConfig) -> bool {
    match c.provider.as_str() {
        "openai" => false,
        "nvidia" => providers::nvidia_key(&c.api_key).is_empty(),
        _ => c.api_key.trim().is_empty(),
    }
}

/// Appends user text, merging into a trailing user entry so roles keep alternating
/// (Anthropic/Gemini require it; e.g. a steering message right after tool results).
fn push_user_text(cfg: &ProviderConfig, history: &mut Vec<Value>, text: &str) {
    if let Some(last) = history.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some("user") {
            match cfg.provider.as_str() {
                "gemini" => {
                    if let Some(parts) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                        parts.push(json!({"text": text}));
                        return;
                    }
                }
                "anthropic" => match last.get_mut("content") {
                    Some(Value::Array(a)) => {
                        a.push(json!({"type": "text", "text": text}));
                        return;
                    }
                    Some(Value::String(s)) => {
                        s.push_str("\n\n");
                        s.push_str(text);
                        return;
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }
    history.push(providers::user_text(cfg, text));
}

#[tauri::command]
pub async fn nvidia_models(state: State<'_, AgentState>, api_key: Option<String>) -> Result<Vec<String>, String> {
    providers::nvidia_models(&state.client.get(), api_key.as_deref().unwrap_or("")).await
}

#[tauri::command]
pub fn agent_send(app: AppHandle, state: State<'_, AgentState>, req: AgentRunReq) -> Result<(), String> {
    // Organization policy: allowed provider/model, approval floor, shared instructions.
    let mut req = req;
    crate::policy::agent_preflight(&mut req)?;
    if missing_key(&req.config) {
        return Err("No API key configured. Open Settings (gear icon) and add your API key.".into());
    }
    if req.workspace.trim().is_empty() {
        return Err("Open a folder first.".into());
    }
    let session = {
        let mut map = state.sessions.lock().unwrap();
        let existing = map.get(&req.session_id).cloned();
        match existing {
            // A session's history is in its provider's native format; switching provider starts fresh.
            Some(s) if s.provider == req.config.provider => s,
            Some(s) if s.running.load(Ordering::SeqCst) => s,
            _ => {
                // Restored after a restart: continue from the persisted history when compatible.
                let history = persist::load_history(&app, &req.session_id)
                    .filter(|(p, _)| p == &req.config.provider)
                    .map(|(_, h)| h)
                    .unwrap_or_default();
                let s = Arc::new(Session::new(&req.config.provider, history));
                map.insert(req.session_id.clone(), s.clone());
                s
            }
        }
    };
    if session.running.swap(true, Ordering::SeqCst) {
        return Err("This agent is still working. Stop it first or wait for it to finish.".into());
    }
    session.cancel.store(false, Ordering::SeqCst);
    let client = state.client.get();
    let approvals = state.approvals.clone();
    let mcp = state.mcp.clone();

    tauri::async_runtime::spawn(async move {
        let sid = req.session_id.clone();
        emit(&app, AgentEvent::Status { session_id: sid.clone(), status: "running".into() });
        let result = run_loop(&app, &client, &session, &approvals, &mcp, req).await;
        {
            // Steering messages that arrive after an error/stop are dropped with the run.
            let mut q = session.queue.lock().unwrap();
            q.clear();
            session.running.store(false, Ordering::SeqCst);
        }
        match result {
            Ok(()) => {
                let st = if session.cancel.load(Ordering::SeqCst) { "stopped" } else { "idle" };
                emit(&app, AgentEvent::Status { session_id: sid, status: st.into() });
            }
            Err(e) => {
                emit(&app, AgentEvent::Error { session_id: sid.clone(), message: e });
                emit(&app, AgentEvent::Status { session_id: sid, status: "error".into() });
            }
        }
    });
    Ok(())
}

/// Queues a message for a running session. Returns false when the session is not running
/// (the caller then sends it as a normal message).
#[tauri::command]
pub fn agent_steer(state: State<'_, AgentState>, session_id: String, message: String) -> bool {
    let Some(s) = state.sessions.lock().unwrap().get(&session_id).cloned() else { return false };
    // Checked under the queue lock: the loop finishes under the same lock (see `run_loop`).
    let mut q = s.queue.lock().unwrap();
    if !s.running.load(Ordering::SeqCst) || s.cancel.load(Ordering::SeqCst) {
        return false;
    }
    q.push(message);
    true
}

/// Everything resolved once per run.
struct RunCtx {
    custom: Customizations,
    allow: Option<Vec<String>>,
    plan_mode: bool,
}

/// Runs the hooks for `event`. For `preToolUse`, returns the block reason when a hook exits non-zero.
async fn run_hooks(app: &AppHandle, sid: &str, ws: &str, ctx: &RunCtx, event: &str, tool: &str, payload: &Value) -> Option<String> {
    for h in ctx.custom.hooks_for(event, tool) {
        let t0 = Instant::now();
        let env = vec![
            ("CEPHEUS_HOOK_EVENT".to_string(), event.to_string()),
            ("CEPHEUS_TOOL_NAME".to_string(), tool.to_string()),
            ("CEPHEUS_SESSION_ID".to_string(), sid.to_string()),
        ];
        let timeout = Duration::from_secs(h.timeout.unwrap_or(60).clamp(1, 600));
        let (code, stdout, stderr) = match tools::run_shell_input(ws, &h.command, &payload.to_string(), &env, timeout).await {
            Ok(o) => (o.code, o.stdout, o.stderr),
            Err(e) => (-1, String::new(), e),
        };
        let blocked = event == "preToolUse" && code != 0;
        debug(
            app,
            sid,
            json!({"kind": "hook", "event": event, "tool": tool, "command": h.command, "exitCode": code,
                   "stdout": stdout.chars().take(4000).collect::<String>(),
                   "stderr": stderr.chars().take(4000).collect::<String>(),
                   "durationMs": t0.elapsed().as_millis() as u64, "blocked": blocked}),
        );
        if blocked {
            let why = if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() };
            return Some(format!("Blocked by preToolUse hook `{}` (exit {code}): {}", h.command, if why.is_empty() { "no reason given" } else { &why }));
        }
    }
    None
}

async fn run_loop(
    app: &AppHandle,
    client: &reqwest::Client,
    session: &Arc<Session>,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    mcp: &Arc<mcp::McpManager>,
    req: AgentRunReq,
) -> Result<(), String> {
    let sid = req.session_id.clone();
    let mut cfg = req.config.clone();
    let ws = req.workspace.clone();
    let plan_mode = req.mode.as_deref() == Some("plan");

    // --- customizations -----------------------------------------------------------------
    let data_dir = app.path().app_data_dir().ok().map(|d| d.to_string_lossy().to_string());
    let custom = customize::load(&ws, data_dir.as_deref()).await;
    let wanted_agent = req.agent.as_deref().filter(|a| !a.is_empty());
    let agent_def = wanted_agent.and_then(|n| custom.agents.iter().find(|a| a.name == n).cloned());
    if let (Some(n), None) = (wanted_agent, &agent_def) {
        emit(app, AgentEvent::Warning { session_id: sid.clone(), message: format!("Custom agent '{n}' was not found in .cepheus/agents; using the default agent.") });
    }
    if let Some(m) = agent_def.as_ref().and_then(|a| a.model.clone()) {
        cfg.model = m;
        cfg.auto = None;
    }
    let mut involved: Vec<String> = req.open_files.iter().map(|p| p.replace('\\', "/")).collect();
    involved.extend(session.touched.lock().unwrap().iter().cloned());

    let mut system = system_prompt(&ws, req.custom_instructions.as_deref());
    let applicable = custom.applicable(&involved);
    let instruction_paths: Vec<String> = applicable.iter().map(|i| i.path.clone()).collect();
    for i in applicable {
        system.push_str(&format!("\n\n# Instructions from {}\n{}", i.path, i.body.trim()));
    }
    if !custom.skills.is_empty() {
        system.push_str("\n\n# Skills\nSkills are reusable instructions for specific tasks. When a task matches a skill, call load_skill with its name first.\n");
        for s in &custom.skills {
            system.push_str(&format!("- {}: {}\n", s.name, s.description));
        }
    }
    if let Some(a) = &agent_def {
        system.push_str(&format!("\n\n# Agent: {}\n{}", a.name, a.body.trim()));
    }
    // Database client: connections + schema-design guidance (src-tauri/src/db/agent.rs).
    if let Some(dbp) = crate::db::agent::system_prompt() {
        system.push_str(&dbp);
    }
    if plan_mode {
        system.push_str(PLAN_MODE_PROMPT);
    }

    // --- tools --------------------------------------------------------------------------
    let mut tool_defs = tools::definitions();
    if !custom.skills.is_empty() {
        tool_defs.push(tools::load_skill_def());
    }
    if !plan_mode {
        mcp.ensure(&ws, req.mcp_servers.as_ref()).await;
        tool_defs.extend(mcp.tool_defs().await);
    }
    let allow = agent_def.as_ref().and_then(|a| a.tools.clone());
    tool_defs.retain(|t| {
        crate::policy::tool_allowed(t.name) // policy: allowedAgentTools
            && (!plan_mode || tools::is_read_only(t.name))
            && customize::tool_allowed(&allow, t.name)
    });
    let allowed: HashSet<&str> = tool_defs.iter().map(|t| t.name).collect();
    let mcp_count = tool_defs.iter().filter(|t| t.name.starts_with("mcp__")).count();

    let skill_names: Vec<String> = custom.skills.iter().map(|s| s.name.clone()).collect();
    emit(app, AgentEvent::Context {
        session_id: sid.clone(),
        instructions: instruction_paths.clone(),
        skills: skill_names.clone(),
        agent: agent_def.as_ref().map(|a| a.name.clone()),
        mcp_tools: mcp_count,
        plan_mode,
    });
    debug(
        app,
        &sid,
        json!({"kind": "context", "instructions": instruction_paths, "skills": skill_names, "agent": agent_def.as_ref().map(|a| &a.name),
               "tools": tool_defs.iter().map(|t| t.name).collect::<Vec<_>>(), "hooks": custom.hooks.len(), "planMode": plan_mode,
               "model": cfg.model, "provider": cfg.provider}),
    );
    let ctx = RunCtx { custom, allow, plan_mode };

    let mut user_msg = req.message.clone();
    if let Some(c) = req.context.as_deref().filter(|c| !c.trim().is_empty()) {
        user_msg.push_str("\n\n<editor_context>\n");
        user_msg.push_str(c);
        user_msg.push_str("\n</editor_context>");
    }

    let mut history = session.history.lock().await;
    push_user_text(&cfg, &mut history, &user_msg);

    let mut check_rounds = 0u32;
    let mut changed = false;
    let mut steps = 0usize;
    loop {
        if session.cancel.load(Ordering::SeqCst) {
            break;
        }
        if steps >= MAX_STEPS {
            emit(app, AgentEvent::Warning { session_id: sid.clone(), message: format!("Stopped after {MAX_STEPS} steps. Send a message to continue.") });
            break;
        }
        steps += 1;
        inject_steering(app, &sid, session, &cfg, &mut history);

        let t0 = Instant::now();
        let call = providers::call(client, &cfg, &system, &tool_defs, &history, 16000);
        let (entry, turn) = tokio::select! {
            r = call => match r {
                Ok(x) => x,
                Err(e) => {
                    debug(app, &sid, json!({"kind": "turn", "provider": cfg.provider, "model": cfg.model, "durationMs": t0.elapsed().as_millis() as u64, "error": e}));
                    persist::save_history(app, &sid, &session.provider, &history);
                    return Err(e);
                }
            },
            _ = session.cancel_notify.notified() => break,
        };
        history.push(entry);
        persist::save_history(app, &sid, &session.provider, &history);
        debug(
            app,
            &sid,
            json!({"kind": "turn", "provider": turn.provider, "model": turn.model, "inputTokens": turn.input_tokens,
                   "outputTokens": turn.output_tokens, "cacheReadTokens": turn.cache_read_tokens, "cacheWriteTokens": turn.cache_write_tokens,
                   "durationMs": t0.elapsed().as_millis() as u64, "toolCalls": turn.calls.len()}),
        );

        emit(app, AgentEvent::Usage { session_id: sid.clone(), input_tokens: turn.input_tokens, output_tokens: turn.output_tokens });
        // Models view: per-model usage, cache hits, Auto fallback notices (providers.rs).
        providers::report_turn(app, &sid, &turn);
        for t in &turn.thinking {
            emit(app, AgentEvent::Thinking { session_id: sid.clone(), text: t.clone() });
        }
        for t in turn.texts.iter().filter(|t| !t.trim().is_empty()) {
            emit(app, AgentEvent::Text { session_id: sid.clone(), text: t.clone() });
        }
        if let Some(w) = &turn.warning {
            emit(app, AgentEvent::Warning { session_id: sid.clone(), message: w.clone() });
        }

        if turn.calls.is_empty() {
            if session.cancel.load(Ordering::SeqCst) {
                break;
            }
            if !session.queue.lock().unwrap().is_empty() {
                continue; // the user steered while the model was answering
            }
            if req.verify && !plan_mode && changed {
                if check_rounds >= MAX_CHECK_ROUNDS {
                    emit(app, AgentEvent::Warning { session_id: sid.clone(), message: format!("Self-check stopped after {MAX_CHECK_ROUNDS} rounds; run the checks yourself to confirm.") });
                } else {
                    check_rounds += 1;
                    changed = false;
                    if let Some(feedback) = self_check(app, &sid, &ws, check_rounds).await {
                        push_user_text(&cfg, &mut history, &feedback);
                        continue;
                    }
                }
            }
            // Finish under the queue lock so a concurrent `agent_steer` either lands before
            // (and is handled) or sees the session as not running.
            let q = session.queue.lock().unwrap();
            if !q.is_empty() {
                continue;
            }
            session.running.store(false, Ordering::SeqCst);
            break;
        }

        let mut outcomes: Vec<ToolOutcome> = Vec::new();
        for call in &turn.calls {
            // After a stop request, still answer every pending call so the history stays valid.
            if session.cancel.load(Ordering::SeqCst) {
                outcomes.push(ToolOutcome { call: call.clone(), output: "Cancelled by the user.".into(), is_error: true });
                continue;
            }
            emit(app, AgentEvent::ToolCall { session_id: sid.clone(), call_id: call.id.clone(), name: call.name.clone(), args: call.args.clone() });

            if call.name == "update_plan" {
                emit(app, AgentEvent::Plan { session_id: sid.clone(), items: call.args.get("items").cloned().unwrap_or(Value::Array(vec![])) });
            }
            let t0 = Instant::now();
            let (output, is_error) = run_tool(app, &sid, &ws, session, approvals, mcp, &ctx, &allowed, &req.approval_mode, call, &mut changed).await;
            debug(
                app,
                &sid,
                json!({"kind": "tool", "name": call.name, "args": call.args.to_string().chars().take(2000).collect::<String>(),
                       "durationMs": t0.elapsed().as_millis() as u64, "resultSize": output.len(),
                       "error": if is_error { Some(output.chars().take(500).collect::<String>()) } else { None }}),
            );
            emit(app, AgentEvent::ToolResult { session_id: sid.clone(), call_id: call.id.clone(), name: call.name.clone(), output: output.clone(), is_error });
            outcomes.push(ToolOutcome { call: call.clone(), output, is_error });
        }
        history.extend(providers::tool_results(&cfg, &outcomes));
        persist::save_history(app, &sid, &session.provider, &history);
    }
    persist::save_history(app, &sid, &session.provider, &history);
    drop(history);
    run_hooks(app, &sid, &ws, &ctx, "stop", "", &json!({"event": "stop", "sessionId": sid, "workspace": ws})).await;
    Ok(())
}

fn inject_steering(app: &AppHandle, sid: &str, session: &Session, cfg: &ProviderConfig, history: &mut Vec<Value>) {
    let msgs: Vec<String> = std::mem::take(&mut *session.queue.lock().unwrap());
    for m in msgs {
        push_user_text(cfg, history, &format!("[Message from the user, sent while you were working]\n{m}"));
        debug(app, sid, json!({"kind": "steer", "text": m.chars().take(500).collect::<String>()}));
        emit(app, AgentEvent::Steered { session_id: sid.to_string(), text: m });
    }
}

/// Runs the detected checks, shown in the chat as `run_check` tool items. Returns feedback for
/// the model when something failed.
async fn self_check(app: &AppHandle, sid: &str, ws: &str, round: u32) -> Option<String> {
    let cmds = checks::detect(ws).await;
    if cmds.is_empty() {
        if round == 1 {
            emit(app, AgentEvent::Warning { session_id: sid.into(), message: "Verify with checks: no test/typecheck/lint/build command detected in this workspace.".into() });
        }
        return None;
    }
    let mut failures = vec![];
    for cmd in cmds {
        let call_id = format!("check-{}", uuid::Uuid::new_v4());
        emit(app, AgentEvent::ToolCall { session_id: sid.into(), call_id: call_id.clone(), name: "run_check".into(), args: json!({"command": cmd, "round": round}) });
        let r = checks::run(ws, &cmd).await;
        let ok = r.code == 0;
        let out = format!("Exit code: {}\n{}", r.code, if r.output.trim().is_empty() { "(no output)" } else { &r.output });
        emit(app, AgentEvent::ToolResult { session_id: sid.into(), call_id, name: "run_check".into(), output: out.clone(), is_error: !ok });
        debug(app, sid, json!({"kind": "check", "command": r.command, "exitCode": r.code, "round": round, "durationMs": r.duration_ms}));
        if !ok {
            failures.push(format!("$ {}\n{}", r.command, out));
        }
    }
    if failures.is_empty() {
        return None;
    }
    Some(format!(
        "[Automatic self-check, round {round}/{MAX_CHECK_ROUNDS}] These project checks failed after your changes:\n\n{}\n\nFix the problems your changes caused (ignore failures that clearly existed before), then summarize.",
        failures.join("\n\n")
    ))
}

#[allow(clippy::too_many_arguments)]
async fn run_tool(
    app: &AppHandle,
    sid: &str,
    ws: &str,
    session: &Session,
    approvals: &Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    mcp: &Arc<mcp::McpManager>,
    ctx: &RunCtx,
    allowed: &HashSet<&str>,
    approval_mode: &str,
    call: &providers::ToolCall,
    changed: &mut bool,
) -> (String, bool) {
    // Enforced here too: models sometimes call tools they were not offered.
    if !allowed.contains(call.name.as_str()) {
        let msg = if ctx.plan_mode && !tools::is_read_only(&call.name) {
            format!("`{}` is not available in Plan mode. Only read-only tools can be used; finish the plan instead.", call.name)
        } else if ctx.allow.is_some() {
            format!("`{}` is not in this agent's tool allowlist.", call.name)
        } else {
            format!("Tool '{}' is not available.", call.name)
        };
        return (msg, true);
    }

    let payload = json!({"event": "preToolUse", "sessionId": sid, "workspace": ws, "tool": call.name, "args": call.args});
    if let Some(block) = run_hooks(app, sid, ws, ctx, "preToolUse", &call.name, &payload).await {
        return (block, true);
    }

    // `|| browser::...`: browser click/type/eval need approval per action (src-tauri/src/browser.rs).
    // `|| db::...`: db_execute always asks (production: even in Turbo); db_query asks in Ask mode.
    if tools::needs_approval(&call.name, approval_mode)
        || crate::browser::needs_approval(&call.name, &call.args, approval_mode)
        || crate::db::agent::needs_approval(&call.name, &call.args, approval_mode)
    {
        let approval_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        approvals.lock().unwrap().insert(approval_id.clone(), tx);
        emit(app, AgentEvent::Status { session_id: sid.into(), status: "waiting".into() });
        emit(app, AgentEvent::ApprovalRequest {
            session_id: sid.into(),
            approval_id: approval_id.clone(),
            call_id: call.id.clone(),
            name: call.name.clone(),
            args: call.args.clone(),
        });
        let approved = tokio::select! {
            r = rx => r.unwrap_or(false),
            _ = session.cancel_notify.notified() => false,
        };
        approvals.lock().unwrap().remove(&approval_id);
        emit(app, AgentEvent::Status { session_id: sid.into(), status: "running".into() });
        if !approved {
            return ("The user rejected this action. Ask how they want to proceed, or try a different approach.".into(), true);
        }
    }

    if let Some(p) = call.args.get("path").and_then(|p| p.as_str()) {
        session.touched.lock().unwrap().insert(p.replace('\\', "/").trim_start_matches("./").to_string());
    }
    let (output, is_error) = if call.name == "load_skill" {
        match customize::load_skill(&ctx.custom.skills, &call.args).await {
            Ok(s) => (s, false),
            Err(e) => (e, true),
        }
    } else if call.name.starts_with("mcp__") {
        match mcp.call(&call.name, &call.args).await {
            Ok((s, err)) => (tools::truncate(s), err),
            Err(e) => (e, true),
        }
    } else {
        match tools::execute(ws, &call.name, &call.args).await {
            Ok((out, change)) => {
                if let Some(ch) = change {
                    *changed = true;
                    emit(app, AgentEvent::FileChanged { session_id: sid.into(), path: ch.path, before: ch.before, after: ch.after });
                }
                (out, false)
            }
            Err(e) => (e, true),
        }
    };
    // Commands may change files too; let the self-check run after them.
    if call.name == "run_command" && !is_error {
        *changed = true;
    }
    let post = json!({"event": "postToolUse", "sessionId": sid, "workspace": ws, "tool": call.name, "args": call.args,
                      "result": output.chars().take(20_000).collect::<String>(), "isError": is_error});
    run_hooks(app, sid, ws, ctx, "postToolUse", &call.name, &post).await;
    (output, is_error)
}

#[tauri::command]
pub fn agent_cancel(state: State<'_, AgentState>, session_id: String) {
    if let Some(s) = state.sessions.lock().unwrap().get(&session_id) {
        s.cancel.store(true, Ordering::SeqCst);
        s.cancel_notify.notify_waiters();
    }
}

#[tauri::command]
pub fn agent_approve(state: State<'_, AgentState>, approval_id: String, approved: bool) {
    if let Some(tx) = state.approvals.lock().unwrap().remove(&approval_id) {
        let _ = tx.send(approved);
    }
}

#[tauri::command]
pub fn agent_reset(state: State<'_, AgentState>, session_id: String) {
    if let Some(s) = state.sessions.lock().unwrap().remove(&session_id) {
        s.cancel.store(true, Ordering::SeqCst);
        s.cancel_notify.notify_waiters();
    }
}

/// Instruction files, skills, custom agents and hooks found for a workspace (UI pickers).
#[tauri::command]
pub async fn agent_customizations(app: AppHandle, workspace: String) -> Result<Value, String> {
    if workspace.trim().is_empty() {
        return Ok(customize::summary(&Customizations::default()));
    }
    let data_dir = app.path().app_data_dir().ok().map(|d| d.to_string_lossy().to_string());
    Ok(customize::summary(&customize::load(&workspace, data_dir.as_deref()).await))
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, AgentState>, workspace: String, servers: Option<Value>) -> Result<Vec<mcp::ServerStatus>, String> {
    Ok(state.mcp.status(&workspace, servers.as_ref()).await)
}

#[tauri::command]
pub async fn mcp_start(state: State<'_, AgentState>, workspace: String, servers: Option<Value>, name: String) -> Result<(), String> {
    state.mcp.start(&workspace, servers.as_ref(), &name).await
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, AgentState>, name: String) -> Result<(), String> {
    state.mcp.stop(&name).await;
    Ok(())
}

/// Single-shot completion without tools: used for inline edits (Ctrl+K),
/// commit-message generation and code completion.
#[tauri::command]
pub async fn ai_oneshot(
    state: State<'_, AgentState>,
    config: ProviderConfig,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    crate::policy::check_model(crate::policy::get(), &config.provider, &config.model)?;
    if missing_key(&config) {
        return Err("No API key configured. Open Settings and add your API key.".into());
    }
    let client = state.client.get();
    let history = vec![providers::user_text(&config, &prompt)];
    let fut = providers::call(&client, &config, &system, &[], &history, max_tokens.unwrap_or(8000));
    let (_, turn) = tokio::time::timeout(Duration::from_secs(300), fut)
        .await
        .map_err(|_| "Request timed out".to_string())??;
    if let Some(w) = turn.warning.filter(|_| turn.texts.is_empty()) {
        return Err(w);
    }
    Ok(turn.texts.join(""))
}
