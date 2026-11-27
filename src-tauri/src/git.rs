use crate::proc_util::{err, std_cmd};
use crate::vfs;
use serde::Serialize;
use std::path::Path;

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    if vfs::is_remote(root) {
        let cmd = std::iter::once("git".to_string())
            .chain(args.iter().map(|a| crate::ssh::shell_quote(a)))
            .collect::<Vec<_>>()
            .join(" ");
        let out = tauri::async_runtime::block_on(vfs::run_shell(root, &cmd, std::time::Duration::from_secs(300)))?;
        return if out.code == 0 {
            Ok(out.stdout)
        } else {
            let e = out.stderr.trim();
            Err(if e.is_empty() { out.stdout.trim().to_string() } else { e.to_string() })
        };
    }
    let out = std_cmd("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("Failed to run git (is it installed?): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if msg.is_empty() {
            msg = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        Err(msg)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub index: String,
    pub worktree: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub ahead_behind: String,
    pub files: Vec<GitFile>,
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = match git(&root, &["status", "--porcelain=v1", "-b", "-z", "-uall"]) {
            Ok(r) => r,
            Err(_) => {
                return Ok(GitStatus { is_repo: false, branch: String::new(), ahead_behind: String::new(), files: vec![] })
            }
        };
        let mut branch = String::new();
        let mut ahead_behind = String::new();
        let mut files = Vec::new();
        let mut parts = raw.split('\0').filter(|s| !s.is_empty());
        while let Some(entry) = parts.next() {
            if let Some(b) = entry.strip_prefix("## ") {
                let (name, rest) = match b.find(" [") {
                    Some(i) => (&b[..i], b[i..].trim()),
                    None => (b, ""),
                };
                branch = name.split("...").next().unwrap_or(name).replace("No commits yet on ", "").to_string();
                ahead_behind = rest.trim_matches(|c| c == '[' || c == ']').to_string();
                continue;
            }
            if entry.len() < 4 {
                continue;
            }
            let x = &entry[0..1];
            let y = &entry[1..2];
            let rel = &entry[3..];
            if x == "R" || x == "C" {
                parts.next(); // original path
            }
            let full = vfs::join(&root, rel);
            files.push(GitFile { path: full, index: x.to_string(), worktree: y.to_string() });
        }
        Ok(GitStatus { is_repo: true, branch, ahead_behind, files })
    })
    .await
    .map_err(err)?
}

fn rel(root: &str, p: &str) -> String {
    vfs::rel(root, p)
}

#[tauri::command]
pub fn git_stage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().map(|p| rel(&root, p)));
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &a).map(|_| ())
}

#[tauri::command]
pub fn git_unstage(root: String, paths: Vec<String>) -> Result<(), String> {
    let mut args = vec!["reset".to_string(), "-q".to_string(), "--".to_string()];
    args.extend(paths.iter().map(|p| rel(&root, p)));
    let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    git(&root, &a).map(|_| ())
}

#[tauri::command]
pub fn git_commit(root: String, message: String) -> Result<String, String> {
    git(&root, &["commit", "-m", &message])
}

#[tauri::command]
pub fn git_discard(root: String, path: String) -> Result<(), String> {
    let r = rel(&root, &path);
    git(&root, &["checkout", "--", &r]).map(|_| ())
}

/// Content of the file at HEAD (empty string if new / untracked).
#[tauri::command]
pub fn git_show_head(root: String, path: String) -> Result<String, String> {
    let r = rel(&root, &path);
    Ok(git(&root, &["show", &format!("HEAD:{r}")]).unwrap_or_default())
}

#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
    git(&root, &["init"]).map(|_| ())
}

#[tauri::command]
pub fn git_diff_staged(root: String) -> Result<String, String> {
    let d = git(&root, &["diff", "--cached"])?;
    if d.trim().is_empty() {
        git(&root, &["diff"])
    } else {
        Ok(d)
    }
}

#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<String>, String> {
    let out = git(&root, &["branch", "--format=%(refname:short)"])?;
    Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

#[tauri::command]
pub fn git_checkout(root: String, branch: String, create: bool) -> Result<(), String> {
    if create {
        git(&root, &["checkout", "-b", &branch]).map(|_| ())
    } else {
        git(&root, &["checkout", &branch]).map(|_| ())
    }
}

/// Runs git with a GitHub token supplied as an HTTP header for this one invocation only
/// (never written into the repo config or the remote URL).
fn git_auth(root: &str, args: &[&str], token: Option<&str>) -> Result<String, String> {
    match token.map(str::trim).filter(|t| !t.is_empty()) {
        None => git(root, args),
        Some(t) => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{t}"));
            let header = format!("http.https://github.com/.extraheader=AUTHORIZATION: basic {b64}");
            let mut full = vec!["-c", header.as_str()];
            full.extend_from_slice(args);
            git(root, &full).map_err(|e| e.replace(&b64, "***"))
        }
    }
}

