//! Debugger core shared by every adapter: session state (`useDebug`), breakpoints, watches and
//! launch configurations. Two backends drive it:
//! - Node.js (JavaScript and, on Node 22.6+, TypeScript) over the V8 inspector protocol (this file):
//!   the program runs as `node --inspect-brk=0 <file>` (or we attach to a port) and we talk CDP
//!   over the inspector WebSocket.
//! - Debug Adapter Protocol adapters over stdio (src/lib/dap.ts), e.g. debugpy for Python.

import { create } from "zustand";
import { monaco } from "./monaco";
import { errMsg } from "./api";
import { get as getApp, set as setApp, toast } from "../store";
import { spawnProc, runCommand, shellQuote } from "./procBus";
import { cdpCondition } from "./debugLogic";
import { LaunchConfig, NODE_TYPES, PYTHON_TYPES, argList, configEnv, currentFileConfig, loadLaunchConfigs, resolveConfig } from "./launch";

export interface Scope { type: string; objectId: string; startLine?: number; endLine?: number; expensive?: boolean }
export interface Frame { id: string; name: string; path: string; line: number; col: number; scopes: Scope[] }
export interface Variable { name: string; value: string; type: string; objectId?: string }
export interface ConsoleLine { kind: "out" | "err" | "log" | "warn" | "error" | "input" | "result" | "info"; text: string }
export interface Breakpoint { line: number; enabled: boolean; condition?: string; hitCondition?: string; logMessage?: string }
export interface EvalResult { value: string; type: string; objectId?: string; error?: boolean }

interface DebugState {
  status: "idle" | "starting" | "running" | "paused";
  /** Program being debugged (for the header and Restart). */
  file: string | null;
  /** Name of the running configuration. */
  sessionName: string;
  adapter: "node" | "dap" | null;
  frames: Frame[];
  frameIndex: number;
  /** Variables per scope/object reference (top frame's first scopes are loaded eagerly). */
  vars: Record<string, Variable[]>;
  /** Normalized path → breakpoints. */
  breakpoints: Record<string, Breakpoint[]>;
  /** "Deactivate all breakpoints" toggle. */
  breakpointsActive: boolean;
  console: ConsoleLine[];
  watches: string[];
  watchValues: Record<string, EvalResult>;
  configs: LaunchConfig[];
  /** Selected configuration name; "" = the current file. */
  selectedConfig: string;
}

/** What each debug adapter implements; the UI only talks to this. */
export interface DebugBackend {
  resume(): void;
  pause(): void;
  stepOver(): void;
  stepInto(): void;
  stepOut(): void;
  evaluate(expr: string, frame: Frame | undefined, context: "watch" | "repl" | "hover"): Promise<EvalResult | null>;
  variables(ref: string): Promise<Variable[]>;
  /** Replaces all breakpoints of one file (already filtered: enabled + active). */
  setBreakpoints(path: string, bps: Breakpoint[]): Promise<void>;
  /** Terminate (launch) or detach (attach). */
  stop(): Promise<void>;
}

function loadBreakpoints(): Record<string, Breakpoint[]> {
  try {
    const raw = JSON.parse(localStorage.getItem("cepheus.breakpoints") || "{}");
    // Older versions stored plain line numbers.
    return Object.fromEntries(Object.entries<any[]>(raw).map(([p, l]) => [p, l.map((b) => (typeof b === "number" ? { line: b, enabled: true } : b))]));
  } catch { return {}; }
}
const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

export const useDebug = create<DebugState>(() => ({
  status: "idle",
  file: null,
  sessionName: "",
  adapter: null,
  frames: [],
  frameIndex: 0,
  vars: {},
  breakpoints: loadBreakpoints(),
  breakpointsActive: lsGet("cepheus.breakpointsActive", "1") === "1",
  console: [],
  watches: JSON.parse(lsGet("cepheus.watches", "[]")),
  watchValues: {},
  configs: [],
  selectedConfig: "",
}));
const dset = useDebug.setState;
const dget = useDebug.getState;

export const norm = (p: string) => p.replace(/\\/g, "/");
const fileUrl = (p: string) => "file:///" + norm(p).replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/").replace(/^([A-Za-z])%3A/, "$1:");
const urlToPath = (u: string) => { try { return norm(decodeURIComponent(new URL(u).pathname).replace(/^\/([A-Za-z]:)/, "$1")); } catch { return u; } };

