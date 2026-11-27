/**
 * File system commands for `cepheus web` with the same names, arguments and results as the
 * desktop backend (src-tauri/src/fs_cmds.rs, search.rs, watcher.rs, history.rs, settings.rs).
 * Every path is confined to the served workspace root or ~/.cepheus.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { ALWAYS_SKIP, IgnoreStack, buildSearchRegex, isBinary, searchText } from "./ignore.js";

export const MAX_TEXT_BYTES = 20_000_000;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export const cepheusHome = () => path.join(os.homedir(), ".cepheus");

function norm(p: string): string {
  const r = path.resolve(p);
  return CASE_INSENSITIVE ? r.toLowerCase() : r;
}

function inside(base: string, p: string): boolean {
  const b = norm(base);
  const n = norm(p);
  return n === b || n.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/** Realpath of the nearest existing ancestor + the remaining (not yet existing) tail. */
function realish(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export class Confiner {
  readonly root: string;
  private rootReal: string;
  private extra: string[];

  constructor(root: string) {
    this.root = path.resolve(root);
    this.rootReal = realish(this.root);
    const home = cepheusHome();
    this.extra = [home, realish(home)];
  }

  /** Returns the resolved absolute path, or throws when it is outside the workspace and ~/.cepheus. */
  check(p: unknown, what = "path"): string {
    if (typeof p !== "string" || !p.trim()) throw new Error(`Missing ${what}`);
    if (/^(ssh|browser):\/\//.test(p)) throw new Error("Remote and browser folders are not available in Cepheus Web (server mode).");
    const abs = path.resolve(this.root, p);
    const real = realish(abs);
    const ok =
      (inside(this.root, abs) && inside(this.rootReal, real)) || this.extra.some((e) => inside(e, abs) && inside(realish(e), real));
    if (!ok) throw new Error(`Access denied: '${p}' is outside the served folder (${this.root}).`);
    return abs;
  }
}

// ---------------------------------------------------------------------------------------------
// Basic file commands
// ---------------------------------------------------------------------------------------------

export async function readDir(p: string) {
  const ents = await fsp.readdir(p, { withFileTypes: true });
  const out = await Promise.all(
    ents.map(async (e) => {
      const full = path.join(p, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = await fsp.stat(full).then((s) => s.isDirectory()).catch(() => false);
      return { name: e.name, path: full, isDir };
    }),
  );
  out.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.toLowerCase().localeCompare(b.name.toLowerCase())));
  return out;
}

export async function readText(p: string): Promise<string> {
  const st = await fsp.stat(p);
  if (st.size > MAX_TEXT_BYTES) throw new Error(`File is too large to open in the editor (${Math.floor(st.size / 1_000_000)} MB)`);
  const buf = await fsp.readFile(p);
  if (isBinary(buf)) throw new Error("File appears to be binary");
  return buf.toString("utf8");
}

export async function writeText(p: string, content: string) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content ?? "", "utf8");
}

export async function renamePath(from: string, to: string) {
  if (fs.existsSync(to)) throw new Error(`'${to}' already exists`);
  await fsp.rename(from, to);
}

export async function readDataUrl(p: string) {
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ({ svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" } as Record<string, string>)[ext] ??
    "application/octet-stream";
  const st = await fsp.stat(p);
  if (st.size > MAX_TEXT_BYTES) throw new Error(`File is too large to open (${Math.floor(st.size / 1_000_000)} MB)`);
  return `data:${mime};base64,${(await fsp.readFile(p)).toString("base64")}`;
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
      resolve({ code, out: (stderr || stdout || (err ? err.message : "")).toString().trim() });
    });
  });
}

/** Moves to the Recycle Bin / Trash; refuses (never deletes permanently) when that is not possible. */
export async function trashPath(p: string, root: string) {
  if (norm(p) === norm(root)) throw new Error("Refusing to delete the workspace folder itself.");
  if (!fs.existsSync(p)) throw new Error(`'${p}' does not exist`);
  const fail = (why: string) =>
    new Error(`Could not move '${path.basename(p)}' to the trash (${why}). Cepheus Web never deletes files permanently — delete it from your file manager or a terminal.`);
  if (process.platform === "win32") {
    const isDir = fs.statSync(p).isDirectory();
    const lit = p.replace(/'/g, "''");
    const script =
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::` +
      `${isDir ? "DeleteDirectory" : "DeleteFile"}('${lit}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const r = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
    if (r.code !== 0 || fs.existsSync(p)) throw fail(r.out || "PowerShell failed");
    return;
  }
  if (process.platform === "darwin") {
    const lit = p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const r = await run("osascript", ["-e", `tell application "Finder" to delete POSIX file "${lit}"`]);
    if (r.code !== 0 || fs.existsSync(p)) throw fail(r.out || "Finder refused");
    return;
  }
  for (const [cmd, args] of [["gio", ["trash", p]], ["trash-put", [p]], ["kioclient5", ["move", p, "trash:/"]]] as [string, string[]][]) {
    const r = await run(cmd, args);
    if (r.code === 0 && !fs.existsSync(p)) return;
  }
  throw fail("no trash tool found: install `gio` (glib) or `trash-cli`");
}

// ---------------------------------------------------------------------------------------------
// Search / list (respects .gitignore minimally)
// ---------------------------------------------------------------------------------------------

async function readGitignore(dir: string): Promise<string | null> {
  return fsp.readFile(path.join(dir, ".gitignore"), "utf8").catch(() => null);
}

/** Yields [absolute path, workspace-relative path] for every non-ignored file. */
export async function* walkFiles(root: string): AsyncGenerator<[string, string]> {
  const stack: [string, string, IgnoreStack][] = [[root, "", new IgnoreStack().with("", await readGitignore(root))]];
  while (stack.length) {
    const [dir, rel, ign] = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    const subdirs: [string, string, IgnoreStack][] = [];
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (ALWAYS_SKIP.has(e.name) || ign.ignored(r, true)) continue;
        subdirs.push([full, r, ign.with(r, await readGitignore(full))]);
      } else if (e.isFile()) {
        if (ign.ignored(r, false)) continue;
        yield [full, r];
      }
    }
    stack.push(...subdirs.reverse());
  }
}

