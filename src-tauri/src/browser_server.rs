//! Tiny static file server used by the integrated browser to preview workspace HTML files.
//! Binds 127.0.0.1 on a random port, serves GET/HEAD only, never leaves the served root.
//! Deliberately std + tokio only (no HTTP crate) so it can also be unit-tested standalone.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn servers() -> &'static Mutex<HashMap<String, u16>> {
    static S: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn root_key(root: &Path) -> String {
    root.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Starts (or reuses) a server for `root` and returns its port.
pub async fn serve(root: &Path) -> Result<u16, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("Cannot serve {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let key = root_key(&root);
    if let Some(p) = servers().lock().unwrap().get(&key) {
        return Ok(*p);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    servers().lock().unwrap().insert(key, port);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let root = root.clone();
            tokio::spawn(async move {
                let _ = handle(stream, &root).await;
            });
        }
    });
    Ok(port)
}

async fn handle(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    // Read the request head only; we never accept bodies.
    loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return respond(&mut stream, 431, "text/plain", b"Request header too large", false).await;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let is_head = method == "HEAD";
    if method != "GET" && !is_head {
        return respond(&mut stream, 405, "text/plain", b"Method not allowed", is_head).await;
    }
    let Some(url_path) = decode_path(target) else {
        return respond(&mut stream, 400, "text/plain", b"Bad request", is_head).await;
    };
    let Some(file) = resolve(root, &url_path) else {
        return respond(&mut stream, 403, "text/plain", b"Forbidden", is_head).await;
    };
    if file.is_dir() {
        if !url_path.ends_with('/') {
            let loc = format!("{}/", url_path);
            let msg = format!(
                "HTTP/1.1 301 Moved Permanently\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                encode_path(&loc)
            );
            return stream.write_all(msg.as_bytes()).await;
        }
        let index = file.join("index.html");
        if index.is_file() {
            return send_file(&mut stream, &index, is_head).await;
        }
        let html = listing(&file, &url_path);
        return respond(&mut stream, 200, "text/html; charset=utf-8", html.as_bytes(), is_head).await;
    }
    if file.is_file() {
        return send_file(&mut stream, &file, is_head).await;
    }
    let body = format!("<!doctype html><title>404</title><p>Not found: {}</p>", html_escape(&url_path));
    respond(&mut stream, 404, "text/html; charset=utf-8", body.as_bytes(), is_head).await
}

async fn send_file(stream: &mut TcpStream, file: &Path, is_head: bool) -> std::io::Result<()> {
    match tokio::fs::read(file).await {
        Ok(bytes) => respond(stream, 200, mime_for(file), &bytes, is_head).await,
        Err(_) => respond(stream, 500, "text/plain", b"Cannot read file", is_head).await,
    }
}

async fn respond(stream: &mut TcpStream, code: u16, ctype: &str, body: &[u8], is_head: bool) -> std::io::Result<()> {
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    // no-store: previews must always reflect the file on disk (live reload).
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !is_head {
        stream.write_all(body).await?;
    }
    stream.flush().await
}

/// Request target -> decoded URL path ("/a b/c.html"), dropping query and fragment.
pub fn decode_path(target: &str) -> Option<String> {
    let path = target.split(['?', '#']).next().unwrap_or("/");
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let s = String::from_utf8(out).ok()?;
    if s.contains('\0') {
        return None;
    }
    Some(s)
}

/// Maps a URL path onto the root; None if it would escape it (.., drive prefixes, symlinks out).
pub fn resolve(root: &Path, url_path: &str) -> Option<PathBuf> {
    let mut p = root.to_path_buf();
    for seg in url_path.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." || seg.contains(':') {
            return None;
        }
        let comp = Path::new(seg);
        if comp.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        p.push(seg);
    }
    // Symlinks/junctions could point outside the root: check the canonical target when it exists.
    if let Ok(real) = std::fs::canonicalize(&p) {
        let root_real = std::fs::canonicalize(root).ok()?;
        if !real.starts_with(&root_real) {
            return None;
        }
    }
    Some(p)
}

pub fn encode_path(p: &str) -> String {
    let mut out = String::new();
    for b in p.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn listing(dir: &Path, url_path: &str) -> String {
    let mut names: Vec<(bool, String)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| (e.path().is_dir(), e.file_name().to_string_lossy().to_string()))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let mut html = format!(
        "<!doctype html><meta charset=utf-8><title>Index of {0}</title><style>body{{font:14px system-ui;margin:24px}}a{{text-decoration:none}}li{{margin:2px 0}}</style><h3>Index of {0}</h3><ul>",
        html_escape(url_path)
    );
    if url_path != "/" {
        html.push_str("<li><a href=\"../\">../</a></li>");
    }
    for (is_dir, n) in names {
        let shown = if is_dir { format!("{n}/") } else { n.clone() };
        html.push_str(&format!("<li><a href=\"{}\">{}</a></li>", encode_path(&shown), html_escape(&shown)));
    }
    html.push_str("</ul>");
    html
}

pub fn mime_for(p: &Path) -> &'static str {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}
