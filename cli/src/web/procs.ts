/**
 * Terminals (term_*) and stdio processes (proc_*, which) for `cepheus web`, mirroring
 * src-tauri/src/terminal.rs and procs.rs. Terminals use node-pty when it can be resolved;
 * otherwise a "basic terminal": the shell runs with pipes and the server does line editing.
 */
import { spawn, spawnSync, execFile, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import * as os from "node:os";

type Emit = (event: string, payload: unknown) => void;

let ptyMod: any | undefined;
/** node-pty if installed next to the CLI (optional), else null. */
export function loadPty(): any | null {
  if (ptyMod !== undefined) return ptyMod;
  try {
    ptyMod = createRequire(import.meta.url)("node-pty");
  } catch {
    ptyMod = null;
  }
  return ptyMod;
}

function hasOnPath(name: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { windowsHide: true, stdio: "ignore" });
  return r.status === 0;
}

function defaultShell(): string {
  if (process.platform === "win32") return hasOnPath("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
  return process.env.SHELL || "/bin/bash";
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* not a group leader */
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

interface Term {
  owner: unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface Proc {
  owner: unknown;
  child: ChildProcess;
}

export class ProcManager {
  private terms = new Map<number, Term>();
  private procs = new Map<number, Proc>();
  private nextTerm = 0;
  private nextProc = 0;

  constructor(private emit: Emit, private confineCwd: (p: unknown) => string, private defaultCwd: string) {}

  get ptyAvailable() {
    return !!loadPty();
  }

  // ------------------------------------------------------------------------------------------
  // Terminals
  // ------------------------------------------------------------------------------------------

  termSpawn(owner: unknown, a: { cwd?: string | null; cols?: number; rows?: number; shell?: string | null; args?: string[] | null }): number {
    const cwd = a.cwd ? this.confineCwd(a.cwd) : this.defaultCwd;
    const shell = a.shell && a.shell.trim() ? a.shell : defaultShell();
    const args = a.args ?? [];
    const id = ++this.nextTerm;
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
    const pty = loadPty();
    if (pty) {
      const p = pty.spawn(shell, args, { name: "xterm-256color", cols: Math.max(2, a.cols ?? 80), rows: Math.max(2, a.rows ?? 24), cwd, env });
      p.onData((data: string) => this.emit("term-data", { id, data }));
      p.onExit(() => {
        this.terms.delete(id);
        this.emit("term-exit", id);
      });
      this.terms.set(id, {
        owner,
        write: (d) => p.write(d),
        resize: (c, r) => p.resize(Math.max(2, c), Math.max(2, r)),
        kill: () => p.kill(),
      });
      return id;
    }
    this.terms.set(id, this.basicTerm(id, owner, shell, args, cwd, env));
    return id;
  }

  /** Pipe-based terminal: local echo + line editing, output with CRLF for xterm. */
  private basicTerm(id: number, owner: unknown, shell: string, args: string[], cwd: string, env: Record<string, string>): Term {
    const isPs = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell);
    const isCmd = /(^|[\\/])cmd(\.exe)?$/i.test(shell);
    let shellArgs = args;
    if (!args.length) {
      if (isPs) shellArgs = ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"];
      else if (isCmd) shellArgs = ["/Q", "/K"];
      else if (/(^|\/)(bash|zsh)$/.test(shell)) shellArgs = ["-i"];
    }
    const child = spawn(shell, shellArgs, { cwd, env, windowsHide: true, stdio: "pipe", detached: process.platform !== "win32" });
    const out = (s: string) => this.emit("term-data", { id, data: s.replace(/\r?\n/g, "\r\n") });
    const promptCmd = isPs ? `Write-Host -NoNewline ("PS " + (Get-Location).Path + "> ")\n` : "";
    const dec1 = new StringDecoder("utf8");
    const dec2 = new StringDecoder("utf8");
    child.stdout?.on("data", (d: Buffer) => out(dec1.write(d)));
    child.stderr?.on("data", (d: Buffer) => out(dec2.write(d)));
    let exited = false;
    const onExit = () => {
      if (exited) return;
      exited = true;
      this.terms.delete(id);
      this.emit("term-exit", id);
    };
    child.on("exit", onExit);
    child.on("error", (e) => {
      out(`\r\n[Cepheus Web] Could not start ${shell}: ${e.message}\r\n`);
      onExit();
    });
    this.emit("term-data", {
      id,
      data: "\x1b[2m[Cepheus Web] Basic terminal: node-pty is not installed, so full-screen programs, Tab completion and arrow-key history are unavailable. Install node-pty next to the CLI for a real terminal.\x1b[0m\r\n",
    });
    if (promptCmd) child.stdin?.write(promptCmd);
    let line = "";
    const send = (s: string) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(s);
    };
    return {
      owner,
      write: (data: string) => {
        for (const ch of Array.from(data)) {
          if (ch === "\r" || ch === "\n") {
            this.emit("term-data", { id, data: "\r\n" });
            send(line + "\n" + promptCmd);
            line = "";
          } else if (ch === "\x7f" || ch === "\b") {
            if (line) {
              line = Array.from(line).slice(0, -1).join("");
              this.emit("term-data", { id, data: "\b \b" });
            }
          } else if (ch === "\x03") {
            this.emit("term-data", { id, data: "^C\r\n" });
            line = "";
            if (process.platform !== "win32" && child.pid) {
              try {
                process.kill(-child.pid, "SIGINT");
              } catch {
                /* ignore */
              }
            }
            send(promptCmd);
          } else if (ch === "\x1b" || ch < " ") {
            // escape sequences / control keys are not supported in the basic terminal
          } else {
            line += ch;
            this.emit("term-data", { id, data: ch });
          }
        }
      },
      resize: () => {},
      kill: () => killTree(child.pid),
    };
  }

  termWrite(id: number, data: string) {
    const t = this.terms.get(Number(id));
    if (!t) throw new Error("terminal not found");
    t.write(String(data ?? ""));
    return null;
  }

  termResize(id: number, cols: number, rows: number) {
    const t = this.terms.get(Number(id));
    if (!t) throw new Error("terminal not found");
    t.resize(Number(cols) || 80, Number(rows) || 24);
    return null;
  }

  termKill(id: number) {
    const t = this.terms.get(Number(id));
    this.terms.delete(Number(id));
    t?.kill();
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // Processes (LSP servers, debug adapters, tasks)
  // ------------------------------------------------------------------------------------------

  procSpawn(owner: unknown, a: { command: string; cwd?: string | null; mode?: string; env?: Record<string, string> | null }): number {
    const command = String(a.command ?? "");
    if (!command.trim()) throw new Error("Missing command");
    const cwd = a.cwd && !String(a.cwd).startsWith("ssh://") ? this.confineCwd(a.cwd) : this.defaultCwd;
    const env = { ...process.env, ...(a.env ?? {}) };
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/D", "/S", "/C", `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true, stdio: "pipe" })
        : spawn("/bin/sh", ["-c", command], { cwd, env, stdio: "pipe", detached: true });
    const id = ++this.nextProc;
    let spawnError: string | null = null;
    child.on("error", (e) => {
      spawnError = e.message;
    });
    if (a.mode === "lsp") {
      let buf = Buffer.alloc(0);
      child.stdout!.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) break;
          const header = buf.subarray(0, sep).toString("ascii");
          const m = /content-length:\s*(\d+)/i.exec(header);
          if (!m) {
            buf = buf.subarray(sep + 4); // headers without a length: skip them (like the desktop reader)
            continue;
          }
          const len = Number(m[1]);
          if (buf.length < sep + 4 + len) break;
          const msg = buf.subarray(sep + 4, sep + 4 + len).toString("utf8");
          buf = buf.subarray(sep + 4 + len);
          this.emit("proc-msg", { id, msg });
        }
      });
    } else {
      const dec = new StringDecoder("utf8");
      child.stdout!.on("data", (d: Buffer) => this.emit("proc-out", { id, stream: "stdout", data: dec.write(d) }));
    }
    const decErr = new StringDecoder("utf8");
    child.stderr!.on("data", (d: Buffer) => this.emit("proc-out", { id, stream: "stderr", data: decErr.write(d) }));
    child.on("close", (code) => {
      this.procs.delete(id);
      if (spawnError) this.emit("proc-out", { id, stream: "stderr", data: `Failed to start \`${command}\`: ${spawnError}\n` });
      this.emit("proc-exit", { id, code: typeof code === "number" ? code : null });
    });
    child.stdin!.on("error", () => {});
    this.procs.set(id, { owner, child });
    return id;
  }

  procWrite(id: number, data: string, framed: boolean) {
    const p = this.procs.get(Number(id));
    if (!p || !p.child.stdin || p.child.stdin.destroyed) throw new Error("process not running");
    const s = String(data ?? "");
    p.child.stdin.write(framed ? `Content-Length: ${Buffer.byteLength(s, "utf8")}\r\n\r\n${s}` : s);
    return null;
  }

  procKill(id: number) {
    const p = this.procs.get(Number(id));
    this.procs.delete(Number(id));
    if (p) killTree(p.child.pid);
    return null;
  }

  which(names: string[]) {
    return (names ?? []).filter((n) => typeof n === "string" && /^[\w.+-]+$/.test(n) && hasOnPath(n));
  }

  /** Kills what a disconnected client started (the app restarts its servers after a reload). */
  disposeOwner(owner: unknown) {
    for (const [id, t] of this.terms) if (t.owner === owner) this.termKill(id);
    for (const [id, p] of this.procs) if (p.owner === owner) this.procKill(id);
  }

  disposeAll() {
    for (const id of [...this.terms.keys()]) this.termKill(id);
    for (const id of [...this.procs.keys()]) this.procKill(id);
  }
}

export const osLabel = () =>
  process.platform === "win32" ? "Windows (commands run in PowerShell)" : process.platform === "darwin" ? "macOS" : os.type();
