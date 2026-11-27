use crate::proc_util::err;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

fn ignored(p: &str) -> bool {
    let p = p.replace('\\', "/");
    ["/.git/", "/node_modules/", "/target/"].iter().any(|s| p.contains(s))
}

#[tauri::command]
pub fn watch_folder(app: AppHandle, state: State<'_, WatchState>, path: String) -> Result<(), String> {
    if crate::vfs::is_remote(&path) {
        // Remote folders are refreshed on save / focus instead of watched.
        *state.0.lock().unwrap() = None;
        return Ok(());
    }
    let mut w = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let paths: Vec<String> = ev
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .filter(|p| !ignored(p))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("fs-changed", paths);
            }
        }
    })
    .map_err(err)?;
    w.watch(Path::new(&path), RecursiveMode::Recursive).map_err(err)?;
    *state.0.lock().unwrap() = Some(w);
    Ok(())
}
