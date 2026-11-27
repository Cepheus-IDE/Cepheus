use super::providers::ToolDef;
use crate::vfs;

use crate::search::{list_any, search_any, SearchOpts};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const MAX_OUTPUT: usize = 30_000;

pub fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_dir",
            description: "List files and folders in a directory of the workspace. Use '.' for the workspace root.",
            schema: json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "Directory path, relative to the workspace root"}
            }, "required": ["path"]}),
        },
        ToolDef {
            name: "find_files",
            description: "Find files in the workspace whose relative path contains the given text (case-insensitive). Respects .gitignore.",
            schema: json!({"type": "object", "properties": {
                "pattern": {"type": "string", "description": "Substring to match against relative file paths, e.g. 'src/components' or '.rs'"}
            }, "required": ["pattern"]}),
        },
        ToolDef {
            name: "read_file",
            description: "Read a text file from the workspace. Output lines are prefixed with line numbers. For large files, pass start_line/end_line.",
            schema: json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "File path, relative to the workspace root"},
                "start_line": {"type": "integer", "description": "1-based first line to read (optional)"},
                "end_line": {"type": "integer", "description": "1-based last line to read, inclusive (optional)"}
            }, "required": ["path"]}),
        },
        ToolDef {
            name: "search",
            description: "Search file contents across the workspace (ripgrep-style). Returns matching lines as path:line: text.",
            schema: json!({"type": "object", "properties": {
                "query": {"type": "string", "description": "Text or regular expression to search for"},
                "is_regex": {"type": "boolean", "description": "Treat query as a regular expression (default false)"},
                "case_sensitive": {"type": "boolean", "description": "Match case (default false)"}
            }, "required": ["query"]}),
        },
        ToolDef {
            name: "write_file",
            description: "Create a new file or completely overwrite an existing file with the given content. Prefer edit_file for small changes to existing files.",
            schema: json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "File path, relative to the workspace root"},
                "content": {"type": "string", "description": "Full new content of the file"}
            }, "required": ["path", "content"]}),
        },
        ToolDef {
            name: "edit_file",
            description: "Edit an existing file by replacing an exact snippet. old_str must appear exactly once in the file (include enough surrounding lines to make it unique). Whitespace and indentation must match exactly.",
            schema: json!({"type": "object", "properties": {
                "path": {"type": "string", "description": "File path, relative to the workspace root"},
                "old_str": {"type": "string", "description": "Exact existing text to replace"},
                "new_str": {"type": "string", "description": "Replacement text"}
            }, "required": ["path", "old_str", "new_str"]}),
        },
        ToolDef {
            name: "run_command",
            description: "Run a shell command in the workspace root and return its combined stdout/stderr and exit code. On Windows this runs in PowerShell; elsewhere in sh. Do not start long-running servers or interactive programs; they will be killed at the timeout.",
            schema: json!({"type": "object", "properties": {
                "command": {"type": "string", "description": "The command line to run"},
                "timeout_secs": {"type": "integer", "description": "Timeout in seconds (default 120, max 600)"}
            }, "required": ["command"]}),
        },
        ToolDef {
            name: "update_plan",
            description: "Publish or update your task plan, shown to the user as a live checklist. Call it at the start of multi-step work and whenever a step changes status. Send the full list every time.",
            schema: json!({"type": "object", "properties": {
                "items": {"type": "array", "description": "The full ordered list of steps", "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Short description of the step"},
                        "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}
                    },
                    "required": ["text", "status"]
                }}
            }, "required": ["items"]}),
        },
        // Integrated browser tool (logic lives in src-tauri/src/browser.rs).
        crate::browser::tool_def(),
    ]
    .into_iter()
    // Database client tools (src-tauri/src/db/agent.rs).
    .chain(crate::db::agent::tool_defs())
    .collect()
}

/// Which tools require approval under each mode.
/// - "ask":       file writes and commands need approval
/// - "auto-edit": file writes are automatic, commands need approval
/// - "turbo":     everything runs automatically
pub fn needs_approval(name: &str, mode: &str) -> bool {
    // MCP tools can do anything their server allows, so they are treated like commands.
    let external = name.starts_with("mcp__");
    match mode {
        "turbo" => false,
        "auto-edit" => name == "run_command" || external,
        _ => matches!(name, "run_command" | "write_file" | "edit_file") || external,
    }
}

/// Tools available in Plan mode: research only, nothing that changes the workspace.
pub fn is_read_only(name: &str) -> bool {
    matches!(name, "list_dir" | "find_files" | "read_file" | "search" | "update_plan" | "load_skill") || crate::db::agent::is_read_only(name)
}

