//! Integrated browser: real child webviews ("browser-N") hosted inside the main window over a
//! Browser editor tab (Tauri multi-webview, `unstable` feature), console capture, DevTools, page
//! snapshots for "Share with Agent", and the agent's `browser` tool.
//!
//! Previewed pages get no IPC access to the app: the child webview loads remote origins, which the
//! Tauri ACL rejects for app commands. Console output is therefore *pulled*: an initialization
//! script buffers console/errors in the page and a poller drains it with `eval_with_callback`
//! (host-injected scripts are not subject to the page's CSP).

use crate::agent::providers::ToolDef;
use crate::browser_server;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewBuilder, WebviewUrl};
use tokio::sync::oneshot;

const MAX_CONSOLE: usize = 500;

#[derive(Serialize, Clone)]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub ts: f64,
}

#[derive(Default)]
struct Page {
    console: VecDeque<ConsoleEntry>,
    url: String,
    title: String,
}

#[derive(Default)]
struct Global {
    pages: HashMap<String, Page>,
    /// The browser tab the user looked at last: the one the agent tool acts on.
    active: Option<String>,
    /// Incremented on every finished page load (lets `open` wait for the navigation it caused).
    load_seq: u64,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

fn g() -> &'static Mutex<Global> {
    static G: OnceLock<Mutex<Global>> = OnceLock::new();
    G.get_or_init(Default::default)
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Only our own child webviews may be driven through these commands — never the IDE's own UI.
fn check_label(label: &str) -> Result<(), String> {
    if label.starts_with("browser-") && label.len() < 64 && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err(format!("Invalid browser label '{label}'"))
    }
}

fn app() -> Result<&'static AppHandle, String> {
    APP.get().ok_or_else(|| "The integrated browser is not initialised yet.".to_string())
}

fn webview(label: &str) -> Result<tauri::Webview, String> {
    check_label(label)?;
    app()?.get_webview(label).ok_or_else(|| "No browser preview is open. Use the browser tool's `open` action first.".to_string())
}

pub fn parse_url(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("Empty URL".into());
    }
    let lower = s.to_lowercase();
    let with_scheme = if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("about:") || lower.starts_with("file://") {
        s.to_string()
    } else if lower.starts_with("localhost") || lower.starts_with("127.") || lower.starts_with("0.0.0.0") || lower.starts_with("[::1]") {
        format!("http://{s}")
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| format!("Invalid URL '{s}': {e}"))?;
    // 0.0.0.0 is a bind address printed by dev servers; browsers should use loopback instead.
    if url.host_str() == Some("0.0.0.0") {
        let mut u = url.clone();
        let _ = u.set_host(Some("127.0.0.1"));
        return Ok(u);
    }
    Ok(url)
}

fn emit(ev: Value) {
    if let Some(a) = APP.get() {
        let _ = a.emit("browser-event", ev);
    }
}

fn push_console(label: &str, entries: Vec<ConsoleEntry>) {
    if entries.is_empty() {
        return;
    }
    {
        let mut st = g().lock().unwrap();
        let page = st.pages.entry(label.to_string()).or_default();
        for e in &entries {
            page.console.push_back(e.clone());
            if page.console.len() > MAX_CONSOLE {
                page.console.pop_front();
            }
        }
    }
    emit(json!({ "label": label, "kind": "console", "entries": entries }));
}

// ----------------------------------------------------------------------------------------------
// Page scripts
// ----------------------------------------------------------------------------------------------

