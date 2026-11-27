//! Settings Sync storage: one private GitHub Gist holding `cepheus-sync.json`, accessed with the
//! GitHub token the user already saved. What goes into the payload is decided by the frontend;
//! secrets are stripped here again before anything is uploaded.

use crate::proc_util::err;
use serde::Serialize;
use serde_json::{json, Value};

const DESCRIPTION: &str = "Cepheus Settings Sync";
const FILE: &str = "cepheus-sync.json";
const API: &str = "https://api.github.com";

fn client() -> Result<reqwest::Client, String> {
    crate::net::builder()
        .user_agent("CepheusIDE")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(err)
}

fn req(c: &reqwest::Client, method: reqwest::Method, url: &str, token: &str) -> Result<reqwest::RequestBuilder, String> {
    if token.trim().is_empty() {
        return Err("Sign in to GitHub first (GitHub panel) — Settings Sync stores your data in a private Gist.".into());
    }
    Ok(c.request(method, url)
        .bearer_auth(token.trim())
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28"))
}

async fn check(r: reqwest::Response) -> Result<Value, String> {
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("request failed");
        return Err(match status.as_u16() {
            401 => "GitHub rejected the token. Sign in again in the GitHub panel.".into(),
            403 | 404 => format!("GitHub: {msg}. The token needs the \"gist\" scope."),
            _ => format!("GitHub {status}: {msg}"),
        });
    }
    Ok(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    gist_id: String,
    updated_at: String,
    content: Option<String>,
}

async fn find_gist(c: &reqwest::Client, token: &str) -> Result<Option<String>, String> {
    for page in 1..=5 {
        let v = check(req(c, reqwest::Method::GET, &format!("{API}/gists?per_page=100&page={page}"), token)?.send().await.map_err(err)?).await?;
        let Some(list) = v.as_array() else { break };
        if let Some(g) = list.iter().find(|g| g.get("description").and_then(|d| d.as_str()) == Some(DESCRIPTION) && g.pointer(&format!("/files/{FILE}")).is_some()) {
            return Ok(g.get("id").and_then(|i| i.as_str()).map(String::from));
        }
        if list.len() < 100 {
            break;
        }
    }
    Ok(None)
}

/// Fetches the sync gist (by id, or found by its description). `None` when none exists yet.
#[tauri::command]
pub async fn sync_fetch(token: String, gist_id: Option<String>) -> Result<Option<Remote>, String> {
    let c = client()?;
    let id = match gist_id.filter(|g| !g.is_empty()) {
        Some(id) => id,
        None => match find_gist(&c, &token).await? {
            Some(id) => id,
            None => return Ok(None),
        },
    };
    let r = req(&c, reqwest::Method::GET, &format!("{API}/gists/{id}"), &token)?.send().await.map_err(err)?;
    if r.status().as_u16() == 404 {
        return Ok(None);
    }
    let v = check(r).await?;
    let file = v.pointer(&format!("/files/{FILE}"));
    let mut content = file.and_then(|f| f.get("content")).and_then(|c| c.as_str()).map(String::from);
    if file.and_then(|f| f.get("truncated")).and_then(|t| t.as_bool()) == Some(true) {
        if let Some(raw) = file.and_then(|f| f.get("raw_url")).and_then(|u| u.as_str()) {
            content = Some(req(&c, reqwest::Method::GET, raw, &token)?.send().await.map_err(err)?.text().await.map_err(err)?);
        }
    }
    Ok(Some(Remote {
        gist_id: id,
        updated_at: v.get("updated_at").and_then(|u| u.as_str()).unwrap_or("").into(),
        content,
    }))
}

/// Creates or updates the private sync gist. Returns the gist id and its new `updated_at`.
#[tauri::command]
pub async fn sync_push(token: String, gist_id: Option<String>, content: String) -> Result<Remote, String> {
    let mut v: Value = serde_json::from_str(&content).map_err(|e| format!("Invalid sync payload: {e}"))?;
    crate::profiles::strip_secrets(&mut v);
    let body_text = serde_json::to_string_pretty(&v).map_err(err)?;
    let c = client()?;
    let files = json!({ FILE: { "content": body_text } });
    let resp = match gist_id.filter(|g| !g.is_empty()) {
        Some(id) => req(&c, reqwest::Method::PATCH, &format!("{API}/gists/{id}"), &token)?.json(&json!({ "files": files })).send().await,
        None => req(&c, reqwest::Method::POST, &format!("{API}/gists"), &token)?
            .json(&json!({ "description": DESCRIPTION, "public": false, "files": files }))
            .send()
            .await,
    }
    .map_err(|e| format!("Cannot reach GitHub: {e}"))?;
    let v = check(resp).await?;
    Ok(Remote {
        gist_id: v.get("id").and_then(|i| i.as_str()).unwrap_or("").into(),
        updated_at: v.get("updated_at").and_then(|u| u.as_str()).unwrap_or("").into(),
        content: None,
    })
}
