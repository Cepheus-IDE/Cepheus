//! Dev Containers: "Reopen in Container" for folders with `.devcontainer/devcontainer.json`.
//! The container is built/run with the `docker` CLI, the workspace is bind-mounted, and files stay
//! on the host. Terminals (`docker exec -it`) and agent commands (`exec_args`) run inside it.
//! Supported keys: image, build.dockerfile/context (or dockerFile), workspaceFolder, containerEnv,
//! remoteEnv, forwardPorts, runArgs, mounts (strings), remoteUser/containerUser,
//! postCreateCommand, postStartCommand. Docker Compose configs are not supported.

use crate::proc_util::{err, std_cmd, tokio_cmd};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    pub container: String,
    pub name: String,
    pub workspace: String,
    pub workspace_folder: String,
    pub user: Option<String>,
    pub env: Vec<(String, String)>,
}

static ACTIVE: Mutex<Option<HashMap<String, Active>>> = Mutex::new(None);

fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let s = s.trim_end_matches('/');
    if cfg!(windows) { s.to_lowercase() } else { s.to_string() }
}

fn with_active<T>(f: impl FnOnce(&mut HashMap<String, Active>) -> T) -> T {
    let mut g = ACTIVE.lock().unwrap();
    f(g.get_or_insert_with(HashMap::new))
}

/// The active container whose workspace contains `dir`, with `dir` mapped into the container.
fn lookup(dir: &str) -> Option<(Active, String)> {
    let d = norm(dir);
    with_active(|m| {
        m.values().find_map(|a| {
            let ws = norm(&a.workspace);
            let rest = d.strip_prefix(&ws)?;
            if !rest.is_empty() && !rest.starts_with('/') {
                return None;
            }
            // Keep the original case of the sub path.
            let orig = dir.replace('\\', "/");
            let orig = orig.trim_end_matches('/');
            let sub = orig.len().checked_sub(rest.len()).and_then(|i| orig.get(i..)).unwrap_or(rest);
            Some((a.clone(), format!("{}{}", a.workspace_folder.trim_end_matches('/'), sub)))
        })
    })
}

/// docker argv that runs `command` in the container for `dir`, or None when no container is active.
pub fn exec_args(dir: &str, command: &str) -> Option<Vec<String>> {
    let (a, cwd) = lookup(dir)?;
    let mut v = vec!["exec".to_string(), "-w".into(), cwd];
    if let Some(u) = &a.user {
        v.extend(["-u".into(), u.clone()]);
    }
    for (k, val) in &a.env {
        v.extend(["-e".into(), format!("{k}={val}")]);
    }
    v.extend([a.container.clone(), "sh".into(), "-c".into(), command.to_string()]);
    Some(v)
}

/// Tells the agent where its commands run.
pub fn agent_note(workspace: &str) -> Option<String> {
    let (a, cwd) = lookup(workspace)?;
    Some(format!(
        "Commands run inside the Linux dev container '{}' with sh (not PowerShell); the workspace is mounted at {cwd}. File tools still use workspace-relative paths.",
        a.name
    ))
}

fn config_path(ws: &Path) -> Option<PathBuf> {
    [ws.join(".devcontainer").join("devcontainer.json"), ws.join(".devcontainer.json")].into_iter().find(|p| p.exists())
}

fn read_config(ws: &Path) -> Result<(PathBuf, Value), String> {
    let p = config_path(ws).ok_or("No .devcontainer/devcontainer.json in this folder.")?;
    let text = std::fs::read_to_string(&p).map_err(err)?;
    let v: Value = serde_json::from_str(&crate::policy::strip_jsonc(&text)).map_err(|e| format!("devcontainer.json: {e}"))?;
    Ok((p, v))
}

fn docker_available() -> bool {
    std_cmd("docker").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}

