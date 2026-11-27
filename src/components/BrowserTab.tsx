import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore, toast, Tab } from "../store";
import { errMsg } from "../lib/api";
import { Bounds, browserApi, dismissDetected, labelFor, normalizeUrl, openBrowser, patchPage, shareWithAgent, useBrowser } from "../lib/browser";

const DEVICES = [
  { id: "fill", label: "Responsive", w: 0, h: 0 },
  { id: "se", label: "Phone S · 375×667", w: 375, h: 667 },
  { id: "phone", label: "Phone · 390×844", w: 390, h: 844 },
  { id: "tablet", label: "Tablet · 768×1024", w: 768, h: 1024 },
  { id: "laptop", label: "Laptop · 1280×800", w: 1280, h: 800 },
  { id: "desktop", label: "Desktop · 1920×1080", w: 1920, h: 1080 },
];

// HTML overlays (menus, modals, palette) must stay visible: the native webview always paints above
// the app's DOM, so it is hidden while anything covers its area.
const OVERLAYS = ".overlay, .ctx-menu, .menu-dropdown, .inline-edit, .modal, .palette";
function isCovered(el: HTMLElement, r: DOMRect): boolean {
  for (const o of document.querySelectorAll<HTMLElement>(OVERLAYS)) {
    if (el.contains(o)) continue;
    const b = o.getBoundingClientRect();
    if (b.width && b.height && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) return true;
  }
  // Catch-all for popups we don't know by class: sample a grid of points.
  for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
    for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
      const hit = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (hit && !el.contains(hit) && !hit.closest(".toasts")) return true;
    }
  }
  return false;
}

// Create/close calls per webview run strictly in order (React StrictMode mounts effects twice).
const chains = new Map<string, Promise<unknown>>();
function queue(label: string, fn: () => Promise<unknown> | void) {
  const p = (chains.get(label) ?? Promise.resolve()).then(fn);
  chains.set(label, p.catch(() => {}));
  return p;
}

