use crate::proc_util::err;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct Term {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TermState {
    terms: Mutex<HashMap<u32, Term>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct TermData {
    id: u32,
    data: String,
}

fn default_shell() -> String {
    if cfg!(windows) {
        let has_pwsh = crate::proc_util::std_cmd("where")
            .arg("pwsh.exe")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if has_pwsh { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[tauri::command]
pub fn term_spawn(
    app: AppHandle,
    state: State<'_, TermState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    // Extra arguments for `shell` (e.g. `docker exec -it …` for dev container terminals).
    args: Option<Vec<String>>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;
    let shell = shell.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    cmd.args(args.unwrap_or_default());
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        cmd.cwd(c);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;

    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    // Only emit complete UTF-8 sequences; keep a trailing partial char for later.
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    if valid == 0 {
                        continue;
                    }
                    let s = String::from_utf8_lossy(&pending[..valid]).to_string();
                    pending.drain(..valid);
                    let _ = app2.emit("term-data", TermData { id, data: s });
                }
            }
        }
        let _ = app2.emit("term-exit", id);
    });

    state
        .terms
        .lock()
        .unwrap()
        .insert(id, Term { writer, master: pair.master, child });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let mut terms = state.terms.lock().unwrap();
    let t = terms.get_mut(&id).ok_or("terminal not found")?;
    t.writer.write_all(data.as_bytes()).map_err(err)?;
    t.writer.flush().map_err(err)
}

#[tauri::command]
pub fn term_resize(state: State<'_, TermState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.terms.lock().unwrap();
    let t = terms.get(&id).ok_or("terminal not found")?;
    t.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

#[tauri::command]
pub fn term_kill(state: State<'_, TermState>, id: u32) -> Result<(), String> {
    if let Some(mut t) = state.terms.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
    Ok(())
}
