use crate::proc_util::err;
use tauri::{AppHandle, Manager};

/// The app config folder (holds settings.json and user snippets), forward slashes, created if missing.
#[tauri::command]
pub fn user_config_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(dir.join("snippets")).map_err(err)?;
    Ok(dir.to_string_lossy().replace('\\', "/"))
}