/// action: "pull" | "push" | "fetch"
#[tauri::command]
pub async fn git_sync(root: String, action: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let t = token.as_deref();
        match action.as_str() {
            "pull" => git_auth(&root, &["pull", "--ff-only"], t),
            "push" => git_auth(&root, &["push", "-u", "origin", "HEAD"], t),
            _ => git_auth(&root, &["fetch", "--all"], t),
        }
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn git_clone(url: String, parent: String, name: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest = Path::new(&parent).join(&name);
        if dest.exists() {
            return Err(format!("'{}' already exists", dest.display()));
        }
        git_auth(&parent, &["clone", &url, &name], token.as_deref())?;
        Ok(dest.to_string_lossy().to_string())
    })
    .await
    .map_err(err)?
}

/// URL of the `origin` remote, or empty.
#[tauri::command]
pub fn git_remote(root: String) -> String {
    git(&root, &["remote", "get-url", "origin"]).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// Adds `origin` (if missing), makes an initial commit if the repo has none, and pushes.
#[tauri::command]
pub async fn git_publish(root: String, url: String, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if git(&root, &["rev-parse", "--git-dir"]).is_err() {
            git(&root, &["init"])?;
        }
        if git(&root, &["rev-parse", "HEAD"]).is_err() {
            git(&root, &["add", "-A"])?;
            git(&root, &["commit", "-m", "Initial commit"])?;
        }
        if git(&root, &["remote", "get-url", "origin"]).is_err() {
            git(&root, &["remote", "add", "origin", &url])?;
        }
        git_auth(&root, &["push", "-u", "origin", "HEAD"], token.as_deref())
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn git_current_branch(root: String) -> String {
    git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// Blame, stash, identity
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub hash: String,
    pub author: String,
    /// Unix seconds
    pub time: i64,
    pub summary: String,
}

/// One entry per line of the committed file (index 0 = line 1). Uncommitted lines have an all-zero hash.
#[tauri::command]
pub async fn git_blame(root: String, path: String) -> Result<Vec<BlameLine>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = rel(&root, &path);
        let raw = git(&root, &["blame", "--porcelain", "--", &r])?;
        let mut info: std::collections::HashMap<String, BlameLine> = std::collections::HashMap::new();
        let mut out = Vec::new();
        let mut cur: Option<String> = None;
        for line in raw.lines() {
            if let Some(_content) = line.strip_prefix('\t') {
                if let Some(h) = cur.take() {
                    out.push(info.get(&h).cloned().unwrap_or(BlameLine { hash: h, author: String::new(), time: 0, summary: String::new() }));
                }
                continue;
            }
            let mut it = line.splitn(2, ' ');
            let (k, v) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
            if k.len() == 40 && k.chars().all(|c| c.is_ascii_hexdigit()) {
                cur = Some(k.to_string());
                info.entry(k.to_string()).or_insert(BlameLine { hash: k.to_string(), author: String::new(), time: 0, summary: String::new() });
                continue;
            }
            if let Some(e) = cur.as_ref().and_then(|h| info.get_mut(h)) {
                match k {
                    "author" => e.author = v.to_string(),
                    "author-time" => e.time = v.parse().unwrap_or(0),
                    "summary" => e.summary = v.to_string(),
                    _ => {}
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
}

#[tauri::command]
pub fn git_stash_list(root: String) -> Result<Vec<StashEntry>, String> {
    let out = git(&root, &["stash", "list", "--format=%gs"])?;
    Ok(out.lines().enumerate().map(|(index, m)| StashEntry { index, message: m.to_string() }).collect())
}

/// action: "push" | "pop" | "apply" | "drop"
#[tauri::command]
pub fn git_stash(root: String, action: String, index: Option<usize>, message: Option<String>) -> Result<String, String> {
    let r = index.map(|i| format!("stash@{{{i}}}"));
    match action.as_str() {
        "push" => {
            let mut a = vec!["stash", "push", "--include-untracked"];
            if let Some(m) = message.as_deref().filter(|m| !m.trim().is_empty()) {
                a.push("-m");
                a.push(m);
            }
            git(&root, &a)
        }
        "pop" | "apply" | "drop" => {
            let mut a = vec!["stash", action.as_str()];
            if let Some(r) = r.as_deref() {
                a.push(r);
            }
            git(&root, &a)
        }
        other => Err(format!("Unknown stash action '{other}'")),
    }
}

#[derive(Serialize)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

#[tauri::command]
pub fn git_identity(root: String) -> Identity {
    let get = |k: &str| git(&root, &["config", "--get", k]).map(|s| s.trim().to_string()).unwrap_or_default();
    Identity { name: get("user.name"), email: get("user.email") }
}

#[tauri::command]
pub fn git_set_identity(root: String, name: String, email: String, global: bool) -> Result<(), String> {
    let scope = if global { "--global" } else { "--local" };
    git(&root, &["config", scope, "user.name", name.trim()])?;
    git(&root, &["config", scope, "user.email", email.trim()]).map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// History, refs, merge stages, patches (log/graph, timeline, branches, merge editor, quick diff)
// ---------------------------------------------------------------------------------------------

/// `git show <rev>:<path>`. `rev` may be a commit-ish ("HEAD", a hash) or an index stage
/// (":0" staged, ":1" merge base, ":2" ours, ":3" theirs). Errors when the blob does not exist.
#[tauri::command]
pub async fn git_show_rev(root: String, rev: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A path that is already repo-relative (e.g. from `git log --name-only`) passes through unchanged.
        let r = rel(&root, &path);
        git(&root, &["show", &format!("{rev}:{r}")])
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Unix seconds (author date)
    pub time: i64,
    pub subject: String,
    /// Ref decorations, e.g. ["HEAD -> main", "origin/main", "tag: v1.0"]
    pub refs: Vec<String>,
    /// Repo-relative path of the file in this commit (only for per-file logs; follows renames).
    pub file: Option<String>,
}

const LOG_FMT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D";

fn parse_log(raw: &str, with_files: bool) -> Vec<GitCommit> {
    raw.split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let mut lines = rec.splitn(2, '\n');
            let head = lines.next()?;
            let f: Vec<&str> = head.split('\x1f').collect();
            if f.len() < 7 {
                return None;
            }
            let file = if with_files {
                lines.next().and_then(|rest| rest.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from))
            } else {
                None
            };
            Some(GitCommit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                email: f[3].to_string(),
                time: f[4].trim().parse().unwrap_or(0),
                subject: f[5].to_string(),
                refs: f[6].trim().split(", ").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
                file,
            })
        })
        .collect()
}

/// Commits newest first. With `path`: history of that file (`--follow`, so renames are tracked and
/// each entry carries the file's path at that commit). With `all`: every branch, not just HEAD.
#[tauri::command]
pub async fn git_log(root: String, path: Option<String>, max_count: Option<u32>, skip: Option<u32>, all: Option<bool>) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<String> = vec![
            "log".into(),
            LOG_FMT.into(),
            format!("--max-count={}", max_count.unwrap_or(300)),
            format!("--skip={}", skip.unwrap_or(0)),
        ];
        let rp = path.as_deref().map(|p| rel(&root, p));
        if let Some(r) = &rp {
            args.extend(["--follow".into(), "--name-only".into(), "--".into(), r.clone()]);
        } else {
            args.push("--topo-order".into());
            if all.unwrap_or(false) {
                args.push("--all".into());
            }
        }
        let a: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        match git(&root, &a) {
            Ok(raw) => Ok(parse_log(&raw, rp.is_some())),
            // A repo without commits has no log; that's not an error for the UI.
            Err(e) if e.contains("does not have any commits") || e.contains("bad default revision") => Ok(vec![]),
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Repo-relative path in the commit
    pub path: String,
    /// Previous path for renames/copies
    pub old_path: Option<String>,
    /// A, M, D, R, C, T
    pub status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub parents: Vec<String>,
    pub files: Vec<ChangedFile>,
}

/// Full message + changed files (vs the first parent; vs the empty tree for a root commit).
#[tauri::command]
pub async fn git_commit_details(root: String, hash: String) -> Result<CommitDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = git(&root, &["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%B", &hash])?;
        let f: Vec<&str> = meta.splitn(7, '\x1f').collect();
        if f.len() < 7 {
            return Err("Unexpected git output".into());
        }
        let parents: Vec<String> = f[1].split_whitespace().map(String::from).collect();
        let raw = match parents.first() {
            Some(p) => git(&root, &["diff", "--name-status", "-M", "-z", p, f[0]])?,
            None => git(&root, &["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-M", "-z", f[0]])?,
        };
        let mut files = Vec::new();
        let mut it = raw.split('\0').filter(|s| !s.is_empty());
        while let Some(st) = it.next() {
            let status = st.chars().next().unwrap_or('M').to_string();
            if status == "R" || status == "C" {
                let old = it.next().unwrap_or("").to_string();
                let new = it.next().unwrap_or("").to_string();
                files.push(ChangedFile { path: new, old_path: Some(old), status });
            } else if let Some(p) = it.next() {
                files.push(ChangedFile { path: p.to_string(), old_path: None, status });
            }
        }
        Ok(CommitDetails {
            hash: f[0].to_string(),
            parents,
            author: f[2].to_string(),
            email: f[3].to_string(),
            time: f[4].trim().parse().unwrap_or(0),
            committer: f[5].to_string(),
            body: f[6].trim_end().to_string(),
            files,
        })
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// Short name: "main" or "origin/main"
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    /// Upstream configured but deleted on the remote
    pub gone: bool,
    pub hash: String,
    pub subject: String,
    pub time: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTag {
    pub name: String,
    pub hash: String,
    pub subject: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    pub branches: Vec<GitBranch>,
    pub tags: Vec<GitTag>,
}

/// "[ahead 2, behind 1]" -> 2 for "ahead ".
fn track_num(track: &str, word: &str) -> u32 {
    track
        .split(|c| c == '[' || c == ']' || c == ',')
        .map(str::trim)
        .find_map(|p| p.strip_prefix(word))
        .and_then(|n| n.trim().parse().ok())
        .unwrap_or(0)
}

/// Local + remote branches (with ahead/behind vs upstream) and tags.
#[tauri::command]
pub async fn git_refs(root: String) -> Result<GitRefs, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = git(
            &root,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%1f%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(contents:subject)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        let mut branches = Vec::new();
        for line in raw.lines() {
            let f: Vec<&str> = line.split('\x1f').collect();
            if f.len() < 8 || f[0].ends_with("/HEAD") {
                continue;
            }
            branches.push(GitBranch {
                name: f[1].to_string(),
                remote: f[0].starts_with("refs/remotes/"),
                current: f[2] == "*",
                upstream: f[3].to_string(),
                ahead: track_num(f[4], "ahead "),
                behind: track_num(f[4], "behind "),
                gone: f[4].contains("gone"),
                hash: f[5].to_string(),
                time: f[6].trim().parse().unwrap_or(0),
                subject: f[7].to_string(),
            });
        }
        let raw = git(&root, &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%1f%(objectname:short)%1f%(contents:subject)", "refs/tags"])?;
        let tags = raw
            .lines()
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\x1f').collect();
                (f.len() >= 3).then(|| GitTag { name: f[0].to_string(), hash: f[1].to_string(), subject: f[2].to_string() })
            })
            .collect();
        Ok(GitRefs { branches, tags })
    })
    .await
    .map_err(err)?
}

