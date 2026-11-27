/**
 * Entry of the Cepheus web build (vite.config.web.ts swaps it in for src/main.tsx).
 * Picks the backend, shows the mode banner, then starts the unchanged app.
 *
 *  - Server mode: the page was opened from `cepheus web` (token in the URL, a stored token, or
 *    the server's /__cepheus/ping answers). Everything runs on the local Node server.
 *  - Browser mode: static hosting (e.g. GitHub Pages). Files come from a folder picked with the
 *    File System Access API; no terminals, git or language servers.
 */
import { setBackend } from "./shims/bus";
import { connectServer, type ServerInfo } from "./backend/server";
import { createBrowserBackend, forgetFolder, fsAccessSupported, reconnectFolder, restoreFolder } from "./backend/browser";

(window as any).__CEPHEUS_WEB__ = true;

const TOKEN_KEY = "cepheus.web.token";

const CSS = `
html.cepheus-web .win-controls { display: none !important; }
html.cepheus-web body { display: flex; flex-direction: column; }
html.cepheus-web #root { flex: 1 1 auto; min-height: 0; height: auto; }
#cepheus-web-banner { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 3px 10px; min-height: 22px;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; background: #1b2a3a; color: #cfe3f7; border-bottom: 1px solid #2c4560; z-index: 10; }
#cepheus-web-banner.warn { background: #3a2c12; color: #f5deb0; border-color: #5c4519; }
#cepheus-web-banner .tag { font-weight: 600; white-space: nowrap; }
#cepheus-web-banner .msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#cepheus-web-banner .msg:hover { white-space: normal; }
#cepheus-web-banner button { font: inherit; background: transparent; color: inherit; border: 1px solid currentColor; border-radius: 3px; padding: 0 8px; cursor: pointer; opacity: .9; }
#cepheus-web-banner button.x { border: none; font-size: 14px; padding: 0 4px; }
`;

function banner(): { set(tag: string, msg: string, warn?: boolean, actions?: { label: string; run: () => void }[]): void } {
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  document.documentElement.classList.add("cepheus-web");
  const el = document.createElement("div");
  el.id = "cepheus-web-banner";
  el.setAttribute("role", "status");
  document.body.insertBefore(el, document.getElementById("root"));
  return {
    set(tag, msg, warn = false, actions = []) {
      el.className = warn ? "warn" : "";
      el.textContent = "";
      const t = document.createElement("span");
      t.className = "tag";
      t.textContent = tag;
      const m = document.createElement("span");
      m.className = "msg";
      m.textContent = msg;
      m.title = msg;
      el.append(t, m);
      for (const a of actions) {
        const b = document.createElement("button");
        b.textContent = a.label;
        b.onclick = a.run;
        el.appendChild(b);
      }
      const x = document.createElement("button");
      x.className = "x";
      x.title = "Hide";
      x.textContent = "×";
      x.onclick = () => (el.style.display = "none");
      el.appendChild(x);
      el.style.display = "";
    },
  };
}

async function serverReachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch("/__cepheus/ping", { cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    return (await r.json())?.cepheus === "web";
  } catch {
    return false;
  }
}

async function boot() {
  const ui = banner();
  const url = new URL(location.href);
  const forced = url.searchParams.get("mode");
  let token = url.searchParams.get("token");
  if (token) {
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private mode */
    }
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash); // keep the token out of history/bookmarks
  } else {
    try {
      token = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
  }

  const tryServer = forced !== "browser" && (forced === "server" || !!token || (await serverReachable()));
  if (tryServer) {
    try {
      let info: ServerInfo | null = null;
      // Declared before connecting: the "connected" callback fires inside connectServer.
      const showServer = () => {
        if (!info) return;
        ui.set(
          "Cepheus Web · local server",
          `Serving ${info.root}. Files, git, search, terminals, language servers and the agent run on this computer` +
            (info.pty ? "." : "; terminals are basic (node-pty is not installed: no full-screen programs or Tab completion).") +
            " Remote SSH, Docker/dev containers, the integrated browser and extension installs need the desktop app.",
        );
      };
      const conn = await connectServer(token, (s) => {
        if (s === "reconnecting") ui.set("Cepheus Web · local server", "Lost the connection to `cepheus web` — reconnecting…", true);
        if (s === "connected") showServer();
      });
      const backend = conn.backend;
      info = conn.info;
      showServer();
      setBackend(backend);
      return;
    } catch (e) {
      ui.set("Cepheus Web", "Could not connect to `cepheus web`. Open the exact URL (with ?token=…) that the command printed.", true);
      try {
        sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* ignore */
      }
      if (forced === "server" || token) {
        // Don't silently fall back when the user meant the server: every command explains it.
        const msg = "Not connected to `cepheus web`: open the URL with ?token=… that the command printed.";
        setBackend({ mode: "server", invoke: async () => Promise.reject(msg), dataDir: () => "/", homeDir: () => "/", rootDir: () => null });
        return;
      }
    }
  }

  const backend = createBrowserBackend();
  setBackend(backend);
  const limits =
    "Runs entirely in this browser: files from a folder you open, keys stored only in this browser's localStorage. " +
    "No terminal, git, language servers or debugger — run `cepheus web` for the full experience. " +
    "Some AI providers block browser requests (CORS): NVIDIA usually does; Ollama needs OLLAMA_ORIGINS.";
  if (!fsAccessSupported()) {
    ui.set("Cepheus Web · browser", "This browser cannot open local folders (File System Access API). Use Chrome or Edge, or run `cepheus web`.", true);
    return;
  }
  const restored = await restoreFolder().catch(() => null);
  if (restored?.needsClick) {
    ui.set("Cepheus Web · browser", `Reopen “${restored.name}”? The browser needs your permission again. ${limits}`, false, [
      {
        label: `Reconnect ${restored.name}`,
        run: async () => {
          if (await reconnectFolder()) ui.set("Cepheus Web · browser", limits);
        },
      },
      {
        label: "Forget",
        run: async () => {
          await forgetFolder();
          ui.set("Cepheus Web · browser", limits);
        },
      },
    ]);
  } else {
    ui.set("Cepheus Web · browser", limits);
  }
}

boot()
  .catch((e) => console.error("[cepheus web] startup failed", e))
  .finally(() => import("../src/main.tsx"));