export function log(kind: ConsoleLine["kind"], text: string) {
  dset((s) => ({ console: [...s.console.slice(-1999), { kind, text }] }));
}

let backend: DebugBackend | null = null;
let lastConfig: LaunchConfig | null = null;

// ----------------------------------------------------------------------------------------------
// Session events (called by the backends)
// ----------------------------------------------------------------------------------------------

/** Execution stopped: show the frames, open the top one, load its variables and the watches. */
export async function onStopped(frames: Frame[]) {
  dset({ status: "paused", frames, frameIndex: 0, vars: {} });
  const top = frames.find((f) => f.path.startsWith("/") || /^[A-Za-z]:/.test(f.path));
  if (top) {
    const { openFile } = await import("./workspace");
    openFile(top.path, top.line, top.col);
  }
  await Promise.all((frames[0]?.scopes ?? []).filter((s) => !s.expensive).slice(0, 3).map((s) => loadVariables(s.objectId)));
  evaluateWatches();
  setApp({ sidebar: "debug", view: "editor" });
}

export function onContinued() {
  dset({ status: "running", frames: [], vars: {}, watchValues: {} });
}

export function onSessionEnded() {
  backend = null;
  dset({ status: "idle", frames: [], vars: {}, watchValues: {}, adapter: null });
}

/** Breakpoints to send for a file, honoring enable flags and "Deactivate all". */
export function effectiveBreakpoints(path: string): Breakpoint[] {
  if (!dget().breakpointsActive) return [];
  return (findBps(path) ?? []).filter((b) => b.enabled);
}
const findBps = (path: string) => Object.entries(dget().breakpoints).find(([p]) => p.toLowerCase() === norm(path).toLowerCase())?.[1];

/** Sends every file's breakpoints to the adapter (session start, toggling "Deactivate all"). */
export async function syncAllBreakpoints(b = backend) {
  if (!b) return;
  for (const p of Object.keys(dget().breakpoints)) await b.setBreakpoints(p, effectiveBreakpoints(p));
}

// ----------------------------------------------------------------------------------------------
// Node.js backend (Chrome DevTools Protocol)
// ----------------------------------------------------------------------------------------------

function remote(o: any): string {
  if (!o) return "undefined";
  if (o.type === "string") return JSON.stringify(o.value);
  if ("value" in o) return String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  return o.description ?? o.className ?? o.type;
}

interface NodeOpts { name: string; command?: string; wsUrl?: string; cwd: string | null; env?: Record<string, string>; stopOnEntry?: boolean; file: string | null }

