//! Organization policy: a system-wide JSON file an administrator deploys next to the app.
//! Every setting it names is locked (overrides user and workspace values), and it can restrict
//! AI providers/models/tools, MCP servers, extensions, updates and networking.
//!
//! Location (override with the `CEPHEUS_POLICY_PATH` environment variable, e.g. for testing):
//! - Windows: `%ProgramData%\Cepheus\policy.json`
//! - macOS:   `/Library/Application Support/Cepheus/policy.json`
//! - Linux:   `/etc/cepheus/policy.json`
//!
//! The file is read once, on first use, and never written by Cepheus.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::PathBuf;
use std::sync::OnceLock;

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPolicy {
    #[serde(default)]
    pub http: String,
    #[serde(default)]
    pub https: String,
    #[serde(default)]
    pub no_proxy: String,
}

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Policy {
    /// Locked settings (same keys as the Settings UI / settings.json). Unknown top-level keys are
    /// treated as settings too, so `{ "approvalMode": "ask" }` works without nesting.
    pub settings: Map<String, Value>,
    /// Provider ids: "nvidia" | "anthropic" | "openai" | "gemini".
    pub allowed_providers: Option<Vec<String>>,
    /// Model id globs (`*`, `?`), e.g. "claude-*", "gpt-5*".
    pub allowed_models: Option<Vec<String>>,
    /// Agent tool names (list_dir, read_file, write_file, edit_file, run_command, ...).
    pub allowed_agent_tools: Option<Vec<String>>,
    /// MCP server names (globs).
    pub allowed_mcp_servers: Option<Vec<String>>,
    /// "ask" (strictest) | "auto-edit" | "turbo": users cannot pick a less strict mode.
    pub minimum_approval_mode: Option<String>,
    /// Appended to every agent's instructions.
    pub shared_instructions: Option<String>,
    /// "publisher" | "publisher.name" | "publisher.name@version" | "*".
    pub extension_allowlist: Option<Vec<String>>,
    /// "publisher.name" or "publisher.name@version", installed once on first launch.
    pub preinstall_extensions: Vec<String>,
    /// Open VSX-compatible registry base URL (private marketplace).
    pub extension_registry_url: Option<String>,
    /// Cepheus collects no telemetry; only "off" is meaningful.
    pub telemetry_level: Option<String>,
    /// "automatic" | "startup" | "manual" | "none"
    pub update_mode: Option<String>,
    /// Update endpoint (latest.json URL) and minisign public key, overriding tauri.conf.json.
    pub update_endpoint: Option<String>,
    pub update_pubkey: Option<String>,
    #[serde(deserialize_with = "proxy_de")]
    pub proxy: Option<ProxyPolicy>,
    /// PEM files (paths) with extra CA certificates trusted for all HTTPS requests.
    pub trusted_certificates: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `"proxy": "http://host:3128"` or `"proxy": { "http": …, "https": …, "noProxy": … }`.
fn proxy_de<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<ProxyPolicy>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::String(s) if !s.trim().is_empty() => Some(ProxyPolicy { http: s.clone(), https: s, no_proxy: String::new() }),
        Value::Object(_) => Some(serde_json::from_value(v).map_err(serde::de::Error::custom)?),
        _ => None,
    })
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub path: String,
    pub present: bool,
    pub error: Option<String>,
    pub policy: Policy,
}

static POLICY: OnceLock<Loaded> = OnceLock::new();

pub fn policy_path() -> PathBuf {
    if let Some(p) = std::env::var_os("CEPHEUS_POLICY_PATH").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    if cfg!(windows) {
        let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("Cepheus").join("policy.json")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/Cepheus/policy.json")
    } else {
        PathBuf::from("/etc/cepheus/policy.json")
    }
}

/// Strips // and /* */ comments and trailing commas (policy and devcontainer files are JSONC).
pub fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_str = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas: `,` followed only by whitespace before `}` or `]` (outside strings).
    let bytes: Vec<char> = out.chars().collect();
    let mut res = String::with_capacity(bytes.len());
    let mut in_str = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_str {
            res.push(c);
            if c == '\\' && i + 1 < bytes.len() {
                res.push(bytes[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            res.push(c);
        } else if c == ',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if j >= bytes.len() || (bytes[j] != '}' && bytes[j] != ']') {
                res.push(c);
            }
        } else {
            res.push(c);
        }
        i += 1;
    }
    res
}

pub fn parse_policy(text: &str) -> Result<Policy, String> {
    let mut p: Policy = serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("Invalid policy file: {e}"))?;
    // Top-level keys that are not policy fields are locked settings.
    let extra = std::mem::take(&mut p.extra);
    for (k, v) in extra {
        p.settings.entry(k).or_insert(v);
    }
    Ok(p)
}

