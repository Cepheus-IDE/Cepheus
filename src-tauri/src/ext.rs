//! Extensions: install VS Code-format extensions from Open VSX (or import them from a local
//! VS Code / Cursor / Windsurf / VSCodium install). Cepheus activates the declarative parts —
//! color themes and snippets — so only JSON/data files are ever extracted; no code is run.

use crate::proc_util::err;
use serde::Serialize;
use serde_json::Value;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const MAX_FILE: u64 = 5_000_000;

fn ext_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(err)?.join("extensions");
    std::fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

const DEFAULT_REGISTRY: &str = "https://open-vsx.org";
static REGISTRY: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// Open VSX-compatible registry base URL: policy > user setting > open-vsx.org.
fn registry() -> String {
    if let Some(u) = crate::policy::get().extension_registry_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        return u.trim_end_matches('/').to_string();
    }
    let u = REGISTRY.read().unwrap().clone();
    if u.trim().is_empty() { DEFAULT_REGISTRY.into() } else { u }
}

/// Sets the user's registry URL ("" = default). Ignored while a policy sets one.
#[tauri::command]
pub fn ext_configure(registry_url: String) -> Result<String, String> {
    let u = registry_url.trim().trim_end_matches('/').to_string();
    if !u.is_empty() && !u.starts_with("https://") && !u.starts_with("http://") {
        return Err("The registry URL must start with https://".into());
    }
    *REGISTRY.write().unwrap() = u;
    Ok(registry())
}

