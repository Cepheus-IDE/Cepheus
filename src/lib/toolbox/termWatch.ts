//! Watches terminal output (`term-data`) for two everyday problems: a port that is already in use
//! ("Free port 3000") and a failed command ("Explain with agent"). Keeps the last lines per terminal.

import { listen } from "@tauri-apps/api/event";
import { DONE_RE } from "../terminalBus";
import { detectPortInUse } from "./portsParse";
import { pushNotice } from "./state";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Lines that mean "this failed" in common toolchains (anchored to avoid matching echoed commands). */
const ERROR_LINE = [
  /^\s*(?:\w+ )?(?:error|Error|ERROR)(?:\[[\w-]+\])?:\s/, // error: / Error: / error[E0308]: / ERROR:
  /:\d+(?::\d+)?:\s+(?:fatal )?error:/, // gcc/clang/go file:line:col: error:
  /\(\d+,\d+\): error TS\d+:/, // tsc
  /^\s*(?:Uncaught )?[A-Z]\w*(?:Error|Exception):\s/, // TypeError: / ModuleNotFoundError: / IOException:
  /^Traceback \(most recent call last\):/, // Python
  /panicked at /, // Rust
  /^panic: /, // Go
  /^Exception in thread "/, // Java
  /^Unhandled(?:Promise)?Rejection|^\s*at .+\(.+:\d+:\d+\)$/, // Node unhandled / stack frame
  /^npm (?:ERR!|error) /, // npm
  /ERR_PNPM_|^error Command failed with exit code/, // pnpm / yarn
  /: command not found$|is not recognized as an internal or external command/,
];

export function lastLines(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n");
}

const buffers = new Map<number, string>();
const cooldown = new Map<string, number>();
let lastFailed: number | null = null;
let lastActive: number | null = null;

/** Output of the terminal that failed most recently (else the one that printed last). */
export function lastFailureOutput(): string {
  const id = lastFailed ?? lastActive;
  return id === null ? "" : terminalTail(id);
}

/** Last ~80 lines of a terminal's output (ANSI stripped). */
export function terminalTail(id: number, lines = 80): string {
  return lastLines(buffers.get(id) ?? "", lines);
}

function cool(key: string, ms: number): boolean {
  const now = Date.now();
  if ((cooldown.get(key) ?? 0) > now) return false;
  cooldown.set(key, now + ms);
  return true;
}

export async function watchTerminals(): Promise<() => void> {
  const timers = new Map<number, number>();
  const pendingError = new Map<number, boolean>();
  const un = await listen<{ id: number; data: string }>("term-data", (e) => {
    const { id, data } = e.payload;
    // Normalize carriage-return redraws (progress bars) to the final text of each line.
    const clean = data.replace(ANSI, "").replace(/\r\n/g, "\n").replace(/[^\n]*\r(?!\n)/g, "");
    const buf = ((buffers.get(id) ?? "") + clean).slice(-24000);
    buffers.set(id, buf);
    lastActive = id;

    const port = detectPortInUse(buf.slice(-clean.length - 300));
    if (port && cool(`port:${port}`, 30000)) {
      pushNotice({ kind: "port", port, text: `Port ${port} is already in use` }, 30000);
      return;
    }
    const lines = clean.split("\n");
    const done = clean.match(DONE_RE);
    const failed = (done && Number(done[1]) !== 0) || lines.some((l) => ERROR_LINE.some((re) => re.test(l)));
    if (failed) { pendingError.set(id, true); lastFailed = id; }
    // Wait until the output settles so the agent gets the whole error, not its first line.
    if (pendingError.get(id)) {
      clearTimeout(timers.get(id));
      timers.set(id, window.setTimeout(() => {
        pendingError.delete(id);
        if (!cool(`err:${id}`, 45000)) return;
        pushNotice({ kind: "error", text: "A terminal command failed", output: terminalTail(id) }, 25000);
      }, 1200));
    }
  });
  const unExit = await listen<number>("term-exit", (e) => {
    buffers.delete(e.payload);
    if (lastFailed === e.payload) lastFailed = null;
    if (lastActive === e.payload) lastActive = null;
  });
  return () => { un(); unExit(); timers.forEach((t) => clearTimeout(t)); };
}
