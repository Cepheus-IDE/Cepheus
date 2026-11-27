//! Provider adapters. Each session keeps its history in the provider's *native* message
//! format, so provider-specific blocks (Claude thinking/fallback blocks, Gemini thought
//! signatures, ...) are echoed back unchanged on the next request.
//!
//! On top of the adapters this module implements request-level robustness: Auto model
//! selection with fallback (429 / 5xx / timeouts / "model not found for account"), a registry of
//! models found unavailable, friendly error messages, live model listing for every provider and
//! per-turn usage reporting (incl. prompt-cache reads/writes).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    /// "nvidia" | "anthropic" | "openai" | "gemini" (custom providers are "openai" + base URL)
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Reasoning effort: low | medium | high | xhigh | max. Mapped per provider
    /// (Claude effort, OpenAI reasoning_effort, Gemini thinking budget/level).
    #[serde(default)]
    pub effort: Option<String>,
    /// Frontend provider id ("nvidia", "custom:<id>", ...) used for usage and availability keys.
    #[serde(default)]
    pub source: Option<String>,
    /// Display name for messages (e.g. a custom provider's name).
    #[serde(default)]
    pub label: Option<String>,
    /// Auto model selection: candidate models tried in order, with fallback on errors.
    #[serde(default)]
    pub auto: Option<AutoPlan>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoPlan {
    /// "fast" | "strong": the tier the frontend picked from the prompt.
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub fast: Vec<ProviderConfig>,
    #[serde(default)]
    pub strong: Vec<ProviderConfig>,
}

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Value,
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

pub struct ToolOutcome {
    pub call: ToolCall,
    pub output: String,
    pub is_error: bool,
}