pub fn load_skill_def() -> ToolDef {
    ToolDef {
        name: "load_skill",
        description: "Load a skill by name: returns its SKILL.md instructions and lists the other files in the skill folder (read workspace files with read_file). Load a skill before doing a task it covers.",
        schema: json!({"type": "object", "properties": {
            "name": {"type": "string", "description": "Skill name, as listed in the system prompt"}
        }, "required": ["name"]}),
    }
}

/// Like `vfs::run_shell`, but feeds `input` on stdin and sets extra environment variables.
/// Used by hooks, which receive the tool call as JSON on stdin.
pub async fn run_shell_input(
    ws: &str,
    command: &str,
    input: &str,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<vfs::CmdOutput, String> {
    if vfs::is_remote(ws) {
        let mut full = String::new();
        for (k, v) in env {
            full.push_str(&format!("export {k}={}; ", crate::ssh::shell_quote(v)));
        }
        full.push_str(&format!("printf '%s' {} | {{ {command}\n}}", crate::ssh::shell_quote(input)));
        return vfs::run_shell(ws, &full, timeout).await;
    }
    use tokio::io::AsyncWriteExt;
    let mut cmd = if cfg!(windows) {
        let mut c = crate::proc_util::tokio_cmd("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        c
    } else {
        let mut c = crate::proc_util::tokio_cmd("sh");
        c.args(["-c", command]);
        c
    };
    cmd.current_dir(ws)
        .envs(env.iter().cloned())
        .kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start command: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes()).await;
        drop(stdin);
    }
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => Ok(vfs::CmdOutput {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into(),
            stderr: String::from_utf8_lossy(&o.stderr).into(),
        }),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("Command timed out after {}s and was killed.", timeout.as_secs())),
    }
}

fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolves a model-supplied path (local or `ssh://`) and refuses anything outside the workspace.
pub fn resolve(ws: &str, p: &str) -> Result<String, String> {
    let p = p.trim();
    if vfs::is_remote(ws) {
        let vfs::Loc::Remote { conn, path: root } = vfs::parse(ws) else { unreachable!() };
        let target = if p.starts_with("ssh://") {
            match vfs::parse(p) {
                vfs::Loc::Remote { path, .. } => path,
                _ => unreachable!(),
            }
        } else if p.starts_with('/') {
            vfs::normalize_posix(p)
        } else {
            vfs::normalize_posix(&format!("{root}/{p}"))
        };
        let inside = target == root || target.starts_with(&format!("{}/", root.trim_end_matches('/')));
        if !inside {
            return Err(format!("Path '{p}' is outside the workspace; access denied."));
        }
        return Ok(vfs::remote_uri(&conn, &target));
    }
    let ws_path = Path::new(ws);
    let candidate = if Path::new(p).is_absolute() { PathBuf::from(p) } else { ws_path.join(p) };
    let norm = lexical_normalize(&candidate);
    let wsn = lexical_normalize(ws_path);
    let inside = if cfg!(windows) {
        norm.to_string_lossy().to_lowercase().starts_with(&wsn.to_string_lossy().to_lowercase())
    } else {
        norm.starts_with(&wsn)
    };
    if !inside {
        return Err(format!("Path '{p}' is outside the workspace; access denied."));
    }
    Ok(norm.to_string_lossy().to_string())
}

pub fn rel_display(ws: &str, p: &str) -> String {
    vfs::rel(ws, p)
}

pub fn truncate(mut s: String) -> String {
    if s.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n... [output truncated]");
    }
    s
}

fn arg_str<'a>(args: &'a Value, k: &str) -> Result<&'a str, String> {
    args.get(k).and_then(|v| v.as_str()).ok_or_else(|| format!("Missing required string argument '{k}'"))
}

/// Result of a file-modifying tool: lets the UI show a diff for review.
pub struct FileChange {
    pub path: String,
    pub before: Option<String>,
    pub after: String,
}