async function startNode(o: NodeOpts) {
  let ws: WebSocket | null = null;
  let procId = 0;
  let seq = 0;
  let ended = false;
  let startPause = !o.wsUrl && !o.stopOnEntry;
  const pending = new Map<number, (r: any) => void>();
  const scripts = new Map<string, string>();
  const bpIds = new Map<string, string[]>(); // lowercased path → CDP breakpoint ids

  const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve(null);
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  const end = (msg?: string) => {
    if (ended) return;
    ended = true;
    if (msg) log("info", msg);
    ws?.close();
    pending.forEach((r) => r(null));
    pending.clear();
    if (backend === b) onSessionEnded();
  };

  const b: DebugBackend = {
    resume: () => void send("Debugger.resume"),
    pause: () => void send("Debugger.pause"),
    stepOver: () => void send("Debugger.stepOver"),
    stepInto: () => void send("Debugger.stepInto"),
    stepOut: () => void send("Debugger.stepOut"),
    async evaluate(expr, frame, context) {
      const silent = context !== "repl";
      const r = frame
        ? await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.id, expression: expr, generatePreview: true, silent })
        : await send("Runtime.evaluate", { expression: expr, generatePreview: true, replMode: context === "repl", silent });
      if (!r) return null;
      const res = r.result;
      if (res?.exceptionDetails) return { value: res.exceptionDetails.exception?.description?.split("\n")[0] ?? res.exceptionDetails.text, type: "error", error: true };
      const o = res?.result;
      return { value: remote(o), type: o?.subtype ?? o?.type ?? "", objectId: o?.type === "object" && o.subtype !== "null" ? o.objectId : undefined };
    },
    async variables(objectId) {
      const r = await send("Runtime.getProperties", { objectId, ownProperties: true, generatePreview: false });
      return (r?.result?.result ?? [])
        .filter((p: any) => p.value || p.get)
        .map((p: any) => ({
          name: p.name,
          value: p.value ? remote(p.value) : "(getter)",
          type: p.value?.subtype ?? p.value?.type ?? "",
          objectId: p.value?.type === "object" && p.value.subtype !== "null" ? p.value.objectId : undefined,
        }));
    },
    async setBreakpoints(path, bps) {
      const k = norm(path).toLowerCase();
      for (const id of bpIds.get(k) ?? []) await send("Debugger.removeBreakpoint", { breakpointId: id });
      const ids: string[] = [];
      for (const bp of bps) {
        const condition = cdpCondition(bp, `${k}:${bp.line}`);
        const r = await send("Debugger.setBreakpointByUrl", { url: fileUrl(path), lineNumber: bp.line - 1, columnNumber: 0, ...(condition ? { condition } : {}) });
        if (r?.result?.breakpointId) ids.push(r.result.breakpointId);
      }
      bpIds.set(k, ids);
    },
    async stop() {
      const id = procId;
      if (o.wsUrl) { await send("Runtime.runIfWaitingForDebugger"); end("Detached."); return; }
      end();
      if (id) await import("./api").then(({ api }) => api.procKill(id)).catch(() => {});
    },
  };

  const onPaused = (p: any) => {
    if (startPause && p.reason === "Break on start") {
      // --inspect-brk stops before the first line; continue to the user's breakpoints.
      startPause = false;
      send("Debugger.resume");
      return;
    }
    startPause = false;
    const frames: Frame[] = p.callFrames.map((f: any) => ({
      id: f.callFrameId,
      name: f.functionName || "(anonymous)",
      path: urlToPath(f.url || scripts.get(f.location.scriptId) || ""),
      line: f.location.lineNumber + 1,
      col: (f.location.columnNumber ?? 0) + 1,
      scopes: f.scopeChain.filter((s: any) => s.type !== "global").map((s: any) => ({
        type: s.type,
        objectId: s.object.objectId,
        startLine: s.startLocation ? s.startLocation.lineNumber + 1 : undefined,
        endLine: s.endLocation ? s.endLocation.lineNumber + 1 : undefined,
      })),
    }));
    onStopped(frames);
  };

  const onMessage = (ev: MessageEvent) => {
    const m = JSON.parse(ev.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); return; }
    switch (m.method) {
      case "Debugger.scriptParsed": scripts.set(m.params.scriptId, m.params.url); break;
      case "Debugger.paused": onPaused(m.params); break;
      case "Debugger.resumed": onContinued(); break;
      case "Runtime.consoleAPICalled": {
        const t = m.params.type;
        log(t === "error" ? "error" : t === "warning" ? "warn" : "log", m.params.args.map(remote).map((x: string) => x.replace(/^"(.*)"$/s, "$1")).join(" "));
        break;
      }
      case "Runtime.exceptionThrown": log("error", m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "Exception"); break;
    }
  };

  const connect = async (url: string) => {
    ws = new WebSocket(url);
    ws.onmessage = onMessage;
    ws.onclose = () => { if (!ended) { if (o.wsUrl || !procId) end("Debugger disconnected."); else log("info", "Debugger disconnected."); } };
    await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error("Could not connect to the Node inspector")); });
    await send("Runtime.enable");
    await send("Debugger.enable");
    await send("Debugger.setPauseOnExceptions", { state: "uncaught" });
    await syncAllBreakpoints(b);
    dset({ status: "running" });
    await send("Runtime.runIfWaitingForDebugger");
  };

  backend = b;
  dset({ adapter: "node" });
  if (o.wsUrl) {
    try { await connect(o.wsUrl); log("info", `Attached to ${o.wsUrl}`); }
    catch (e) { log("error", errMsg(e)); end(); }
    return;
  }
  let stderrBuf = "";
  try {
    procId = await spawnProc(o.command!, o.cwd, "raw", {
      out: (stream, data) => {
        if (stream === "stdout") return log("out", data.replace(/\r?\n$/, ""));
        stderrBuf += data;
        const m = !ws && stderrBuf.match(/Debugger listening on (ws:\/\/\S+)/);
        if (m) connect(m[1]).catch((err) => { log("error", errMsg(err)); b.stop(); });
        // The script finished; Node keeps running until the inspector detaches.
        if (/Waiting for the debugger to disconnect/.test(data)) ws?.close();
        // Hide the inspector's own chatter.
        const text = data.split(/\r?\n/).filter((l) => l && !/^(Debugger listening|For help, see|Debugger attached|Waiting for the debugger to disconnect)/.test(l)).join("\n");
        if (text) log("err", text);
      },
      exit: (code) => end(`Process exited with code ${code ?? "?"}`),
    }, o.env && Object.keys(o.env).length ? o.env : undefined);
  } catch (e) {
    log("error", errMsg(e));
    end();
  }
}

