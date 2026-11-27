use crate::fs_cmds::is_binary;
use crate::proc_util::err;
use crate::vfs;
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub len: usize,
    pub text: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub max_results: Option<usize>,
}

fn walker(root: &Path) -> ignore::Walk {
    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .require_git(false)
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !(n == ".git" || n == "node_modules" || n == "target" || n == "dist" || n == ".venv")
        })
        .build()
}

pub fn build_regex(o: &SearchOpts) -> Result<Regex, String> {
    let mut pat = if o.is_regex {
        o.query.clone()
    } else {
        regex::escape(&o.query)
    };
    if o.whole_word {
        pat = format!(r"\b(?:{})\b", pat);
    }
    RegexBuilder::new(&pat)
        .case_insensitive(!o.case_sensitive)
        .build()
        .map_err(err)
}

pub fn search_impl(root: &Path, o: &SearchOpts) -> Result<Vec<SearchMatch>, String> {
    if o.query.is_empty() {
        return Ok(vec![]);
    }
    let re = build_regex(o)?;
    let max = o.max_results.unwrap_or(2000);
    let mut out = Vec::new();
    for ent in walker(root).flatten() {
        if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let p = ent.path();
        if p.metadata().map(|m| m.len() > 2_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(p) else { continue };
        if is_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                let col = line[..m.start()].encode_utf16().count() + 1;
                let len = line[m.start()..m.end()].encode_utf16().count();
                let shown: String = line.chars().take(400).collect();
                out.push(SearchMatch {
                    path: p.to_string_lossy().to_string(),
                    line: i + 1,
                    col,
                    len,
                    text: shown,
                });
                if out.len() >= max {
                    return Ok(out);
                }
            }
        }
    }
    Ok(out)
}

pub fn list_impl(root: &Path, max: usize) -> Vec<String> {
    walker(root)
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .take(max)
        .map(|e| e.path().to_string_lossy().to_string())
        .collect()
}

const REMOTE_EXCLUDES: &[&str] = &[".git", "node_modules", "target", "dist", ".venv", "__pycache__"];

/// Content search on a remote host with grep (available everywhere), parsed into SearchMatch.
async fn search_remote(root: &str, o: &SearchOpts) -> Result<Vec<SearchMatch>, String> {
    if o.query.is_empty() {
        return Ok(vec![]);
    }
    let re = build_regex(o)?;
    let max = o.max_results.unwrap_or(2000);
    let mut cmd = String::from("grep -rnIH --color=never -m 200");
    for d in REMOTE_EXCLUDES {
        cmd.push_str(&format!(" --exclude-dir={d}"));
    }
    if !o.case_sensitive {
        cmd.push_str(" -i");
    }
    if o.whole_word {
        cmd.push_str(" -w");
    }
    cmd.push_str(if o.is_regex { " -E" } else { " -F" });
    cmd.push_str(&format!(" -e {} -- . 2>/dev/null | head -n {}", crate::ssh::shell_quote(&o.query), max));
    let out = vfs::run_shell(root, &cmd, std::time::Duration::from_secs(60)).await?;
    let mut res = Vec::new();
    for line in out.stdout.lines() {
        let rest = line.strip_prefix("./").unwrap_or(line);
        let mut it = rest.splitn(3, ':');
        let (Some(file), Some(ln), Some(text)) = (it.next(), it.next(), it.next()) else { continue };
        let Ok(ln) = ln.parse::<usize>() else { continue };
        let (col, len) = re
            .find(text)
            .map(|m| (text[..m.start()].encode_utf16().count() + 1, text[m.start()..m.end()].encode_utf16().count()))
            .unwrap_or((1, 0));
        res.push(SearchMatch { path: vfs::join(root, file), line: ln, col, len, text: text.chars().take(400).collect() });
    }
    Ok(res)
}

pub async fn search_any(root: &str, opts: &SearchOpts) -> Result<Vec<SearchMatch>, String> {
    if vfs::is_remote(root) {
        return search_remote(root, opts).await;
    }
    let (r, o) = (root.to_string(), opts.clone());
    tauri::async_runtime::spawn_blocking(move || search_impl(Path::new(&r), &o)).await.map_err(err)?
}

pub async fn list_any(root: &str, max: usize) -> Result<Vec<String>, String> {
    if vfs::is_remote(root) {
        let mut cmd = String::from("find . -type f");
        for d in REMOTE_EXCLUDES {
            cmd.push_str(&format!(" -not -path '*/{d}/*'"));
        }
        cmd.push_str(&format!(" 2>/dev/null | head -n {max}"));
        let out = vfs::run_shell(root, &cmd, std::time::Duration::from_secs(60)).await?;
        return Ok(out.stdout.lines().filter(|l| !l.is_empty()).map(|l| vfs::join(root, l.trim_start_matches("./"))).collect());
    }
    let r = root.to_string();
    tauri::async_runtime::spawn_blocking(move || list_impl(Path::new(&r), max)).await.map_err(err)
}

#[tauri::command]
pub async fn search_files(root: String, opts: SearchOpts) -> Result<Vec<SearchMatch>, String> {
    search_any(&root, &opts).await
}

#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    list_any(&root, 50_000).await
}