pub async fn execute(ws: &str, name: &str, args: &Value) -> Result<(String, Option<FileChange>), String> {
    match name {
        "list_dir" => {
            let dir = resolve(ws, args.get("path").and_then(|v| v.as_str()).unwrap_or("."))?;
            let entries: Vec<String> = vfs::read_dir(&dir)
                .await?
                .into_iter()
                .map(|e| if e.is_dir { format!("{}/", e.name) } else { e.name })
                .collect();
            Ok((if entries.is_empty() { "(empty directory)".into() } else { entries.join("\n") }, None))
        }
        "find_files" => {
            let pat = arg_str(args, "pattern")?.to_lowercase().replace('\\', "/");
            let files = list_any(ws, 200_000).await?;
            let hits: Vec<String> = files
                .iter()
                .map(|f| rel_display(ws, f))
                .filter(|r| r.to_lowercase().contains(&pat))
                .take(300)
                .collect();
            Ok((if hits.is_empty() { "No files matched.".into() } else { hits.join("\n") }, None))
        }
        "read_file" => {
            let p = resolve(ws, arg_str(args, "path")?)?;
            let text = vfs::read_text(&p).await?;
            let lines: Vec<&str> = text.lines().collect();
            let total = lines.len();
            let start = args.get("start_line").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;
            let end = args
                .get("end_line")
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .unwrap_or(total)
                .min(total)
                .min(start + 1999);
            let mut out = String::new();
            for (i, l) in lines.iter().enumerate().take(end).skip(start - 1) {
                out.push_str(&format!("{:>5}\t{}\n", i + 1, l));
            }
            if end < total {
                out.push_str(&format!("... [{} more lines; total {}. Use start_line/end_line to read more]\n", total - end, total));
            }
            if total == 0 {
                out = "(empty file)".into();
            }
            Ok((truncate(out), None))
        }
        "search" => {
            let opts = SearchOpts {
                query: arg_str(args, "query")?.to_string(),
                is_regex: args.get("is_regex").and_then(|v| v.as_bool()).unwrap_or(false),
                case_sensitive: args.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false),
                whole_word: false,
                max_results: Some(200),
            };
            let res = search_any(ws, &opts).await?;
            if res.is_empty() {
                return Ok(("No matches.".into(), None));
            }
            let out = res
                .iter()
                .map(|m| format!("{}:{}: {}", rel_display(ws, &m.path), m.line, m.text.trim()))
                .collect::<Vec<_>>()
                .join("\n");
            Ok((truncate(out), None))
        }
        "write_file" => {
            let p = resolve(ws, arg_str(args, "path")?)?;
            let content = arg_str(args, "content")?.to_string();
            let before = if vfs::exists(&p).await { vfs::read_text(&p).await.ok() } else { None };
            vfs::write(&p, content.as_bytes()).await?;
            let msg = format!(
                "{} {} ({} lines)",
                if before.is_some() { "Overwrote" } else { "Created" },
                rel_display(ws, &p),
                content.lines().count()
            );
            Ok((msg, Some(FileChange { path: p, before, after: content })))
        }
        "edit_file" => {
            let p = resolve(ws, arg_str(args, "path")?)?;
            let old = arg_str(args, "old_str")?;
            let new = arg_str(args, "new_str")?;
            let text = vfs::read_text(&p).await?;
            // Tolerate CRLF files when the model sends LF snippets.
            let crlf = text.contains("\r\n");
            let (old_n, new_n) = if crlf && !old.contains("\r\n") {
                (old.replace('\n', "\r\n"), new.replace('\n', "\r\n"))
            } else {
                (old.to_string(), new.to_string())
            };
            let count = text.matches(&old_n).count();
            if count == 0 {
                return Err("old_str was not found in the file. Re-read the file and copy the exact text.".into());
            }
            if count > 1 {
                return Err(format!("old_str matches {count} places; include more surrounding context to make it unique."));
            }
            let updated = text.replacen(&old_n, &new_n, 1);
            vfs::write(&p, updated.as_bytes()).await?;
            Ok((format!("Edited {}", rel_display(ws, &p)), Some(FileChange { path: p, before: Some(text), after: updated })))
        }
        "run_command" => {
            let command = arg_str(args, "command")?;
            let secs = args.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(120).clamp(1, 600);
            let out = vfs::run_shell(ws, command, Duration::from_secs(secs)).await?;
            let mut s = out.stdout;
            if !out.stderr.trim().is_empty() {
                s.push_str("\n[stderr]\n");
                s.push_str(&out.stderr);
            }
            let res = format!("Exit code: {}\n{}", out.code, if s.trim().is_empty() { "(no output)".into() } else { s });
            Ok((truncate(res), None))
        }
        "update_plan" => Ok(("Plan updated.".into(), None)),
        // Integrated browser tool (src-tauri/src/browser.rs).
        "browser" => crate::browser::agent_tool(ws, args).await.map(|out| (out, None)),
        // Database client tools (src-tauri/src/db/agent.rs).
        n if crate::db::agent::TOOL_NAMES.contains(&n) => Box::pin(crate::db::agent::execute(n, args)).await.map(|out| (out, None)),
        other => Err(format!("Unknown tool '{other}'")),
    }
}
