/**
 * Browser-only mode (static hosting such as GitHub Pages). Files come from a folder the user
 * picks with the File System Access API (Chromium browsers); its handle is kept in IndexedDB.
 * Paths are virtual: `browser://<folder name>/sub/file.ts`.
 */
import { BROWSER_ONLY, type Backend } from "./types";
import { idbDel, idbGet, idbKeys, idbSet } from "./idb";
import { dispatch } from "../shims/bus";
import { ALWAYS_SKIP, IgnoreStack, buildSearchRegex, isBinary, searchText } from "../../cli/src/web/ignore";
import { aiOneshot, FREE_PROXY_ORIGINS, modelsList, openvsxMeta, openvsxSearch, openvsxText, setBrowserMode, setFreeProxy } from "../../cli/src/web/providers";
import { AgentBridge, type CoreLike } from "../../cli/src/web/agentBridge";

const PREFIX = "browser://";
const MAX_TEXT_BYTES = 20_000_000;

export const fsAccessSupported = () => typeof (window as any).showDirectoryPicker === "function";

type Dir = FileSystemDirectoryHandle;

let root: Dir | null = null;
/** Folder remembered from a previous visit whose permission must be re-granted with a click. */
let pendingRoot: Dir | null = null;
const links: string[] = [];

function parse(p: string): { name: string; parts: string[] } {
  const m = /^browser:\/*([^/]+)(\/.*)?$/.exec(String(p ?? ""));
  if (!m) throw `Not a browser folder path: ${p}`;
  return { name: decodeURIComponent(m[1]), parts: (m[2] ?? "").split("/").filter((s) => s && s !== ".") };
}

function rootFor(name: string): Dir {
  if (!root || root.name !== name) {
    throw pendingRoot?.name === name
      ? `Click “Reconnect ${name}” in the banner to give this page access to the folder again.`
      : `The folder “${name}” is not open in this browser tab. Use File › Open Folder…`;
  }
  return root;
}

async function dirAt(name: string, parts: string[], create = false): Promise<Dir> {
  let d = rootFor(name);
  for (const seg of parts) {
    if (seg === "..") throw "Paths with '..' are not allowed";
    d = await d.getDirectoryHandle(seg, { create });
  }
  return d;
}

async function handleAt(p: string): Promise<FileSystemHandle> {
  const { name, parts } = parse(p);
  if (!parts.length) return rootFor(name);
  const parent = await dirAt(name, parts.slice(0, -1));
  const last = parts[parts.length - 1];
  try {
    return await parent.getFileHandle(last);
  } catch {
    return await parent.getDirectoryHandle(last);
  }
}

async function fileAt(p: string, create = false): Promise<FileSystemFileHandle> {
  const { name, parts } = parse(p);
  if (!parts.length) throw "That is a folder";
  const parent = await dirAt(name, parts.slice(0, -1), create);
  return parent.getFileHandle(parts[parts.length - 1], { create });
}

const join = (base: string, n: string) => base.replace(/\/+$/, "") + "/" + n;

async function readText(p: string): Promise<string> {
  const f = await (await fileAt(p)).getFile();
  if (f.size > MAX_TEXT_BYTES) throw `File is too large to open in the editor (${Math.floor(f.size / 1_000_000)} MB)`;
  const buf = new Uint8Array(await f.arrayBuffer());
  if (isBinary(buf)) throw "File appears to be binary";
  return new TextDecoder().decode(buf);
}

async function writeText(p: string, content: string) {
  const fh = await fileAt(p, true);
  const w = await (fh as any).createWritable();
  await w.write(content ?? "");
  await w.close();
}

async function readDir(p: string) {
  const d = (await handleAt(p)) as Dir;
  if (d.kind !== "directory") throw "Not a folder";
  const out: { name: string; path: string; isDir: boolean }[] = [];
  for await (const [n, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) out.push({ name: n, path: join(p, n), isDir: h.kind === "directory" });
  out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
  return out;
}

async function copyInto(src: FileSystemHandle, destDir: Dir, name: string) {
  if (src.kind === "file") {
    const f = await (src as FileSystemFileHandle).getFile();
    const w = await ((await destDir.getFileHandle(name, { create: true })) as any).createWritable();
    await w.write(f);
    await w.close();
  } else {
    const sub = await destDir.getDirectoryHandle(name, { create: true });
    for await (const [n, h] of (src as any).entries() as AsyncIterable<[string, FileSystemHandle]>) await copyInto(h, sub, n);
  }
}

async function exists(p: string) {
  try {
    await handleAt(p);
    return true;
  } catch {
    return false;
  }
}

async function rename(from: string, to: string) {
  if (await exists(to)) throw `'${to}' already exists`;
  const a = parse(from);
  const b = parse(to);
  if (a.name !== b.name || !a.parts.length || !b.parts.length) throw "Cannot move outside the open folder";
  const src = await handleAt(from);
  const destDir = await dirAt(b.name, b.parts.slice(0, -1), true);
  const newName = b.parts[b.parts.length - 1];
  if (typeof (src as any).move === "function") {
    try {
      await (src as any).move(destDir, newName);
      return;
    } catch {
      /* fall back to copy + delete */
    }
  }
  await copyInto(src, destDir, newName);
  await (await dirAt(a.name, a.parts.slice(0, -1))).removeEntry(a.parts[a.parts.length - 1], { recursive: true });
}