/// Injected into every document of a preview webview before page scripts run.
const INIT_JS: &str = r#"(function(){
  if (window.__cepheus) return;
  var q = [];
  function fmt(a){
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (typeof Node !== 'undefined' && a instanceof Node) return '<' + (a.nodeName || '').toLowerCase() + '>';
      if (typeof a === 'object' && a !== null) return JSON.stringify(a).slice(0, 2000);
      return String(a);
    } catch (e) { return String(a); }
  }
  function push(level, args){
    var text = Array.prototype.map.call(args, fmt).join(' ');
    if (text.length > 4000) text = text.slice(0, 4000) + '…';
    q.push({ level: level, text: text, ts: Date.now() });
    if (q.length > 500) q.shift();
  }
  ['log','info','warn','error','debug'].forEach(function(l){
    var orig = console[l];
    console[l] = function(){ try { push(l, arguments); } catch (e) {} return orig.apply(this, arguments); };
  });
  window.addEventListener('error', function(e){
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) { push('error', ['Failed to load resource: ' + (t.src || t.href)]); return; }
    push('error', [(e.error && e.error.stack) || (e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : ''))]);
  }, true);
  window.addEventListener('unhandledrejection', function(e){ push('error', ['Unhandled promise rejection: ' + fmt(e.reason)]); });
  Object.defineProperty(window, '__cepheus', { enumerable: false, value: {
    drain: function(){ var out = q; q = []; return JSON.stringify({ u: location.href, t: document.title, l: out }); }
  }});
})();"#;

const DRAIN_JS: &str = "(function(){try{return window.__cepheus?window.__cepheus.drain():JSON.stringify({u:location.href,t:document.title,l:[]})}catch(e){return null}})()";

/// Shared helpers for read/click/type: element lookup (CSS selector or `text=...`) and description.
const HELPERS_JS: &str = r#"
function __desc(el){
  var s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
  ['href','src','type','name','placeholder','role','aria-label','alt','title','for'].forEach(function(a){
    var v = el.getAttribute(a);
    if (v != null && v !== '') { v = String(v); if (v.length > 60) v = v.slice(0, 60) + '…'; s += '[' + a + '="' + v + '"]'; }
  });
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.value) s += '[value="' + String(el.value).slice(0, 40) + '"]';
  if (el.disabled) s += '[disabled]';
  if (el.checked) s += '[checked]';
  return s;
}
function __find(sel){
  if (sel.indexOf('text=') === 0) {
    var want = sel.slice(5).trim().toLowerCase();
    var c = document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],label,summary,[onclick]');
    var i, t;
    for (i = 0; i < c.length; i++) { t = (c[i].innerText || c[i].value || '').trim().toLowerCase(); if (t === want) return c[i]; }
    for (i = 0; i < c.length; i++) { t = (c[i].innerText || c[i].value || '').trim().toLowerCase(); if (t.indexOf(want) >= 0) return c[i]; }
    return null;
  }
  return document.querySelector(sel);
}
"#;

const READ_JS: &str = r#"
var SKIP = {SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, META:1, LINK:1, HEAD:1};
var lines = [], MAX = 250;
function vis(el){ if (!el.getClientRects().length) return false; var s = getComputedStyle(el); return s.visibility !== 'hidden'; }
function own(el){
  var t = '';
  for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function walk(el, d){
  if (lines.length >= MAX || SKIP[el.tagName.toUpperCase()] || !vis(el)) return;
  var t = own(el), kids = el.children;
  // Collapse anonymous single-child wrappers to keep the outline compact.
  var anon = !el.id && !t && kids.length === 1 && !el.getAttribute('class') && !el.getAttribute('role') && /^(DIV|SPAN|SECTION)$/.test(el.tagName);
  if (!anon) { lines.push(new Array(Math.min(d, 20) + 1).join('  ') + __desc(el) + (t ? ' "' + t + '"' : '')); d++; }
  if (el.tagName.toLowerCase() === 'svg') return;
  for (var i = 0; i < kids.length; i++) walk(kids[i], d);
}
if (document.body) walk(document.body, 0);
if (lines.length >= MAX) lines.push('… (outline truncated)');
var text = (document.body ? document.body.innerText : '').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
return {url: location.href, title: document.title, w: innerWidth, h: innerHeight, text: text.slice(0, 6000), truncated: text.length > 6000, outline: lines.join('\n')};
"#;

const CLICK_JS: &str = r#"
var el = __find(SEL);
if (!el) return {error: 'No element matches ' + SEL};
el.scrollIntoView({block: 'center', inline: 'center'});
var r = el.getBoundingClientRect();
var o = {bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0};
if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerdown', o));
el.dispatchEvent(new MouseEvent('mousedown', o));
if (el.focus) el.focus();
if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', o));
el.dispatchEvent(new MouseEvent('mouseup', o));
el.click();
return {ok: 'Clicked ' + __desc(el)};
"#;

const TYPE_JS: &str = r#"
var el = __find(SEL);
if (!el) return {error: 'No element matches ' + SEL};
el.scrollIntoView({block: 'center'});
el.focus();
if (el.isContentEditable) {
  document.execCommand('selectAll', false);
  document.execCommand('insertText', false, TEXT);
} else if ('value' in el) {
  // Use the prototype setter so React/Vue controlled inputs notice the change.
  var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  var d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, TEXT); else el.value = TEXT;
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
} else {
  return {error: 'Element is not editable: ' + __desc(el)};
}
if (SUBMIT) {
  var k = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true};
  var go = el.dispatchEvent(new KeyboardEvent('keydown', k));
  el.dispatchEvent(new KeyboardEvent('keypress', k));
  el.dispatchEvent(new KeyboardEvent('keyup', k));
  if (go && el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
}
return {ok: 'Typed into ' + __desc(el) + (SUBMIT ? ' and pressed Enter' : '')};
"#;

