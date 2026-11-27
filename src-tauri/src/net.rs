//! Shared HTTP client setup: proxy and extra trusted CA certificates for every backend request.
//! Build clients with `crate::net::builder()` instead of `reqwest::Client::builder()`.
//!
//! The values come from the user's settings (via `net_configure`) and the organization policy,
//! which always wins. The proxy is also exported as HTTP(S)_PROXY / NO_PROXY so child processes
//! (git, docker, language servers) use it too.

use crate::proc_util::err;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

#[derive(Default, Clone)]
struct NetState {
    http: String,
    https: String,
    no_proxy: String,
    certs: Vec<reqwest::Certificate>,
}

static STATE: RwLock<Option<NetState>> = RwLock::new(None);
/// Whether we exported proxy variables (so clearing the setting removes them again).
static ENV_SET: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct NetConfig {
    pub http: String,
    pub https: String,
    pub no_proxy: String,
    pub trusted_certificates: Vec<String>,
}

fn effective(user: NetConfig) -> NetConfig {
    let p = crate::policy::get();
    let mut c = user;
    if let Some(px) = &p.proxy {
        c.http = px.http.clone();
        c.https = px.https.clone();
        c.no_proxy = px.no_proxy.clone();
    }
    // Policy certificates are added to (not replacing) the user's.
    for cert in &p.trusted_certificates {
        if !c.trusted_certificates.contains(cert) {
            c.trusted_certificates.push(cert.clone());
        }
    }
    c
}

fn load_certs(paths: &[String]) -> (Vec<reqwest::Certificate>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for p in paths.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        match std::fs::read(p) {
            Ok(bytes) => match reqwest::Certificate::from_pem_bundle(&bytes) {
                Ok(c) if !c.is_empty() => out.extend(c),
                Ok(_) => errors.push(format!("{p}: no certificates found")),
                Err(e) => errors.push(format!("{p}: {e}")),
            },
            Err(e) => errors.push(format!("{p}: {e}")),
        }
    }
    (out, errors)
}

fn apply(cfg: NetConfig) -> Vec<String> {
    let (certs, errors) = load_certs(&cfg.trusted_certificates);
    let set_env = |k: &str, v: &str| {
        if v.trim().is_empty() {
            std::env::remove_var(k);
        } else {
            std::env::set_var(k, v.trim());
        }
    };
    // Only touch the environment when a proxy is configured here, so a system-wide
    // HTTPS_PROXY the user already has keeps working.
    let configured = !cfg.http.trim().is_empty() || !cfg.https.trim().is_empty();
    if configured || ENV_SET.load(Ordering::SeqCst) {
        set_env("HTTP_PROXY", &cfg.http);
        set_env("HTTPS_PROXY", if cfg.https.trim().is_empty() { &cfg.http } else { &cfg.https });
        set_env("NO_PROXY", &cfg.no_proxy);
    }
    ENV_SET.store(configured, Ordering::SeqCst);
    *STATE.write().unwrap() = Some(NetState { http: cfg.http, https: cfg.https, no_proxy: cfg.no_proxy, certs });
    errors
}

fn state() -> NetState {
    if let Some(s) = STATE.read().unwrap().clone() {
        return s;
    }
    // Not configured from the UI yet: apply policy values alone.
    apply(effective(NetConfig::default()));
    STATE.read().unwrap().clone().unwrap_or_default()
}

/// A reqwest builder with the configured proxy and CA certificates.
pub fn builder() -> reqwest::ClientBuilder {
    let s = state();
    let mut b = reqwest::Client::builder();
    let no_proxy = reqwest::NoProxy::from_string(&s.no_proxy);
    if !s.http.trim().is_empty() {
        if let Ok(p) = reqwest::Proxy::http(s.http.trim()) {
            b = b.proxy(p.no_proxy(no_proxy.clone()));
        }
    }
    let https = if s.https.trim().is_empty() { s.http.trim() } else { s.https.trim() };
    if !https.is_empty() {
        if let Ok(p) = reqwest::Proxy::https(https) {
            b = b.proxy(p.no_proxy(no_proxy));
        }
    }
    for c in s.certs {
        b = b.add_root_certificate(c);
    }
    b
}

/// The HTTPS proxy URL, for libraries that take a proxy directly (the updater).
pub fn https_proxy() -> Option<String> {
    let s = state();
    let u = if s.https.trim().is_empty() { s.http } else { s.https };
    Some(u.trim().to_string()).filter(|u| !u.is_empty())
}

/// Applies the user's network settings (merged with policy). Returns certificate load errors.
#[tauri::command]
pub fn net_configure(config: NetConfig) -> Result<Vec<String>, String> {
    let cfg = effective(config);
    for u in [&cfg.http, &cfg.https].into_iter().filter(|u| !u.trim().is_empty()) {
        reqwest::Proxy::all(u.trim()).map_err(|e| format!("Invalid proxy URL '{u}': {e}"))?;
    }
    Ok(apply(cfg))
}

#[allow(dead_code)]
pub fn client() -> Result<reqwest::Client, String> {
    builder().build().map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_cert_paths_are_reported() {
        let (c, e) = load_certs(&["Z:/definitely/missing.pem".into(), "".into()]);
        assert!(c.is_empty());
        assert_eq!(e.len(), 1);
    }

    #[test]
    fn builder_with_proxy_builds() {
        *STATE.write().unwrap() = Some(NetState { http: "http://127.0.0.1:3128".into(), no_proxy: "localhost".into(), ..Default::default() });
        assert!(builder().build().is_ok());
        assert_eq!(https_proxy().as_deref(), Some("http://127.0.0.1:3128"));
    }
}