async function remove(p: string) {
  const { name, parts } = parse(p);
  if (!parts.length) throw "Refusing to delete the open folder itself.";
  const label = parts.join("/");
  if (!window.confirm(`Permanently delete “${label}”?\n\nThe browser cannot move files to the trash, so this cannot be undone.`)) {
    throw "Delete cancelled";
  }
  await (await dirAt(name, parts.slice(0, -1))).removeEntry(parts[parts.length - 1], { recursive: true });
}

async function readGitignore(d: Dir): Promise<string | null> {
  try {
    return await (await (await d.getFileHandle(".gitignore")).getFile()).text();
  } catch {
    return null;
  }
}

async function* walk(rootPath: string): AsyncGenerator<[string, FileSystemFileHandle, string]> {
  const { name, parts } = parse(rootPath);
  const start = await dirAt(name, parts);
  const stack: [Dir, string, IgnoreStack][] = [[start, "", new IgnoreStack().with("", await readGitignore(start))]];
  while (stack.length) {
    const [d, rel, ign] = stack.pop()!;
    const ents: [string, FileSystemHandle][] = [];
    for await (const e of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) ents.push(e);
    ents.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    const subs: [Dir, string, IgnoreStack][] = [];
    for (const [n, h] of ents) {
      const r = rel ? `${rel}/${n}` : n;
      if (h.kind === "directory") {
        if (ALWAYS_SKIP.has(n) || ign.ignored(r, true)) continue;
        subs.push([h as Dir, r, ign.with(r, await readGitignore(h as Dir))]);
      } else if (!ign.ignored(r, false)) {
        yield [join(rootPath, r), h as FileSystemFileHandle, r];
      }
    }
    stack.push(...subs.reverse());
  }
}

async function listFiles(rootPath: string, max = 50_000) {
  const out: string[] = [];
  for await (const [p] of walk(rootPath)) {
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

async function searchFiles(rootPath: string, opts: any) {
  const out: { path: string; line: number; col: number; len: number; text: string }[] = [];
  if (!opts?.query) return out;
  const re = buildSearchRegex(opts);
  for await (const [p, fh] of walk(rootPath)) {
    const f = await fh.getFile();
    if (f.size > 2_000_000) continue;
    const buf = new Uint8Array(await f.arrayBuffer());
    if (isBinary(buf)) continue;
    if (searchText(new TextDecoder().decode(buf), re, p, out, opts.maxResults ?? 2000)) break;
  }
  return out;
}

async function dataUrl(p: string) {
  const f = await (await fileAt(p)).getFile();
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(String(r.error));
    r.readAsDataURL(f);
  });
}

// ---------------------------------------------------------------------------------------------
// Folder selection and permission
// ---------------------------------------------------------------------------------------------

async function adopt(d: Dir): Promise<string> {
  root = d;
  pendingRoot = null;
  await idbSet("root", d).catch(() => {});
  return PREFIX + d.name;
}

export async function pickDirectory(): Promise<string | null> {
  if (!fsAccessSupported()) {
    alert("Opening a folder needs the File System Access API, which this browser does not support. Use Chrome or Edge, or run `cepheus web` for the full experience.");
    return null;
  }
  try {
    const d: Dir = await (window as any).showDirectoryPicker({ id: "cepheus", mode: "readwrite" });
    return await adopt(d);
  } catch (e: any) {
    if (e?.name === "AbortError") return null;
    throw e?.message ?? String(e);
  }
}

/** Restores the last folder: open it when permission is still granted, else remember it for a click. */
export async function restoreFolder(): Promise<{ name: string; needsClick: boolean } | null> {
  const d = await idbGet<Dir>("root");
  if (!d || typeof (d as any).queryPermission !== "function") return null;
  const perm = await (d as any).queryPermission({ mode: "readwrite" }).catch(() => "denied");
  if (perm === "granted") {
    root = d;
    links.push(`cepheus://open?folder=${encodeURIComponent(PREFIX + d.name)}`);
    return { name: d.name, needsClick: false };
  }
  pendingRoot = d;
  return { name: d.name, needsClick: true };
}

