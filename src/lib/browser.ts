// Integrated browser: Browser editor tabs backed by native child webviews (src-tauri/src/browser.rs),
// dev-server URL detection, workspace preview server, live reload and "Share with Agent".

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { errMsg } from "./api";
import { get, set, toast, Tab } from "../store";
import { relative, samePath } from "./paths";
import { serverKey, UrlScanner } from "./browserDetect";

export interface ConsoleEntry { level: string; text: string; ts: number }
export interface PageState { url: string; title: string; loading: boolean; console: ConsoleEntry[] }

interface BrowserState {
  pages: Record<string, PageState>;
  /** Dev server URL waiting for the "Open in Browser" prompt. */
  detected: string | null;
  /** Preview servers by served root folder. */
  servers: Record<string, number>;
}

export const useBrowser = create<BrowserState>(() => ({ pages: {}, detected: null, servers: {} }));
const bset = useBrowser.setState;
const bget = useBrowser.getState;

export const browserApi = {
  create: (label: string, url: string, b: Bounds) => invoke<void>("browser_create", { label, url, ...b }),
  setBounds: (label: string, b: Bounds) => invoke<void>("browser_set_bounds", { label, ...b }),
  navigate: (label: string, url: string) => invoke<string>("browser_navigate", { label, url }),
  history: (label: string, action: "back" | "forward" | "reload" | "stop") => invoke<void>("browser_history", { label, action }),
  close: (label: string) => invoke<void>("browser_close", { label }),
  devtools: (label: string) => invoke<boolean>("browser_devtools", { label }),
  clearConsole: (label: string) => invoke<void>("browser_clear_console", { label }),
  snapshot: (label: string) => invoke<string>("browser_snapshot", { label }),
  serve: (root: string) => invoke<number>("browser_serve", { root }),
};

export interface Bounds { x: number; y: number; w: number; h: number; visible: boolean }

export const labelFor = (tabId: string) => "browser-" + tabId.replace(/[^a-zA-Z0-9]/g, "");
const tabForLabel = (label: string) => get().tabs.find((t) => t.kind === "browser" && labelFor(t.id) === label);

export function patchPage(label: string, patch: Partial<PageState>) {
  bset((s) => {
    const prev = s.pages[label] ?? { url: "", title: "", loading: false, console: [] };
    return { pages: { ...s.pages, [label]: { ...prev, ...patch } } };
  });
}

/** Normalises what the user typed in the address bar. */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "about:blank";
  if (/^(https?:|about:|file:)/i.test(s)) return s;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(s) || /^[\w.-]+:\d+(\/|$)/.test(s)) return "http://" + s;
  if (!/\s/.test(s) && /\.[a-z]{2,}(\/|$|:)/i.test(s)) return "https://" + s;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(s);
}

let tabCounter = 0;

/**
 * Opens `url` in a Browser tab. `reuse`: "same-origin" reuses a tab already showing that origin,
 * "active" reuses the active/last browser tab (agent), "none" always opens a new tab.
 */
export async function openBrowser(url = "", reuse: "same-origin" | "active" | "none" = "same-origin"): Promise<string> {
  const target = url ? normalizeUrl(url) : "";
  const tabs = get().tabs.filter((t) => t.kind === "browser");
  let tab: Tab | undefined;
  if (reuse === "active") tab = tabs.find((t) => t.id === get().activeId) ?? tabs[tabs.length - 1];
  else if (reuse === "same-origin" && target) tab = tabs.find((t) => sameOrigin(t.path, target));
  if (tab) {
    const id = tab.id;
    set((s) => ({ activeId: id, view: "editor", tabs: target ? s.tabs.map((t) => (t.id === id ? { ...t, path: target } : t)) : s.tabs }));
    if (target) await browserApi.navigate(labelFor(id), target).catch(() => {/* not created yet: the tab creates it with tab.path */});
    return id;
  }
  const id = `browser:${Date.now().toString(36)}${++tabCounter}`;
  set((s) => ({
    tabs: [...s.tabs, { id, kind: "browser", path: target, title: target ? hostTitle(target) : "Browser" }],
    activeId: id,
    view: "editor",
  }));
  return id;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function hostTitle(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "Browser";
  }
}

// ----------------------------------------------------------------------------------------------
// Static preview of workspace files
// ----------------------------------------------------------------------------------------------

async function serveRoot(root: string): Promise<number> {
  const known = bget().servers[root];
  if (known) return known;
  const port = await browserApi.serve(root);
  bset((s) => ({ servers: { ...s.servers, [root]: port } }));
  return port;
}