fn ws_hash(ws: &str) -> String {
    let h = Sha256::digest(norm(ws).as_bytes());
    h.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

fn str_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(String::from).filter(|s| !s.trim().is_empty())
}

fn env_of(v: &Value, k: &str) -> Vec<(String, String)> {
    v.get(k)
        .and_then(|e| e.as_object())
        .map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

/// Lifecycle commands may be a string (shell), an array (argv) or an object of named commands.
fn lifecycle(v: Option<&Value>) -> Vec<Vec<String>> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![vec!["sh".into(), "-c".into(), s.clone()]],
        Some(Value::Array(a)) => vec![a.iter().filter_map(|x| x.as_str().map(String::from)).collect()],
        Some(Value::Object(o)) => o.values().flat_map(|x| lifecycle(Some(x))).collect(),
        _ => vec![],
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    has_config: bool,
    config_path: Option<String>,
    name: Option<String>,
    docker: bool,
    active: Option<Active>,
}

#[tauri::command]
pub async fn devcontainer_detect(workspace: String) -> DetectResult {
    let ws = PathBuf::from(&workspace);
    let cfg = if workspace.starts_with("ssh://") { None } else { config_path(&ws) };
    let name = cfg.as_ref().and_then(|_| read_config(&ws).ok()).and_then(|(_, v)| str_of(&v, "name"));
    let docker = if cfg.is_some() { tauri::async_runtime::spawn_blocking(docker_available).await.unwrap_or(false) } else { false };
    DetectResult {
        has_config: cfg.is_some(),
        config_path: cfg.map(|p| p.to_string_lossy().to_string()),
        name,
        docker,
        active: lookup(&workspace).map(|(a, _)| a),
    }
}

fn log(app: &AppHandle, line: impl Into<String>) {
    let _ = app.emit("devcontainer-log", line.into());
}

/// Runs docker with live output to `devcontainer-log`; returns stdout.
async fn docker(app: &AppHandle, args: &[String], quiet: bool) -> Result<String, String> {
    if !quiet {
        log(app, format!("$ docker {}", args.join(" ")));
    }
    let mut child = tokio_cmd("docker")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Cannot run docker: {e}"))?;
    let stderr = child.stderr.take().unwrap();
    let app2 = app.clone();
    let err_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut all = String::new();
        while let Ok(Some(l)) = lines.next_line().await {
            if !quiet {
                log(&app2, l.clone());
            }
            all.push_str(&l);
            all.push('\n');
        }
        all
    });
    let mut out = String::new();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        if !quiet {
            log(app, l.clone());
        }
        out.push_str(&l);
        out.push('\n');
    }
    let status = child.wait().await.map_err(err)?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("docker failed");
        return Err(format!("docker {}: {last}", args.first().map(String::as_str).unwrap_or("")));
    }
    Ok(out)
}

