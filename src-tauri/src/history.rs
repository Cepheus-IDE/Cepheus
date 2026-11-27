//! Time Machine: a local history of every version of a file that was saved in the editor or
//! written by the agent. Snapshots live in the app data folder, never in the project.

use crate::proc_util::err;
use serde::Serialize;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const KEEP: usize = 200;

fn key(path: &str) -> String {
    // FNV-1a over the normalized path.
    let norm = path.replace('\\', "/").to_lowercase();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in norm.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn dir_for(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(err)?.join("history").join(key(path)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    ts: u64,
    size: u64,
    label: String,
}

fn list(dir: &PathBuf) -> Vec<(u64, String, PathBuf)> {
    let mut v: Vec<(u64, String, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".snap")?;
            let (ts, label) = stem.split_once('_').unwrap_or((stem, "save"));
            Some((ts.parse().ok()?, label.to_string(), e.path()))
        })
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v
}

/// label: "save" | "agent" | "before-agent" | "restore"
#[tauri::command]
pub fn history_save(app: AppHandle, path: String, content: String, label: Option<String>) -> Result<(), String> {
    let dir = dir_for(&app, &path)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let existing = list(&dir);
    if let Some((_, _, last)) = existing.first() {
        if std::fs::read_to_string(last).map(|t| t == content).unwrap_or(false) {
            return Ok(()); // unchanged
        }
    }
    let _ = std::fs::write(dir.join("path.txt"), &path);
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let label: String = label.unwrap_or_else(|| "save".into()).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    std::fs::write(dir.join(format!("{ts}_{label}.snap")), content).map_err(err)?;
    for (_, _, old) in existing.into_iter().skip(KEEP - 1) {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

#[tauri::command]
pub fn history_list(app: AppHandle, path: String) -> Result<Vec<Snapshot>, String> {
    let dir = dir_for(&app, &path)?;
    Ok(list(&dir)
        .into_iter()
        .map(|(ts, label, p)| Snapshot { ts, label, size: p.metadata().map(|m| m.len()).unwrap_or(0) })
        .collect())
}

#[tauri::command]
pub fn history_read(app: AppHandle, path: String, ts: u64) -> Result<String, String> {
    let dir = dir_for(&app, &path)?;
    let (_, _, p) = list(&dir).into_iter().find(|(t, _, _)| *t == ts).ok_or("Snapshot not found")?;
    std::fs::read_to_string(p).map_err(err)
}