fn load() -> Loaded {
    let path = policy_path();
    let mut l = Loaded { path: path.to_string_lossy().to_string(), ..Default::default() };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            l.present = true;
            match parse_policy(&text) {
                Ok(p) => l.policy = p,
                // A broken file must not brick the app; the error is shown in the UI.
                Err(e) => l.error = Some(e),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            l.present = true;
            l.error = Some(format!("Cannot read policy file: {e}"));
        }
    }
    l
}

pub fn get() -> &'static Policy {
    &POLICY.get_or_init(load).policy
}

/// Effective organization policy for the frontend.
#[tauri::command]
pub fn policy_get() -> Loaded {
    POLICY.get_or_init(load).clone()
}

// ---------------------------------------------------------------------------------------------
// Matching helpers (also used by other modules)
// ---------------------------------------------------------------------------------------------

/// Case-insensitive glob with `*` and `?`.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn list_allows(list: &Option<Vec<String>>, value: &str) -> bool {
    match list {
        None => true,
        Some(l) => l.iter().any(|g| glob_match(g.trim(), value)),
    }
}

pub fn provider_allowed(p: &Policy, provider: &str) -> bool {
    list_allows(&p.allowed_providers, provider)
}

pub fn model_allowed(p: &Policy, model: &str) -> bool {
    list_allows(&p.allowed_models, model)
}

pub fn tool_allowed(name: &str) -> bool {
    // update_plan only renders a checklist; it is never blocked.
    name == "update_plan" || list_allows(&get().allowed_agent_tools, name)
}

/// For the MCP client: whether a configured server may be started.
#[allow(dead_code)]
pub fn mcp_allowed(name: &str) -> bool {
    list_allows(&get().allowed_mcp_servers, name)
}

/// Extension allowlist: entries are "publisher", "publisher.name" or "publisher.name@version".
pub fn extension_allowed_by(list: &Option<Vec<String>>, id: &str, version: &str) -> bool {
    let Some(list) = list else { return true };
    let id = id.to_lowercase();
    let publisher = id.split('.').next().unwrap_or("");
    list.iter().any(|e| {
        let e = e.trim().to_lowercase();
        if e == "*" || e == publisher || e == id {
            return true;
        }
        match e.split_once('@') {
            Some((eid, ver)) => eid == id && (ver == version.to_lowercase() || ver == "*"),
            None => false,
        }
    })
}

pub fn extension_allowed(id: &str, version: &str) -> bool {
    extension_allowed_by(&get().extension_allowlist, id, version)
}

fn strictness(mode: &str) -> u8 {
    match mode {
        "turbo" => 0,
        "auto-edit" => 1,
        _ => 2,
    }
}

/// Raises `mode` to the policy's minimum approval mode.
pub fn approval_floor_by(min: Option<&str>, mode: &str) -> String {
    match min {
        Some(m) if strictness(m) > strictness(mode) => m.to_string(),
        _ => mode.to_string(),
    }
}

pub fn check_model(p: &Policy, provider: &str, model: &str) -> Result<(), String> {
    if !provider_allowed(p, provider) {
        return Err(format!("The provider '{provider}' is not allowed by your organization's policy."));
    }
    if !model.trim().is_empty() && !model_allowed(p, model) {
        return Err(format!("The model '{model}' is not allowed by your organization's policy."));
    }
    Ok(())
}

