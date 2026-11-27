//! Auto-updates through tauri-plugin-updater, driven from the frontend (no JS plugin package).
//! Endpoint and public key come from the organization policy (`updateEndpoint`, `updatePubkey`)
//! or tauri.conf.json `plugins.updater`; with no endpoint or key the updater stays disabled.
//! Updates are downloaded first and installed only when the user agrees to restart.

use crate::proc_util::err;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<tauri_plugin_updater::Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    /// False when no endpoint or public key is set: the UI hides update actions.
    configured: bool,
    endpoint: String,
    /// "policy" | "config" | ""
    source: String,
    /// Policy-managed mode, if any ("automatic" | "startup" | "manual" | "none").
    policy_mode: Option<String>,
    current_version: String,
}

fn resolved(app: &AppHandle) -> (Vec<String>, String, String) {
    let p = crate::policy::get();
    let conf = app.config().plugins.0.get("updater").cloned().unwrap_or_default();
    let conf_endpoints: Vec<String> = conf
        .get("endpoints")
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).filter(|s| !s.trim().is_empty()).collect())
        .unwrap_or_default();
    let conf_key = conf.get("pubkey").and_then(|k| k.as_str()).unwrap_or("").to_string();
    let (endpoints, source) = match p.update_endpoint.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        Some(e) => (vec![e.to_string()], "policy"),
        None if !conf_endpoints.is_empty() => (conf_endpoints, "config"),
        None => (vec![], ""),
    };
    let key = p.update_pubkey.clone().filter(|k| !k.trim().is_empty()).unwrap_or(conf_key);
    (endpoints, key, source.to_string())
}

#[tauri::command]
pub fn update_config(app: AppHandle) -> UpdateConfig {
    let (endpoints, key, source) = resolved(&app);
    UpdateConfig {
        configured: !endpoints.is_empty() && !key.trim().is_empty(),
        endpoint: endpoints.first().cloned().unwrap_or_default(),
        source,
        policy_mode: crate::policy::get().update_mode.clone(),
        current_version: app.package_info().version.to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, UpdateState>) -> Result<Option<UpdateInfo>, String> {
    if crate::policy::get().update_mode.as_deref() == Some("none") {
        return Err("Updates are disabled by your organization's policy.".into());
    }
    let (endpoints, key, _) = resolved(&app);
    if endpoints.is_empty() || key.trim().is_empty() {
        return Err("Updates are not configured for this build (no update endpoint / public key).".into());
    }
    let urls = endpoints.iter().map(|e| e.parse()).collect::<Result<Vec<_>, _>>().map_err(|e| format!("Invalid update endpoint: {e}"))?;
    let mut b = app.updater_builder().endpoints(urls).map_err(err)?.pubkey(key);
    if let Some(px) = crate::net::https_proxy().and_then(|p| p.parse().ok()) {
        b = b.proxy(px);
    }
    let update = b.build().map_err(err)?.check().await.map_err(|e| format!("Update check failed: {e}"))?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *state.bytes.lock().unwrap() = None;
    *state.pending.lock().unwrap() = update;
    Ok(info)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// Downloads (and verifies) the pending update; emits `update-progress` events.
#[tauri::command]
pub async fn update_download(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let update = state.pending.lock().unwrap().clone().ok_or("No update available. Check for updates first.")?;
    let mut downloaded = 0u64;
    let app2 = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app2.emit("update-progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    *state.bytes.lock().unwrap() = Some(bytes);
    Ok(())
}

/// Installs the downloaded update and restarts. On Windows the installer closes the app itself.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    let update = state.pending.lock().unwrap().clone().ok_or("No update available.")?;
    let bytes = state.bytes.lock().unwrap().take().ok_or("The update has not been downloaded yet.")?;
    update.install(bytes).map_err(|e| format!("Install failed: {e}"))?;
    app.restart();
}
