//! Workspace customizations for the agent: instruction files, skills, custom agents and hooks.
//! Everything is read through `vfs`, so it works for local and `ssh://` workspaces alike.

use crate::vfs;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;

/// Instruction files that always apply (when present) at the workspace root.
const ROOT_INSTRUCTION_FILES: &[&str] = &["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const MAX_INSTRUCTION_BYTES: usize = 40_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instruction {
    /// Relative path (workspace) shown to the user.
    pub path: String,
    pub apply_to: Option<String>,
    #[serde(skip)]
    pub body: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// "workspace" | "user"
    pub source: String,
    /// Absolute folder of the skill.
    pub dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    /// None = all tools.
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub path: String,
    #[serde(skip)]
    pub body: String,
}

#[derive(Clone, Serialize)]
pub struct Hook {
    /// "preToolUse" | "postToolUse" | "stop"
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub timeout: Option<u64>,
}

#[derive(Default, Clone, Serialize)]
pub struct Customizations {
    pub instructions: Vec<Instruction>,
    pub skills: Vec<Skill>,
    pub agents: Vec<AgentDef>,
    pub hooks: Vec<Hook>,
}

// ---------------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------------

/// Splits a `---` YAML-ish frontmatter block from the body. Supports `key: value`,
/// `key: [a, b]` and block lists (`key:` followed by `  - a` lines).
pub fn parse_frontmatter(text: &str) -> (HashMap<String, Value>, String) {
    let t = text.trim_start_matches('\u{feff}');
    let mut map = HashMap::new();
    let rest = t.strip_prefix("---\r\n").or_else(|| t.strip_prefix("---\n"));
    let Some(rest) = rest else { return (map, t.to_string()) };
    let mut body_start = None;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            body_start = Some(offset + line.len());
            break;
        }
        offset += line.len();
    }
    let Some(bs) = body_start else { return (map, t.to_string()) };
    let head = &rest[..offset];
    let body = rest[bs..].to_string();
    let mut last_key: Option<String> = None;
    for line in head.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let trimmed = line.trim_start();
        if let (Some(item), Some(k)) = (trimmed.strip_prefix("- "), last_key.as_ref()) {
            let entry = map.entry(k.clone()).or_insert_with(|| Value::Array(vec![]));
            if !entry.is_array() {
                *entry = Value::Array(vec![]);
            }
            entry.as_array_mut().unwrap().push(Value::String(unquote(item.trim())));
            continue;
        }
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim().to_string();
        let v = v.trim();
        last_key = Some(k.clone());
        if v.is_empty() {
            map.insert(k, Value::Null);
        } else if v.starts_with('[') && v.ends_with(']') {
            let items = v[1..v.len() - 1]
                .split(',')
                .map(|s| unquote(s.trim()))
                .filter(|s| !s.is_empty())
                .map(Value::String)
                .collect();
            map.insert(k, Value::Array(items));
        } else {
            map.insert(k, Value::String(unquote(v)));
        }
    }
    (map, body)
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && ((s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\''))) {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

fn fm_str(m: &HashMap<String, Value>, k: &str) -> Option<String> {
    match m.get(k)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Array(a) => Some(a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(",")),
        _ => None,
    }
}

