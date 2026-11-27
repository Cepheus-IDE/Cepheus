//! "Verify with checks": detects the workspace's own checks (typecheck/lint/test scripts,
//! cargo check, go test, pytest) so the agent loop can run them after it finishes.

use crate::vfs;
use serde_json::Value;
use std::time::Duration;

async fn has(ws: &str, rel: &str) -> bool {
    vfs::exists(&vfs::join(ws, rel)).await
}

async fn read(ws: &str, rel: &str) -> Option<String> {
    let p = vfs::join(ws, rel);
    if !vfs::exists(&p).await {
        return None;
    }
    vfs::read_text(&p).await.ok()
}

/// Commands to run, in order. Empty when nothing is detectable.
pub async fn detect(ws: &str) -> Vec<String> {
    let mut cmds = vec![];
    if let Some(pkg) = read(ws, "package.json").await.and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        let pm = if has(ws, "pnpm-lock.yaml").await {
            "pnpm"
        } else if has(ws, "yarn.lock").await {
            "yarn"
        } else if has(ws, "bun.lockb").await || has(ws, "bun.lock").await {
            "bun"
        } else {
            "npm"
        };
        let scripts = pkg.get("scripts").and_then(|s| s.as_object()).cloned().unwrap_or_default();
        let script = |n: &str| scripts.get(n).and_then(|v| v.as_str()).map(String::from);
        if script("typecheck").is_some() {
            cmds.push(format!("{pm} run typecheck"));
        } else if script("type-check").is_some() {
            cmds.push(format!("{pm} run type-check"));
        } else if has(ws, "tsconfig.json").await {
            cmds.push("npx tsc --noEmit".into());
        }
        if script("lint").is_some() {
            cmds.push(format!("{pm} run lint"));
        }
        // npm's placeholder test script always fails; ignore it. Bare `vitest` would start watch mode.
        if let Some(t) = script("test").filter(|t| !t.contains("no test specified")) {
            let vitest_watch = t.contains("vitest") && !t.contains("run");
            cmds.push(if vitest_watch { format!("{pm} exec vitest run") } else { format!("{pm} test") });
        }
    }
    if has(ws, "Cargo.toml").await {
        cmds.push("cargo check --quiet".into());
    } else if has(ws, "src-tauri/Cargo.toml").await {
        cmds.push("cargo check --quiet --manifest-path src-tauri/Cargo.toml".into());
    }
    if has(ws, "go.mod").await {
        cmds.push("go test ./...".into());
    }
    let pytest = has(ws, "pytest.ini").await
        || has(ws, "conftest.py").await
        || read(ws, "pyproject.toml").await.map(|t| t.contains("[tool.pytest")).unwrap_or(false)
        || read(ws, "setup.cfg").await.map(|t| t.contains("[tool:pytest]")).unwrap_or(false);
    if pytest {
        cmds.push("python -m pytest -q".into());
    }
    cmds
}

pub struct CheckResult {
    pub command: String,
    pub code: i32,
    pub output: String,
    pub duration_ms: u64,
}

/// Runs one check command and keeps the tail of its output (where failures usually are).
pub async fn run(ws: &str, command: &str) -> CheckResult {
    let t0 = std::time::Instant::now();
    let (code, mut output) = match vfs::run_shell(ws, command, Duration::from_secs(600)).await {
        Ok(o) => {
            let mut s = o.stdout;
            if !o.stderr.trim().is_empty() {
                s.push('\n');
                s.push_str(&o.stderr);
            }
            (o.code, s)
        }
        Err(e) => (-1, e),
    };
    const TAIL: usize = 8000;
    if output.len() > TAIL {
        let mut cut = output.len() - TAIL;
        while !output.is_char_boundary(cut) {
            cut += 1;
        }
        output = format!("... [earlier output omitted]\n{}", &output[cut..]);
    }
    CheckResult { command: command.into(), code, output, duration_ms: t0.elapsed().as_millis() as u64 }
}
