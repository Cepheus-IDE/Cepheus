//! Deep links (`cepheus://open?folder=…`, `cepheus://agent/new?prompt=…`) and single-instance
//! handling: a link opened while Cepheus runs is routed to the existing window.
//!
//! URLs are queued here and the frontend drains them with `deep_link_take` (on start and on each
//! `deep-link` event), so a link that launched the app is not lost before the UI is listening.

use std::sync::Mutex;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_deep_link::DeepLinkExt;

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn push<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let urls: Vec<String> = urls.into_iter().filter(|u| u.to_lowercase().starts_with("cepheus:")).collect();
    if urls.is_empty() {
        return;
    }
    PENDING.lock().unwrap().extend(urls);
    let _ = app.emit("deep-link", ());
}

pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Must be registered first (single-instance requirement).
pub fn single_instance<R: Runtime>() -> TauriPlugin<R> {
    // With the "deep-link" feature, URLs in `argv` are forwarded to the deep-link plugin, which
    // fires `on_open_url` below; here we only bring the window forward.
    tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app))
}

/// Wires the deep-link plugin to the queue. Register after `tauri_plugin_deep_link::init()`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("cepheus-continuity")
        .setup(|app, _| {
            // Dev builds are not installed, so the scheme points nowhere until registered for this exe
            // (per-user registry on Windows). Installed builds register it via the bundler config.
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            {
                let _ = app.deep_link().register_all();
            }
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                push(app, urls.into_iter().map(|u| u.to_string()).collect());
            }
            let handle = app.clone();
            app.deep_link().on_open_url(move |e| {
                focus_main(&handle);
                push(&handle, e.urls().into_iter().map(|u| u.to_string()).collect());
            });
            Ok(())
        })
        .build()
}

#[tauri::command]
pub fn deep_link_take() -> Vec<String> {
    let mut v = PENDING.lock().unwrap();
    let mut out: Vec<String> = Vec::new();
    for u in v.drain(..) {
        if !out.contains(&u) {
            out.push(u);
        }
    }
    out
}