/** URL of a local file through the preview server (workspace root when the file is inside it). */
export async function previewUrlFor(path: string): Promise<string> {
  const ws = get().workspace;
  if (path.startsWith("ssh://")) throw new Error("Preview of remote (SSH) files is not supported yet.");
  const inWs = ws && !ws.startsWith("ssh://") && path.toLowerCase().startsWith(ws.replace(/[\\/]+$/, "").toLowerCase());
  const root = inWs ? ws! : path.replace(/[\\/][^\\/]*$/, "");
  const rel = relative(root, path);
  const port = await serveRoot(root);
  return `http://127.0.0.1:${port}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

export async function previewActiveFile() {
  const s = get();
  const tab = s.tabs.find((t) => t.id === s.activeId);
  if (!tab || tab.kind !== "file") return toast("Open an HTML file first.", "error");
  if (!/\.(html?|svg|xhtml)$/i.test(tab.path)) return toast("The active file is not an HTML file.", "error");
  try {
    const { saveFile } = await import("./workspace");
    if (s.dirty[tab.path]) await saveFile(tab.path);
    await openBrowser(await previewUrlFor(tab.path), "same-origin");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Root folder served on `url`'s port, if it is one of our preview servers. */
function servedRoot(url: string): string | null {
  const m = url.match(/^http:\/\/127\.0\.0\.1:(\d+)\//);
  if (!m) return null;
  const entry = Object.entries(bget().servers).find(([, p]) => p === Number(m[1]));
  return entry ? entry[0] : null;
}

// ----------------------------------------------------------------------------------------------
// Share with Agent
// ----------------------------------------------------------------------------------------------

export async function shareWithAgent(label: string, prompt: string, target: "new" | "current") {
  try {
    const snapshot = await browserApi.snapshot(label);
    const { newSession, ensureSession, sendMessage } = await import("./agent");
    const sess = target === "new" ? newSession() : ensureSession();
    set({ agentOpen: true });
    const ctx =
      "The user shared the page open in the IDE's integrated browser (text snapshot; no screenshot — " +
      "image capture of the preview is not supported). You can inspect it further with the `browser` tool.\n\n" +
      snapshot;
    await sendMessage(sess.id, prompt.trim() || "Take a look at this page.", ctx);
  } catch (e) {
    toast("Could not share the page: " + errMsg(e), "error");
  }
}

// ----------------------------------------------------------------------------------------------
// Global listeners (installed once from App)
// ----------------------------------------------------------------------------------------------

const WEB_EXT = /\.(html?|css|js|mjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf)$/i;
const seenServers = new Set<string>();

function onDetected(urls: string[]) {
  const ports = new Set(Object.values(bget().servers));
  for (const u of urls) {
    const port = Number(u.match(/:(\d+)/)?.[1]);
    if (ports.has(port)) continue;
    const key = serverKey(u);
    if (seenServers.has(key)) continue;
    seenServers.add(key);
    // Already previewing it: nothing to ask.
    if (get().tabs.some((t) => t.kind === "browser" && sameOrigin(t.path, u))) continue;
    bset({ detected: u });
  }
}

export function dismissDetected() {
  bset({ detected: null });
}

export async function initBrowser(): Promise<() => void> {
  invoke("browser_init").catch(() => {});
  const scanners = new Map<string, UrlScanner>();
  const scan = (key: string, data: string) => {
    let sc = scanners.get(key);
    if (!sc) scanners.set(key, (sc = new UrlScanner()));
    const found = sc.feed(data);
    if (found.length) onDetected(found);
  };

  let reloadTimer = 0;
  let pendingReload = new Set<string>();

  const unlisten = await Promise.all([
    listen<{ id: number; data: string }>("term-data", (e) => scan("t" + e.payload.id, e.payload.data)),
    listen<{ id: string; stream: string; data: string }>("proc-out", (e) => scan("p" + e.payload.id, e.payload.data)),
    listen<{ url: string }>("browser-open-request", (e) => {
      openBrowser(e.payload.url, "active").catch((err) => toast(errMsg(err), "error"));
    }),
    listen<any>("browser-event", ({ payload: ev }) => {
      const label: string = ev.label;
      if (ev.kind === "console") {
        const prev = bget().pages[label]?.console ?? [];
        patchPage(label, { console: [...prev, ...ev.entries].slice(-500) });
        return;
      }
      const patch: Partial<PageState> = {};
      if (ev.url) patch.url = ev.url;
      if (ev.kind === "nav") patch.loading = !!ev.loading;
      if (ev.kind === "state") patch.title = ev.title ?? "";
      patchPage(label, patch);
      const tab = tabForLabel(label);
      if (tab) {
        const page = bget().pages[label];
        const title = page.title || hostTitle(page.url);
        if (tab.path !== page.url || tab.title !== title) {
          set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, path: page.url || t.path, title } : t)) }));
        }
      }
    }),
    // Live reload: a saved file under a previewed folder reloads that preview (static server mode).
    listen<string[]>("fs-changed", (e) => {
      const changed = e.payload.filter((p) => WEB_EXT.test(p));
      if (!changed.length) return;
      for (const t of get().tabs) {
        if (t.kind !== "browser") continue;
        const root = servedRoot(t.path);
        if (root && changed.some((p) => p.toLowerCase().startsWith(root.replace(/[\\/]+$/, "").toLowerCase()) || samePath(p, root))) {
          pendingReload.add(labelFor(t.id));
        }
      }
      if (!pendingReload.size) return;
      clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        for (const l of pendingReload) browserApi.history(l, "reload").catch(() => {});
        pendingReload = new Set();
      }, 200);
    }),
  ]);
  return () => unlisten.forEach((u) => u());
}
