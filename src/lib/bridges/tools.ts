//! Extension bridges: finding the CLIs and project tools bridges use, running them with the buffer on
//! stdin (via a temp file) and their output captured to files, and one-click installs in a terminal.

import { create } from "zustand";
import { api } from "../api";
import { runCommand, shellQuote, tempDir } from "../procBus";
import { get, toast } from "../../store";
import { installFor, OS, TOOLS, ToolDef } from "./registry";
import { redirectLine } from "./core";

export const isWin = () => navigator.userAgent.includes("Windows");
export function currentOS(): OS {
  const ua = navigator.userAgent;
  return ua.includes("Windows") ? "win" : ua.includes("Mac") ? "mac" : "linux";
}
const sep = () => (isWin() ? "\\" : "/");
const join = (...p: string[]) => p.map((x, i) => (i === 0 ? x.replace(/[\\/]+$/, "") : x.replace(/^[\\/]+|[\\/]+$/g, ""))).join(sep());
const parentDir = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const normalize = (p: string) => (isWin() ? p.replace(/\//g, "\\") : p);

/** Local workspace folder bridges may run tools in (none for SSH workspaces). */
export function localWorkspace(): string | null {
  const ws = get().workspace;
  return ws && !ws.startsWith("ssh://") ? ws : null;
}

export interface ToolStatus { ok: boolean; detail?: string }
export const useTools = create<{ status: Record<string, ToolStatus>; workspace: string | null }>(() => ({ status: {}, workspace: null }));

let pending: Set<string> | null = null;
let pendingPromise: Promise<void> | null = null;

/** Checks tools (batched; results cached per workspace until `force`). */
export function checkTools(ids: string[], force = false): Promise<void> {
  const st = useTools.getState();
  const ws = localWorkspace();
  if (st.workspace !== ws) useTools.setState({ status: {}, workspace: ws });
  const need = ids.filter((id) => TOOLS[id] && (force || !useTools.getState().status[id]));
  if (!need.length) return Promise.resolve();
  pending ??= new Set();
  need.forEach((id) => pending!.add(id));
  pendingPromise ??= new Promise<void>((resolve) => setTimeout(async () => {
    const batch = [...pending!];
    pending = null;
    pendingPromise = null;
    try { await runChecks(batch); } finally { resolve(); }
  }, 30));
  return pendingPromise;
}

async function runChecks(ids: string[]) {
  const ws = localWorkspace();
  const out: Record<string, ToolStatus> = {};
  const exes = new Set<string>();
  await Promise.all(ids.map(async (id) => {
    const c = TOOLS[id].check;
    if ("exe" in c) {
      if (ws && c.local) for (const rel of c.local) if (await api.exists(join(ws, rel)).catch(() => false)) { out[id] = { ok: true, detail: rel }; return; }
      exes.add(c.exe);
    } else if ("npm" in c) {
      const dir = ws ? await findNodeModulesPkg(c.npm, ws, ws) : null;
      out[id] = dir ? { ok: true, detail: "project" } : { ok: false, detail: ws ? "not in this project's node_modules" : "open a folder first" };
    } else {
      const found = ws ? (await Promise.all(c.files.map((f) => api.exists(join(ws, f)).catch(() => false)))).findIndex(Boolean) : -1;
      out[id] = found >= 0 ? { ok: true, detail: c.files[found] } : { ok: false, detail: ws ? "not found in the project" : "open a folder first" };
    }
  }));
  if (exes.size) {
    const found = new Set(await api.which([...exes]).catch(() => [] as string[]));
    for (const id of ids) {
      const c = TOOLS[id].check;
      if ("exe" in c && !out[id]) out[id] = found.has(c.exe) ? { ok: true, detail: "PATH" } : { ok: false, detail: `\`${c.exe}\` not on PATH` };
    }
  }
  useTools.setState((s) => ({ status: { ...s.status, ...out } }));
}

/** Folder that has node_modules/<pkg>, walking up from `from` to `root` (monorepos). */
export async function findNodeModulesPkg(pkg: string, from: string, root: string): Promise<string | null> {
  let dir = from;
  const r = root.replace(/[\\/]+$/, "").toLowerCase();
  for (let i = 0; i < 30; i++) {
    if (await api.exists(join(dir, "node_modules", ...pkg.split("/"), "package.json")).catch(() => false)) return dir;
    if (dir.replace(/[\\/]+$/, "").toLowerCase() === r) break;
    const up = parentDir(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return null;
}

/** How to start a tool for a file: the command (quoted) and the folder to run it in. */
export async function resolveTool(id: string, file: string): Promise<{ exe: string; cwd: string } | null> {
  const def = TOOLS[id];
  const ws = localWorkspace();
  const fileDir = parentDir(normalize(file));
  if (!def) return null;
  const c = def.check;
  if ("npm" in c) {
    if (!ws) return null;
    const dir = await findNodeModulesPkg(c.npm, fileDir, ws);
    if (!dir) return null;
    const bin = join(dir, "node_modules", ".bin", (c.bin ?? c.npm.split("/").pop()!) + (isWin() ? ".cmd" : ""));
    if (await api.exists(bin).catch(() => false)) return { exe: shellQuote(bin), cwd: dir };
    return { exe: `npx --no ${c.npm}`, cwd: dir }; // package without a .bin shim of that name
  }
  if ("exe" in c) {
    if (ws && c.local) for (const rel of c.local) {
      const p = join(ws, rel);
      if (await api.exists(p).catch(() => false)) return { exe: shellQuote(normalize(p)), cwd: ws };
    }
    const st = useTools.getState().status[id];
    if (st && !st.ok) return null;
    if (!st) { await checkTools([id]); if (!useTools.getState().status[id]?.ok) return null; }
    return { exe: c.exe, cwd: ws ?? fileDir };
  }
  return null;
}

export interface ToolRun { code: number | null; stdout: string; stderr: string; text: string }
export interface ToolHandle { done: Promise<ToolRun>; kill: () => void }

let seq = 0;
/**
 * Runs `<exe> <args>` with output redirected to temp files. With `input`, the text is written to a
 * temp copy named like `file` and fed on stdin ("stdin") or rewritten in place ("inplace").
 */
export function runTool(exe: string, args: (tmp: string) => string, o: { cwd: string; file: string; input?: string; mode?: "stdin" | "inplace" | "none"; timeoutMs?: number }): ToolHandle {
  let killed = false;
  let kill = () => { killed = true; };
  const done = (async (): Promise<ToolRun> => {
    const tmpRoot = await tempDir();
    const dir = join(tmpRoot, `cepheus-bridge-${Date.now().toString(36)}-${++seq}`);
    const base = normalize(o.file).split(/[\\/]/).pop() || "buffer.txt";
    const input = join(dir, base);
    const outF = join(dir, "out.txt");
    const errF = join(dir, "err.txt");
    const mode = o.mode ?? "none";
    try {
      await api.writeFile(mode === "none" ? errF : input, mode === "none" ? "" : o.input ?? "");
      if (killed) return { code: null, stdout: "", stderr: "cancelled", text: "" };
      const line = redirectLine(exe, args(input), { stdin: mode === "stdin" ? input : undefined, stdout: outF, stderr: errF }, shellQuote);
      const h = runCommand(line, o.cwd);
      kill = () => { killed = true; h.kill(); };
      const timer = setTimeout(() => h.kill(), o.timeoutMs ?? 20000);
      const r = await h.done;
      clearTimeout(timer);
      const [stdout, stderr] = await Promise.all([api.readFile(outF).catch(() => r.stdout), api.readFile(errF).catch(() => r.stderr)]);
      const text = mode === "inplace" ? await api.readFile(input).catch(() => "") : stdout;
      return { code: killed ? null : r.code, stdout, stderr: stderr || r.stderr, text };
    } finally {
      runCommand(isWin() ? `rmdir /s /q ${shellQuote(dir)}` : `rm -rf ${shellQuote(dir)}`, null);
    }
  })();
  return { done, kill: () => kill() };
}

/** Runs a tool's install command in a visible terminal, then re-checks it. */
export function installTool(id: string, after?: (ok: boolean) => void) {
  const def: ToolDef | undefined = TOOLS[id];
  const cmd = def && installFor(def, currentOS());
  if (!def || !cmd) {
    toast(def?.note ?? `No one-click installer for ${def?.name ?? id}.`);
    return;
  }
  if ("npm" in def.check && !localWorkspace()) {
    toast(`Open the project folder first — ${def.name} is installed into the project.`, "error");
    return;
  }
  import("../terminalBus").then(({ runInTerminal }) => runInTerminal({
    title: `Install ${def.name}`,
    command: cmd,
    onExit: async (code) => {
      await checkTools([id], true);
      const ok = !!useTools.getState().status[id]?.ok;
      if (code === 0 && ok) toast(`${def.name} installed.${def.note ? " " + def.note : ""}`);
      else if (code === 0) toast(`${def.name}: the install finished but Cepheus still can't find it — you may need to restart Cepheus so it picks up the new PATH.`, "error");
      else toast(`Installing ${def.name} failed (exit code ${code}). See the terminal.`, "error");
      after?.(ok);
    },
  }));
}
