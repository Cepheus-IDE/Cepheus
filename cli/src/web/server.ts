/**
 * `cepheus web`: serves the Cepheus IDE web build (dist-web) and a token-protected WebSocket
 * (`/ws`) that answers the app's backend commands with the same names, arguments and results
 * as the desktop (Tauri) backend, and pushes the same events.
 *
 * Protocol (JSON text frames):
 *   client → server  {t:"invoke", id, cmd, args}
 *   server → client  {t:"result", id, ok:true, value} | {t:"result", id, ok:false, error}
 *   server → client  {t:"event", event, payload}
 *   server → client  {t:"hello", root, home, platform, sep, pty, version}   (once, on connect)
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  Confiner, FolderWatcher, cepheusHome, historyList, historyRead, historySave, listFiles, loadSettings, readDataUrl, readDir,
  readText, renamePath, saveSettings, searchFiles, sessionDelete, sessionSave, sessionsLoad, trashPath, writeText,
} from "./fsops.js";
import { gitCommands } from "./git.js";
import { ProcManager } from "./procs.js";
import { AgentBridge, type CoreLike } from "./agentBridge.js";
import { createNodeToolHost } from "./nodeHost.js";
import { aiOneshot, modelsList, openvsxMeta, openvsxSearch, openvsxText } from "./providers.js";

export interface WebServerOptions {
  /** Folder to serve (the workspace); every file operation is confined to it and ~/.cepheus. */
  root: string;
  port?: number;
  /** Interface to bind; default 127.0.0.1. */
  host?: string;
  /** Open the browser. */
  open?: boolean;
  /** Folder with the web build (index.html). Default: CEPHEUS_WEB_DIST, then known locations. */
  distDir?: string;
  /** Fixed token (tests); default random. */
  token?: string;
  /** Agent core override (tests); default `../core/agent.js`. */
  agentCore?: CoreLike | null;
  /** Logger; default console.log. Pass () => {} to silence. */
  log?: (msg: string) => void;
  /** Try the next ports when `port` is busy (default true). */
  portFallback?: boolean;
}

export interface WebServerHandle {
  url: string;
  token: string;
  port: number;
  host: string;
  root: string;
  close(): Promise<void>;
}

export const NOT_AVAILABLE = "Not available in Cepheus Web";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

function findDist(explicit?: string): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env.CEPHEUS_WEB_DIST,
    path.resolve(here, "../web-app"), // packaged CLI: dist/web-app next to dist/web
    path.resolve(here, "../../web-app"),
    path.resolve(here, "../../../dist-web"), // repository: cli/src/web or cli/dist/web → <repo>/dist-web
    path.resolve(process.cwd(), "dist-web"),
  ].filter((x): x is string => !!x);
  const hit = candidates.find((d) => fs.existsSync(path.join(d, "index.html")));
  return hit ? path.resolve(hit) : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Cookies ignore the port, so the name includes it (several servers can run side by side). */
