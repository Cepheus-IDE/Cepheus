//! Generic Debug Adapter Protocol client. Adapters run as child processes speaking DAP over
//! stdio with the same Content-Length framing as LSP (procs.rs "lsp" mode). Implements the
//! shared DebugBackend so the Run and Debug view works the same for every adapter.
//! Built in: Python via debugpy (`python -m debugpy.adapter`). Any other adapter can be used
//! with `"adapterCommand": "<command line>"` in a launch configuration.

import { api, errMsg } from "./api";
import { spawnProc, runCommand } from "./procBus";
import { toast } from "../store";
import { LaunchConfig, PYTHON_TYPES, argList } from "./launch";
import {
  Breakpoint, DebugBackend, EvalResult, Frame, Variable, log, norm, onContinued, onSessionEnded, onStopped,
  setBackend, syncAllBreakpoints, currentBackend, useDebug,
} from "./debugger";

const isWin = navigator.userAgent.includes("Windows");
const nativePath = (p: string) => (isWin ? p.replace(/\//g, "\\") : p);

class DapClient {
  id = 0;
  private seq = 0;
  private pending = new Map<number, { ok: (b: any) => void; err: (e: Error) => void }>();
  private waiters = new Map<string, ((body: any) => void)[]>();
  onEvent: (event: string, body: any) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  stderr = "";

  async start(command: string, cwd: string | null) {
    this.id = await spawnProc(command, cwd, "lsp", {
      msg: (m) => this.handle(m),
      out: (stream, data) => { if (stream === "stderr") { this.stderr += data; } },
      exit: (code) => {
        this.pending.forEach((p) => p.err(new Error(`Debug adapter exited (${code ?? "?"}). ${this.stderr.trim().slice(-500)}`)));
        this.pending.clear();
        this.onExit(code);
      },
    });
  }

  request(command: string, args?: any): Promise<any> {
    const seq = ++this.seq;
    return new Promise((ok, err) => {
      this.pending.set(seq, { ok, err });
      api.procWrite(this.id, JSON.stringify({ seq, type: "request", command, arguments: args }), true).catch((e) => {
        this.pending.delete(seq);
        err(new Error(errMsg(e)));
      });
    });
  }

  /** Resolves on the next occurrence of `event`. */
  once(event: string): Promise<any> {
    return new Promise((r) => this.waiters.set(event, [...(this.waiters.get(event) ?? []), r]));
  }

  private respond(req: any, success: boolean, body?: any, message?: string) {
    api.procWrite(this.id, JSON.stringify({ seq: ++this.seq, type: "response", request_seq: req.seq, command: req.command, success, body, message }), true).catch(() => {});
  }

  private handle(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "response") {
      const p = this.pending.get(m.request_seq);
      if (!p) return;
      this.pending.delete(m.request_seq);
      if (m.success) p.ok(m.body ?? {});
      else p.err(new Error(m.body?.error?.format ?? m.message ?? `${m.command} failed`));
    } else if (m.type === "event") {
      const ws = this.waiters.get(m.event);
      if (ws) { this.waiters.delete(m.event); ws.forEach((w) => w(m.body ?? {})); }
      this.onEvent(m.event, m.body ?? {});
    } else if (m.type === "request") {
      // Reverse requests (runInTerminal, startDebugging): not supported; output stays in the Debug Console.
      this.respond(m, false, undefined, `${m.command} is not supported by Cepheus`);
    }
  }
}

/** Finds a Python with debugpy, or explains how to get one. */
async function findPython(preferred?: string): Promise<string | null> {
  const candidates = preferred ? [preferred] : isWin ? ["python", "py -3", "python3"] : ["python3", "python"];
  let noDebugpy: string | null = null;
  for (const py of candidates) {
    const r = await runCommand(`${py} -c "import sys; import debugpy; print(sys.executable)"`, null).done;
    const out = r.stdout + r.stderr;
    if (r.code === 0) return py;
    // The Windows Store alias prints this instead of running anything.
    if (/Python was not found|is not recognized|not found|No such file|9009/i.test(out) && !/No module named/i.test(out)) continue;
    if (/No module named '?debugpy/i.test(out)) { noDebugpy = py; continue; }
  }
  if (noDebugpy) {
    toast(`debugpy is not installed for "${noDebugpy}". Run: ${noDebugpy} -m pip install debugpy`, "error");
    log("error", `debugpy is missing. Install it with:\n  ${noDebugpy} -m pip install debugpy`);
  } else {
    toast("Python was not found. Install Python 3 (python.org), then run: python -m pip install debugpy", "error");
    log("error", "Python was not found on PATH.\nInstall Python 3 from https://www.python.org/downloads/ (tick \"Add python.exe to PATH\"), then:\n  python -m pip install debugpy\nOr set \"python\": \"C:/path/to/python.exe\" in the launch configuration.");
  }
  return null;
}

/** Builds the adapter-specific launch/attach arguments. */
function requestArgs(c: LaunchConfig, cwd: string | null, env: Record<string, string>, python: string | null): any {
  const { source, adapterCommand, command, ...rest } = c;
  void source; void adapterCommand; void command;
  if (PYTHON_TYPES.includes(c.type)) {
    if (c.request === "attach") {
      const host = c.connect?.host ?? c.host ?? c.address ?? "127.0.0.1";
      const port = c.connect?.port ?? c.port ?? 5678;
      return { ...rest, type: "python", connect: { host, port }, justMyCode: c.justMyCode ?? true };
    }
    return {
      ...rest,
      type: "python",
      program: c.program ? nativePath(c.program) : undefined,
      module: c.module,
      args: argList(c.args),
      cwd: cwd ? nativePath(cwd) : undefined,
      env,
      console: "internalConsole",
      stopOnEntry: !!c.stopOnEntry,
      justMyCode: c.justMyCode ?? true,
      ...(python && c.python ? { python: [c.python] } : {}),
    };
  }
  return { ...rest, cwd: cwd ?? undefined, env };
}

/** Starts a DAP session; returns its backend, or null when it could not start. */
export async function startDap(c: LaunchConfig, cwd: string | null, env: Record<string, string>): Promise<DebugBackend | null> {
  let adapterCmd = c.adapterCommand;
  let python: string | null = null;
  if (!adapterCmd && PYTHON_TYPES.includes(c.type)) {
    log("info", "Looking for Python with debugpy…");
    python = await findPython(c.python);
    if (!python) return null;
    adapterCmd = `${python} -m debugpy.adapter`;
  }
  if (!adapterCmd) throw new Error(`No debug adapter for type "${c.type}".`);

  const dap = new DapClient();
  let threadId = 0;
  let ended = false;
  let caps: any = {};

  const end = (msg?: string) => {
    if (ended) return;
    ended = true;
    if (msg) log("info", msg);
    if (currentBackend() === b) onSessionEnded();
    setTimeout(() => api.procKill(dap.id).catch(() => {}), 1500);
  };

  const stackFrames = async (tid: number): Promise<Frame[]> => {
    const st = await dap.request("stackTrace", { threadId: tid, startFrame: 0, levels: 50 }).catch(() => ({ stackFrames: [] }));
    const frames: Frame[] = [];
    for (const [i, f] of (st.stackFrames ?? []).entries()) {
      const scopes = i < 20 ? await dap.request("scopes", { frameId: f.id }).then((r) => r.scopes ?? []).catch(() => []) : [];
      frames.push({
        id: String(f.id),
        name: f.name,
        path: f.source?.path ? norm(f.source.path) : f.source?.name ?? "",
        line: f.line,
        col: f.column || 1,
        scopes: scopes.map((s: any) => ({
          type: String(s.presentationHint ?? s.name).toLowerCase() === "locals" ? "local" : String(s.name).toLowerCase(),
          objectId: String(s.variablesReference),
          startLine: s.line,
          endLine: s.endLine,
          expensive: !!s.expensive,
        })),
      });
    }
    return frames;
  };

  dap.onEvent = async (event, body) => {
    switch (event) {
      case "stopped":
        threadId = body.threadId ?? threadId;
        if (!threadId) threadId = (await dap.request("threads").catch(() => ({ threads: [] }))).threads?.[0]?.id ?? 0;
        onStopped(await stackFrames(threadId));
        break;
      case "continued": onContinued(); break;
      case "output": {
        const cat = body.category ?? "console";
        if (cat === "telemetry") break;
        const text = String(body.output ?? "").replace(/\r?\n$/, "");
        if (text) log(cat === "stderr" ? "err" : cat === "stdout" ? "out" : cat === "important" ? "warn" : "info", text);
        break;
      }
      case "thread": if (body.reason === "started" && !threadId) threadId = body.threadId; break;
      case "exited": log("info", `Process exited with code ${body.exitCode ?? "?"}`); break;
      case "terminated": end(); break;
    }
  };
  dap.onExit = () => end();

  const b: DebugBackend = {
    resume: () => void dap.request("continue", { threadId }).then(() => onContinued()).catch((e) => log("error", errMsg(e))),
    pause: () => void dap.request("pause", { threadId }).catch((e) => log("error", errMsg(e))),
    stepOver: () => void dap.request("next", { threadId }).catch((e) => log("error", errMsg(e))),
    stepInto: () => void dap.request("stepIn", { threadId }).catch((e) => log("error", errMsg(e))),
    stepOut: () => void dap.request("stepOut", { threadId }).catch((e) => log("error", errMsg(e))),
    async evaluate(expression, frame, context): Promise<EvalResult | null> {
      try {
        const r = await dap.request("evaluate", { expression, frameId: frame ? +frame.id : undefined, context });
        return { value: r.result ?? "", type: r.type ?? "", objectId: r.variablesReference ? String(r.variablesReference) : undefined };
      } catch (e) {
        return { value: errMsg(e), type: "error", error: true };
      }
    },
    async variables(ref): Promise<Variable[]> {
      const r = await dap.request("variables", { variablesReference: +ref }).catch(() => ({ variables: [] }));
      return (r.variables ?? []).map((v: any) => ({
        name: v.name, value: v.value, type: v.type ?? "", objectId: v.variablesReference ? String(v.variablesReference) : undefined,
      }));
    },
    async setBreakpoints(path, bps: Breakpoint[]) {
      if (ended) return;
      // Only send files the adapter could own (avoid sending .ts breakpoints to debugpy).
      if (PYTHON_TYPES.includes(c.type) && !/\.py$/i.test(path)) return;
      await dap.request("setBreakpoints", {
        source: { path: nativePath(path) },
        breakpoints: bps.map((x) => ({
          line: x.line,
          ...(x.condition && caps.supportsConditionalBreakpoints !== false ? { condition: x.condition } : {}),
          ...(x.hitCondition && caps.supportsHitConditionalBreakpoints !== false ? { hitCondition: x.hitCondition } : {}),
          ...(x.logMessage && caps.supportsLogPoints !== false ? { logMessage: x.logMessage } : {}),
        })),
        lines: bps.map((x) => x.line),
      }).catch((e) => log("warn", `Breakpoints for ${path}: ${errMsg(e)}`));
    },
    async stop() {
      if (ended) return;
      await Promise.race([dap.request("disconnect", { terminateDebuggee: c.request !== "attach" }).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      end();
    },
  };

  log("info", `${adapterCmd}`);
  await dap.start(adapterCmd, cwd);
  setBackend(b);
  try {
    caps = await dap.request("initialize", {
      clientID: "cepheus", clientName: "Cepheus IDE", adapterID: c.type, locale: "en",
      linesStartAt1: true, columnsStartAt1: true, pathFormat: "path",
      supportsVariableType: true, supportsRunInTerminalRequest: false, supportsProgressReporting: false,
    });
    const initialized = dap.once("initialized");
    const launched = dap.request(c.request === "attach" ? "attach" : "launch", requestArgs(c, cwd, env, python));
    launched.catch(() => {});
    // Adapters send `initialized` once they accept configuration; some answer launch only after configurationDone.
    await Promise.race([initialized, launched.then(() => initialized)]);
    await syncAllBreakpoints(b);
    await dap.request("setExceptionBreakpoints", { filters: PYTHON_TYPES.includes(c.type) ? ["uncaught"] : [] }).catch(() => {});
    if (caps?.supportsConfigurationDoneRequest !== false) await dap.request("configurationDone").catch(() => {});
    await launched;
    if (useDebug.getState().status === "starting") useDebug.setState({ status: "running" });
    log("info", c.request === "attach" ? "Attached." : "Started.");
    return b;
  } catch (e) {
    log("error", errMsg(e));
    await b.stop();
    return null;
  }
}
