//! Agent session persistence: `<app data>/agent-sessions/<id>.json` holds the UI session
//! (items, plan, changes, title, model, tokens, debug log) and `<id>.history.json` the
//! provider-native conversation history so a restored session can continue.

use crate::proc_util::err;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn safe_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Invalid session id '{id}'"));
    }
    Ok(id.to_string())
}

pub fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(err)?.join("agent-sessions");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

/// Writes atomically (temp file + rename) so a crash never leaves half a JSON file.
fn write_atomic(path: &PathBuf, data: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(err)?;
    std::fs::rename(&tmp, path).map_err(err)
}

pub fn save_history(app: &AppHandle, id: &str, provider: &str, history: &[Value]) {
    let Ok(id) = safe_id(id) else { return };
    let Ok(d) = dir(app) else { return };
    let data = json!({"provider": provider, "history": history}).to_string();
    let _ = write_atomic(&d.join(format!("{id}.history.json")), &data);
}

pub fn load_history(app: &AppHandle, id: &str) -> Option<(String, Vec<Value>)> {
    let id = safe_id(id).ok()?;
    let text = std::fs::read_to_string(dir(app).ok()?.join(format!("{id}.history.json"))).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Some((v.get("provider")?.as_str()?.to_string(), v.get("history")?.as_array()?.clone()))
}

#[tauri::command]
pub fn agent_sessions_load(app: AppHandle) -> Result<Vec<Value>, String> {
    let d = dir(&app)?;
    let mut out = vec![];
    for ent in std::fs::read_dir(d).map_err(err)?.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.ends_with(".history.json") {
            continue;
        }
        if let Ok(v) = std::fs::read_to_string(ent.path()).map_err(err).and_then(|t| serde_json::from_str::<Value>(&t).map_err(err)) {
            out.push(v);
        }
    }
    out.sort_by_key(|v| std::cmp::Reverse(v.get("createdAt").and_then(|c| c.as_u64()).unwrap_or(0)));
    Ok(out)
}

#[tauri::command]
pub fn agent_session_save(app: AppHandle, id: String, data: Value) -> Result<(), String> {
    let id = safe_id(&id)?;
    write_atomic(&dir(&app)?.join(format!("{id}.json")), &data.to_string())
}

#[tauri::command]
pub fn agent_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    let id = safe_id(&id)?;
    let d = dir(&app)?;
    for f in [format!("{id}.json"), format!("{id}.history.json")] {
        let p = d.join(f);
        if p.exists() {
            std::fs::remove_file(p).map_err(err)?;
        }
    }
    Ok(())
}
