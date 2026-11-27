//! Virtual file system: one API for local paths and `ssh://<connId>/<path>` remote paths.

use crate::fs_cmds::{is_binary, DirEntry};
use crate::proc_util::err;
use crate::ssh;
use std::path::Path;
use std::time::Duration;

pub const MAX_TEXT_BYTES: u64 = 20_000_000;

pub enum Loc {
    Local(String),
    Remote { conn: String, path: String },
}

pub fn is_remote(p: &str) -> bool {
    p.starts_with("ssh://")
}

pub fn parse(p: &str) -> Loc {
    match p.strip_prefix("ssh://") {
        Some(rest) => {
            let (conn, path) = match rest.find('/') {
                Some(i) => (&rest[..i], &rest[i..]),
                None => (rest, "/"),
            };
            Loc::Remote { conn: conn.to_string(), path: normalize_posix(path) }
        }
        None => Loc::Local(p.to_string()),
    }
}

pub fn remote_uri(conn: &str, path: &str) -> String {
    format!("ssh://{conn}{}", normalize_posix(path))
}

pub fn normalize_posix(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Joins a child path onto a local or remote base.
pub fn join(base: &str, rel: &str) -> String {
    if is_remote(base) {
        format!("{}/{}", base.trim_end_matches('/'), rel.trim_start_matches('/'))
    } else {
        Path::new(base).join(rel).to_string_lossy().to_string()
    }
}

/// Path of `p` relative to `root`, using forward slashes.
pub fn rel(root: &str, p: &str) -> String {
    if is_remote(root) {
        let r = root.trim_end_matches('/');
        p.strip_prefix(r).map(|x| x.trim_start_matches('/').to_string()).unwrap_or_else(|| p.to_string())
    } else {
        Path::new(p)
            .strip_prefix(root)
            .map(|r| r.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| p.to_string())
    }
}

fn sftp_err(e: impl std::fmt::Display) -> String {
    format!("Remote: {e}")
}

pub async fn read_dir(p: &str) -> Result<Vec<DirEntry>, String> {
    let mut out = match parse(p) {
        Loc::Local(l) => {
            let mut v = Vec::new();
            for ent in std::fs::read_dir(&l).map_err(err)? {
                let ent = ent.map_err(err)?;
                v.push(DirEntry {
                    name: ent.file_name().to_string_lossy().to_string(),
                    path: ent.path().to_string_lossy().to_string(),
                    is_dir: ent.file_type().map(|t| t.is_dir()).unwrap_or(false),
                });
            }
            v
        }
        Loc::Remote { conn, path } => {
            let c = ssh::conn(&conn).await?;
            let rd = c.sftp.read_dir(path.clone()).await.map_err(sftp_err)?;
            rd.filter(|e| e.file_name() != "." && e.file_name() != "..")
                .map(|e| {
                    let name = e.file_name();
                    let mut is_dir = e.file_type().is_dir();
                    if e.file_type().is_symlink() {
                        // Treat symlinks to directories as directories (resolved lazily on open).
                        is_dir = e.metadata().is_dir();
                    }
                    DirEntry { path: remote_uri(&conn, &format!("{}/{}", path.trim_end_matches('/'), name)), name, is_dir }
                })
                .collect()
        }
    };
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

pub async fn read(p: &str) -> Result<Vec<u8>, String> {
    match parse(p) {
        Loc::Local(l) => std::fs::read(l).map_err(err),
        Loc::Remote { conn, path } => {
            let c = ssh::conn(&conn).await?;
            if let Ok(m) = c.sftp.metadata(path.clone()).await {
                if m.size.unwrap_or(0) > MAX_TEXT_BYTES {
                    return Err(format!("File is too large to open ({} MB)", m.size.unwrap_or(0) / 1_000_000));
                }
            }
            c.sftp.read(path).await.map_err(sftp_err)
        }
    }
}

pub async fn read_text(p: &str) -> Result<String, String> {
    let bytes = read(p).await?;
    if is_binary(&bytes) {
        return Err("File appears to be binary".into());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub async fn mkdir_all(p: &str) -> Result<(), String> {
    match parse(p) {
        Loc::Local(l) => std::fs::create_dir_all(l).map_err(err),
        Loc::Remote { conn, path } => {
            let c = ssh::conn(&conn).await?;
            let mut cur = String::new();
            for seg in path.split('/').filter(|s| !s.is_empty()) {
                cur.push('/');
                cur.push_str(seg);
                if !c.sftp.try_exists(cur.clone()).await.unwrap_or(false) {
                    c.sftp.create_dir(cur.clone()).await.map_err(sftp_err)?;
                }
            }
            Ok(())
        }
    }
}

fn parent(p: &str) -> Option<String> {
    if is_remote(p) {
        let i = p.rfind('/')?;
        (i > "ssh://".len()).then(|| p[..i].to_string())
    } else {
        Path::new(p).parent().map(|x| x.to_string_lossy().to_string())
    }
}

pub async fn write(p: &str, bytes: &[u8]) -> Result<(), String> {
    if let Some(par) = parent(p) {
        mkdir_all(&par).await?;
    }
    match parse(p) {
        Loc::Local(l) => std::fs::write(l, bytes).map_err(err),
        Loc::Remote { conn, path } => {
            let c = ssh::conn(&conn).await?;
            c.sftp.write(path, bytes).await.map_err(sftp_err)
        }
    }
}

pub async fn exists(p: &str) -> bool {
    match parse(p) {
        Loc::Local(l) => Path::new(&l).exists(),
        Loc::Remote { conn, path } => match ssh::conn(&conn).await {
            Ok(c) => c.sftp.try_exists(path).await.unwrap_or(false),
            Err(_) => false,
        },
    }
}

pub async fn rename(from: &str, to: &str) -> Result<(), String> {
    if exists(to).await {
        return Err(format!("'{to}' already exists"));
    }
    match (parse(from), parse(to)) {
        (Loc::Local(a), Loc::Local(b)) => std::fs::rename(a, b).map_err(err),
        (Loc::Remote { conn, path: a }, Loc::Remote { path: b, .. }) => {
            let c = ssh::conn(&conn).await?;
            c.sftp.rename(a, b).await.map_err(sftp_err)
        }
        _ => Err("Cannot move between local and remote".into()),
    }
}

/// Local: move to the Recycle Bin. Remote: delete (there is no remote trash).
pub async fn remove(p: &str) -> Result<(), String> {
    match parse(p) {
        Loc::Local(l) => trash::delete(&l).map_err(err),
        Loc::Remote { conn, path } => {
            if path == "/" || path.matches('/').count() < 2 {
                return Err("Refusing to delete a top-level directory".into());
            }
            let out = ssh::exec(&conn, None, &format!("rm -rf -- {}", ssh::shell_quote(&path)), Duration::from_secs(60)).await?;
            if out.code != 0 {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
            Ok(())
        }
    }
}

pub struct CmdOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a shell command in `cwd` (PowerShell locally on Windows, sh remotely).
pub async fn run_shell(cwd: &str, command: &str, timeout: Duration) -> Result<CmdOutput, String> {
    match parse(cwd) {
        Loc::Remote { conn, path } => {
            let o = ssh::exec(&conn, Some(&path), command, timeout).await?;
            Ok(CmdOutput { code: o.code, stdout: String::from_utf8_lossy(&o.stdout).into(), stderr: String::from_utf8_lossy(&o.stderr).into() })
        }
        Loc::Local(dir) => {
            let mut cmd = if let Some(args) = crate::devcontainer::exec_args(&dir, command) {
                // "Reopen in Container": run inside the dev container (files are bind-mounted).
                let mut c = crate::proc_util::tokio_cmd("docker");
                c.args(args);
                c
            } else if cfg!(windows) {
                let mut c = crate::proc_util::tokio_cmd("powershell.exe");
                c.args(["-NoProfile", "-NonInteractive", "-Command", command]);
                c
            } else {
                let mut c = crate::proc_util::tokio_cmd("sh");
                c.args(["-c", command]);
                c
            };
            cmd.current_dir(dir)
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let child = cmd.spawn().map_err(|e| format!("Failed to start command: {e}"))?;
            match tokio::time::timeout(timeout, child.wait_with_output()).await {
                Ok(Ok(o)) => Ok(CmdOutput {
                    code: o.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&o.stdout).into(),
                    stderr: String::from_utf8_lossy(&o.stderr).into(),
                }),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!("Command timed out after {}s and was killed.", timeout.as_secs())),
            }
        }
    }
}