/** Asks a running inspector (`node --inspect=PORT`) for its WebSocket URL. The webview cannot
 *  fetch it directly (no CORS headers), so a tiny Node script does. */
async function inspectorUrl(address: string, port: number): Promise<string> {
  const js = `fetch('http://${address}:${port}/json/list').then(r=>r.json()).then(j=>console.log(JSON.stringify(j))).catch(e=>{console.error(e.message);process.exit(1)})`;
  const r = await runCommand(`node -e ${shellQuote(js)}`, null).done;
  if (r.code !== 0) throw new Error(`No Node inspector at ${address}:${port}. Start the program with --inspect=${port}. ${r.stderr.trim()}`);
  const list = JSON.parse(r.stdout.trim());
  const url = list.find((t: any) => t.type === "node" || t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  if (!url) throw new Error(`The inspector at ${address}:${port} has no debuggable target.`);
  return url;
}

// ----------------------------------------------------------------------------------------------
// Starting / stopping
// ----------------------------------------------------------------------------------------------

export async function refreshConfigs() {
  const configs = await loadLaunchConfigs(getApp().workspace);
  const saved = lsGet(`cepheus.launch.${getApp().workspace}`, "");
  dset({ configs, selectedConfig: configs.some((c) => c.name === saved) ? saved : configs.some((c) => c.name === dget().selectedConfig) ? dget().selectedConfig : "" });
}

export function selectConfig(name: string) {
  dset({ selectedConfig: name });
  try { localStorage.setItem(`cepheus.launch.${getApp().workspace}`, name); } catch { /* private mode */ }
}

const activeFile = () => {
  const st = getApp();
  return st.tabs.find((t) => t.id === st.activeId && t.kind === "file")?.path;
};

/** Starts a session: an explicit config, a file, the selected launch configuration, or the current file. */
export async function startDebugging(target?: string | LaunchConfig) {
  const st = getApp();
  if (dget().status !== "idle") return;
  if (st.workspace?.startsWith("ssh://")) return toast("Debugging runs locally; open a local folder.", "error");
  const file = activeFile();
  let cfg: LaunchConfig | null = null;
  if (typeof target === "object") cfg = target;
  else if (typeof target === "string") cfg = currentFileConfig(target);
  else {
    if (!dget().configs.length) await refreshConfigs();
    cfg = dget().configs.find((c) => c.name === dget().selectedConfig) ?? currentFileConfig(file ?? dget().file ?? undefined);
  }
  if (!cfg) {
    toast("Open a JavaScript, TypeScript or Python file, or add a launch configuration (gear in Run and Debug).", "error");
    return;
  }
  const { saveAll } = await import("./workspace");
  await saveAll();
  lastConfig = cfg;
  const c = resolveConfig(cfg, file);
  const cwd = c.cwd || st.workspace;
  const env = await configEnv(c);
  dset({ status: "starting", file: c.program ?? c.module ?? null, sessionName: c.name, console: [], watchValues: {} });
  setApp({ panelOpen: true, panelTab: "debug", sidebar: "debug", view: "editor" });
  if (c.console && c.console !== "internalConsole") log("info", `console: "${c.console}" is not supported; output goes to the Debug Console.`);

  try {
    if (NODE_TYPES.includes(c.type)) {
      if (c.request === "attach") {
        const address = c.address || "127.0.0.1";
        const port = c.port || 9229;
        log("info", `Attaching to ${address}:${port}…`);
        await startNode({ name: c.name, wsUrl: await inspectorUrl(address, port), cwd, file: null });
        return;
      }
      let command = c.command;
      if (!command) {
        if (!c.program) throw new Error(`Configuration "${c.name}" has no "program".`);
        const rt = c.runtimeExecutable || "node";
        command = [shellQuote(rt), "--inspect-brk=127.0.0.1:0", ...argList(c.runtimeArgs).map(shellQuote), shellQuote(c.program), ...argList(c.args).map(shellQuote)].join(" ");
      }
      log("info", command.replace(/ --inspect-brk=127\.0\.0\.1:0/, ""));
      await startNode({ name: c.name, command, cwd, env, stopOnEntry: c.stopOnEntry, file: c.program ?? null });
      return;
    }
    const { startDap } = await import("./dap");
    if (PYTHON_TYPES.includes(c.type) || c.adapterCommand) {
      backend = await startDap(c, cwd, env);
      if (backend) dset({ adapter: "dap" });
      else onSessionEnded();
      return;
    }
    throw new Error(`Debug type "${c.type}" is not supported. Use node, python, or set "adapterCommand" to a Debug Adapter Protocol server.`);
  } catch (e) {
    log("error", errMsg(e));
    toast(errMsg(e), "error");
    onSessionEnded();
  }
}

/** Internal hook for dap.ts: the backend that is now driving the session. */
export function setBackend(b: DebugBackend | null) { backend = b; }
export const currentBackend = () => backend;

export async function stopDebugging() {
  const b = backend;
  if (!b) return onSessionEnded();
  await b.stop();
  onSessionEnded();
}

export async function restartDebugging() {
  const cfg = lastConfig;
  await stopDebugging();
  setTimeout(() => startDebugging(cfg ?? undefined), 300);
}

export const resume = () => backend?.resume();
export const pause = () => backend?.pause();
export const stepOver = () => backend?.stepOver();
export const stepInto = () => backend?.stepInto();
export const stepOut = () => backend?.stepOut();

/** F5: start, or continue when paused. */
export function startOrContinue() {
  const s = dget().status;
  if (s === "idle") startDebugging();
  else if (s === "paused") resume();
}

export async function loadVariables(ref: string) {
  const vars = (await backend?.variables(ref)) ?? [];
  dset((s) => ({ vars: { ...s.vars, [ref]: vars } }));
  return vars;
}

/** Debug console REPL. */
export async function evaluate(expr: string) {
  log("input", expr);
  const s = dget();
  if (!backend || s.status === "idle") return log("error", "Start a debug session to evaluate expressions.");
  const r = await backend.evaluate(expr, s.status === "paused" ? s.frames[s.frameIndex] : undefined, "repl");
  if (!r) return log("error", "Not available.");
  log(r.error ? "error" : "result", r.value);
}

/** Hover / inline evaluation in the selected frame. */
export async function evaluateSilently(expr: string): Promise<EvalResult | null> {
  const s = dget();
  if (!backend || s.status !== "paused") return null;
  return backend.evaluate(expr, s.frames[s.frameIndex], "hover");
}

export function selectFrame(i: number) {
  const f = dget().frames[i];
  if (!f) return;
  dset({ frameIndex: i });
  import("./workspace").then((w) => w.openFile(f.path, f.line, f.col));
  for (const s of f.scopes.filter((x) => !x.expensive).slice(0, 3)) if (!dget().vars[s.objectId]) loadVariables(s.objectId);
  evaluateWatches();
}

// ----------------------------------------------------------------------------------------------
// Watch expressions
// ----------------------------------------------------------------------------------------------

const saveWatches = (w: string[]) => { dset({ watches: w }); try { localStorage.setItem("cepheus.watches", JSON.stringify(w)); } catch { /* ignore */ } };

export async function evaluateWatches() {
  const s = dget();
  if (!backend || s.status !== "paused") return dset({ watchValues: {} });
  const frame = s.frames[s.frameIndex];
  const out: Record<string, EvalResult> = {};
  for (const w of s.watches) out[w] = (await backend.evaluate(w, frame, "watch")) ?? { value: "not available", type: "", error: true };
  dset({ watchValues: out });
}

export function addWatch(expr: string) {
  const e = expr.trim();
  if (!e || dget().watches.includes(e)) return;
  saveWatches([...dget().watches, e]);
  evaluateWatches();
}
export function editWatch(old: string, expr: string) {
  const e = expr.trim();
  if (!e) return removeWatch(old);
  saveWatches(dget().watches.map((w) => (w === old ? e : w)));
  evaluateWatches();
}
export function removeWatch(expr: string) { saveWatches(dget().watches.filter((w) => w !== expr)); }
export function clearWatches() { saveWatches([]); dset({ watchValues: {} }); }

// ----------------------------------------------------------------------------------------------
// Breakpoints
// ----------------------------------------------------------------------------------------------

function saveBps(bps: Record<string, Breakpoint[]>, changed: string[]) {
  dset({ breakpoints: bps });
  try { localStorage.setItem("cepheus.breakpoints", JSON.stringify(bps)); } catch { /* ignore */ }
  for (const p of changed) backend?.setBreakpoints(p, effectiveBreakpoints(p));
}

/** Adds, updates (with `patch`) or — when `patch` is null — removes the breakpoint at a line. */
export function updateBreakpoint(path: string, line: number, patch: Partial<Breakpoint> | null) {
  const k = Object.keys(dget().breakpoints).find((p) => p.toLowerCase() === norm(path).toLowerCase()) ?? norm(path);
  const cur = dget().breakpoints[k] ?? [];
  const existing = cur.find((b) => b.line === line);
  let next: Breakpoint[];
  if (patch === null) next = cur.filter((b) => b.line !== line);
  else if (existing) next = cur.map((b) => (b.line === line ? { ...b, ...patch } : b));
  else next = [...cur, { line, enabled: true, ...patch }].sort((a, b) => a.line - b.line);
  // Empty strings mean "no condition".
  next = next.map((b) => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== "" && v !== undefined)) as unknown as Breakpoint);
  const bps = { ...dget().breakpoints, [k]: next };
  if (!next.length) delete bps[k];
  saveBps(bps, [k]);
}