#[derive(Default)]
pub struct Turn {
    pub texts: Vec<String>,
    pub thinking: Vec<String>,
    pub calls: Vec<ToolCall>,
    /// Set when the model declined or stopped abnormally.
    pub warning: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Prompt-cache tokens (included in `input_tokens`).
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// Which candidate actually answered (differs from the request under Auto / fallback).
    pub provider: String,
    pub source: String,
    pub model: String,
    /// Fallback notices ("X failed, switched to Y") to show in the chat.
    pub notices: Vec<String>,
    /// Availability keys (`source|model`) found unavailable during this call.
    pub unavailable: Vec<String>,
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ErrKind {
    Http,
    Timeout,
    Network,
    BadResponse,
}

#[derive(Debug, Clone)]
pub struct ApiErr {
    pub kind: ErrKind,
    pub status: Option<u16>,
    pub detail: String,
    pub retry_after: Option<u64>,
}

impl ApiErr {
    fn new(kind: ErrKind, detail: impl Into<String>) -> Self {
        ApiErr { kind, status: None, detail: detail.into(), retry_after: None }
    }
    fn code(&self) -> u16 {
        self.status.unwrap_or(0)
    }
    /// The model itself can't be used with this key (NVIDIA lists models some accounts can't call).
    pub fn model_unavailable(&self) -> bool {
        let d = self.detail.to_lowercase();
        match self.code() {
            404 | 410 => true,
            400 | 422 => {
                d.contains("model")
                    // "not available": the Cepheus free proxy rejects models outside its allowlist.
                    && ["not found", "does not exist", "not supported", "not available", "unknown model", "invalid model", "no such model"]
                        .iter()
                        .any(|s| d.contains(s))
            }
            _ => false,
        }
    }
    /// Worth retrying the same request a moment later.
    fn transient(&self) -> bool {
        // The free proxy's daily quota won't reset within a retry window.
        if self.free_tier_limit() && self.detail.contains("daily") {
            return false;
        }
        matches!(self.kind, ErrKind::Timeout | ErrKind::Network)
            || matches!(self.code(), 408 | 409 | 425 | 429 | 500..=599)
    }
    /// A 429 from the Cepheus free proxy, whose message already says what to do ("Free tier limit…").
    fn free_tier_limit(&self) -> bool {
        self.code() == 429 && self.detail.starts_with("Free tier")
    }
    /// The key/endpoint is unusable (skip other models on the same endpoint).
    fn endpoint_dead(&self) -> bool {
        matches!(self.code(), 401 | 402) || (self.kind == ErrKind::Network && self.status.is_none())
    }
}

impl From<&str> for ApiErr {
    fn from(s: &str) -> Self {
        ApiErr::new(ErrKind::BadResponse, s)
    }
}
impl From<String> for ApiErr {
    fn from(s: String) -> Self {
        ApiErr::new(ErrKind::BadResponse, s)
    }
}

fn net_err(e: reqwest::Error) -> ApiErr {
    let kind = if e.is_timeout() { ErrKind::Timeout } else { ErrKind::Network };
    ApiErr::new(kind, e.to_string())
}

fn provider_label(cfg: &ProviderConfig) -> String {
    if let Some(l) = cfg.label.as_deref().filter(|l| !l.trim().is_empty()) {
        return l.to_string();
    }
    match cfg.provider.as_str() {
        "nvidia" => "NVIDIA".into(),
        "anthropic" => "Anthropic".into(),
        "gemini" => "Google".into(),
        "openai" => {
            let b = cfg.base_url.as_deref().unwrap_or("").to_lowercase();
            if b.contains("11434") || b.contains("ollama") {
                "Ollama".into()
            } else if b.contains("1234") || b.contains("lmstudio") {
                "LM Studio".into()
            } else if b.is_empty() || b.contains("api.openai.com") {
                "OpenAI".into()
            } else {
                "OpenAI-compatible".into()
            }
        }
        o => o.to_string(),
    }
}

fn is_local(cfg: &ProviderConfig) -> bool {
    let b = cfg.base_url.as_deref().unwrap_or("");
    b.contains("localhost") || b.contains("127.0.0.1") || b.contains("0.0.0.0")
}

fn short_reason(e: &ApiErr) -> String {
    match e.kind {
        ErrKind::Timeout => "timed out".into(),
        ErrKind::Network => "network error".into(),
        ErrKind::BadResponse => "bad response".into(),
        ErrKind::Http if e.model_unavailable() => format!("{} not available", e.code()),
        ErrKind::Http => match e.code() {
            429 => "429 rate limited".into(),
            401 => "401 key rejected".into(),
            403 => "403 access denied".into(),
            c => format!("error {c}"),
        },
    }
}

/// Maps any provider error to a clear message with a suggested action.
pub fn friendly(cfg: &ProviderConfig, e: &ApiErr) -> String {
    let who = if cfg.model.is_empty() { provider_label(cfg) } else { format!("{} · {}", provider_label(cfg), cfg.model) };
    let own_nvidia_key = cfg.provider == "nvidia" && !cfg.api_key.trim().is_empty() && cfg.api_key != builtin_nvidia_key();
    // The proxy's own message is complete and friendly; don't bury it under a generic one.
    if e.free_tier_limit() {
        return format!("{who}: {}", e.detail);
    }
    let (what, hint): (String, String) = match e.kind {
        ErrKind::Timeout => ("The request timed out.".into(), "Retry, or pick a faster model (or Auto).".into()),
        ErrKind::Network if is_local(cfg) => (
            "Could not reach the local model server.".into(),
            format!("Make sure Ollama / LM Studio is running at {}.", cfg.base_url.as_deref().unwrap_or("")),
        ),
        ErrKind::Network => ("Could not reach the provider (network error).".into(), "Check your internet connection or proxy, then retry.".into()),
        ErrKind::BadResponse => ("The provider sent an unexpected response.".into(), "Retry, or switch to another model.".into()),
        ErrKind::Http => match e.code() {
            401 if cfg.provider == "nvidia" => (
                "The NVIDIA API key was rejected (401).".into(),
                "Fix or remove your key in Settings (empty = free built-in access), or get one at build.nvidia.com.".into(),
            ),
            401 => ("The API key was rejected (401).".into(), "Check the API key for this provider in Settings or Language Models.".into()),
            402 => ("This account is out of credits (402).".into(), "Add credits with the provider, or switch to another provider / Auto.".into()),
            403 => ("Access denied (403): this key can't use this model.".into(), "Switch to another model, or use a key that has access.".into()),
            _ if e.model_unavailable() => (
                format!("This model isn't available for your account ({}).", e.code()),
                "It has been marked unavailable. Pick another model, or choose Auto to skip unavailable models.".into(),
            ),
            429 if cfg.provider == "nvidia" && !own_nvidia_key => (
                "Rate limit reached on the shared free tier (429).".into(),
                "Wait a minute and retry, switch to Auto / another model, or add your own NVIDIA key in Settings.".into(),
            ),
            429 => ("Rate limit reached (429).".into(), "Wait a moment and retry, or switch to Auto / another model.".into()),
            413 => ("The request is too large for this model (413).".into(), "Start a new task or pick a model with a larger context window.".into()),
            400 => ("The provider rejected the request (400).".into(), "Try another model; this one may not support tool calling or this context size.".into()),
            c if c >= 500 => (format!("The provider had a server error ({c})."), "Retry in a moment, or switch to another model / Auto.".into()),
            c => (format!("API error {c}."), "Retry, or switch to another model.".into()),
        },
    };
    // NVIDIA's 404 names internal function/account ids, which only add noise.
    let raw = match e.detail.find("Not found for account") {
        Some(_) => "Not found for this account.".to_string(),
        None => e.detail.clone(),
    };
    let mut detail: String = raw.chars().take(300).collect();
    if raw.chars().count() > 300 {
        detail.push('…');
    }
    if detail.trim().is_empty() {
        format!("{who}: {what} {hint}")
    } else {
        format!("{who}: {what} {hint}\nDetails: {detail}")
    }
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

fn base(cfg: &ProviderConfig, default: &str) -> String {
    cfg.base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .trim_end_matches('/')
        .to_string()
}

async fn read(resp: reqwest::Response) -> Result<Value, ApiErr> {
    let status = resp.status();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok());
    let text = resp.text().await.map_err(net_err)?;
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                ["/error/message", "/0/error/message", "/detail", "/message", "/error"]
                    .iter()
                    .find_map(|p| v.pointer(p).and_then(|m| m.as_str()).map(String::from))
            })
            .unwrap_or(text);
        return Err(ApiErr { kind: ErrKind::Http, status: Some(status.as_u16()), detail, retry_after });
    }
    serde_json::from_str(&text).map_err(|e| ApiErr::new(ErrKind::BadResponse, format!("Bad JSON from API: {e}")))
}

