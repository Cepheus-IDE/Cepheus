//! Long-running child processes talking over stdio, used by language servers (LSP framing)
//! and the debugger (raw output). Events: `proc-msg` (one LSP message), `proc-out`
//! (raw stdout/stderr chunk) and `proc-exit`.

use crate::proc_util::{err, std_cmd, tokio_cmd};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

struct Proc {
    stdin: mpsc::UnboundedSender<Vec<u8>>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct ProcState {
    procs: Mutex<HashMap<u32, Proc>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct ProcMsg {
    id: u32,
    msg: String,
}

#[derive(Serialize, Clone)]
struct ProcOut {
    id: u32,
    stream: &'static str,
    data: String,
}

#[derive(Serialize, Clone)]
struct ProcExit {
    id: u32,
    code: Option<i32>,
}

/// Runs `command` through the platform shell so `.cmd` shims (npm-installed servers) resolve.
fn shell_command(command: &str) -> tokio::process::Command {
    if cfg!(windows) {
        let mut c = tokio_cmd("cmd.exe");
        #[cfg(windows)]
        {
            c.raw_arg("/D /S /C \"").raw_arg(command).raw_arg("\"");
        }
        c
    } else {
        let mut c = tokio_cmd("/bin/sh");
        c.arg("-c").arg(command);
        c
    }
}

/// mode: "lsp" (Content-Length framed JSON-RPC on stdout) | "raw"
#[tauri::command]
pub async fn proc_spawn(
    app: AppHandle,
    state: State<'_, ProcState>,
    command: String,
    cwd: Option<String>,
    mode: String,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let mut cmd = shell_command(&command);
    if let Some(d) = cwd.as_deref().filter(|d| !d.is_empty() && !d.starts_with("ssh://")) {
        cmd.current_dir(d);
    }
    if let Some(env) = env {
        cmd.envs(env);
    }
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start `{command}`: {e}"))?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let pid = child.id();

    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        while let Some(buf) = rx.recv().await {
            if stdin.write_all(&buf).await.is_err() || stdin.flush().await.is_err() {
                break;
            }
        }
    });

    // stdout
    let a = app.clone();
    let lsp = mode == "lsp";
    tokio::spawn(async move {
        let mut r = BufReader::new(stdout);
        if lsp {
            loop {
                // Headers until a blank line, then exactly Content-Length bytes.
                let mut len: Option<usize> = None;
                loop {
                    let mut line = String::new();
                    match r.read_line(&mut line).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => {}
                    }
                    let l = line.trim();
                    if l.is_empty() {
                        if len.is_some() {
                            break;
                        }
                        continue;
                    }
                    if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().ok();
                    }
                }
                let mut buf = vec![0u8; len.unwrap_or(0)];
                if r.read_exact(&mut buf).await.is_err() {
                    return;
                }
                let _ = a.emit("proc-msg", ProcMsg { id, msg: String::from_utf8_lossy(&buf).into_owned() });
            }
        } else {
            let mut buf = vec![0u8; 8192];
            loop {
                match r.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        let _ = a.emit("proc-out", ProcOut { id, stream: "stdout", data: String::from_utf8_lossy(&buf[..n]).into_owned() });
                    }
                }
            }
        }
    });

    // stderr (always raw)
    let a = app.clone();
    tokio::spawn(async move {
        let mut r = BufReader::new(stderr);
        let mut buf = vec![0u8; 8192];
        loop {
            match r.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    let _ = a.emit("proc-out", ProcOut { id, stream: "stderr", data: String::from_utf8_lossy(&buf[..n]).into_owned() });
                }
            }
        }
    });

    // exit
    let a = app.clone();
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|s| s.code());
        let _ = a.emit("proc-exit", ProcExit { id, code });
    });

    state.procs.lock().unwrap().insert(id, Proc { stdin: tx, pid });
    Ok(id)
}

/// Writes to stdin; `framed` wraps `data` as one LSP message.
#[tauri::command]
pub fn proc_write(state: State<'_, ProcState>, id: u32, data: String, framed: bool) -> Result<(), String> {
    let procs = state.procs.lock().unwrap();
    let p = procs.get(&id).ok_or("process not running")?;
    let bytes = if framed {
        let mut b = format!("Content-Length: {}\r\n\r\n", data.len()).into_bytes();
        b.extend_from_slice(data.as_bytes());
        b
    } else {
        data.into_bytes()
    };
    p.stdin.send(bytes).map_err(err)
}

#[tauri::command]
pub fn proc_kill(state: State<'_, ProcState>, id: u32) {
    if let Some(p) = state.procs.lock().unwrap().remove(&id) {
        if let Some(pid) = p.pid {
            // Kill the whole tree: the shell wrapper plus the real server/program.
            if cfg!(windows) {
                let _ = std_cmd("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
            } else {
                let _ = std_cmd("kill").args(["-TERM", &format!("-{pid}")]).output();
                let _ = std_cmd("kill").args(["-TERM", &pid.to_string()]).output();
            }
        }
    }
}

/// Which of these executables are on PATH.
#[tauri::command]
pub fn which(names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .filter(|n| {
            let finder = if cfg!(windows) { "where" } else { "which" };
            std_cmd(finder).arg(n).output().map(|o| o.status.success()).unwrap_or(false)
        })
        .collect()
}
