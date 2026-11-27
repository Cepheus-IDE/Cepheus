use crate::proc_util::err;
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Value, String> {
    let p = settings_path(&app)?;
    if !p.exists() {
        return Ok(Value::Null);
    }
    let s = std::fs::read_to_string(p).map_err(err)?;
    Ok(serde_json::from_str(&s).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    let p = settings_path(&app)?;
    std::fs::write(p, serde_json::to_string_pretty(&settings).map_err(err)?).map_err(err)
}