async fn post(req: reqwest::RequestBuilder, body: &Value) -> Result<Value, ApiErr> {
    read(req.json(body).send().await.map_err(net_err)?).await
}

async fn get(req: reqwest::RequestBuilder) -> Result<Value, ApiErr> {
    read(req.send().await.map_err(net_err)?).await
}

// ---------------------------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------------------------

pub fn user_text(cfg: &ProviderConfig, text: &str) -> Value {
    match cfg.provider.as_str() {
        "gemini" => json!({"role": "user", "parts": [{"text": text}]}),
        _ => json!({"role": "user", "content": text}),
    }
}

/// Returns the history entries to append for a batch of tool results.
pub fn tool_results(cfg: &ProviderConfig, results: &[ToolOutcome]) -> Vec<Value> {
    match cfg.provider.as_str() {
        "openai" | "nvidia" => results
            .iter()
            .map(|r| json!({"role": "tool", "tool_call_id": r.call.id, "content": r.output}))
            .collect(),
        "gemini" => vec![json!({
            "role": "user",
            "parts": results.iter().map(|r| {
                let mut fr = json!({
                    "name": r.call.name,
                    "response": if r.is_error { json!({"error": r.output}) } else { json!({"output": r.output}) }
                });
                if !r.call.id.starts_with("gemini-") { fr["id"] = json!(r.call.id); }
                json!({"functionResponse": fr})
            }).collect::<Vec<_>>()
        })],
        _ => vec![json!({
            "role": "user",
            "content": results.iter().map(|r| json!({
                "type": "tool_result",
                "tool_use_id": r.call.id,
                "content": r.output,
                "is_error": r.is_error,
            })).collect::<Vec<_>>()
        })],
    }
}

/// History wire format. Fallback only moves between providers that share one, so the
/// session's native history stays valid.
fn family(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "anthropic",
        "gemini" => "gemini",
        _ => "openai",
    }
}

/// Availability key shared with the frontend: `<provider id>|<model>`.
pub fn avail_key(cfg: &ProviderConfig) -> String {
    format!("{}|{}", cfg.source.as_deref().unwrap_or(&cfg.provider), cfg.model)
}

fn unavailable() -> &'static Mutex<HashSet<String>> {
    static U: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    U.get_or_init(Default::default)
}

/// After this many assistant turns in one task, Auto escalates to the strong tier.
const ESCALATE_AFTER_TURNS: usize = 8;
/// Per-attempt timeout when another candidate is waiting (the last one gets the client's 10 min).
const ATTEMPT_TIMEOUT_SECS: u64 = 240;

fn candidates(cfg: &ProviderConfig, history: &[Value]) -> Vec<ProviderConfig> {
    let mut solo = cfg.clone();
    solo.auto = None;
    let Some(plan) = &cfg.auto else { return vec![solo] };
    let turns = history
        .iter()
        .filter(|m| matches!(m.get("role").and_then(|r| r.as_str()), Some("assistant") | Some("model")))
        .count();
    let strong_first = plan.tier == "strong" || turns >= ESCALATE_AFTER_TURNS;
    let (a, b) = if strong_first { (&plan.strong, &plan.fast) } else { (&plan.fast, &plan.strong) };
    let fam = family(&cfg.provider);
    let dead = unavailable().lock().unwrap().clone();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in a.iter().chain(b.iter()) {
        if family(&c.provider) != fam || c.model.trim().is_empty() {
            continue;
        }
        let k = avail_key(c);
        if dead.contains(&k) || !seen.insert(k) {
            continue;
        }
        let mut c = c.clone();
        c.auto = None;
        if c.effort.is_none() {
            c.effort = cfg.effort.clone();
        }
        out.push(c);
    }
    if out.is_empty() {
        // Everything is marked unavailable: retry the first real candidate rather than the
        // Auto placeholder config.
        let first = a.iter().chain(b.iter()).find(|c| family(&c.provider) == fam && !c.model.trim().is_empty());
        out.push(first.cloned().map(|mut c| { c.auto = None; c }).unwrap_or(solo));
    }
    out
}

