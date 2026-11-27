//! Profiles: named sets of settings, keybindings, enabled extensions, user snippets and layout.
//! The frontend owns switching; this module stores `profiles.json`, each profile's snippets folder,
//! and the `.cepheus-profile` export/import format. Secrets are stripped from everything that
//! leaves this machine (exports and Settings Sync).

use crate::proc_util::err;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const FORMAT: &str = "cepheus-profile";

/// Keys whose values are never exported or synced, at any depth.
const SECRET_KEYS: &[&str] = &["keys", "githubToken", "apiKey", "api_key", "token", "password", "passphrase", "secret", "privateKey"];

/// Removes secret-looking keys recursively.
pub fn strip_secrets(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| !SECRET_KEYS.iter().any(|s| s.eq_ignore_ascii_case(k)));
            m.values_mut().for_each(strip_secrets);
        }
        Value::Array(a) => a.iter_mut().for_each(strip_secrets),
        _ => {}
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_config_dir().map_err(err)?;
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

fn safe_profile_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid profile id".into());
    }
    Ok(())
}

fn snippets_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    safe_profile_id(id)?;
    let d = root.join("profiles").join(id).join("snippets");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

fn is_snippet_file(name: &str) -> bool {
    let l = name.to_lowercase();
    (l.ends_with(".json") || l.ends_with(".code-snippets")) && !name.contains(['/', '\\']) && !name.contains("..")
}

pub fn read_snippets(dir: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if is_snippet_file(&name) && e.metadata().map(|m| m.len() < 2_000_000).unwrap_or(false) {
                if let Ok(t) = std::fs::read_to_string(e.path()) {
                    out.insert(name, Value::String(t));
                }
            }
        }
    }
    out
}

pub fn write_snippets(dir: &Path, files: &Map<String, Value>) -> Result<usize, String> {
    let mut n = 0;
    for (name, content) in files {
        if let (true, Some(text)) = (is_snippet_file(name), content.as_str()) {
            std::fs::write(dir.join(name), text).map_err(err)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Builds the export document (pure, for tests).
pub fn build_export(profile: &Value, snippets: Map<String, Value>) -> Value {
    let mut p = profile.clone();
    strip_secrets(&mut p);
    if let Value::Object(m) = &mut p {
        // Folder associations are machine paths.
        m.remove("folders");
    }
    serde_json::json!({
        "format": FORMAT,
        "version": 1,
        "exportedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        "profile": p,
        "snippets": snippets,
    })
}

/// Validates an export document and returns (profile, snippets).
pub fn parse_export(text: &str) -> Result<(Value, Map<String, Value>), String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("Not a profile file: {e}"))?;
    if v.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        return Err("Not a Cepheus profile (.cepheus-profile) file.".into());
    }
    let mut profile = v.get("profile").cloned().filter(|p| p.is_object()).ok_or("The profile file has no profile data.")?;
    strip_secrets(&mut profile);
    if profile.get("name").and_then(|n| n.as_str()).map(str::trim).unwrap_or("").is_empty() {
        return Err("The profile has no name.".into());
    }
    let snippets = v.get("snippets").and_then(|s| s.as_object()).cloned().unwrap_or_default();
    Ok((profile, snippets))
}

#[tauri::command]
pub fn profiles_load(app: AppHandle) -> Result<Value, String> {
    let p = config_dir(&app)?.join("profiles.json");
    if !p.exists() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&std::fs::read_to_string(p).map_err(err)?).unwrap_or(Value::Null))
}

#[tauri::command]
pub fn profiles_save(app: AppHandle, data: Value) -> Result<(), String> {
    let p = config_dir(&app)?.join("profiles.json");
    std::fs::write(p, serde_json::to_string_pretty(&data).map_err(err)?).map_err(err)
}