/// Single entry point for the agent loop: enforces provider/model rules, the approval-mode floor,
/// and appends shared instructions (plus a note when commands run inside a dev container).
pub fn agent_preflight(req: &mut crate::agent::AgentRunReq) -> Result<(), String> {
    let p = get();
    check_model(p, &req.config.provider, &req.config.model)?;
    req.approval_mode = approval_floor_by(p.minimum_approval_mode.as_deref(), &req.approval_mode);
    let mut extra = String::new();
    if let Some(s) = p.shared_instructions.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        extra.push_str("Organization instructions:\n");
        extra.push_str(s);
    }
    if let Some(note) = crate::devcontainer::agent_note(&req.workspace) {
        if !extra.is_empty() {
            extra.push_str("\n\n");
        }
        extra.push_str(&note);
    }
    if !extra.is_empty() {
        let base = req.custom_instructions.take().unwrap_or_default();
        req.custom_instructions = Some(if base.trim().is_empty() { extra } else { format!("{base}\n\n{extra}") });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        // comments are allowed
        "settings": { "inlineCompletion": false },
        "approvalMode": "ask",
        "allowedProviders": ["anthropic", "openai"],
        "allowedModels": ["claude-*", "gpt-5*"],
        "allowedAgentTools": ["read_file", "list_dir"],
        "minimumApprovalMode": "auto-edit",
        "sharedInstructions": "Never commit secrets.",
        "extensionAllowlist": ["dracula-theme", "pkief.material-icon-theme@5.0.0", "github.github-vscode-theme"],
        "preinstallExtensions": ["dracula-theme.theme-dracula"],
        "proxy": "http://proxy.corp:3128",
        "trustedCertificates": ["C:/certs/corp.pem"],
        "updateMode": "manual", /* block comment */
    }"#;

    #[test]
    fn parses_jsonc_and_flattens_settings() {
        let p = parse_policy(SAMPLE).unwrap();
        assert_eq!(p.settings.get("inlineCompletion"), Some(&Value::Bool(false)));
        assert_eq!(p.settings.get("approvalMode"), Some(&Value::String("ask".into())));
        assert!(!p.settings.contains_key("allowedProviders"));
        assert_eq!(p.proxy.as_ref().unwrap().https, "http://proxy.corp:3128");
        assert_eq!(p.update_mode.as_deref(), Some("manual"));
        assert_eq!(p.trusted_certificates.len(), 1);
    }

    #[test]
    fn proxy_object_form() {
        let p = parse_policy(r#"{"proxy": {"http": "http://a:1", "https": "http://b:2", "noProxy": "localhost"}}"#).unwrap();
        let px = p.proxy.unwrap();
        assert_eq!((px.http.as_str(), px.https.as_str(), px.no_proxy.as_str()), ("http://a:1", "http://b:2", "localhost"));
    }

    #[test]
    fn strings_with_comment_markers_survive() {
        let p = parse_policy(r#"{"sharedInstructions": "see http://x/y // not a comment, ok",}"#).unwrap();
        assert_eq!(p.shared_instructions.as_deref(), Some("see http://x/y // not a comment, ok"));
    }

    #[test]
    fn invalid_policy_is_an_error() {
        assert!(parse_policy("{ nope").is_err());
    }

    #[test]
    fn models_and_providers() {
        let p = parse_policy(SAMPLE).unwrap();
        assert!(check_model(&p, "anthropic", "claude-opus-5-5").is_ok());
        assert!(check_model(&p, "anthropic", "Claude-Sonnet-5-5").is_ok());
        assert!(check_model(&p, "nvidia", "claude-opus-5-5").is_err());
        assert!(check_model(&p, "openai", "llama3.1").is_err());
        assert!(check_model(&p, "openai", "gpt-5-mini").is_ok());
        assert!(check_model(&Policy::default(), "nvidia", "anything").is_ok());
    }

    #[test]
    fn globs() {
        assert!(glob_match("claude-*", "claude-opus"));
        assert!(glob_match("*", ""));
        assert!(glob_match("gpt-?", "gpt-5"));
        assert!(!glob_match("gpt-?", "gpt-55"));
        assert!(glob_match("*mini*", "o4-mini-high"));
        assert!(!glob_match("claude", "claude-opus"));
    }

    #[test]
    fn extension_allowlist() {
        let p = parse_policy(SAMPLE).unwrap();
        let l = &p.extension_allowlist;
        assert!(extension_allowed_by(l, "dracula-theme.theme-dracula", "2.25.1")); // publisher
        assert!(extension_allowed_by(l, "GitHub.github-vscode-theme", "6.3.5")); // id, case-insensitive
        assert!(extension_allowed_by(l, "pkief.material-icon-theme", "5.0.0")); // exact version
        assert!(!extension_allowed_by(l, "pkief.material-icon-theme", "5.1.0"));
        assert!(!extension_allowed_by(l, "evil.theme", "1.0.0"));
        assert!(extension_allowed_by(&None, "evil.theme", "1.0.0"));
        assert!(extension_allowed_by(&Some(vec!["*".into()]), "x.y", "1"));
    }

    #[test]
    fn approval_floor() {
        assert_eq!(approval_floor_by(Some("auto-edit"), "turbo"), "auto-edit");
        assert_eq!(approval_floor_by(Some("auto-edit"), "ask"), "ask");
        assert_eq!(approval_floor_by(Some("ask"), "auto-edit"), "ask");
        assert_eq!(approval_floor_by(None, "turbo"), "turbo");
    }

    #[test]
    fn loads_from_override_path() {
        // Set only for this process; never touches %ProgramData%.
        let f = std::env::temp_dir().join(format!("cepheus-policy-test-{}.json", std::process::id()));
        std::fs::write(&f, SAMPLE).unwrap();
        std::env::set_var("CEPHEUS_POLICY_PATH", &f);
        assert_eq!(policy_path(), f);
        let l = load();
        assert!(l.present && l.error.is_none());
        assert_eq!(l.policy.minimum_approval_mode.as_deref(), Some("auto-edit"));
        std::fs::write(&f, "{ broken").unwrap();
        let l = load();
        assert!(l.present && l.error.is_some(), "a broken file is reported, not fatal");
        std::fs::remove_file(&f).unwrap();
        assert!(!load().present);
        std::env::remove_var("CEPHEUS_POLICY_PATH");
    }
}