/// Calls the model once (with Auto selection / fallback when `cfg.auto` is set). Returns the
/// assistant entry to append to history plus the parsed turn. Errors are user-friendly strings.
pub async fn call(
    client: &reqwest::Client,
    cfg: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
) -> Result<(Value, Turn), String> {
    let cands = candidates(cfg, history);
    let n = cands.len();
    let mut notices: Vec<String> = Vec::new();
    let mut newly_unavailable: Vec<String> = Vec::new();
    let mut dead_endpoints: HashSet<String> = HashSet::new();
    let mut last_err: Option<String> = None;
    for (i, c) in cands.iter().enumerate() {
        let endpoint = format!("{}|{}", c.source.as_deref().unwrap_or(&c.provider), c.base_url.as_deref().unwrap_or(""));
        if dead_endpoints.contains(&endpoint) {
            continue;
        }
        let more = i + 1 < n;
        match attempt(client, c, system, tools, history, max_tokens, more).await {
            Ok((entry, mut turn)) => {
                turn.provider = c.provider.clone();
                turn.source = c.source.clone().unwrap_or_else(|| c.provider.clone());
                turn.model = c.model.clone();
                turn.notices = notices;
                turn.unavailable = newly_unavailable;
                return Ok((entry, turn));
            }
            Err(e) => {
                if e.model_unavailable() {
                    let k = avail_key(c);
                    unavailable().lock().unwrap().insert(k.clone());
                    newly_unavailable.push(k);
                }
                if e.endpoint_dead() {
                    dead_endpoints.insert(endpoint);
                }
                let msg = friendly(c, &e);
                if n == 1 {
                    return Err(msg);
                }
                notices.push(format!("Auto: {} · {} {}; trying the next model.", provider_label(c), c.model, short_reason(&e)));
                last_err = Some(msg);
            }
        }
    }
    Err(format!(
        "Auto: every candidate model failed ({} tried). Last error: {}",
        notices.len(),
        last_err.unwrap_or_else(|| "no usable model is configured.".into())
    ))
}

async fn attempt(
    client: &reqwest::Client,
    c: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
    more: bool,
) -> Result<(Value, Turn), ApiErr> {
    if more {
        // Another candidate is waiting: don't let one slow endpoint stall the task.
        return match tokio::time::timeout(
            Duration::from_secs(ATTEMPT_TIMEOUT_SECS),
            call_one(client, c, system, tools, history, max_tokens),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err(ApiErr::new(ErrKind::Timeout, format!("no answer within {ATTEMPT_TIMEOUT_SECS}s"))),
        };
    }
    // Last (or only) candidate: one quiet retry for transient failures.
    match call_one(client, c, system, tools, history, max_tokens).await {
        Err(e) if e.transient() => {
            tokio::time::sleep(Duration::from_secs(e.retry_after.unwrap_or(2).clamp(1, 10))).await;
            call_one(client, c, system, tools, history, max_tokens).await
        }
        r => r,
    }
}

async fn call_one(
    client: &reqwest::Client,
    cfg: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
) -> Result<(Value, Turn), ApiErr> {
    match cfg.provider.as_str() {
        "openai" => openai(client, cfg, system, tools, history, max_tokens).await,
        "nvidia" => openai(client, &nvidia_config(cfg), system, tools, history, max_tokens).await,
        "gemini" => gemini(client, cfg, system, tools, history, max_tokens).await,
        "anthropic" => anthropic(client, cfg, system, tools, history, max_tokens).await,
        other => Err(format!("Unknown provider '{other}'").into()),
    }
}

/// Emits the per-turn model usage (`model-usage` event) and fallback notices for the UI.
/// Hooked into the agent loop right after its `Usage` event.
pub fn report_turn(app: &tauri::AppHandle, session_id: &str, turn: &Turn) {
    use tauri::Emitter;
    for n in &turn.notices {
        let _ = app.emit("agent-event", json!({"type": "warning", "sessionId": session_id, "message": n}));
    }
    let _ = app.emit(
        "model-usage",
        json!({
            "sessionId": session_id,
            "provider": turn.provider,
            "source": turn.source,
            "model": turn.model,
            "inputTokens": turn.input_tokens,
            "outputTokens": turn.output_tokens,
            "cacheRead": turn.cache_read_tokens,
            "cacheWrite": turn.cache_write_tokens,
            "unavailable": turn.unavailable,
        }),
    );
}

// ---------------------------------------------------------------------------------------------
// Anthropic (Claude) - Messages API over raw HTTP
// ---------------------------------------------------------------------------------------------

fn claude_supports_adaptive(model: &str) -> bool {
    ["opus-5", "opus-4-6", "opus-4-7", "opus-4-8", "sonnet-5", "sonnet-4-6", "fable", "mythos", "haiku-5"]
        .iter()
        .any(|m| model.contains(m))
}

fn claude_supports_fallbacks(model: &str) -> bool {
    ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"]
        .iter()
        .any(|m| model == *m)
}