/// Subcommands the UI may run through `git_run` (branch/tag management, merge, rebase, reset,
/// commit options, PR checkout ...). Keeps the generic entry point from becoming `git -c ...`.
const RUN_ALLOWED: &[&str] = &[
    "branch", "tag", "merge", "rebase", "reset", "fetch", "pull", "push", "commit", "checkout", "switch",
    "revert", "cherry-pick", "remote", "rev-parse", "rev-list", "log", "show", "diff", "status", "restore",
];

/// Runs `git <args>` for the subcommands above. `token` (GitHub) is used for fetch/pull/push.
#[tauri::command]
pub async fn git_run(root: String, args: Vec<String>, token: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sub = args.first().map(String::as_str).unwrap_or("");
        if !RUN_ALLOWED.contains(&sub) {
            return Err(format!("git {sub} is not allowed here"));
        }
        // Never let git open an editor (merge/rebase/commit messages) from a GUI process.
        let mut a: Vec<&str> = vec!["-c", "core.editor=true"];
        a.extend(args.iter().map(|s| s.as_str()));
        if matches!(sub, "fetch" | "pull" | "push") {
            git_auth(&root, &a, token.as_deref())
        } else {
            git(&root, &a)
        }
    })
    .await
    .map_err(err)?
}

/// `git apply --unidiff-zero [--cached] [--reverse]` with the patch on stdin (stage / unstage a hunk).
#[tauri::command]
pub async fn git_apply(root: String, patch: String, cached: bool, reverse: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
        if cached {
            args.push("--cached");
        }
        if reverse {
            args.push("--reverse");
        }
        args.push("-");
        if vfs::is_remote(&root) {
            let cmd = format!("git {} <<'CEPHEUS_PATCH_EOF'\n{}\nCEPHEUS_PATCH_EOF", args.join(" "), patch.trim_end_matches('\n'));
            let out = tauri::async_runtime::block_on(vfs::run_shell(&root, &cmd, std::time::Duration::from_secs(60)))?;
            return if out.code == 0 { Ok(()) } else { Err(out.stderr.trim().to_string()) };
        }
        use std::io::Write;
        let mut child = std_cmd("git")
            .args(&args)
            .current_dir(&root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run git: {e}"))?;
        child.stdin.take().ok_or("no stdin")?.write_all(patch.as_bytes()).map_err(err)?;
        let out = child.wait_with_output().map_err(err)?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    })
    .await
    .map_err(err)?
}
