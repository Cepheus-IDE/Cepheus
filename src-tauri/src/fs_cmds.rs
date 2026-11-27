//! File commands. Every path may be local or `ssh://` remote (see `vfs`).

use crate::proc_util::err;
use crate::vfs;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// Local-only text read (used by search over local trees).
pub fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(err)?;
    if is_binary(&bytes) {
        return Err("File appears to be binary".into());
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub async fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    vfs::read_dir(&path).await
}

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    if !vfs::is_remote(&path) {
        if let Ok(m) = std::fs::metadata(&path) {
            if m.len() > vfs::MAX_TEXT_BYTES {
                return Err(format!("File is too large to open in the editor ({} MB)", m.len() / 1_000_000));
            }
        }
    }
    vfs::read_text(&path).await
}

/// Reads any file as a data: URL (used for extension icons / icon-theme images).
#[tauri::command]
pub async fn read_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = vfs::read(&path).await?;
    let mime = match path.rsplit('.').next().map(|e| e.to_lowercase()).as_deref() {
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    vfs::write(&path, content.as_bytes()).await
}

#[tauri::command]
pub async fn create_dir(path: String) -> Result<(), String> {
    vfs::mkdir_all(&path).await
}

#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    vfs::rename(&from, &to).await
}

/// Local files go to the Recycle Bin; remote files are deleted.
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    vfs::remove(&path).await
}

#[tauri::command]
pub async fn path_exists(path: String) -> bool {
    vfs::exists(&path).await
}