async fn anthropic(
    client: &reqwest::Client,
    cfg: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
) -> Result<(Value, Turn), ApiErr> {
    let url = format!("{}/v1/messages", base(cfg, "https://api.anthropic.com"));
    let mut body = json!({
        "model": cfg.model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": history,
        // Top-level auto caching: caches tools + system + conversation prefix across loop turns.
        "cache_control": {"type": "ephemeral"},
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.schema}))
                .collect(),
        );
    }
    if claude_supports_adaptive(&cfg.model) {
        body["thinking"] = json!({"type": "adaptive", "display": "summarized"});
        if let Some(e) = cfg.effort.as_deref().filter(|e| !e.is_empty()) {
            body["output_config"] = json!({"effort": e});
        }
    }
    let mut req = client
        .post(url)
        .header("x-api-key", &cfg.api_key)
        .header("anthropic-version", "2026-10-21")
        .header("content-type", "application/json");
    if claude_supports_fallbacks(&cfg.model) {
        // Server-side refusal fallback: the API retries on a fallback model if this one declines.
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01");
    }
    let resp = post(req, &body).await?;

    let content = resp.get("content").cloned().unwrap_or(json!([]));
    let mut turn = Turn::default();
    for block in content.as_array().into_iter().flatten() {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    turn.texts.push(t.to_string());
                }
            }
            Some("thinking") => {
                if let Some(t) = block.get("thinking").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
                    turn.thinking.push(t.to_string());
                }
            }
            Some("tool_use") => turn.calls.push(ToolCall {
                id: block["id"].as_str().unwrap_or_default().to_string(),
                name: block["name"].as_str().unwrap_or_default().to_string(),
                args: block.get("input").cloned().unwrap_or(json!({})),
            }),
            _ => {}
        }
    }
    match resp.get("stop_reason").and_then(|s| s.as_str()) {
        Some("refusal") => {
            let cat = resp
                .pointer("/stop_details/category")
                .and_then(|c| c.as_str())
                .unwrap_or("unspecified");
            turn.warning = Some(format!("The model declined this request (category: {cat})."));
            turn.calls.clear();
        }
        Some("max_tokens") => {
            turn.warning = Some("Response hit the max_tokens limit and was cut off.".into());
        }
        _ => {}
    }
    let u = |k: &str| resp.pointer(&format!("/usage/{k}")).and_then(|v| v.as_u64()).unwrap_or(0);
    turn.cache_read_tokens = u("cache_read_input_tokens");
    turn.cache_write_tokens = u("cache_creation_input_tokens");
    turn.input_tokens = u("input_tokens") + turn.cache_read_tokens + turn.cache_write_tokens;
    turn.output_tokens = u("output_tokens");
    Ok((json!({"role": "assistant", "content": content}), turn))
}

// ---------------------------------------------------------------------------------------------
// NVIDIA NIM (build.nvidia.com) - OpenAI-compatible, with a built-in free-tier key
// ---------------------------------------------------------------------------------------------

pub const NVIDIA_BASE: &str = "https://integrate.api.nvidia.com/v1";

/// Key compiled in by build.rs (empty when none was provided at build time).
pub fn builtin_nvidia_key() -> &'static str {
    env!("CEPHEUS_NVIDIA_KEY")
}

/// Cepheus free-model proxy: OpenAI-compatible, holds the NVIDIA key server-side, needs no
/// Authorization header and rate-limits per client.
pub const CEPHEUS_PROXY_BASE: &str = "https://api.cepheus.codes/v1";

/// Proxy base URL; `CEPHEUS_PROXY_URL` overrides it (testing against a local proxy run).
pub fn cepheus_proxy_base() -> String {
    std::env::var("CEPHEUS_PROXY_URL")
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| CEPHEUS_PROXY_BASE.to_string())
}

/// The user's own key wins; otherwise the built-in one (empty = use the free proxy).
pub fn nvidia_key(user_key: &str) -> String {
    let k = user_key.trim();
    if k.is_empty() { builtin_nvidia_key().to_string() } else { k.to_string() }
}

fn nvidia_config(cfg: &ProviderConfig) -> ProviderConfig {
    let mut c = cfg.clone();
    c.api_key = nvidia_key(&cfg.api_key);
    if c.base_url.as_deref().map(str::trim).unwrap_or("").is_empty() {
        // No key at all: the free proxy. An empty api_key makes `openai()` / `list_models()`
        // send no Authorization header, which is what the proxy expects.
        c.base_url = Some(if c.api_key.is_empty() { cepheus_proxy_base() } else { NVIDIA_BASE.into() });
    }
    c
}

/// Models that cannot chat (embeddings, guards, detectors, image/audio models, ...) are filtered out.
fn is_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    const SKIP: &[&str] = &[
        "embed", "safety", "guard", "clip", "retriever", "rerank", "pii", "detector", "translate",
        "calibration", "starcoder", "parakeet", "riva", "whisper", "tts", "asr", "gliner", "cosmos",
        "dall-e", "moderation", "davinci", "babbage", "realtime", "transcribe", "gpt-image", "-audio",
        "imagen", "veo", "aqa",
    ];
    !SKIP.iter().any(|s| id.contains(s))
}

pub async fn nvidia_models(client: &reqwest::Client, user_key: &str) -> Result<Vec<String>, String> {
    let cfg = ProviderConfig { provider: "nvidia".into(), api_key: user_key.into(), ..Default::default() };
    Ok(list_models(client, &cfg).await?.into_iter().map(|m| m.id).collect())
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio, ...)
// ---------------------------------------------------------------------------------------------

/// OpenAI reasoning models accept `reasoning_effort` (gpt-oss also on NVIDIA NIM / Groq / Ollama).
fn openai_reasoning(model: &str) -> bool {
    let m = model.to_lowercase();
    let short = m.rsplit('/').next().unwrap_or(&m);
    (short.starts_with("o1") || short.starts_with("o3") || short.starts_with("o4") || short.starts_with("gpt-5") || short.contains("gpt-oss"))
        && !short.contains("chat")
}

fn openai_effort(e: &str) -> &'static str {
    match e {
        "low" => "low",
        "medium" => "medium",
        _ => "high",
    }
}