fn http() -> reqwest::Client {
    crate::net::builder()
        .user_agent("CepheusIDE/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("client")
}

/// Bumped when the set of extracted files changes, so older installs get refreshed.
const LAYOUT_MARKER: &str = ".cepheus-v2";

/// Data-only files Cepheus can use: manifests, themes, snippets, icon images, top-level docs.
fn wanted(rel: &str) -> bool {
    let l = rel.to_lowercase();
    if l.contains("node_modules/") || l.starts_with("src/") || l.contains("/test/") {
        return false;
    }
    if [".json", ".jsonc", ".tmtheme", ".code-snippets", ".svg", ".png"].iter().any(|e| l.ends_with(e)) {
        return true;
    }
    // README / CHANGELOG at the extension root (shown on the extension page when offline).
    !l.contains('/') && l.ends_with(".md")
}

fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err("invalid extension id".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeContrib {
    label: String,
    ui_theme: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetContrib {
    language: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconThemeContrib {
    id: String,
    label: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    id: String,
    name: String,
    display_name: String,
    publisher: String,
    version: String,
    description: String,
    categories: Vec<String>,
    themes: Vec<ThemeContrib>,
    icon_themes: Vec<IconThemeContrib>,
    snippets: Vec<SnippetContrib>,
    /// Other contribution points present in package.json (languages, commands, debuggers, ...).
    other_contributions: Vec<String>,
    icon: Option<String>,
    readme: Option<String>,
    changelog: Option<String>,
    repository: Option<String>,
    source: String,
    needs_update: bool,
}

fn nls(dir: &Path, s: &str) -> String {
    if s.len() > 2 && s.starts_with('%') && s.ends_with('%') {
        if let Ok(t) = std::fs::read_to_string(dir.join("package.nls.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                if let Some(r) = v.get(&s[1..s.len() - 1]).and_then(|x| x.as_str().or_else(|| x.get("message").and_then(|m| m.as_str()))) {
                    return r.to_string();
                }
            }
        }
    }
    s.to_string()
}

fn read_manifest(dir: &Path, id: &str) -> Option<ExtInfo> {
    let pkg: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("package.json")).ok()?).ok()?;
    let s = |k: &str| nls(dir, pkg.get(k).and_then(|v| v.as_str()).unwrap_or(""));
    let resolve = |p: &str| dir.join(p.trim_start_matches("./")).to_string_lossy().to_string();
    let themes = pkg
        .pointer("/contributes/themes")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let path = t.get("path")?.as_str()?;
                    Some(ThemeContrib {
                        label: nls(dir, t.get("label").and_then(|l| l.as_str()).or(t.get("id").and_then(|l| l.as_str())).unwrap_or("Theme")),
                        ui_theme: t.get("uiTheme").and_then(|u| u.as_str()).unwrap_or("vs-dark").to_string(),
                        path: resolve(path),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let snippets = pkg
        .pointer("/contributes/snippets")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(SnippetContrib {
                        language: t.get("language")?.as_str()?.to_string(),
                        path: resolve(t.get("path")?.as_str()?),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let source = std::fs::read_to_string(dir.join(".cepheus-source")).unwrap_or_else(|_| "openvsx".into());
    let icon_themes = pkg
        .pointer("/contributes/iconThemes")
        .and_then(|t| t.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    Some(IconThemeContrib {
                        id: t.get("id")?.as_str()?.to_string(),
                        label: nls(dir, t.get("label").and_then(|l| l.as_str()).unwrap_or("Icons")),
                        path: resolve(t.get("path")?.as_str()?),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let other_contributions = pkg
        .get("contributes")
        .and_then(|c| c.as_object())
        .map(|o| o.keys().filter(|k| !["themes", "iconThemes", "snippets"].contains(&k.as_str())).cloned().collect())
        .unwrap_or_default();
    let find_doc = |prefix: &str| {
        std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
            let n = e.file_name().to_string_lossy().to_lowercase();
            (n.starts_with(prefix) && n.ends_with(".md")).then(|| e.path().to_string_lossy().to_string())
        })
    };
    let icon = pkg.get("icon").and_then(|i| i.as_str()).map(resolve).filter(|p| Path::new(p).exists());
    let repository = pkg
        .get("repository")
        .and_then(|r| r.as_str().map(String::from).or_else(|| r.get("url").and_then(|u| u.as_str()).map(String::from)))
        .map(|u| u.trim_start_matches("git+").trim_end_matches(".git").to_string());
    Some(ExtInfo {
        name: pkg.get("name").and_then(|v| v.as_str()).unwrap_or(id).to_string(),
        icon_themes,
        other_contributions,
        icon,
        readme: find_doc("readme"),
        changelog: find_doc("changelog"),
        repository,
        needs_update: source.trim() == "openvsx" && !dir.join(LAYOUT_MARKER).exists(),
        id: id.to_string(),
        display_name: { let d = s("displayName"); if d.is_empty() { s("name") } else { d } },
        publisher: s("publisher"),
        version: s("version"),
        description: s("description"),
        categories: pkg
            .get("categories")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        themes,
        snippets,
        source: source.trim().to_string(),
    })
}

fn contributes_assets(pkg: &Value) -> bool {
    let has = |k: &str| pkg.pointer(&format!("/contributes/{k}")).and_then(|v| v.as_array()).map(|a| !a.is_empty()).unwrap_or(false);
    has("themes") || has("snippets") || has("iconThemes")
}

fn install_vsix(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Invalid .vsix: {e}"))?;
    if dest.exists() {
        std::fs::remove_dir_all(dest).map_err(err)?;
    }
    std::fs::create_dir_all(dest).map_err(err)?;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        if f.is_dir() || f.size() > MAX_FILE {
            continue;
        }
        let Some(name) = f.enclosed_name() else { continue };
        let Ok(rel) = name.strip_prefix("extension") else { continue };
        let rel_s = rel.to_string_lossy().replace('\\', "/");
        if !wanted(&rel_s) {
            continue;
        }
        let out = dest.join(rel);
        if let Some(p) = out.parent() {
            std::fs::create_dir_all(p).map_err(err)?;
        }
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(err)?;
        std::fs::write(out, buf).map_err(err)?;
    }
    std::fs::write(dest.join(LAYOUT_MARKER), "").map_err(err)?;
    Ok(())
}

/// Extension metadata from Open VSX (README/CHANGELOG URLs, downloads, rating, ...).
#[tauri::command]
pub async fn openvsx_meta(namespace: String, name: String) -> Result<Value, String> {
    http()
        .get(format!("{}/api/{namespace}/{name}", registry()))
        .send()
        .await
        .map_err(|e| format!("Cannot reach the extension registry: {e}"))?
        .json()
        .await
        .map_err(err)
}

/// Fetches a text resource (README, CHANGELOG) — restricted to the registry (and Open VSX storage).
#[tauri::command]
pub async fn openvsx_text(url: String) -> Result<String, String> {
    let reg = format!("{}/", registry());
    if !url.starts_with(&reg) && !url.starts_with("https://open-vsx.org/") && !url.starts_with("https://openvsxorg.blob.core.windows.net/") {
        return Err("URL not allowed".into());
    }
    http().get(url).send().await.map_err(err)?.text().await.map_err(err)
}

#[tauri::command]
pub async fn openvsx_search(query: String, category: Option<String>) -> Result<Value, String> {
    let mut q: Vec<(&str, String)> = vec![("query", query), ("size", "40".into()), ("sortBy", "downloadCount".into())];
    if let Some(c) = category.filter(|c| !c.is_empty()) {
        q.push(("category", c));
    }
    http()
        .get(format!("{}/api/-/search", registry()))
        .query(&q)
        .send()
        .await
        .map_err(|e| format!("Cannot reach the extension registry: {e}"))?
        .json()
        .await
        .map_err(err)
}

/// Installs an extension (latest, or a pinned `version`) after the organization allowlist check.
#[tauri::command]
pub async fn ext_install(app: AppHandle, namespace: String, name: String, version: Option<String>) -> Result<ExtInfo, String> {
    let id = format!("{namespace}.{name}").to_lowercase();
    safe_id(&id)?;
    let client = http();
    let url = match version.as_deref().filter(|v| !v.is_empty()) {
        Some(v) => format!("{}/api/{namespace}/{name}/{v}", registry()),
        None => format!("{}/api/{namespace}/{name}", registry()),
    };
    let meta: Value = client.get(url).send().await.map_err(err)?.json().await.map_err(err)?;
    if let Some(e) = meta.get("error").and_then(|e| e.as_str()) {
        return Err(e.to_string());
    }
    let ver = meta.get("version").and_then(|v| v.as_str()).unwrap_or("");
    if !crate::policy::extension_allowed(&id, ver) {
        return Err(format!("{id}@{ver} is not allowed by your organization's extension allowlist."));
    }
    let url = meta.pointer("/files/download").and_then(|u| u.as_str()).ok_or("Extension has no download")?;
    let bytes = client.get(url).send().await.map_err(err)?.bytes().await.map_err(err)?;
    let dest = ext_root(&app)?.join(&id);
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || install_vsix(&dest2, &bytes)).await.map_err(err)??;
    read_manifest(&dest, &id).ok_or_else(|| "Installed, but package.json is missing".into())
}

#[tauri::command]
pub fn ext_list(app: AppHandle) -> Result<Vec<ExtInfo>, String> {
    let mut out = Vec::new();
    for ent in std::fs::read_dir(ext_root(&app)?).map_err(err)?.flatten() {
        let id = ent.file_name().to_string_lossy().to_string();
        if let Some(m) = read_manifest(&ent.path(), &id) {
            out.push(m);
        }
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn ext_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    safe_id(&id)?;
    let d = ext_root(&app)?.join(&id);
    if d.exists() {
        std::fs::remove_dir_all(d).map_err(err)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Import from VS Code-family editors
// ---------------------------------------------------------------------------------------------

/// (display name, %APPDATA% folder, extensions folder under home)
const EDITORS: &[(&str, &str, &str)] = &[
    ("VS Code", "Code", ".vscode"),
    ("VS Code Insiders", "Code - Insiders", ".vscode-insiders"),
    ("Cursor", "Cursor", ".cursor"),
    ("Windsurf", "Windsurf", ".windsurf"),
    ("VSCodium", "VSCodium", ".vscode-oss"),
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFound {
    name: String,
    has_settings: bool,
    extension_count: usize,
}

fn editor_paths(app: &AppHandle, name: &str) -> Option<(PathBuf, PathBuf)> {
    let (_, cfg, ext) = EDITORS.iter().find(|e| e.0 == name)?;
    let settings = app.path().config_dir().ok()?.join(cfg).join("User");
    let exts = app.path().home_dir().ok()?.join(ext).join("extensions");
    Some((settings, exts))
}

#[tauri::command]
pub fn vscode_detect(app: AppHandle) -> Vec<EditorFound> {
    EDITORS
        .iter()
        .filter_map(|(name, _, _)| {
            let (s, e) = editor_paths(&app, name)?;
            let has_settings = s.join("settings.json").exists();
            let extension_count = std::fs::read_dir(&e).map(|d| d.flatten().filter(|x| x.path().is_dir()).count()).unwrap_or(0);
            (has_settings || extension_count > 0).then(|| EditorFound { name: name.to_string(), has_settings, extension_count })
        })
        .collect()
}

fn copy_assets(src: &Path, dst: &Path) -> std::io::Result<()> {
    fn walk(base: &Path, cur: &Path, dst: &Path, depth: usize) -> std::io::Result<()> {
        if depth > 6 {
            return Ok(());
        }
        for ent in std::fs::read_dir(cur)?.flatten() {
            let p = ent.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if p.is_dir() {
                if ent.file_name() != "node_modules" && ent.file_name() != ".git" {
                    walk(base, &p, dst, depth + 1)?;
                }
            } else if wanted(&rel) && !rel.to_lowercase().starts_with("src/") && ent.metadata().map(|m| m.len() <= MAX_FILE).unwrap_or(false) {
                let out = dst.join(&rel);
                if let Some(par) = out.parent() {
                    std::fs::create_dir_all(par)?;
                }
                std::fs::copy(&p, out)?;
            }
        }
        Ok(())
    }
    walk(src, src, dst, 0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    settings: Option<String>,
    imported: Vec<String>,
}

/// Copies theme/snippet extensions and returns the raw settings.json (JSONC) for the UI to map.
#[tauri::command]
pub async fn vscode_import(app: AppHandle, editor: String) -> Result<ImportResult, String> {
    let (settings_dir, exts_dir) = editor_paths(&app, &editor).ok_or("Unknown editor")?;
    let root = ext_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings = std::fs::read_to_string(settings_dir.join("settings.json")).ok();
        let mut imported = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&exts_dir) {
            for ent in rd.flatten() {
                let dir = ent.path();
                let Ok(txt) = std::fs::read_to_string(dir.join("package.json")) else { continue };
                let Ok(pkg) = serde_json::from_str::<Value>(&txt) else { continue };
                if !contributes_assets(&pkg) {
                    continue;
                }
                let publisher = pkg.get("publisher").and_then(|v| v.as_str()).unwrap_or("local");
                let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("ext");
                let id = format!("{publisher}.{name}").to_lowercase();
                let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("");
                if safe_id(&id).is_err() || !crate::policy::extension_allowed(&id, version) {
                    continue;
                }
                let dst = root.join(&id);
                let _ = std::fs::remove_dir_all(&dst);
                if copy_assets(&dir, &dst).is_ok() {
                    let _ = std::fs::write(dst.join(".cepheus-source"), &editor);
                    let _ = std::fs::write(dst.join(LAYOUT_MARKER), "");
                    imported.push(id);
                }
            }
        }
        Ok(ImportResult { settings, imported })
    })
    .await
    .map_err(err)?
}

// ---------------------------------------------------------------------------------------------
// Organization: preinstalled extensions
// ---------------------------------------------------------------------------------------------

/// Installs the policy's `preinstallExtensions` once each ("publisher.name" or
/// "publisher.name@version"). Extensions the user later removes are not reinstalled.
/// Returns the ids installed now.
#[tauri::command]
pub async fn ext_preinstall(app: AppHandle) -> Result<Vec<String>, String> {
    let wanted = crate::policy::get().preinstall_extensions.clone();
    if wanted.is_empty() {
        return Ok(vec![]);
    }
    let marker = ext_root(&app)?.join(".cepheus-preinstalled");
    let done: Vec<String> = std::fs::read_to_string(&marker).unwrap_or_default().lines().map(|l| l.trim().to_lowercase()).collect();
    let mut installed = Vec::new();
    let mut errors = Vec::new();
    let mut record = done.clone();
    for spec in wanted {
        let spec = spec.trim().to_lowercase();
        let (id, version) = match spec.split_once('@') {
            Some((i, v)) => (i.to_string(), Some(v.to_string())),
            None => (spec.clone(), None),
        };
        if done.contains(&spec) || done.contains(&id) {
            continue;
        }
        let Some((ns, name)) = id.split_once('.') else { continue };
        if ext_root(&app)?.join(&id).exists() {
            record.push(spec.clone());
            continue;
        }
        match ext_install(app.clone(), ns.to_string(), name.to_string(), version).await {
            Ok(_) => {
                installed.push(id);
                record.push(spec);
            }
            Err(e) => errors.push(format!("{id}: {e}")),
        }
    }
    let _ = std::fs::write(&marker, record.join("
"));
    if installed.is_empty() && !errors.is_empty() {
        return Err(format!("Preinstall failed: {}", errors.join("; ")));
    }
    Ok(installed)
}