fn fm_list(m: &HashMap<String, Value>, k: &str) -> Option<Vec<String>> {
    match m.get(k)? {
        Value::Array(a) => Some(a.iter().filter_map(|v| v.as_str().map(String::from)).collect()),
        Value::String(s) => Some(s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Globs (applyTo)
// ---------------------------------------------------------------------------------------------

fn glob_to_regex(glob: &str) -> String {
    let mut re = String::from("^");
    let chars: Vec<char> = glob.chars().collect();
    let mut i = 0;
    let mut in_brace = false;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' if chars.get(i + 1) == Some(&'*') => {
                if chars.get(i + 2) == Some(&'/') {
                    re.push_str("(?:.*/)?");
                    i += 3;
                } else {
                    re.push_str(".*");
                    i += 2;
                }
                continue;
            }
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            '{' => {
                in_brace = true;
                re.push_str("(?:");
            }
            '}' if in_brace => {
                in_brace = false;
                re.push(')');
            }
            ',' if in_brace => re.push('|'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    re.push('$');
    re
}

/// Matches a comma-separated glob list (`applyTo`) against a relative path with `/` separators.
/// Patterns without a `/` also match the file name, so `*.ts` works like `**/*.ts`.
pub fn glob_match(globs: &str, path: &str) -> bool {
    let path = path.replace('\\', "/");
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    split_globs(globs).iter().any(|g| {
        let g = g.trim_start_matches("./");
        let Ok(re) = regex::RegexBuilder::new(&glob_to_regex(g)).case_insensitive(cfg!(windows)).build() else { return false };
        re.is_match(&path) || (!g.contains('/') && re.is_match(&name))
    })
}

/// Splits on commas that are not inside `{...}`.
fn split_globs(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0;
    let mut cur = String::new();
    for c in s.chars() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                if !cur.trim().is_empty() {
                    out.push(cur.trim().to_string());
                }
                cur.clear();
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_string());
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

async fn read_opt(p: &str) -> Option<String> {
    if !vfs::exists(p).await {
        return None;
    }
    vfs::read_text(p).await.ok()
}

fn clip(mut s: String) -> String {
    if s.len() > MAX_INSTRUCTION_BYTES {
        let mut cut = MAX_INSTRUCTION_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n... [truncated]");
    }
    s
}

async fn md_files(dir: &str) -> Vec<(String, String)> {
    let Ok(entries) = vfs::read_dir(dir).await else { return vec![] };
    let mut v: Vec<(String, String)> = entries
        .into_iter()
        .filter(|e| !e.is_dir && e.name.to_lowercase().ends_with(".md"))
        .map(|e| (e.name.clone(), vfs::join(dir, &e.name)))
        .collect();
    v.sort();
    v
}

async fn load_skills_from(root: &str, source: &str, out: &mut Vec<Skill>) {
    let Ok(entries) = vfs::read_dir(root).await else { return };
    for e in entries.into_iter().filter(|e| e.is_dir) {
        let dir = vfs::join(root, &e.name);
        let Some(text) = read_opt(&vfs::join(&dir, "SKILL.md")).await else { continue };
        let (fm, body) = parse_frontmatter(&text);
        let name = fm_str(&fm, "name").unwrap_or_else(|| e.name.clone());
        if out.iter().any(|s| s.name == name) {
            continue; // workspace skills shadow user skills with the same name
        }
        let description = fm_str(&fm, "description")
            .unwrap_or_else(|| body.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).unwrap_or("").trim().to_string());
        out.push(Skill { name, description, source: source.into(), dir });
    }
}

/// Loads everything. `data_dir` is the app data folder (user-level skills live in `<data_dir>/skills`).
pub async fn load(ws: &str, data_dir: Option<&str>) -> Customizations {
    let mut c = Customizations::default();
    for f in ROOT_INSTRUCTION_FILES {
        if let Some(text) = read_opt(&vfs::join(ws, f)).await {
            let (fm, body) = parse_frontmatter(&text);
            c.instructions.push(Instruction { path: f.to_string(), apply_to: fm_str(&fm, "applyTo"), body: clip(body) });
        }
    }
    let cep = vfs::join(ws, ".cepheus");
    for (name, path) in md_files(&vfs::join(&cep, "instructions")).await {
        if let Some(text) = read_opt(&path).await {
            let (fm, body) = parse_frontmatter(&text);
            c.instructions.push(Instruction {
                path: format!(".cepheus/instructions/{name}"),
                apply_to: fm_str(&fm, "applyTo"),
                body: clip(body),
            });
        }
    }
    load_skills_from(&vfs::join(&cep, "skills"), "workspace", &mut c.skills).await;
    if let Some(d) = data_dir {
        load_skills_from(&vfs::join(d, "skills"), "user", &mut c.skills).await;
    }
    for (name, path) in md_files(&vfs::join(&cep, "agents")).await {
        if let Some(text) = read_opt(&path).await {
            let (fm, body) = parse_frontmatter(&text);
            let stem = name.trim_end_matches(".md").trim_end_matches(".agent").to_string();
            c.agents.push(AgentDef {
                name: fm_str(&fm, "name").unwrap_or(stem),
                description: fm_str(&fm, "description").unwrap_or_default(),
                tools: fm_list(&fm, "tools").filter(|t| !t.is_empty()),
                model: fm_str(&fm, "model"),
                path: format!(".cepheus/agents/{name}"),
                body: clip(body),
            });
        }
    }
    if let Some(text) = read_opt(&vfs::join(&cep, "hooks.json")).await {
        c.hooks = parse_hooks(&text);
    }
    c
}

/// Accepts `[{...}]`, `{"hooks": [...]}` or `{"hooks": {"preToolUse": [{matcher, command}]}}`.
pub fn parse_hooks(text: &str) -> Vec<Hook> {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return vec![] };
    let root = v.get("hooks").cloned().unwrap_or(v);
    let mut out = vec![];
    let mut push = |event: Option<&str>, h: &Value| {
        let Some(command) = h.get("command").and_then(|c| c.as_str()).filter(|c| !c.trim().is_empty()) else { return };
        let Some(event) = event.or_else(|| h.get("event").and_then(|e| e.as_str())) else { return };
        out.push(Hook {
            event: event.to_string(),
            matcher: h.get("matcher").and_then(|m| m.as_str()).map(String::from).filter(|m| !m.is_empty()),
            command: command.to_string(),
            timeout: h.get("timeout").and_then(|t| t.as_u64()),
        });
    };
    match &root {
        Value::Array(a) => a.iter().for_each(|h| push(None, h)),
        Value::Object(o) => {
            for (event, list) in o {
                if let Value::Array(a) = list {
                    a.iter().for_each(|h| push(Some(event), h));
                }
            }
        }
        _ => {}
    }
    out
}

impl Customizations {
    /// Instructions that apply given the files currently involved (open or touched by the agent).
    pub fn applicable(&self, involved: &[String]) -> Vec<&Instruction> {
        self.instructions
            .iter()
            .filter(|i| match i.apply_to.as_deref().map(str::trim) {
                None | Some("") | Some("**") | Some("**/*") | Some("*") => true,
                Some(g) => involved.iter().any(|p| glob_match(g, p)),
            })
            .collect()
    }

    pub fn hooks_for<'a>(&'a self, event: &'a str, tool: &'a str) -> impl Iterator<Item = &'a Hook> + 'a {
        self.hooks.iter().filter(move |h| {
            h.event.eq_ignore_ascii_case(event)
                && match h.matcher.as_deref() {
                    None | Some("*") => true,
                    Some(m) => regex::Regex::new(&format!("^(?:{m})$")).map(|re| re.is_match(tool)).unwrap_or(false),
                }
        })
    }
}