/// Wraps a body (which `return`s a value) into a self-contained, exception-safe script.
fn script(body: &str) -> String {
    format!("(function(){{try{{{HELPERS_JS}\nvar __r=(function(){{{body}\n}})();return JSON.stringify(__r===undefined?null:__r)}}catch(e){{return JSON.stringify({{error:String(e&&e.stack||e)}})}}}})()")
}

// ----------------------------------------------------------------------------------------------
// Evaluation helpers
// ----------------------------------------------------------------------------------------------

async fn eval_raw(label: &str, js: String, timeout: Duration) -> Result<String, String> {
    let wv = webview(label)?;
    let (tx, rx) = oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    wv.eval_with_callback(js, move |res| {
        if let Some(t) = tx.lock().unwrap().take() {
            let _ = t.send(res);
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(s)) => Ok(s),
        Ok(Err(_)) => Err("Script evaluation was cancelled.".into()),
        Err(_) => Err("The page did not respond in time (still loading or busy?).".into()),
    }
}

/// Runs a script that returns `JSON.stringify(...)` and parses the result.
async fn eval_json(label: &str, js: String, timeout: Duration) -> Result<Value, String> {
    let raw = eval_raw(label, js, timeout).await?;
    match serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null) {
        Value::String(s) => serde_json::from_str(&s).map_err(|_| s),
        Value::Null => Err("The script produced no result (the page may be navigating).".into()),
        other => Ok(other),
    }
}

/// Drains the page's console buffer into our store and updates url/title.
async fn poll_once(label: &str) -> Result<(), String> {
    let v = eval_json(label, DRAIN_JS.to_string(), Duration::from_secs(2)).await?;
    let url = v.get("u").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let title = v.get("t").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let entries: Vec<ConsoleEntry> = v
        .get("l")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .map(|e| ConsoleEntry {
                    level: e.get("level").and_then(|x| x.as_str()).unwrap_or("log").to_string(),
                    text: e.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    ts: e.get("ts").and_then(|x| x.as_f64()).unwrap_or_else(now_ms),
                })
                .collect()
        })
        .unwrap_or_default();
    let changed = {
        let mut st = g().lock().unwrap();
        let page = st.pages.entry(label.to_string()).or_default();
        let changed = !url.is_empty() && (page.url != url || page.title != title);
        if changed {
            page.url = url.clone();
            page.title = title.clone();
        }
        changed
    };
    if changed {
        emit(json!({ "label": label, "kind": "state", "url": url, "title": title }));
    }
    push_console(label, entries);
    Ok(())
}

fn spawn_poller(label: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Some(a) = APP.get() else { break };
            if a.get_webview(&label).is_none() {
                break;
            }
            let _ = poll_once(&label).await;
        }
    });
}

// ----------------------------------------------------------------------------------------------
// Commands used by the Browser tab
// ----------------------------------------------------------------------------------------------