async fn openai(
    client: &reqwest::Client,
    cfg: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
) -> Result<(Value, Turn), ApiErr> {
    let url = format!("{}/chat/completions", base(cfg, "https://api.openai.com/v1"));
    let mut messages = vec![json!({"role": "system", "content": system})];
    messages.extend(history.iter().cloned());
    let mut body = json!({"model": cfg.model, "messages": messages});
    // NIM endpoints default to a small completion limit; OpenAI's newer models reject max_tokens.
    // Same for the free proxy (keyless nvidia), which caps the value at its own limit.
    if cfg.base_url.as_deref() == Some(NVIDIA_BASE) || (cfg.provider == "nvidia" && cfg.api_key.is_empty()) {
        body["max_tokens"] = json!(max_tokens.min(16384));
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|t| json!({"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.schema}}))
                .collect(),
        );
    }
    if let Some(e) = cfg.effort.as_deref().filter(|e| !e.is_empty() && openai_reasoning(&cfg.model)) {
        body["reasoning_effort"] = json!(openai_effort(e));
    }
    let send = |body: &Value| {
        let mut req = client.post(&url);
        if !cfg.api_key.is_empty() {
            req = req.bearer_auth(&cfg.api_key);
        }
        let body = body.clone();
        async move { post(req, &body).await }
    };
    let resp = match send(&body).await {
        // Some compatible servers reject the reasoning flag: retry once without it.
        Err(e) if e.code() == 400 && body.get("reasoning_effort").is_some() && e.detail.to_lowercase().contains("reasoning") => {
            body.as_object_mut().map(|o| o.remove("reasoning_effort"));
            send(&body).await?
        }
        r => r?,
    };
    let msg = resp.pointer("/choices/0/message").cloned().ok_or("Empty response from model")?;
    let mut turn = Turn::default();
    if let Some(t) = msg.get("content").and_then(|c| c.as_str()).filter(|s| !s.is_empty()) {
        turn.texts.push(t.to_string());
    }
    if let Some(t) = msg
        .get("reasoning_content")
        .or_else(|| msg.get("reasoning"))
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
    {
        turn.thinking.push(t.to_string());
    }
    let mut entry = json!({"role": "assistant", "content": msg.get("content").cloned().unwrap_or(Value::Null)});
    if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()).filter(|c| !c.is_empty()) {
        for c in calls {
            let args_s = c.pointer("/function/arguments").and_then(|a| a.as_str()).unwrap_or("{}");
            turn.calls.push(ToolCall {
                id: c["id"].as_str().unwrap_or_default().to_string(),
                name: c.pointer("/function/name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
                args: serde_json::from_str(args_s).unwrap_or(json!({})),
            });
        }
        entry["tool_calls"] = Value::Array(calls.clone());
    }
    if resp.pointer("/choices/0/finish_reason").and_then(|f| f.as_str()) == Some("length") {
        turn.warning = Some("Response was cut off (length limit).".into());
    }
    turn.input_tokens = resp.pointer("/usage/prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    turn.output_tokens = resp.pointer("/usage/completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    turn.cache_read_tokens = resp.pointer("/usage/prompt_tokens_details/cached_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok((entry, turn))
}

// ---------------------------------------------------------------------------------------------
// Google Gemini - generateContent
// ---------------------------------------------------------------------------------------------

/// Gemini 3 takes a thinking level, Gemini 2.5 a token budget; older models have no thinking.
fn gemini_thinking(model: &str, effort: Option<&str>, max_tokens: u32) -> Option<Value> {
    let e = effort.filter(|e| !e.is_empty())?;
    let m = model.to_lowercase();
    if m.contains("gemini-3") {
        let level = if matches!(e, "low" | "medium") { "low" } else { "high" };
        Some(json!({"thinkingLevel": level, "includeThoughts": true}))
    } else if m.contains("gemini-2.5") {
        let budget: i64 = match e {
            "low" => 1024,
            "medium" => 4096,
            "high" => 8192,
            "xhigh" => 16384,
            _ => -1, // max: dynamic
        };
        let budget = if budget > 0 { budget.min((max_tokens / 2).max(1024) as i64) } else { budget };
        Some(json!({"thinkingBudget": budget, "includeThoughts": true}))
    } else {
        None
    }
}

async fn gemini(
    client: &reqwest::Client,
    cfg: &ProviderConfig,
    system: &str,
    tools: &[ToolDef],
    history: &[Value],
    max_tokens: u32,
) -> Result<(Value, Turn), ApiErr> {
    let url = format!(
        "{}/v1beta/models/{}:generateContent",
        base(cfg, "https://generativelanguage.googleapis.com"),
        cfg.model
    );
    let mut body = json!({
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": history,
        "generationConfig": {"maxOutputTokens": max_tokens},
    });
    if let Some(t) = gemini_thinking(&cfg.model, cfg.effort.as_deref(), max_tokens) {
        body["generationConfig"]["thinkingConfig"] = t;
    }
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": tools.iter().map(|t| json!({
                "name": t.name, "description": t.description, "parameters": t.schema
            })).collect::<Vec<_>>()
        }]);
    }
    let req = client.post(url).header("x-goog-api-key", &cfg.api_key);
    let resp = post(req, &body).await?;
    let content = resp
        .pointer("/candidates/0/content")
        .cloned()
        .unwrap_or(json!({"role": "model", "parts": []}));
    let mut turn = Turn::default();
    for (i, part) in content.get("parts").and_then(|p| p.as_array()).into_iter().flatten().enumerate() {
        if let Some(fc) = part.get("functionCall") {
            turn.calls.push(ToolCall {
                id: fc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("gemini-{i}")),
                name: fc["name"].as_str().unwrap_or_default().to_string(),
                args: fc.get("args").cloned().unwrap_or(json!({})),
            });
        } else if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            if part.get("thought").and_then(|b| b.as_bool()) == Some(true) {
                turn.thinking.push(t.to_string());
            } else {
                turn.texts.push(t.to_string());
            }
        }
    }
    match resp.pointer("/candidates/0/finishReason").and_then(|f| f.as_str()) {
        Some("SAFETY") | Some("PROHIBITED_CONTENT") | Some("RECITATION") => {
            turn.warning = Some("The model stopped for safety reasons.".into())
        }
        Some("MAX_TOKENS") => turn.warning = Some("Response was cut off (max tokens).".into()),
        _ => {}
    }
    let u = |k: &str| resp.pointer(&format!("/usageMetadata/{k}")).and_then(|v| v.as_u64()).unwrap_or(0);
    turn.input_tokens = u("promptTokenCount");
    turn.output_tokens = u("candidatesTokenCount") + u("thoughtsTokenCount");
    turn.cache_read_tokens = u("cachedContentTokenCount");
    let mut entry = content;
    entry["role"] = json!("model");
    if entry.get("parts").map(|p| p.as_array().map(|a| a.is_empty()).unwrap_or(true)).unwrap_or(true) {
        entry["parts"] = json!([{"text": ""}]);
    }
    Ok((entry, turn))
}