export async function listFiles(root: string, max = 50_000): Promise<string[]> {
  const out: string[] = [];
  for await (const [full] of walkFiles(root)) {
    out.push(full);
    if (out.length >= max) break;
  }
  return out;
}

export async function searchFiles(root: string, opts: any) {
  const out: { path: string; line: number; col: number; len: number; text: string }[] = [];
  if (!opts?.query) return out;
  const re = buildSearchRegex(opts);
  const max = opts.maxResults ?? 2000;
  for await (const [full] of walkFiles(root)) {
    let st: fs.Stats;
    try {
      st = await fsp.stat(full);
    } catch {
      continue;
    }
    if (st.size > 2_000_000) continue;
    let buf: Buffer;
    try {
      buf = await fsp.readFile(full);
    } catch {
      continue;
    }
    if (isBinary(buf)) continue;
    if (searchText(buf.toString("utf8"), re, full, out, max)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------------------------

export class FolderWatcher {
  private w: fs.FSWatcher | null = null;
  constructor(private emit: (paths: string[]) => void) {}

  watch(dir: string) {
    this.close();
    try {
      // Recursive watching is native on Windows/macOS and supported on Linux since Node 20.
      this.w = fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const full = path.join(dir, name.toString());
        const s = full.replace(/\\/g, "/");
        if (["/.git/", "/node_modules/", "/target/"].some((x) => s.includes(x))) return;
        this.emit([full]);
      });
      this.w.on("error", () => this.close());
    } catch {
      this.w = null; // not supported: the UI still refreshes on save / focus
    }
  }

  close() {
    try {
      this.w?.close();
    } catch {
      /* ignore */
    }
    this.w = null;
  }
}

// ---------------------------------------------------------------------------------------------
// Settings, Time Machine and agent session files (~/.cepheus)
// ---------------------------------------------------------------------------------------------

const settingsFile = () => path.join(cepheusHome(), "web-settings.json");

export async function loadSettings() {
  try {
    return JSON.parse(await fsp.readFile(settingsFile(), "utf8"));
  } catch {
    return null;
  }
}

export async function saveSettings(v: any) {
  await fsp.mkdir(cepheusHome(), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(v ?? null, null, 2), "utf8");
}

function historyKey(p: string): string {
  // FNV-1a 64-bit over the normalized path (same keys as the desktop app).
  const norm = Buffer.from(p.replace(/\\/g, "/").toLowerCase(), "utf8");
  let h = 0xcbf29ce484222325n;
  for (const b of norm) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const historyDir = (p: string) => path.join(cepheusHome(), "history", historyKey(p));

async function snaps(dir: string): Promise<[number, string, string][]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const v: [number, string, string][] = [];
  for (const n of names) {
    if (!n.endsWith(".snap")) continue;
    const stem = n.slice(0, -5);
    const i = stem.indexOf("_");
    const ts = Number(i < 0 ? stem : stem.slice(0, i));
    if (!Number.isFinite(ts)) continue;
    v.push([ts, i < 0 ? "save" : stem.slice(i + 1), path.join(dir, n)]);
  }
  return v.sort((a, b) => b[0] - a[0]);
}

export async function historySave(p: string, content: string, label?: string | null) {
  const dir = historyDir(p);
  await fsp.mkdir(dir, { recursive: true });
  const existing = await snaps(dir);
  if (existing[0] && (await fsp.readFile(existing[0][2], "utf8").catch(() => null)) === content) return null;
  await fsp.writeFile(path.join(dir, "path.txt"), p).catch(() => {});
  const lab = (label || "save").replace(/[^A-Za-z0-9-]/g, "");
  await fsp.writeFile(path.join(dir, `${Date.now()}_${lab}.snap`), content, "utf8");
  for (const [, , old] of existing.slice(199)) await fsp.rm(old, { force: true });
  return null;
}

export async function historyList(p: string) {
  const out = [];
  for (const [ts, label, f] of await snaps(historyDir(p))) out.push({ ts, label, size: (await fsp.stat(f).catch(() => ({ size: 0 }))).size });
  return out;
}

export async function historyRead(p: string, ts: number) {
  const hit = (await snaps(historyDir(p))).find(([t]) => t === Number(ts));
  if (!hit) throw new Error("Snapshot not found");
  return fsp.readFile(hit[2], "utf8");
}

const sessionsDir = () => path.join(cepheusHome(), "web-agent-sessions");
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id || "")) throw new Error("Invalid session id");
  return id;
};

export async function sessionsLoad() {
  const dir = sessionsDir();
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fsp.readFile(path.join(dir, n), "utf8")));
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export async function sessionSave(id: string, data: any) {
  await fsp.mkdir(sessionsDir(), { recursive: true });
  const f = path.join(sessionsDir(), `${safeId(id)}.json`);
  await fsp.writeFile(f + ".tmp", JSON.stringify(data));
  await fsp.rename(f + ".tmp", f);
}

export async function sessionDelete(id: string) {
  await fsp.rm(path.join(sessionsDir(), `${safeId(id)}.json`), { force: true });
}