export const getBreakpoint = (path: string, line: number) => findBps(path)?.find((b) => b.line === line);
export const fileBreakpoints = (path: string) => findBps(path) ?? [];

/** Lines moved by edits above them (from sticky gutter decorations). */
export function replaceFileBreakpoints(path: string, bps: Breakpoint[]) {
  const k = Object.keys(dget().breakpoints).find((p) => p.toLowerCase() === norm(path).toLowerCase()) ?? norm(path);
  const seen = new Set<number>();
  const next = bps.filter((b) => !seen.has(b.line) && seen.add(b.line)).sort((a, b) => a.line - b.line);
  saveBps({ ...dget().breakpoints, [k]: next }, [k]);
}

export function toggleBreakpoint(path: string, line: number) {
  updateBreakpoint(path, line, getBreakpoint(path, line) ? null : {});
}

export function setAllBreakpointsEnabled(enabled: boolean) {
  const bps = Object.fromEntries(Object.entries(dget().breakpoints).map(([p, l]) => [p, l.map((b) => ({ ...b, enabled }))]));
  saveBps(bps, Object.keys(bps));
}

export function toggleBreakpointsActive() {
  const on = !dget().breakpointsActive;
  dset({ breakpointsActive: on });
  try { localStorage.setItem("cepheus.breakpointsActive", on ? "1" : "0"); } catch { /* ignore */ }
  syncAllBreakpoints();
}

