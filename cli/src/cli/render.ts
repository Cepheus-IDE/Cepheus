/** Terminal rendering of agent events: streaming text, compact tool lines, mini diffs, plans. */
import type { AgentEvent, PlanItem } from "../core/types.js";
import { diffStats, hunks } from "../core/diff.js";
import { c, sym, termWidth } from "./ansi.js";

export type Out = { write(s: string): any };

function oneLine(s: string, max = 80): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Colored unified-style diff, limited to `maxLines` lines. */
export function formatDiff(before: string | null, after: string, maxLines = 14, context = 1): string {
  const hs = hunks(before, after, context);
  const width = termWidth() - 4;
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const h of hs) total += h.lines.length;
  for (let hi = 0; hi < hs.length; hi++) {
    const h = hs[hi];
    if (hi > 0) lines.push(c.gray("    ⋯"));
    for (const op of h.lines) {
      if (shown >= maxLines) break;
      const no = op.kind === "del" ? op.oldLine : op.newLine;
      const num = c.gray(String(no ?? "").padStart(4) + " ");
      const text = op.text.length > width - 6 ? op.text.slice(0, width - 7) + "…" : op.text;
      if (op.kind === "add") lines.push(num + c.green("+ " + text));
      else if (op.kind === "del") lines.push(num + c.red("- " + text));
      else lines.push(num + c.dim("  " + text));
      shown++;
    }
    if (shown >= maxLines) break;
  }
  if (total > shown) lines.push(c.gray(`     … ${total - shown} more diff lines (/diff to see all)`));
  return lines.map((l) => "    " + l).join("\n");
}

export function formatPlan(items: PlanItem[]): string {
  return items
    .map((it) => {
      if (it.status === "done") return `  ${c.green(sym.done)} ${c.dim(it.text)}`;
      if (it.status === "in_progress") return `  ${c.yellow(sym.doing)} ${c.bold(it.text)}`;
      return `  ${c.gray(sym.todo)} ${it.text}`;
    })
    .join("\n");
}

function exitCodeOf(output: string): number | null {
  const m = /^Exit code: (-?\d+)/.exec(output);
  return m ? parseInt(m[1], 10) : null;
}

function lastLines(s: string, n: number): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** A small spinner shown while the model or a tool is working (TTY only). */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  constructor(private out: NodeJS.WriteStream) {}
  start(label: string) {
    if (!this.out.isTTY) return;
    this.label = label;
    if (this.timer) return;
    const frames = process.platform === "win32" ? ["-", "\\", "|", "/"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.timer = setInterval(() => {
      this.out.write(`\r${c.cyan(frames[this.frame++ % frames.length])} ${c.dim(this.label)}\x1b[K`);
    }, 90);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.out.write("\r\x1b[K");
  }
}

export interface RenderOptions {
  verbose?: boolean;
  /** Show the mini diff after each edit (default true). */
  diffs?: boolean;
}

/** Turns agent events into terminal output. */
export class TerminalRenderer {
  private calls = new Map<string, { name: string; args: any }>();
  private pendingChange: { path: string; before: string | null; after: string } | null = null;
  private lastContext = "";
  private streaming = false;
  private atLineStart = true;
  readonly spinner: Spinner;
  usage = { input: 0, output: 0 };
  /** True when the current message's text arrived as deltas. */
  private streamedText = false;

  constructor(
    private out: NodeJS.WriteStream,
    private opts: RenderOptions = {},
  ) {
    this.spinner = new Spinner(out);
  }

  private write(s: string) {
    this.spinner.stop();
    if (!s) return;
    this.out.write(s);
    this.atLineStart = s.endsWith("\n");
  }

  private line(s: string) {
    this.endStream();
    if (!this.atLineStart) this.write("\n");
    this.write(s + "\n");
  }

  private endStream() {
    if (this.streaming) {
      this.streaming = false;
      if (!this.atLineStart) this.write("\n");
    }
  }

  /** Ensures following output starts on a fresh line. */
  flush() {
    this.spinner.stop();
    this.endStream();
    if (!this.atLineStart) this.write("\n");
  }