function cookieToken(req: http.IncomingMessage, port: number): string | null {
  const m = new RegExp(`(?:^|;\\s*)cepheus_token_${port}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie ?? "");
  return m ? m[1] : null;
}

function isLoopback(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd.exe", ["/c", "start", "", url.replace(/&/g, "^&")]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const root = path.resolve(opts.root);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a folder: ${root}`);
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const dist = findDist(opts.distDir);
  const confiner = new Confiner(root);
  const confine = (p: unknown, what?: string) => confiner.check(p, what);
  const clients = new Set<WebSocket>();
  let port = opts.port ?? 4000;

  const broadcast = (event: string, payload: unknown) => {
    const msg = JSON.stringify({ t: "event", event, payload });
    for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  };

  const procs = new ProcManager(broadcast, (p) => confine(p, "cwd"), root);
  const watcher = new FolderWatcher((paths) => broadcast("fs-changed", paths));
  const nvidiaKey = () => process.env.NVIDIA_API_KEY || process.env.CEPHEUS_NVIDIA_KEY || undefined;
  const agent = new AgentBridge({
    loadCore: async () => {
      if (opts.agentCore !== undefined) return opts.agentCore;
      return (await import("../core/agent.js")) as unknown as CoreLike;
    },
    host: (ws) => createNodeToolHost(ws, (p) => confine(p)),
    // The core reports `/`-separated paths; the app's tabs use native ones.
    emit: (ev) =>
      broadcast("agent-event", ev?.type === "fileChanged" && path.sep === "\\" ? { ...ev, path: String(ev.path).replace(/\//g, "\\") } : ev),
    defaultNvidiaKey: nvidiaKey,
    coreMissing: "The agent core is not available in this build of the CLI.",
    checkWorkspace: (ws) => confine(ws, "workspace"),
  });
  const git = gitCommands(confine);

  type Ctx = { ws: WebSocket; state: { linkTaken: boolean } };
  type Handler = (a: Record<string, any>, ctx: Ctx) => any;

  const commands: Record<string, Handler> = {
    // --- files -------------------------------------------------------------------------------
    read_dir: (a) => readDir(confine(a.path)),
    read_file: (a) => readText(confine(a.path)),
    write_file: async (a) => (await writeText(confine(a.path), String(a.content ?? "")), null),
    create_dir: async (a) => (await fs.promises.mkdir(confine(a.path), { recursive: true }), null),
    rename_path: async (a) => (await renamePath(confine(a.from, "from"), confine(a.to, "to")), null),
    delete_path: async (a) => (await trashPath(confine(a.path), root), null),
    path_exists: (a) => {
      try {
        return fs.existsSync(confine(a.path));
      } catch {
        return false;
      }
    },
    read_data_url: (a) => readDataUrl(confine(a.path)),
    search_files: (a) => searchFiles(confine(a.root, "root"), a.opts ?? {}),
    list_files: (a) => listFiles(confine(a.root, "root")),
    watch_folder: (a) => (watcher.watch(confine(a.path)), null),
    // --- settings / history / sessions -------------------------------------------------------
    load_settings: () => loadSettings(),
    save_settings: async (a) => (await saveSettings(a.settings), null),
    history_save: (a) => historySave(confine(a.path), String(a.content ?? ""), a.label),
    history_list: (a) => historyList(confine(a.path)),
    history_read: (a) => historyRead(confine(a.path), a.ts),
    agent_sessions_load: () => sessionsLoad(),
    agent_session_save: async (a) => (await sessionSave(a.id, a.data), null),
    agent_session_delete: async (a) => (await sessionDelete(a.id), null),
    // --- terminals / processes ---------------------------------------------------------------
    term_spawn: (a, ctx) => procs.termSpawn(ctx.ws, a),
    term_write: (a) => procs.termWrite(a.id, a.data),
    term_resize: (a) => procs.termResize(a.id, a.cols, a.rows),
    term_kill: (a) => procs.termKill(a.id),
    proc_spawn: (a, ctx) => procs.procSpawn(ctx.ws, a as any),
    proc_write: (a) => procs.procWrite(a.id, a.data, !!a.framed),
    proc_kill: (a) => procs.procKill(a.id),
    which: (a) => procs.which(a.names),
    // --- git ---------------------------------------------------------------------------------
    ...(git as Record<string, Handler>),
    // --- agent / models ----------------------------------------------------------------------
    agent_send: (a) => agent.send(a.req),
    agent_cancel: (a) => agent.cancel(a.sessionId),
    agent_approve: (a) => agent.approve(a.approvalId, a.approved),
    agent_reset: (a) => agent.reset(a.sessionId),
    agent_steer: (a) => agent.steer(a.sessionId, a.message),
    agent_customizations: (a) => agent.customizations(a.workspace, (p) => (path.sep === "\\" ? String(p).replace(/\//g, "\\") : p)),
    ai_oneshot: async (a) => {
      const viaCore = await agent.oneshot(a.config, a.system, a.prompt, a.maxTokens).catch(() => undefined);
      return viaCore ?? aiOneshot(a.config ?? {}, String(a.system ?? ""), String(a.prompt ?? ""), a.maxTokens ?? 8000, nvidiaKey());
    },
    models_list: (a) => modelsList(a.config ?? {}, nvidiaKey()),
    nvidia_models: async (a) => (await modelsList({ provider: "nvidia", apiKey: a.apiKey ?? "" }, nvidiaKey())).map((m) => m.id),
    models_unavailable: () => [],
    models_reset_unavailable: () => null,
    mcp_status: () => [],
    // --- extensions (registry browsing only) ---------------------------------------------------
    openvsx_search: (a) => openvsxSearch(a.query, a.category),
    openvsx_meta: (a) => openvsxMeta(a.namespace, a.name),
    openvsx_text: (a) => openvsxText(a.url),
    ext_list: () => [],
    ext_preinstall: () => [],
    ext_configure: () => "https://open-vsx.org",
    // --- app plumbing --------------------------------------------------------------------------
    net_configure: () => [],
    profiles_load: () => null,
    deep_link_take: (_a, ctx) => {
      // Opens the served folder once per page load (handled by the app's cepheus:// link code).
      if (ctx.state.linkTaken) return [];
      ctx.state.linkTaken = true;
      return [`cepheus://open?folder=${encodeURIComponent(root)}`];
    },
    web_info: () => ({ root, home: os.homedir(), platform: process.platform, sep: path.sep, pty: procs.ptyAvailable }),
  };

  // ------------------------------------------------------------------------------------------
  // HTTP (static files)
  // ------------------------------------------------------------------------------------------

  const allowedHosts = () => {
    const names = new Set(["127.0.0.1", "localhost", "[::1]"]);
    if (!isLoopback(host) && host !== "0.0.0.0" && host !== "::") names.add(host.includes(":") ? `[${host}]` : host);
    if (host === "0.0.0.0" || host === "::") {
      for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) names.add(i.family === "IPv6" ? `[${i.address}]` : i.address);
      names.add(os.hostname().toLowerCase());
    }
    return new Set([...names].map((n) => `${n}:${port}`));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: string | Buffer, type = "text/plain; charset=utf-8", extra: Record<string, string> = {}) => {
      res.writeHead(code, {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-cache",
        ...extra,
      });
      res.end(body);
    };
    if (!allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) return send(403, "Forbidden host");
    if (u.pathname === "/__cepheus/ping") return send(200, JSON.stringify({ cepheus: "web", version: 1 }), "application/json");
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed");
    if (!dist) {
      return send(503, `<!doctype html><meta charset="utf-8"><title>Cepheus Web</title><body style="font-family:system-ui;padding:2em">
<h2>The Cepheus web build was not found</h2><p>Build it from the repository root with <code>npx vite build --config vite.config.web.ts</code>,
or point <code>CEPHEUS_WEB_DIST</code> at a folder containing it.</p>`, "text/html; charset=utf-8");
    }
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return send(400, "Bad path");
    }
    let file = path.join(dist, path.normalize(rel).replace(/^([\\/]|\.\.[\\/])+/, ""));
    if (file !== dist && !file.startsWith(dist + path.sep)) return send(403, "Forbidden");
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      const idx = path.join(file, "index.html");
      file = fs.existsSync(idx) ? idx : path.extname(rel) ? "" : path.join(dist, "index.html");
    }
    if (!file || !fs.existsSync(file)) return u.pathname === "/favicon.ico" ? send(204, "") : send(404, "Not found");
    const extra: Record<string, string> = {};
    const t = u.searchParams.get("token");
    if (t && safeEqual(t, token)) extra["set-cookie"] = `cepheus_token_${port}=${token}; Path=/; HttpOnly; SameSite=Strict`;
    if (file.includes(`${path.sep}assets${path.sep}`)) extra["cache-control"] = "public, max-age=31536000, immutable";
    const body = fs.readFileSync(file);
    send(200, req.method === "HEAD" ? "" : body, MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", extra);
  });

  // ------------------------------------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const reject = (code: number, why: string) => {
      socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${why}`);
      socket.destroy();
    };
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/ws") return reject(404, "Not Found");
    const hostHeader = String(req.headers.host ?? "").toLowerCase();
    if (!allowedHosts().has(hostHeader)) return reject(403, "Forbidden host");
    const origin = String(req.headers.origin ?? "");
    if (!origin || origin.toLowerCase() !== `http://${hostHeader}`) return reject(403, "Forbidden origin");
    const given = u.searchParams.get("token") ?? cookieToken(req, port) ?? "";
    if (!safeEqual(given, token)) return reject(401, "Invalid token");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    const ctx: Ctx = { ws, state: { linkTaken: false } };
    ws.send(JSON.stringify({ t: "hello", ...commands.web_info({}, ctx), version: 1 }));
    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.t !== "invoke") return;
      const reply = (ok: boolean, v: unknown) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(ok ? { t: "result", id: msg.id, ok, value: v === undefined ? null : v } : { t: "result", id: msg.id, ok, error: v }));
      };
      const h = Object.prototype.hasOwnProperty.call(commands, msg.cmd) ? commands[msg.cmd] : undefined;
      if (!h) return reply(false, `${NOT_AVAILABLE}: '${msg.cmd}' needs the desktop app.`);
      try {
        reply(true, await h(msg.args ?? {}, ctx));
      } catch (e) {
        reply(false, e instanceof Error ? e.message : String(e));
      }
    });
    ws.on("close", () => {
      clients.delete(ws);
      procs.disposeOwner(ws);
    });
  });

  // ------------------------------------------------------------------------------------------
  // Listen
  // ------------------------------------------------------------------------------------------

  const tries = opts.portFallback === false ? 1 : 20;
  for (let i = 0; ; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (e: any) {
      if (e?.code !== "EADDRINUSE" || i + 1 >= tries) throw e;
      port++;
    }
  }
  port = (server.address() as any).port ?? port;
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${shownHost}:${port}/?token=${token}`;
  log(`Cepheus Web is serving ${root}`);
  log(`Open: ${url}`);
  if (!dist) log("Warning: the web build (dist-web) was not found; run `npx vite build --config vite.config.web.ts` in the repository.");
  if (!isLoopback(host)) log(`Warning: listening on ${host} — anyone who can reach this address and has the token can edit files and run commands.`);
  if (!procs.ptyAvailable) log("Terminals run in basic mode (node-pty is not installed).");
  if (opts.open) openBrowser(url);

  return {
    url,
    token,
    port,
    host,
    root,
    close: async () => {
      watcher.close();
      agent.disposeAll();
      procs.disposeAll();
      for (const c of clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export { cepheusHome };