export default function BrowserTab({ tab, visible }: { tab: Tab; visible: boolean }) {
  const label = labelFor(tab.id);
  const page = useBrowser((s) => s.pages[label]);
  const uiZoom = useStore((s) => s.settings.uiZoom) || 1;
  const [address, setAddress] = useState(tab.path);
  const [editing, setEditing] = useState(false);
  const [device, setDevice] = useState("fill");
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const url = page?.url || tab.path;

  useEffect(() => {
    if (!editing) setAddress(url);
  }, [url, editing]);

  // Empty tab (Browser: Open URL…): focus the address bar.
  useEffect(() => {
    if (!tab.path && visible) inputRef.current?.focus();
  }, []);

  // Create the native webview once and keep it glued to the placeholder.
  useLayoutEffect(() => {
    let created = false;
    let disposed = false;
    let last = "";
    const measure = (): Bounds => {
      const el = viewRef.current;
      const r = el?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const show = !!el && !!r && visibleRef.current && r.width > 2 && r.height > 2 && !isCovered(el, r);
      return r
        ? { x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr, visible: show }
        : { x: 0, y: 0, w: 1, h: 1, visible: false };
    };
    const sync = () => {
      if (!created || disposed) return;
      const b = measure();
      const key = b.visible ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}` : "hidden";
      if (key === last) return;
      last = key;
      browserApi.setBounds(label, b).catch(() => {});
    };
    patchPage(label, { url: tab.path, loading: !!tab.path });
    queue(label, async () => {
      if (disposed) return;
      const b = measure();
      // Latest URL: openBrowser() may have updated the tab while it was mounting.
      const path = useStore.getState().tabs.find((t) => t.id === tab.id)?.path || tab.path;
      await browserApi.create(label, path || "about:blank", b);
      created = true;
      last = b.visible ? "" : "hidden";
      sync();
    }).catch((e) => toast(errMsg(e), "error"));
    const timer = window.setInterval(sync, 120);
    const ro = new ResizeObserver(sync);
    if (viewRef.current) ro.observe(viewRef.current);
    window.addEventListener("resize", sync);
    return () => {
      disposed = true;
      clearInterval(timer);
      ro.disconnect();
      window.removeEventListener("resize", sync);
      queue(label, () => (created ? browserApi.close(label) : undefined)).catch(() => {});
      useBrowser.setState((s) => {
        const pages = { ...s.pages };
        delete pages[label];
        return { pages };
      });
    };
  }, [label]);

  const go = async (raw: string) => {
    const target = normalizeUrl(raw);
    setEditing(false);
    setAddress(target);
    try {
      await browserApi.navigate(label, target);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const hist = (a: "back" | "forward" | "reload" | "stop") => browserApi.history(label, a).catch((e) => toast(errMsg(e), "error"));
  const dev = DEVICES.find((d) => d.id === device)!;
  const errors = page?.console.filter((c) => c.level === "error").length ?? 0;

  return (
    <div className="browser-tab" style={{ display: visible ? "flex" : "none" }}>
      <div className="browser-bar">
        <button className="icon-btn" title="Back" onClick={() => hist("back")}><i className="codicon codicon-arrow-left" /></button>
        <button className="icon-btn" title="Forward" onClick={() => hist("forward")}><i className="codicon codicon-arrow-right" /></button>
        {page?.loading ? (
          <button className="icon-btn" title="Stop" onClick={() => hist("stop")}><i className="codicon codicon-close" /></button>
        ) : (
          <button className="icon-btn" title="Reload" onClick={() => hist("reload")}><i className="codicon codicon-refresh" /></button>
        )}
        <form className="browser-address" onSubmit={(e) => { e.preventDefault(); go(address); }}>
          <i className={`codicon codicon-${page?.loading ? "loading codicon-modifier-spin" : /^https:/.test(url) ? "lock" : "globe"}`} />
          <input
            ref={inputRef}
            value={address}
            spellCheck={false}
            placeholder="Enter a URL, e.g. localhost:5173"
            onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setAddress(url); e.currentTarget.blur(); } }}
          />
        </form>
        <select className="browser-device" value={device} onChange={(e) => setDevice(e.target.value)} title="Device size">
          {DEVICES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <button className={`icon-btn ${consoleOpen ? "on" : ""}`} title="Console" onClick={() => setConsoleOpen((o) => !o)}>
          <i className="codicon codicon-debug-console" />
          {errors > 0 && <span className="browser-badge">{errors}</span>}
        </button>
        <button className="icon-btn" title="Inspect (DevTools)" onClick={() => browserApi.devtools(label).catch((e) => toast(errMsg(e), "error"))}><i className="codicon codicon-inspect" /></button>
        <button className="icon-btn" title="Share page with Agent" onClick={() => setShare((s) => (s === null ? "" : null))}><i className="codicon codicon-hubot" /></button>
        <button className="icon-btn" title="Open in external browser" onClick={() => url && !url.startsWith("about:") && openUrl(url).catch((e) => toast(errMsg(e), "error"))}><i className="codicon codicon-link-external" /></button>
      </div>
      {share !== null && (
        <form
          className="browser-share"
          onSubmit={(e) => { e.preventDefault(); shareWithAgent(label, share, "current"); setShare(null); }}
        >
          <i className="codicon codicon-hubot" />
          <input autoFocus value={share} onChange={(e) => setShare(e.target.value)} placeholder="Ask the agent about this page (URL, text, DOM outline and console are attached)…" onKeyDown={(e) => e.key === "Escape" && setShare(null)} />
          <button type="button" className="btn small" onClick={() => { shareWithAgent(label, share, "new"); setShare(null); }}>New task</button>
          <button type="submit" className="btn small primary">Send to current</button>
        </form>
      )}
      <div className="browser-stage">
        <div
          ref={viewRef}
          className={`browser-viewport ${dev.w ? "device" : ""}`}
          style={dev.w ? { width: dev.w / uiZoom, height: dev.h / uiZoom } : undefined}
        >
          {!url && <div className="browser-empty muted">Type a URL above. Local dev servers (localhost) are detected from terminal output.</div>}
        </div>
        {dev.w > 0 && <div className="browser-size muted small">{dev.w} × {dev.h}</div>}
      </div>
      {consoleOpen && <ConsolePane label={label} />}
    </div>
  );
}

function ConsolePane({ label }: { label: string }) {
  const entries = useBrowser((s) => s.pages[label]?.console) ?? [];
  const [filter, setFilter] = useState<"all" | "error" | "warn">("all");
  const ref = useRef<HTMLDivElement>(null);
  const shown = entries.filter((e) => filter === "all" || e.level === filter || (filter === "warn" && e.level === "error"));
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  return (
    <div className="browser-console">
      <div className="browser-console-bar">
        <span>Console</span>
        <div className="seg">
          {(["all", "warn", "error"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "warn" ? "Warnings" : "Errors"}</button>
          ))}
        </div>
        <div className="spacer" />
        <button className="icon-btn" title="Clear console" onClick={() => { browserApi.clearConsole(label).catch(() => {}); patchPage(label, { console: [] }); }}>
          <i className="codicon codicon-clear-all" />
        </button>
      </div>
      <div className="browser-console-list" ref={ref}>
        {shown.length === 0 && <div className="muted small" style={{ padding: 8 }}>No messages.</div>}
        {shown.map((e, i) => (
          <div key={i} className={`browser-log ${e.level}`}>
            <span className="ts">{new Date(e.ts).toLocaleTimeString()}</span>
            <pre>{e.text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bottom-right prompt shown when a dev server URL appears in terminal / process output. */
export function DevServerPrompt() {
  const url = useBrowser((s) => s.detected);
  useEffect(() => {
    if (!url) return;
    const t = setTimeout(dismissDetected, 15000);
    return () => clearTimeout(t);
  }, [url]);
  if (!url) return null;
  return (
    <div className="browser-prompt">
      <i className="codicon codicon-globe" />
      <span>Dev server detected at <code>{url}</code></span>
      <button className="btn small primary" onClick={() => { dismissDetected(); openBrowser(url).catch((e) => toast(errMsg(e), "error")); }}>Open in Browser</button>
      <button className="icon-btn" title="Dismiss" onClick={dismissDetected}><i className="codicon codicon-close" /></button>
    </div>
  );
}