  handle(ev: AgentEvent) {
    switch (ev.type) {
      case "status":
        if (ev.status === "running") this.spinner.start("working…");
        else this.spinner.stop();
        break;
      case "textDelta":
        if (!this.streaming) {
          this.spinner.stop();
          if (!this.atLineStart) this.write("\n");
          this.streaming = true;
        }
        this.write(ev.text);
        this.streamedText = true;
        break;
      case "text":
        // Providers may emit thinking between the deltas and the final text,
        // which ends the stream early; the text was still printed already.
        if (this.streaming || this.streamedText) this.endStream();
        else this.line(ev.text.trimEnd());
        this.streamedText = false;
        break;
      case "thinking": {
        if (this.opts.verbose) this.line(c.gray(c.italic(`${sym.think} ${ev.text.trim()}`)));
        else this.line(c.gray(c.italic(`${sym.think} ${oneLine(ev.text, termWidth() - 6)}`)));
        break;
      }
      case "toolCall":
        this.calls.set(ev.callId, { name: ev.name, args: ev.args });
        if (ev.name === "run_command") this.spinner.start(`running ${oneLine(ev.args?.command ?? "", 60)}`);
        else this.spinner.start(ev.name);
        break;
      case "approvalRequest":
        this.spinner.stop();
        break;
      case "fileChanged":
        this.pendingChange = { path: ev.relPath, before: ev.before, after: ev.after };
        break;
      case "toolResult":
        this.toolLine(ev.callId, ev.name, ev.output, ev.isError);
        this.spinner.start("working…");
        break;
      case "plan":
        if (ev.items.length) this.line(c.bold("Plan") + "\n" + formatPlan(ev.items));
        break;
      case "warning":
        this.line(c.yellow(`${sym.warn} ${ev.message}`));
        break;
      case "error":
        this.line(c.red(`${sym.fail} ${ev.message}`));
        break;
      case "usage":
        this.usage.input += ev.inputTokens;
        this.usage.output += ev.outputTokens;
        break;
      case "steered":
        this.line(c.gray(`↳ sent to the agent: ${oneLine(ev.text)}`));
        break;
      case "context": {
        const bits: string[] = [];
        if (ev.instructions.length) bits.push(`instructions: ${ev.instructions.join(", ")}`);
        if (ev.skills.length) bits.push(`skills: ${ev.skills.length}`);
        if (ev.mcpTools) bits.push(`MCP tools: ${ev.mcpTools}`);
        if (ev.agent) bits.push(`agent: ${ev.agent}`);
        if (ev.planMode) bits.push("plan mode (read-only)");
        const text = bits.join(` ${sym.dot} `);
        if (text && text !== this.lastContext) this.line(c.gray(text));
        this.lastContext = text;
        break;
      }
      case "debug":
        if (this.opts.verbose) this.line(c.gray(`[debug] ${JSON.stringify(ev.entry).slice(0, 400)}`));
        break;
    }
  }

  private toolLine(callId: string, name: string, output: string, isError: boolean) {
    const call = this.calls.get(callId);
    const args = call?.args ?? {};
    const p = typeof args.path === "string" ? args.path : "";
    if (name === "update_plan") return;
    if (isError) {
      const label = name === "run_command" ? `run ${oneLine(args.command ?? "", 60)}` : `${name}${p ? " " + p : ""}`;
      const first = output.split(/\r?\n/).find((l) => l.trim()) ?? "";
      this.line(`${c.red(sym.fail)} ${label} ${c.gray(sym.arrow)} ${c.red(oneLine(first, 100))}`);
      return;
    }
    switch (name) {
      case "read_file": {
        const range = args.start_line || args.end_line ? c.gray(` (lines ${args.start_line ?? 1}-${args.end_line ?? "end"})`) : "";
        this.line(`${c.green(sym.ok)} read ${p}${range}`);
        break;
      }
      case "list_dir":
        this.line(`${c.green(sym.ok)} list ${p || "."}`);
        break;
      case "find_files": {
        const n = output.startsWith("No files") ? 0 : output.split("\n").length;
        this.line(`${c.green(sym.ok)} find "${oneLine(args.pattern ?? "", 40)}" ${c.gray(`${sym.arrow} ${n} file${n === 1 ? "" : "s"}`)}`);
        break;
      }
      case "search": {
        const n = output.startsWith("No matches") ? 0 : output.split("\n").length;
        this.line(`${c.green(sym.ok)} search "${oneLine(args.query ?? "", 40)}" ${c.gray(`${sym.arrow} ${n} match${n === 1 ? "" : "es"}`)}`);
        break;
      }
      case "write_file":
      case "edit_file": {
        // The tool's fileChanged event arrives right before its result.
        const ch = this.pendingChange;
        this.pendingChange = null;
        const verb = name === "write_file" ? (ch?.before == null ? "create" : "write") : "edit";
        if (ch) {
          const st = diffStats(ch.before, ch.after);
          this.line(`${c.yellow(sym.edit)} ${verb} ${ch.path} ${c.green("+" + st.added)} ${c.red(sym.minus + st.removed)}`);
          if (this.opts.diffs !== false) this.write(formatDiff(ch.before, ch.after, ch.before == null ? 8 : 14) + "\n");
        } else this.line(`${c.yellow(sym.edit)} ${verb} ${p}`);
        break;
      }
      case "run_command": {
        const code = exitCodeOf(output);
        const ok = code === 0;
        const status = code == null ? "" : ok ? c.green(`exit ${code}`) : c.red(`exit ${code}`);
        this.line(`${c.cyan(sym.run)} run ${c.bold(oneLine(args.command ?? "", termWidth() - 24))} ${c.gray(sym.arrow)} ${status}`);
        const body = output.replace(/^Exit code: -?\d+\n?/, "");
        if (!ok || this.opts.verbose) {
          const tail = lastLines(body, this.opts.verbose ? 20 : 6);
          if (tail.length && tail[0] !== "(no output)") this.write(tail.map((l) => c.gray("    │ " + oneLine(l, termWidth() - 8))).join("\n") + "\n");
        }
        break;
      }
      case "load_skill":
        this.line(`${c.green(sym.ok)} skill ${args.name ?? ""}`);
        break;
      default:
        if (name.startsWith("mcp__")) {
          const [, server, tool] = name.split("__");
          this.line(`${c.green(sym.ok)} ${c.magenta("mcp")} ${server}/${tool} ${c.gray(oneLine(output, 60))}`);
        } else this.line(`${c.green(sym.ok)} ${name}`);
    }
  }
}