/// Called once by the frontend at startup.
#[tauri::command]
pub fn browser_init(app: AppHandle) {
    if APP.set(app.clone()).is_ok() {
        // With the multi-webview (`unstable`) runtime the main webview is created as a window
        // *child*, which skips attaching the frameless-window resize borders on Windows.
        // Re-asserting `resizable` attaches them again.
        if let Some(w) = app.get_window("main") {
            let _ = w.set_resizable(true);
        }
    }
}

/// Creates a preview webview at the given physical bounds (relative to the window client area).
/// Async on purpose: creating webviews from a sync command deadlocks on Windows.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_create(app: AppHandle, label: String, url: String, x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    check_label(&label)?;
    let _ = APP.set(app.clone());
    if app.get_webview(&label).is_some() {
        return Ok(());
    }
    let url = parse_url(&url)?;
    let window = app.get_window("main").ok_or("Main window not found")?;
    let nav_label = label.clone();
    let title_label = label.clone();
    let popup_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(INIT_JS)
        .devtools(true)
        // Don't steal keyboard focus from the editor (e.g. when the agent opens a page).
        .focused(false)
        .on_page_load(move |_wv, p| {
            let url = p.url().to_string();
            let started = matches!(p.event(), PageLoadEvent::Started);
            {
                let mut st = g().lock().unwrap();
                if !started {
                    st.load_seq += 1;
                }
                st.pages.entry(nav_label.clone()).or_default().url = url.clone();
            }
            if started {
                push_console(&nav_label, vec![ConsoleEntry { level: "nav".into(), text: format!("Navigated to {url}"), ts: now_ms() }]);
            }
            emit(json!({ "label": nav_label, "kind": "nav", "url": url, "loading": started }));
        })
        .on_document_title_changed(move |_wv, title| {
            let url = {
                let mut st = g().lock().unwrap();
                let page = st.pages.entry(title_label.clone()).or_default();
                page.title = title.clone();
                page.url.clone()
            };
            emit(json!({ "label": title_label, "kind": "state", "url": url, "title": title }));
        })
        // target=_blank / window.open: keep the user inside the preview instead of a popup window.
        .on_new_window(move |url, _features| {
            let label = popup_label.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(wv) = webview(&label) {
                    let _ = wv.navigate(url);
                }
            });
            NewWindowResponse::Deny
        });
    let wv = window
        .add_child(builder, PhysicalPosition::new(x.round() as i32, y.round() as i32), PhysicalSize::new(w.max(1.0).round() as u32, h.max(1.0).round() as u32))
        .map_err(|e| format!("Could not create the browser view: {e}"))?;
    if !visible {
        let _ = wv.hide();
    }
    {
        let mut st = g().lock().unwrap();
        st.pages.entry(label.clone()).or_default();
        if visible || st.active.is_none() {
            st.active = Some(label.clone());
        }
    }
    spawn_poller(label);
    Ok(())
}