/// Whether an agent's `tools:` allowlist permits `name`. Entries may end with `*` (prefix match),
/// e.g. `mcp__github__*`.
pub fn tool_allowed(allow: &Option<Vec<String>>, name: &str) -> bool {
    match allow {
        None => true,
        Some(list) => name == "update_plan"
            || list.iter().any(|t| match t.strip_suffix('*') {
                Some(prefix) => name.starts_with(prefix),
                None => t == name,
            }),
    }
}

/// Implements the `load_skill` tool.
pub async fn load_skill(skills: &[Skill], args: &Value) -> Result<String, String> {
    let name = args.get("name").and_then(|v| v.as_str()).ok_or("Missing required string argument 'name'")?;
    let skill = skills
        .iter()
        .find(|s| s.name.eq_ignore_ascii_case(name.trim()))
        .ok_or_else(|| format!("Unknown skill '{name}'. Available: {}", skills.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")))?;
    let text = vfs::read_text(&vfs::join(&skill.dir, "SKILL.md")).await?;
    let (_, body) = parse_frontmatter(&text);
    let files = list_files(&skill.dir).await;
    let mut out = format!("# Skill: {}\nFolder: {}\n\n{}", skill.name, skill.dir, body.trim());
    if !files.is_empty() {
        out.push_str("\n\n## Files in this skill\n");
        for f in files {
            out.push_str(&format!("- {f}\n"));
        }
    }
    Ok(super::tools::truncate(out))
}

/// Relative paths of the files in a skill folder (breadth-first, capped), excluding SKILL.md.
async fn list_files(root: &str) -> Vec<String> {
    let mut out = vec![];
    let mut queue = vec![(root.to_string(), String::new(), 0u32)];
    while let Some((dir, prefix, depth)) = queue.pop() {
        let Ok(entries) = vfs::read_dir(&dir).await else { continue };
        for e in entries {
            let rel = if prefix.is_empty() { e.name.clone() } else { format!("{prefix}/{}", e.name) };
            if e.is_dir {
                if depth < 3 && e.name != "node_modules" && !e.name.starts_with('.') {
                    queue.push((vfs::join(&dir, &e.name), rel, depth + 1));
                }
            } else if rel != "SKILL.md" && out.len() < 200 {
                out.push(rel);
            }
        }
    }
    out.sort();
    out
}

/// Summary for the UI picker / customizations view.
pub fn summary(c: &Customizations) -> Value {
    json!({
        "instructions": c.instructions,
        "skills": c.skills,
        "agents": c.agents,
        "hooks": c.hooks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_and_globs() {
        let (fm, body) = parse_frontmatter("---\nname: rev\ntools: [read_file, search]\nmodel: x\n---\nBody\n");
        assert_eq!(fm_str(&fm, "name").unwrap(), "rev");
        assert_eq!(fm_list(&fm, "tools").unwrap(), vec!["read_file", "search"]);
        assert_eq!(body, "Body\n");
        let (fm, _) = parse_frontmatter("---\ntools:\n  - a\n  - b\n---\n");
        assert_eq!(fm_list(&fm, "tools").unwrap(), vec!["a", "b"]);
        assert!(glob_match("**/*.ts", "src/a/b.ts"));
        assert!(glob_match("**/*.ts", "b.ts"));
        assert!(glob_match("*.{ts,tsx}", "src/x.tsx"));
        assert!(glob_match("src/**", "src/x/y.rs"));
        assert!(!glob_match("src/**/*.rs", "lib/x.rs"));
        assert!(glob_match("docs/*.md, **/*.py", "a/b.py"));
        let hooks = parse_hooks(r#"{"hooks":[{"event":"preToolUse","matcher":"run_.*","command":"x"}]}"#);
        assert_eq!(hooks.len(), 1);
    }
}