/// Builds (if needed) and starts the dev container for `workspace`.
#[tauri::command]
pub async fn devcontainer_up(app: AppHandle, workspace: String, rebuild: bool) -> Result<Active, String> {
    if workspace.starts_with("ssh://") {
        return Err("Dev Containers work on local folders only.".into());
    }
    if !tauri::async_runtime::spawn_blocking(docker_available).await.unwrap_or(false) {
        return Err("Docker was not found on PATH. Install Docker Desktop (or Docker Engine) and try again.".into());
    }
    docker(&app, &["info".into(), "--format".into(), "{{.ServerVersion}}".into()], true)
        .await
        .map_err(|_| "Docker is installed but not running. Start Docker Desktop and try again.".to_string())?;

    let ws = PathBuf::from(&workspace);
    let (cfg_path, cfg) = read_config(&ws)?;
    let cfg_dir = cfg_path.parent().unwrap().to_path_buf();
    if cfg.get("dockerComposeFile").is_some() {
        return Err("Docker Compose dev containers are not supported yet; use \"image\" or \"build\".".into());
    }
    let hash = ws_hash(&workspace);
    let cname = format!("cepheus-dc-{hash}");
    let folder_name = ws.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "workspace".into());
    let wf = str_of(&cfg, "workspaceFolder").unwrap_or_else(|| format!("/workspaces/{folder_name}"));
    let user = str_of(&cfg, "remoteUser").or_else(|| str_of(&cfg, "containerUser"));
    let display = str_of(&cfg, "name").unwrap_or_else(|| folder_name.clone());

    if rebuild {
        let _ = docker(&app, &["rm".into(), "-f".into(), cname.clone()], false).await;
    }
    let state = docker(&app, &["ps".into(), "-a".into(), "--filter".into(), format!("name=^/{cname}$"), "--format".into(), "{{.State}}".into()], true).await?;
    let state = state.trim().to_string();
    let mut created = false;
    if state.is_empty() {
        // Image: given, or built from the Dockerfile.
        let image = if let Some(img) = str_of(&cfg, "image") {
            img
        } else {
            let build = cfg.get("build").cloned().unwrap_or(Value::Null);
            let dockerfile = str_of(&build, "dockerfile").or_else(|| str_of(&cfg, "dockerFile")).ok_or("devcontainer.json needs \"image\" or \"build.dockerfile\".")?;
            let context = str_of(&build, "context").unwrap_or_else(|| ".".into());
            let tag = format!("cepheus-dc-img-{hash}");
            let mut args = vec!["build".into(), "-t".into(), tag.clone(), "-f".into(), cfg_dir.join(&dockerfile).to_string_lossy().to_string()];
            if let Some(a) = build.get("args").and_then(|a| a.as_object()) {
                for (k, v) in a {
                    args.extend(["--build-arg".into(), format!("{k}={}", v.as_str().unwrap_or(""))]);
                }
            }
            args.push(cfg_dir.join(&context).to_string_lossy().to_string());
            log(&app, "Building the dev container image…");
            docker(&app, &args, false).await?;
            tag
        };
        let mut args: Vec<String> = vec![
            "run".into(), "-d".into(), "--name".into(), cname.clone(),
            "--label".into(), format!("dev.cepheus.workspace={workspace}"),
            "-v".into(), format!("{}:{wf}", ws.to_string_lossy()),
            "-w".into(), wf.clone(),
        ];
        for (k, v) in env_of(&cfg, "containerEnv") {
            args.extend(["-e".into(), format!("{k}={v}")]);
        }
        if let Some(ports) = cfg.get("forwardPorts").and_then(|p| p.as_array()) {
            for p in ports {
                let p = p.as_u64().map(|n| n.to_string()).or_else(|| p.as_str().map(String::from)).unwrap_or_default();
                if let Some(port) = p.rsplit(':').next().filter(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty()) {
                    args.extend(["-p".into(), format!("127.0.0.1:{port}:{port}")]);
                }
            }
        }
        if let Some(m) = cfg.get("mounts").and_then(|m| m.as_array()) {
            for s in m.iter().filter_map(|x| x.as_str()) {
                args.extend(["--mount".into(), s.replace("${localWorkspaceFolder}", &ws.to_string_lossy())]);
            }
        }
        if let Some(ra) = cfg.get("runArgs").and_then(|r| r.as_array()) {
            args.extend(ra.iter().filter_map(|x| x.as_str().map(String::from)));
        }
        if let Some(u) = str_of(&cfg, "containerUser") {
            args.extend(["-u".into(), u]);
        }
        // overrideCommand (default true): keep the container alive regardless of the image's CMD.
        let override_cmd = cfg.get("overrideCommand").and_then(|o| o.as_bool()).unwrap_or(true);
        if override_cmd {
            args.extend(["--entrypoint".into(), "/bin/sh".into(), image, "-c".into(), "trap 'exit 0' TERM; while sleep 1000; do :; done".into()]);
        } else {
            args.push(image);
        }
        log(&app, "Starting the dev container…");
        docker(&app, &args, false).await?;
        created = true;
    } else if state != "running" {
        docker(&app, &["start".into(), cname.clone()], false).await?;
    }
    let id = docker(&app, &["inspect".into(), "--format".into(), "{{.Id}}".into(), cname.clone()], true).await?.trim().chars().take(12).collect::<String>();
    let active = Active { container: id, name: display, workspace: workspace.clone(), workspace_folder: wf, user, env: env_of(&cfg, "remoteEnv") };
    with_active(|m| m.insert(norm(&workspace), active.clone()));

    let mut hooks = Vec::new();
    if created {
        hooks.extend(lifecycle(cfg.get("onCreateCommand")));
        hooks.extend(lifecycle(cfg.get("postCreateCommand")));
    }
    if created || state != "running" {
        hooks.extend(lifecycle(cfg.get("postStartCommand")));
    }
    for h in hooks.into_iter().filter(|h| !h.is_empty()) {
        let mut args = vec!["exec".to_string(), "-w".into(), active.workspace_folder.clone()];
        if let Some(u) = &active.user {
            args.extend(["-u".into(), u.clone()]);
        }
        args.push(active.container.clone());
        args.extend(h);
        if let Err(e) = docker(&app, &args, false).await {
            log(&app, format!("Lifecycle command failed: {e}"));
        }
    }
    log(&app, format!("Dev container ready: {} ({})", active.name, active.container));
    Ok(active)
}