/// Keeps the native webview glued to the tab's placeholder element (physical pixels).
#[tauri::command]
pub fn browser_set_bounds(label: String, x: f64, y: f64, w: f64, h: f64, visible: bool) -> Result<(), String> {
    let wv = webview(&label)?;
    if visible && w >= 1.0 && h >= 1.0 {
        wv.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32)).map_err(|e| e.to_string())?;
        wv.set_size(PhysicalSize::new(w.round() as u32, h.round() as u32)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        g().lock().unwrap().active = Some(label);
    } else {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(label: String, url: String) -> Result<String, String> {
    let wv = webview(&label)?;
    let url = parse_url(&url)?;
    let s = url.to_string();
    wv.navigate(url).map_err(|e| e.to_string())?;
    Ok(s)
}

/// back | forward | reload | stop
#[tauri::command]
pub fn browser_history(label: String, action: String) -> Result<(), String> {
    let wv = webview(&label)?;
    match action.as_str() {
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "stop" => wv.eval("window.stop()"),
        _ => wv.reload(),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_close(label: String) -> Result<(), String> {
    check_label(&label)?;
    if let Ok(wv) = webview(&label) {
        let _ = wv.close();
    }
    let mut st = g().lock().unwrap();
    st.pages.remove(&label);
    if st.active.as_deref() == Some(label.as_str()) {
        st.active = st.pages.keys().next().cloned();
    }
    Ok(())
}

/// Toggles the WebView2 DevTools window for the preview; returns whether it is now open.
#[tauri::command]
pub fn browser_devtools(label: String) -> Result<bool, String> {
    let wv = webview(&label)?;
    if wv.is_devtools_open() {
        wv.close_devtools();
        Ok(false)
    } else {
        wv.open_devtools();
        Ok(true)
    }
}

#[tauri::command]
pub fn browser_console(label: String) -> Vec<ConsoleEntry> {
    g().lock().unwrap().pages.get(&label).map(|p| p.console.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
pub fn browser_clear_console(label: String) {
    if let Some(p) = g().lock().unwrap().pages.get_mut(&label) {
        p.console.clear();
    }
}

/// Text snapshot of the page (URL, title, visible text, DOM outline, console problems).
#[tauri::command]
pub async fn browser_snapshot(label: String) -> Result<String, String> {
    let _ = poll_once(&label).await;
    read_page(&label).await
}

/// Serves a local folder over http://127.0.0.1:<port>/ and returns the port.
#[tauri::command]
pub async fn browser_serve(root: String) -> Result<u16, String> {
    if root.starts_with("ssh://") {
        return Err("Preview of remote (SSH) workspaces is not supported yet.".into());
    }
    browser_server::serve(Path::new(&root)).await
}

// ----------------------------------------------------------------------------------------------
// Page reading
// ----------------------------------------------------------------------------------------------

fn console_summary(label: &str, since: Option<f64>, limit: usize) -> String {
    let st = g().lock().unwrap();
    let Some(page) = st.pages.get(label) else { return String::new() };
    let items: Vec<&ConsoleEntry> = page
        .console
        .iter()
        .filter(|e| since.is_none_or(|s| e.ts >= s))
        .filter(|e| e.level != "nav")
        .collect();
    let skip = items.len().saturating_sub(limit);
    items[skip..]
        .iter()
        .map(|e| format!("[{}] {}", e.level, e.text.chars().take(600).collect::<String>()))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn read_page(label: &str) -> Result<String, String> {
    let v = eval_json(label, script(READ_JS), Duration::from_secs(8)).await?;
    if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
        return Err(format!("Reading the page failed: {e}"));
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut out = format!(
        "URL: {}\nTitle: {}\nViewport: {}x{}\n\n## Visible text\n{}{}\n\n## DOM outline (tag#id.class[attrs] \"text\")\n{}\n",
        s("url"),
        s("title"),
        v.get("w").and_then(|x| x.as_u64()).unwrap_or(0),
        v.get("h").and_then(|x| x.as_u64()).unwrap_or(0),
        s("text"),
        if v.get("truncated").and_then(|x| x.as_bool()).unwrap_or(false) { "\n… (text truncated)" } else { "" },
        s("outline"),
    );
    let console = console_summary(label, None, 40);
    out.push_str("\n## Console (most recent last)\n");
    out.push_str(if console.is_empty() { "(no console output)" } else { &console });
    Ok(out)
}

fn active_label() -> Result<String, String> {
    let st = g().lock().unwrap();
    st.active
        .clone()
        .filter(|l| st.pages.contains_key(l))
        .or_else(|| st.pages.keys().next().cloned())
        .ok_or_else(|| "No browser preview is open. Use the browser tool's `open` action first.".to_string())
}

// ----------------------------------------------------------------------------------------------
// Agent tool
// ----------------------------------------------------------------------------------------------

pub fn tool_def() -> ToolDef {
    ToolDef {
        name: "browser",
        description: "Control the IDE's integrated browser preview to verify web UI changes. Actions: \
`open` (url: http(s) URL such as http://localhost:5173, or a workspace-relative .html file which is served locally; \
returns a page snapshot), `read` (visible text, compact DOM outline and console output of the current page), \
`click` (selector: CSS selector or `text=Button label`), `type` (selector + text, optional submit=true to press Enter), \
`eval` (js: JavaScript expression or statements with `return`, run in the page; async allowed). \
Only the preview page is affected, never the IDE itself. Start dev servers yourself only if they are not running; \
the user usually has one in a terminal.",
        schema: json!({"type": "object", "properties": {
            "action": {"type": "string", "enum": ["open", "read", "click", "type", "eval"]},
            "url": {"type": "string", "description": "For open: URL or workspace-relative HTML file"},
            "selector": {"type": "string", "description": "For click/type: CSS selector, or text=<visible label>"},
            "text": {"type": "string", "description": "For type: text to enter (replaces the field's value)"},
            "submit": {"type": "boolean", "description": "For type: press Enter / submit the form afterwards"},
            "js": {"type": "string", "description": "For eval: code to run in the page"}
        }, "required": ["action"]}),
    }
}

/// Reading is free; acting on the page needs approval like other side effects.
pub fn needs_approval(name: &str, args: &Value, mode: &str) -> bool {
    if name != "browser" {
        return false;
    }
    let action = args.get("action").and_then(|v| v.as_str()).unwrap_or("");
    match mode {
        "turbo" => false,
        "auto-edit" => action == "eval",
        _ => matches!(action, "click" | "type" | "eval"),
    }
}

fn arg<'a>(args: &'a Value, k: &str) -> Result<&'a str, String> {
    args.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).ok_or_else(|| format!("Missing required argument '{k}'"))
}

/// Turns the agent's `url` into something loadable: URLs pass through, workspace files get served.
async fn agent_url(ws: &str, raw: &str) -> Result<String, String> {
    let s = raw.trim();
    let lower = s.to_lowercase();
    let looks_like_url = lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("localhost") || lower.starts_with("127.") || lower.starts_with("0.0.0.0");
    if !looks_like_url && !crate::vfs::is_remote(ws) {
        if let Ok(p) = crate::agent::tools::resolve(ws, s) {
            let path = Path::new(&p);
            if path.is_file() || path.is_dir() {
                let port = browser_server::serve(Path::new(ws)).await?;
                let rel = path.strip_prefix(ws).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                return Ok(format!("http://127.0.0.1:{port}/{}", browser_server::encode_path(rel.trim_start_matches('/'))));
            }
        }
    }
    Ok(parse_url(s)?.to_string())
}

async fn wait_load(after_seq: u64, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if g().lock().unwrap().load_seq > after_seq {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Result of a click/type: what happened plus where the page is now and any new errors.
async fn after_action(label: &str, msg: String, started: f64) -> String {
    tokio::time::sleep(Duration::from_millis(700)).await;
    let _ = poll_once(label).await;
    let (url, title) = {
        let st = g().lock().unwrap();
        st.pages.get(label).map(|p| (p.url.clone(), p.title.clone())).unwrap_or_default()
    };
    let console = console_summary(label, Some(started), 30);
    format!(
        "{msg}\nNow at: {url} ({title})\nConsole since the action:\n{}\nUse action `read` to see the updated page.",
        if console.is_empty() { "(nothing)".to_string() } else { console }
    )
}

pub async fn agent_tool(ws: &str, args: &Value) -> Result<String, String> {
    let action = arg(args, "action")?;
    match action {
        "open" => {
            let url = agent_url(ws, arg(args, "url")?).await?;
            let a = app()?;
            let seq = g().lock().unwrap().load_seq;
            // The frontend owns tab layout: it opens/focuses a Browser tab and navigates it.
            a.emit("browser-open-request", json!({ "url": url })).map_err(|e| e.to_string())?;
            if !wait_load(seq, Duration::from_secs(25)).await {
                return Err(format!("Timed out waiting for {url} to load. Is the server running?"));
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
            let label = active_label()?;
            let _ = poll_once(&label).await;
            let page = read_page(&label).await?;
            Ok(truncate(format!("Opened {url} in the IDE browser.\n\n{page}")))
        }
        "read" => {
            let label = active_label()?;
            let _ = poll_once(&label).await;
            Ok(truncate(read_page(&label).await?))
        }
        "click" | "type" => {
            let label = active_label()?;
            let sel = serde_json::to_string(arg(args, "selector")?).unwrap();
            // Arguments become JSON literals declared ahead of the fixed script (no string splicing).
            let body = if action == "click" {
                format!("var SEL={sel};{CLICK_JS}")
            } else {
                let text = serde_json::to_string(args.get("text").and_then(|v| v.as_str()).unwrap_or("")).unwrap();
                let submit = args.get("submit").and_then(|v| v.as_bool()).unwrap_or(false);
                format!("var SEL={sel},TEXT={text},SUBMIT={submit};{TYPE_JS}")
            };
            let started = now_ms();
            let v = eval_json(&label, script(&body), Duration::from_secs(8)).await?;
            if let Some(e) = v.get("error").and_then(|x| x.as_str()) {
                return Err(e.to_string());
            }
            let msg = v.get("ok").and_then(|x| x.as_str()).unwrap_or("Done").to_string();
            Ok(after_action(&label, msg, started).await)
        }
        "eval" => {
            let label = active_label()?;
            let started = now_ms();
            let (result, is_err) = eval_user(&label, arg(args, "js")?).await?;
            let console = console_summary(&label, Some(started), 30);
            let mut out = if is_err { format!("Error: {result}") } else { format!("Result: {result}") };
            if !console.is_empty() {
                out.push_str("\nConsole:\n");
                out.push_str(&console);
            }
            if is_err {
                Err(truncate(out))
            } else {
                Ok(truncate(out))
            }
        }
        other => Err(format!("Unknown browser action '{other}'. Use open, read, click, type or eval.")),
    }
}

fn truncate(mut s: String) -> String {
    let max = crate::agent::tools::MAX_OUTPUT;
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
        s.push_str("\n... [truncated]");
    }
    s
}

/// Runs agent JS in the page and awaits its (possibly async) result. The code is spliced into the
/// script text rather than passed to `eval()`, so pages with a strict CSP still allow it. It is
/// first tried as an expression, then (if that does not parse) as a statement body.
async fn eval_user(label: &str, code: &str) -> Result<(String, bool), String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let expr = code.trim().trim_end_matches(';');
    let launch = |body: String| {
        format!(
            "(function(){{var K='{id}';window.__cxp=window.__cxp||{{}};window.__cxp[K]={{p:1}};\
function ser(v){{try{{if(v===undefined)return 'undefined';if(typeof Element!=='undefined'&&v instanceof Element)return v.outerHTML.slice(0,4000);\
if(typeof v==='string')return v;var s=JSON.stringify(v,null,1);return s===undefined?String(v):s}}catch(e){{return String(v)}}}}\
Promise.resolve().then(async function(){{\n{body}\n}}).then(function(v){{window.__cxp[K]={{d:1,v:ser(v)}}}},function(e){{window.__cxp[K]={{d:1,e:String(e&&e.stack||e)}}}});\
return JSON.stringify('started')}})()"
        )
    };
    let mut started = false;
    for body in [format!("return (\n{expr}\n);"), code.to_string()] {
        if let Ok(Value::String(s)) = eval_json(label, launch(body), Duration::from_secs(5)).await {
            if s == "started" {
                started = true;
                break;
            }
        }
    }
    if !started {
        return Ok(("SyntaxError: the script could not be parsed (or the page is navigating).".into(), true));
    }
    let poll = format!("(function(){{var r=window.__cxp&&window.__cxp['{id}'];if(r&&r.d)delete window.__cxp['{id}'];return JSON.stringify(r||null)}})()");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match eval_json(label, poll.clone(), Duration::from_secs(3)).await {
            Ok(v) if v.get("d").is_some() => {
                if let Some(e) = v.get("e").and_then(|x| x.as_str()) {
                    return Ok((e.to_string(), true));
                }
                return Ok((v.get("v").and_then(|x| x.as_str()).unwrap_or("undefined").to_string(), false));
            }
            Ok(_) => {}
            Err(e) if e.contains("navigating") => return Ok(("The page navigated before the script finished.".into(), false)),
            Err(_) => {}
        }
    }
    Ok(("Timed out after 20s waiting for the script's result.".into(), true))
}