/** Must run in a click handler: asks for access again and opens the folder. */
export async function reconnectFolder(): Promise<boolean> {
  const d = pendingRoot;
  if (!d) return false;
  const perm = await (d as any).requestPermission({ mode: "readwrite" }).catch(() => "denied");
  if (perm !== "granted") return false;
  const p = await adopt(d);
  links.push(`cepheus://open?folder=${encodeURIComponent(p)}`);
  dispatch("deep-link", null);
  return true;
}

export async function forgetFolder() {
  pendingRoot = null;
  await idbDel("root").catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Agent: CLI core + a ToolHost over the picked folder (no commands in the browser)
// ---------------------------------------------------------------------------------------------

const coreModules = import.meta.glob("../../cli/src/core/agent.ts");

function browserHost(workspace: string) {
  const { name } = parse(workspace);
  const hostRoot = "/" + name; // POSIX-style root for the core; mapped back to browser:// below
  const toVirtual = (p: string) => {
    const s = String(p).replace(/\\/g, "/");
    if (s.startsWith("browser:")) return PREFIX + parse(s).name + "/" + parse(s).parts.join("/");
    if (s === hostRoot || s.startsWith(hostRoot + "/")) return PREFIX + name + s.slice(hostRoot.length);
    if (!s.startsWith("/")) return join(PREFIX + name, s);
    throw `Path '${p}' is outside the open folder`;
  };
  const toHostRel = (p: string) => {
    const r = parse(p).parts.join("/");
    return r || ".";
  };
  return {
    root: hostRoot,
    caseInsensitive: false,
    osLabel: "a web browser (no shell: run_command is not available)",
    readFile: (p: string) => readText(toVirtual(p)),
    writeFile: (p: string, c: string) => writeText(toVirtual(p), c),
    exists: (p: string) => exists(toVirtual(p)),
    async listDir(p: string) {
      return (await readDir(toVirtual(p))).map((e) => ({ name: e.name, isDir: e.isDir }));
    },
    async findFiles(limit = 50_000) {
      return (await listFiles(PREFIX + name, limit)).map(toHostRel);
    },
    async search(o: any) {
      return (await searchFiles(PREFIX + name, { ...o, maxResults: o.maxResults ?? 200 })).map((h) => ({ path: toHostRel(h.path), line: h.line, text: h.text }));
    },
    async removeFile(p: string) {
      const { name: n, parts } = parse(toVirtual(p));
      await (await dirAt(n, parts.slice(0, -1))).removeEntry(parts[parts.length - 1]);
    },
    async runCommand() {
      return { code: 127, stdout: "", stderr: `Commands cannot run in the browser. ${BROWSER_ONLY}.` };
    },
    toVirtual,
  };
}

function installFetchShim() {
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/^https:\/\/api\.anthropic\.com\//.test(url)) {
      const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      h.set("anthropic-dangerous-direct-browser-access", "true");
      init = { ...init, headers: h };
    }
    try {
      return await orig(input as any, init);
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      })();
      let why = "the server refused requests from web pages (CORS) or is unreachable";
      if (host.includes("cepheus.codes")) why = "the free Cepheus tier only accepts pages served from https://cepheus.codes; add your own key in Settings";
      else if (host.includes("nvidia.com")) why = "NVIDIA's API does not accept requests from web pages (CORS); use `cepheus web` for NVIDIA models";
      else if (host.endsWith(":11434")) why = "Ollama rejects web pages unless started with OLLAMA_ORIGINS set to this site's origin";
      throw new TypeError(`Failed to fetch ${host}: ${why}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

const LS_SETTINGS = "cepheus.web.settings";

function historyKey(p: string) {
  return "hist:" + p.toLowerCase() + "\u0000";
}

export function createBrowserBackend(): Backend {
  setBrowserMode(true);
  // Keyless use goes through the free proxy, whose CORS only allows the cepheus.codes pages;
  // elsewhere the user gets the add-a-key guidance instead of a CORS failure.
  setFreeProxy(FREE_PROXY_ORIGINS.includes(window.location.origin));
  installFetchShim();
  const agent = new AgentBridge({
    loadCore: async () => {
      const load = Object.values(coreModules)[0];
      return load ? ((await load()) as CoreLike) : null;
    },
    host: (ws) => browserHost(ws),
    emit: (ev) => {
      if (ev?.type === "fileChanged" && typeof ev.path === "string") {
        try {
          ev = { ...ev, path: browserHost(PREFIX + (root?.name ?? "")).toVirtual(ev.path) };
        } catch {
          /* leave as is */
        }
      }
      dispatch("agent-event", ev);
    },
    coreMissing: "The agent is not included in this web build.",
    checkWorkspace: (ws) => {
      parse(ws);
      return ws;
    },
  });

  const handlers: Record<string, (a: any) => any> = {
    read_dir: (a) => readDir(a.path),
    read_file: (a) => readText(a.path),
    write_file: async (a) => (await writeText(a.path, a.content), null),
    create_dir: async (a) => {
      const { name, parts } = parse(a.path);
      await dirAt(name, parts, true);
      return null;
    },
    rename_path: async (a) => (await rename(a.from, a.to), null),
    delete_path: async (a) => (await remove(a.path), null),
    path_exists: (a) => exists(a.path),
    read_data_url: (a) => dataUrl(a.path),
    search_files: (a) => searchFiles(a.root, a.opts ?? {}),
    list_files: (a) => listFiles(a.root),
    watch_folder: () => null,
    load_settings: () => {
      try {
        return JSON.parse(localStorage.getItem(LS_SETTINGS) ?? "null");
      } catch {
        return null;
      }
    },
    save_settings: (a) => {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(a.settings ?? null));
      return null;
    },
    history_save: async (a) => {
      const k = historyKey(a.path);
      const keys = (await idbKeys(k)).sort().reverse();
      if (keys[0] && (await idbGet<string>(keys[0])) === a.content) return null;
      await idbSet(`${k}${Date.now()}_${String(a.label || "save").replace(/[^A-Za-z0-9-]/g, "")}`, String(a.content ?? ""));
      for (const old of keys.slice(49)) await idbDel(old);
      return null;
    },
    history_list: async (a) => {
      const k = historyKey(a.path);
      const out = [];
      for (const key of (await idbKeys(k)).sort().reverse()) {
        const [ts, label] = key.slice(k.length).split("_");
        out.push({ ts: Number(ts), label: label || "save", size: ((await idbGet<string>(key)) ?? "").length });
      }
      return out;
    },
    history_read: async (a) => {
      const k = historyKey(a.path);
      const key = (await idbKeys(k)).find((x) => x.slice(k.length).startsWith(`${a.ts}_`));
      if (!key) throw "Snapshot not found";
      return idbGet<string>(key);
    },
    agent_sessions_load: async () => {
      const out = [];
      for (const k of await idbKeys("sess:")) out.push(await idbGet(k));
      return out.filter(Boolean);
    },
    agent_session_save: async (a) => (await idbSet(`sess:${a.id}`, a.data), null),
    agent_session_delete: async (a) => (await idbDel(`sess:${a.id}`), null),
    agent_send: (a) => agent.send(a.req),
    agent_cancel: (a) => agent.cancel(a.sessionId),
    agent_approve: (a) => agent.approve(a.approvalId, a.approved),
    agent_reset: (a) => agent.reset(a.sessionId),
    agent_steer: (a) => agent.steer(a.sessionId, a.message),
    agent_customizations: (a) =>
      agent.customizations(a.workspace, (p) => {
        try {
          return browserHost(a.workspace).toVirtual(p);
        } catch {
          return p;
        }
      }),
    ai_oneshot: async (a) => (await agent.oneshot(a.config, a.system, a.prompt, a.maxTokens).catch(() => undefined)) ??
      aiOneshot(a.config ?? {}, String(a.system ?? ""), String(a.prompt ?? ""), a.maxTokens ?? 8000),
    models_list: (a) => modelsList(a.config ?? {}),
    nvidia_models: async (a) => (await modelsList({ provider: "nvidia", apiKey: a.apiKey ?? "" })).map((m) => m.id),
    models_unavailable: () => [],
    models_reset_unavailable: () => null,
    mcp_status: () => [],
    openvsx_search: (a) => openvsxSearch(a.query, a.category),
    openvsx_meta: (a) => openvsxMeta(a.namespace, a.name),
    openvsx_text: (a) => openvsxText(a.url),
    ext_list: () => [],
    ext_preinstall: () => [],
    ext_configure: () => "https://open-vsx.org",
    net_configure: () => [],
    profiles_load: () => null,
    deep_link_take: () => links.splice(0),
    // Quiet answers for things the UI polls; the features themselves are unavailable.
    git_status: () => ({ isRepo: false, branch: "", aheadBehind: "", files: [] }),
    git_current_branch: () => "",
    git_remote: () => "",
    git_show_head: () => "",
    git_log: () => [],
    git_stash_list: () => [],
    which: () => [],
    ssh_list: () => [],
    ssh_config_hosts: () => [],
  };

  return {
    mode: "browser",
    async invoke(cmd, args) {
      const h = handlers[cmd];
      if (!h) throw `${BROWSER_ONLY} ('${cmd}')`;
      try {
        return await h(args ?? {});
      } catch (e: any) {
        if (typeof e === "string") throw e;
        if (e?.name === "NotFoundError") throw "No such file or folder";
        if (e?.name === "NotAllowedError") throw "The browser denied access to the folder. Open it again with File › Open Folder…";
        throw e?.message ?? String(e);
      }
    },
    dataDir: () => "browser-data://cepheus",
    homeDir: () => "browser-data://home",
    rootDir: () => (root ? PREFIX + root.name : null),
    pickDirectory,
  };
}