// ---------------------------------------------------------------------------------------------
// Live model listing (Language Models editor)
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: Option<String>,
    pub context_window: Option<u64>,
    pub max_output: Option<u64>,
    /// None = unknown (the frontend fills in from its known-model table).
    pub tools: Option<bool>,
    pub vision: Option<bool>,
    pub reasoning: Option<bool>,
}

fn supported(v: &Value, path: &str) -> Option<bool> {
    v.pointer(path).and_then(|b| b.as_bool())
}

pub async fn list_models(client: &reqwest::Client, cfg: &ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    let fail = |e: ApiErr| friendly(cfg, &e);
    let mut out: Vec<ModelInfo> = Vec::new();
    match cfg.provider.as_str() {
        "anthropic" => {
            let root = base(cfg, "https://api.anthropic.com");
            let mut after: Option<String> = None;
            for _ in 0..5 {
                let mut url = format!("{root}/v1/models?limit=1000");
                if let Some(a) = &after {
                    url.push_str(&format!("&after_id={a}"));
                }
                let v = get(client.get(url).header("x-api-key", &cfg.api_key).header("anthropic-version", "2026-10-21"))
                    .await
                    .map_err(fail)?;
                for m in v["data"].as_array().into_iter().flatten() {
                    let Some(id) = m["id"].as_str() else { continue };
                    let caps = &m["capabilities"];
                    out.push(ModelInfo {
                        id: id.into(),
                        name: m["display_name"].as_str().map(String::from),
                        context_window: m["max_input_tokens"].as_u64(),
                        max_output: m["max_tokens"].as_u64(),
                        tools: Some(true),
                        vision: supported(caps, "/image_input/supported"),
                        reasoning: supported(caps, "/thinking/supported").or(supported(caps, "/effort/supported")),
                    });
                }
                if v["has_more"].as_bool() != Some(true) {
                    break;
                }
                after = v["last_id"].as_str().map(String::from);
                if after.is_none() {
                    break;
                }
            }
        }
        "gemini" => {
            let root = base(cfg, "https://generativelanguage.googleapis.com");
            let mut token: Option<String> = None;
            for _ in 0..5 {
                let mut url = format!("{root}/v1beta/models?pageSize=1000");
                if let Some(t) = &token {
                    url.push_str(&format!("&pageToken={t}"));
                }
                let v = get(client.get(url).header("x-goog-api-key", &cfg.api_key)).await.map_err(fail)?;
                for m in v["models"].as_array().into_iter().flatten() {
                    let gen = m["supportedGenerationMethods"]
                        .as_array()
                        .map(|a| a.iter().any(|x| x.as_str() == Some("generateContent")))
                        .unwrap_or(false);
                    let Some(id) = m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string()) else { continue };
                    if !gen || !is_chat_model(&id) || id.contains("image") {
                        continue;
                    }
                    out.push(ModelInfo {
                        name: m["displayName"].as_str().map(String::from),
                        context_window: m["inputTokenLimit"].as_u64(),
                        max_output: m["outputTokenLimit"].as_u64(),
                        tools: Some(!id.contains("gemma")),
                        vision: Some(id.starts_with("gemini")),
                        reasoning: m["thinking"].as_bool(),
                        id,
                    });
                }
                token = v["nextPageToken"].as_str().filter(|t| !t.is_empty()).map(String::from);
                if token.is_none() {
                    break;
                }
            }
        }
        "openai" | "nvidia" => {
            let c = if cfg.provider == "nvidia" { nvidia_config(cfg) } else { cfg.clone() };
            let mut req = client.get(format!("{}/models", base(&c, "https://api.openai.com/v1")));
            if !c.api_key.is_empty() {
                req = req.bearer_auth(&c.api_key);
            }
            let v = get(req).await.map_err(fail)?;
            for m in v["data"].as_array().into_iter().flatten() {
                let Some(id) = m["id"].as_str() else { continue };
                if !is_chat_model(id) {
                    continue;
                }
                // OpenRouter-style metadata when present.
                let params = m["supported_parameters"].as_array();
                let mods = m.pointer("/architecture/input_modalities").and_then(|a| a.as_array());
                out.push(ModelInfo {
                    id: id.into(),
                    name: m["name"].as_str().map(String::from),
                    context_window: m["context_length"].as_u64().or(m["context_window"].as_u64()),
                    max_output: m.pointer("/top_provider/max_completion_tokens").and_then(|v| v.as_u64()),
                    tools: params.map(|p| p.iter().any(|x| x.as_str() == Some("tools"))),
                    vision: mods.map(|a| a.iter().any(|x| x.as_str() == Some("image"))),
                    reasoning: params.map(|p| p.iter().any(|x| matches!(x.as_str(), Some("reasoning") | Some("include_reasoning")))),
                });
            }
        }
        other => return Err(format!("Unknown provider '{other}'")),
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    Ok(out)
}