/// Leaves the container (stops it; it is reused next time).
#[tauri::command]
pub async fn devcontainer_stop(app: AppHandle, workspace: String) -> Result<(), String> {
    let a = with_active(|m| m.remove(&norm(&workspace)));
    if let Some(a) = a {
        docker(&app, &["stop".into(), "-t".into(), "2".into(), a.container], false).await?;
    }
    Ok(())
}

/// Program + args for an interactive shell inside the container (for the PTY terminal).
#[tauri::command]
pub fn devcontainer_shell(workspace: String) -> Option<(String, Vec<String>)> {
    let (a, cwd) = lookup(&workspace)?;
    let mut args = vec!["exec".to_string(), "-it".into(), "-w".into(), cwd];
    if let Some(u) = &a.user {
        args.extend(["-u".into(), u.clone()]);
    }
    for (k, v) in &a.env {
        args.extend(["-e".into(), format!("{k}={v}")]);
    }
    args.extend([a.container, "sh".into(), "-c".into(), "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi".into()]);
    Some(("docker".into(), args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_host_paths_into_the_container() {
        with_active(|m| {
            m.insert(
                norm("C:\\Code\\App"),
                Active { container: "abc".into(), name: "app".into(), workspace: "C:\\Code\\App".into(), workspace_folder: "/workspaces/App".into(), user: Some("node".into()), env: vec![] },
            )
        });
        let args = exec_args("C:\\Code\\App\\src\\lib", "npm test").unwrap();
        assert_eq!(args, ["exec", "-w", "/workspaces/App/src/lib", "-u", "node", "abc", "sh", "-c", "npm test"]);
        assert!(exec_args("C:\\Code\\Apple", "x").is_none());
        assert!(exec_args("C:\\Code\\App", "x").unwrap().contains(&"/workspaces/App".to_string()));
        assert!(agent_note("c:/code/app").unwrap().contains("/workspaces/App"));
        with_active(|m| m.clear());
    }

    #[test]
    fn lifecycle_forms() {
        let v: Value = serde_json::json!({"a": "npm i", "b": ["echo", "hi"]});
        assert_eq!(lifecycle(Some(&Value::String("npm i".into()))), vec![vec!["sh", "-c", "npm i"]]);
        assert_eq!(lifecycle(v.get("b")), vec![vec!["echo", "hi"]]);
        assert_eq!(lifecycle(Some(&v)).len(), 2);
    }
}