export function clearBreakpoints() {
  const paths = Object.keys(dget().breakpoints);
  dset({ breakpoints: {} });
  try { localStorage.setItem("cepheus.breakpoints", "{}"); } catch { /* ignore */ }
  for (const p of paths) backend?.setBreakpoints(p, []);
}

/** F9 on the cursor line. */
export function toggleBreakpointAtCursor(ed: monaco.editor.ICodeEditor | null) {
  const model = ed?.getModel();
  const pos = ed?.getPosition();
  if (model && pos && model.uri.scheme === "file") toggleBreakpoint(model.uri.fsPath, pos.lineNumber);
}

/** Opens the inline condition/logpoint editor at the cursor line. */
export async function editBreakpointAtCursor(ed: monaco.editor.ICodeEditor | null, kind: "condition" | "log") {
  const pos = ed?.getPosition();
  if (!ed || !pos) return;
  (await import("./debugEditor")).openBreakpointWidget(ed, pos.lineNumber, kind);
}

/** Gutter, inline values, floating toolbar and the testing decorations for the main editor. */
export function attachDebugGutter(ed: monaco.editor.IStandaloneCodeEditor) {
  let detach: (() => void) | null = null;
  let disposed = false;
  Promise.all([import("./debugEditor"), import("./testingEditor")]).then(([d, t]) => {
    if (disposed) return;
    const a = d.attachDebugEditor(ed);
    const b = t.attachTestingEditor(ed);
    detach = () => { a(); b(); };
  }).catch((e) => console.error("debug editor", e));
  return () => { disposed = true; detach?.(); };
}