fn list_client() -> reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        crate::net::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("http client")
    })
    .clone()
}

#[tauri::command]
pub async fn models_list(config: ProviderConfig) -> Result<Vec<ModelInfo>, String> {
    list_models(&list_client(), &config).await
}

/// Models found unavailable for this account during this app run (`<provider id>|<model>`).
#[tauri::command]
pub fn models_unavailable() -> Vec<String> {
    let mut v: Vec<String> = unavailable().lock().unwrap().iter().cloned().collect();
    v.sort();
    v
}

/// Forget unavailable marks (all when `keys` is None) so the models are tried again.
#[tauri::command]
pub fn models_reset_unavailable(keys: Option<Vec<String>>) {
    let mut u = unavailable().lock().unwrap();
    match keys {
        Some(k) => k.iter().for_each(|k| {
            u.remove(k);
        }),
        None => u.clear(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http(code: u16, detail: &str) -> ApiErr {
        ApiErr { kind: ErrKind::Http, status: Some(code), detail: detail.into(), retry_after: None }
    }

    #[test]
    fn classifies_errors() {
        assert!(http(404, "Function 'x': Not found for account 'y'").model_unavailable());
        assert!(http(400, "The model `foo` does not exist").model_unavailable());
        assert!(!http(400, "messages: invalid").model_unavailable());
        assert!(http(429, "").transient() && http(503, "").transient());
        assert!(!http(401, "").transient() && http(401, "").endpoint_dead());
        let cfg = ProviderConfig { provider: "nvidia".into(), model: "google/gemma".into(), ..Default::default() };
        assert!(friendly(&cfg, &http(429, "")).contains("free tier"));
        // The free proxy's 429 text is shown as-is; its daily limit is not retried.
        let daily = http(429, "Free tier daily limit of 400 requests reached. It resets within 3h.");
        assert!(friendly(&cfg, &daily).contains(": Free tier daily limit") && !daily.transient());
        assert!(http(429, "Free tier limit: 20 requests per minute.").transient());
        assert!(http(400, "Model not available on the free tier. Use one of: a, b").model_unavailable());
    }

    #[test]
    fn keyless_nvidia_uses_free_proxy() {
        let c = nvidia_config(&ProviderConfig { provider: "nvidia".into(), ..Default::default() });
        if builtin_nvidia_key().is_empty() {
            assert_eq!(c.base_url.as_deref(), Some(cepheus_proxy_base().as_str()));
            assert!(c.api_key.is_empty(), "proxy requests must carry no Authorization header");
        } else {
            assert_eq!(c.base_url.as_deref(), Some(NVIDIA_BASE));
        }
        // A user key always goes straight to NVIDIA.
        let own = nvidia_config(&ProviderConfig { provider: "nvidia".into(), api_key: "nvapi-x".into(), ..Default::default() });
        assert_eq!((own.base_url.as_deref(), own.api_key.as_str()), (Some(NVIDIA_BASE), "nvapi-x"));
    }

    #[test]
    fn auto_candidates_respect_family_and_tier() {
        let m = |p: &str, id: &str| ProviderConfig { provider: p.into(), model: id.into(), ..Default::default() };
        let cfg = ProviderConfig {
            provider: "nvidia".into(),
            model: "a".into(),
            auto: Some(AutoPlan { tier: "fast".into(), fast: vec![m("nvidia", "f"), m("gemini", "g")], strong: vec![m("openai", "s"), m("nvidia", "f")] }),
            ..Default::default()
        };
        let ids: Vec<String> = candidates(&cfg, &[]).into_iter().map(|c| c.model).collect();
        assert_eq!(ids, vec!["f", "s"]);
        let long: Vec<Value> = (0..ESCALATE_AFTER_TURNS).map(|_| json!({"role": "assistant"})).collect();
        let ids: Vec<String> = candidates(&cfg, &long).into_iter().map(|c| c.model).collect();
        assert_eq!(ids, vec!["s", "f"]);
    }
}
