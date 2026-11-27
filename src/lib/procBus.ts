//! Routes backend process events (`proc-out`, `proc-msg`, `proc-exit`) to per-process handlers.
//! Events can arrive before `proc_spawn` returns the id, so unclaimed events are buffered briefly
//! and replayed when a handler subscribes.

import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

export interface ProcHandlers {
  out?: (stream: "stdout" | "stderr", data: string) => void;
  msg?: (msg: string) => void;
  exit?: (code: number | null) => void;
}

type Ev = { t: number; id: number; kind: "out" | "msg" | "exit"; payload: any };
const handlers = new Map<number, ProcHandlers>();
let early: Ev[] = [];
let ready: Promise<void> | null = null;

function dispatch(e: Ev) {
  const h = handlers.get(e.id);
  if (!h) {
    const now = Date.now();
    early = early.filter((x) => now - x.t < 5000).slice(-2000);
    early.push(e);
    return;
  }
  if (e.kind === "out") h.out?.(e.payload.stream, e.payload.data);
  else if (e.kind === "msg") h.msg?.(e.payload.msg);
  else { handlers.delete(e.id); h.exit?.(e.payload.code); }
}

function init() {
  ready ??= Promise.all([
    listen<any>("proc-out", (e) => dispatch({ t: Date.now(), id: e.payload.id, kind: "out", payload: e.payload })),
    listen<any>("proc-msg", (e) => dispatch({ t: Date.now(), id: e.payload.id, kind: "msg", payload: e.payload })),
    listen<any>("proc-exit", (e) => dispatch({ t: Date.now(), id: e.payload.id, kind: "exit", payload: e.payload })),
  ]).then(() => {});
  return ready;
}

/** Spawns a process and routes its events to `h` (none are lost). */
export async function spawnProc(command: string, cwd: string | null, mode: "lsp" | "raw", h: ProcHandlers, env?: Record<string, string>) {
  await init();
  const id = await api.procSpawn(command, cwd, mode, env);
  handlers.set(id, h);
  const mine = early.filter((e) => e.id === id);
  early = early.filter((e) => e.id !== id);
  for (const e of mine) dispatch(e);
  return id;
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface RunHandle { id: Promise<number>; done: Promise<RunResult>; kill: () => void }

/** Runs a shell command to completion, collecting output; `onOutput` streams it as it arrives. */
export function runCommand(command: string, cwd: string | null, opts: { env?: Record<string, string>; onOutput?: (data: string, stream: "stdout" | "stderr") => void } = {}): RunHandle {
  let stdout = "", stderr = "";
  let resolveDone!: (r: RunResult) => void;
  const done = new Promise<RunResult>((r) => (resolveDone = r));
  const id = spawnProc(command, cwd, "raw", {
    out: (s, d) => { if (s === "stdout") stdout += d; else stderr += d; opts.onOutput?.(d, s); },
    exit: (code) => resolveDone({ code, stdout, stderr }),
  }, opts.env);
  id.catch((e) => resolveDone({ code: -1, stdout, stderr: String(e) }));
  return { id, done, kill: () => { id.then((i) => api.procKill(i)).catch(() => {}); } };
}

/** Quotes one argument for the platform shell used by `proc_spawn` (cmd.exe on Windows). */
export function shellQuote(a: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(a)) return a;
  const isWin = navigator.userAgent.includes("Windows");
  // Windows: MSVCRT argv rules (backslashes before a quote are doubled, quotes escaped).
  return isWin ? `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"` : `'${a.replace(/'/g, `'\\''`)}'`;
}

let tmp: Promise<string> | null = null;
/** The OS temp directory (asked from the shell once; the webview has no env access). */
export function tempDir(): Promise<string> {
  const isWin = navigator.userAgent.includes("Windows");
  tmp ??= runCommand(isWin ? "echo %TEMP%" : 'echo "${TMPDIR:-/tmp}"', null).done.then((r) => r.stdout.trim().replace(/[\\/]+$/, "") || (isWin ? "C:\\Windows\\Temp" : "/tmp"));
  return tmp;
}