/// The profile's user snippets folder (created on demand).
#[tauri::command]
pub fn profile_snippets_dir(app: AppHandle, id: String) -> Result<String, String> {
    Ok(snippets_dir(&config_dir(&app)?, &id)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn profile_snippets_read(app: AppHandle, id: String) -> Result<Map<String, Value>, String> {
    Ok(read_snippets(&snippets_dir(&config_dir(&app)?, &id)?))
}

#[tauri::command]
pub fn profile_snippets_write(app: AppHandle, id: String, files: Map<String, Value>) -> Result<usize, String> {
    write_snippets(&snippets_dir(&config_dir(&app)?, &id)?, &files)
}

#[tauri::command]
pub fn profile_delete_data(app: AppHandle, id: String) -> Result<(), String> {
    safe_profile_id(&id)?;
    let d = config_dir(&app)?.join("profiles").join(&id);
    if d.exists() {
        std::fs::remove_dir_all(d).map_err(err)?;
    }
    Ok(())
}

/// Writes `profile` (plus its snippets) to a .cepheus-profile file, without secrets.
#[tauri::command]
pub fn profile_export(app: AppHandle, path: String, id: String, profile: Value) -> Result<(), String> {
    let snippets = read_snippets(&snippets_dir(&config_dir(&app)?, &id)?);
    let doc = build_export(&profile, snippets);
    std::fs::write(path, serde_json::to_string_pretty(&doc).map_err(err)?).map_err(err)
}

/// Reads a .cepheus-profile file; its snippets are stored under `new_id`. Returns the profile.
#[tauri::command]
pub fn profile_import(app: AppHandle, path: String, new_id: String) -> Result<Value, String> {
    let text = std::fs::read_to_string(&path).map_err(err)?;
    let (profile, snippets) = parse_export(&text)?;
    write_snippets(&snippets_dir(&config_dir(&app)?, &new_id)?, &snippets)?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "id": "work", "name": "Work", "folders": ["C:/code/app"],
            "data": {
                "settings": { "fontSize": 15, "keys": { "anthropic": "sk-ant-secret" }, "githubToken": "ghp_x",
                              "sshHosts": [{ "host": "h", "password": "p" }], "keybindings": { "file.save": "Ctrl+S" } },
                "extensions": ["dracula-theme.theme-dracula"],
                "layout": { "sideW": 300 }
            }
        })
    }

    #[test]
    fn strips_secrets_recursively() {
        let mut v = sample();
        strip_secrets(&mut v);
        let s = v.to_string();
        assert!(!s.contains("sk-ant-secret") && !s.contains("ghp_x") && !s.contains("\"password\""));
        assert!(s.contains("fontSize") && s.contains("file.save"));
    }

    #[test]
    fn export_import_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cepheus-prof-test-{}", std::process::id()));
        let snip_src = dir.join("src");
        let snip_dst = dir.join("dst");
        std::fs::create_dir_all(&snip_src).unwrap();
        std::fs::create_dir_all(&snip_dst).unwrap();
        std::fs::write(snip_src.join("typescript.json"), r#"{"log":{"prefix":"cl","body":"console.log($1)"}}"#).unwrap();
        std::fs::write(snip_src.join("notes.txt"), "ignored").unwrap();

        let doc = build_export(&sample(), read_snippets(&snip_src));
        let text = serde_json::to_string_pretty(&doc).unwrap();
        assert!(!text.contains("sk-ant-secret"));
        assert!(!text.contains("C:/code/app"), "folder paths are machine-specific");

        let (profile, snippets) = parse_export(&text).unwrap();
        assert_eq!(profile["name"], "Work");
        assert_eq!(profile["data"]["settings"]["fontSize"], 15);
        assert_eq!(profile["data"]["extensions"][0], "dracula-theme.theme-dracula");
        assert_eq!(write_snippets(&snip_dst, &snippets).unwrap(), 1);
        assert!(snip_dst.join("typescript.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_foreign_files_and_bad_names() {
        assert!(parse_export(r#"{"name":"x"}"#).is_err());
        assert!(parse_export("not json").is_err());
        assert!(parse_export(r#"{"format":"cepheus-profile","profile":{"name":"  "}}"#).is_err());
        assert!(!is_snippet_file("../evil.json"));
        assert!(!is_snippet_file("a/b.json"));
        assert!(safe_profile_id("../x").is_err());
        assert!(safe_profile_id("p-123_a").is_ok());
    }
}
