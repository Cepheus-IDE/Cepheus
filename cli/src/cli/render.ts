/** Terminal rendering of agent events: streamed answers, compact tool rows with timing, diffs, plans, summary. */
import type { AgentEvent, PlanItem } from "../core/types.js";
import { diffStats, hunks } from "../core/diff.js";
import { c, colorEnabled, fmtDuration, readWidth, sgr, spread, sym, termWidth, truncEnd } from "./ansi.js";

export type Out = { write(s: string): any };

/** Indent of everything the agent prints under its marker. */
const IND = "  ";

function oneLine(s: string, max = 80): string {
  return truncEnd(String(s ?? "").replace(/\s+/g, " ").trim(), max);
}

/** Colored unified-style diff in a gutter, limited to `maxLines` lines. */
export function formatDiff(before: string | null, after: string, maxLines = 14, context = 1): string {
  const hs = hunks(before, after, context);
  const width = Math.max(30, termWidth() - 14);
  const lines: string[] = [];
  let shown = 0;
  let total = 0;
  for (const h of hs) total += h.lines.length;
  for (let hi = 0; hi < hs.length; hi++) {
    const h = hs[hi];
    if (hi > 0) lines.push(c.gray(`     ${sym.bar} ${sym.ellipsis}`));
    for (const op of h.lines) {
      if (shown >= maxLines) break;
      const no = op.kind === "del" ? op.oldLine : op.newLine;
      const num = c.gray(String(no ?? "").padStart(4) + " " + sym.bar + " ");
      const text = truncEnd(op.text.replace(/\t/g, "  "), width);
      if (op.kind === "add") lines.push(num + c.green("+ " + text));
      else if (op.kind === "del") lines.push(num + c.red("- " + text));
      else lines.push(num + c.gray("  " + text));
      shown++;
    }
    if (shown >= maxLines) break;
  }
  if (total > shown) lines.push(c.gray(`     ${sym.bar} ${sym.ellipsis} ${total - shown} more diff lines (/diff to see all)`));
  return lines.map((l) => "    " + l).join("\n");
}

export function formatPlan(items: PlanItem[]): string {
  return items
    .map((it) => {
      if (it.status === "done") return `${IND}  ${c.green(sym.done)} ${c.gray(it.text)}`;
      if (it.status === "in_progress") return `${IND}  ${c.accent(sym.doing)} ${c.bold(it.text)}`;
      return `${IND}  ${c.gray(sym.todo)} ${it.text}`;
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

/** A spinner with a label and elapsed time, shown while the model or a tool is working (TTY only). */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private label = "";
  private since = 0;
  constructor(private out: NodeJS.WriteStream) {}
  start(label: string) {
    if (!this.out.isTTY) return;
    if (label !== this.label) this.since = Date.now();
    this.label = label;
    if (this.timer) return;
    const draw = () => {
      const f = sym.spinner[this.frame++ % sym.spinner.length];
      const secs = Math.floor((Date.now() - this.since) / 1000);
      const time = secs >= 1 ? c.gray(`  ${secs}s`) : "";
      const label = truncEnd(this.label, Math.max(10, termWidth() - 16));
      this.out.write(`\r${IND}${c.accent(f)} ${c.soft(label)}${time}${colorEnabled ? "\x1b[K" : ""}`);
    };
    draw();
    this.timer = setInterval(draw, 90);
  }
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.label = "";
    this.out.write("\r\x1b[K");
  }
}

/**
 * Streams markdown-ish answer text to the terminal: indents it under the agent marker, wraps words to the
 * reading width (TTY only), styles **bold**, `code`, headings and fenced code blocks when colors are on.
 * With colors off the text passes through unchanged (only indented), so piped output stays faithful.
 */
class AnswerStream {
  private col = 0;
  private lineStart = true;
  private first = true;
  private word = "";
  private wordLen = 0;
  private ticks = "";
  private fence = false;
  private skipLine = false;
  private code = false;
  private bold = false;
  private heading = false;
  private star = false;
  private headingHashes = false;

  constructor(
    private emit: (s: string) => void,
    private wrap: boolean,
  ) {}

  private get width() {
    return readWidth() - IND.length - 1;
  }

  private startLine() {
    if (!this.lineStart) return;
    this.lineStart = false;
    if (this.first) {
      this.first = false;
      this.emit(c.accent(sym.mark) + " ");
    } else this.emit(IND);
    if (this.fence) this.emit(c.gray(sym.bar + " ") + sgr.grayOn());
  }

  private flushWord() {
    if (!this.wordLen && !this.word) return;
    this.startLine();
    if (this.wrap && this.col > 0 && this.col + this.wordLen > this.width) {
      this.emit("\n" + IND);
      this.col = 0;
    }
    this.emit(this.word);
    this.col += this.wordLen;
    this.word = "";
    this.wordLen = 0;
  }

  private addVisible(ch: string) {
    this.word += ch;
    this.wordLen += 1;
  }

  private flushStar() {
    if (this.star) {
      this.star = false;
      this.addVisible("*");
    }
  }

  private flushTicks() {
    const t = this.ticks;
    this.ticks = "";
    for (const ch of t) this.normal(ch);
  }

  private newline() {
    this.flushStar();
    this.flushWord();
    if (this.lineStart) this.startLine(); // keep empty lines inside the block
    if (this.code) { this.word += sgr.fgOff(); this.code = false; this.flushWord(); }
    if (this.bold || this.heading) { this.emit(sgr.boldOff()); this.bold = false; this.heading = false; }
    if (this.fence) this.emit(sgr.fgOff());
    this.emit("\n");
    this.col = 0;
    this.lineStart = true;
    this.headingHashes = false;
  }

  private normal(ch: string) {
    if (ch === "\n") return this.newline();
    if (this.fence) {
      this.startLine();
      this.emit(ch);
      return;
    }
    const styled = colorEnabled;
    if (styled && this.headingHashes) {
      if (ch === "#") return;
      this.headingHashes = false;
      if (ch === " ") return;
    }
    if (styled && ch === "#" && this.lineStart && !this.word) {
      this.headingHashes = true;
      this.heading = true;
      this.word += sgr.boldOn();
      return;
    }
    if (styled && ch === "*") {
      if (this.star) {
        this.star = false;
        this.bold = !this.bold;
        this.word += this.bold ? sgr.boldOn() : this.heading ? "" : sgr.boldOff();
        return;
      }
      this.star = true;
      return;
    }
    this.flushStar();
    if (styled && ch === "`") {
      this.code = !this.code;
      this.word += this.code ? sgr.codeOn() : sgr.fgOff();
      return;
    }
    if (ch === " " || ch === "\t") {
      this.flushWord();
      this.startLine();
      if (this.wrap && this.col + 1 > this.width) {
        this.emit("\n" + IND);
        this.col = 0;
        return;
      }
      this.emit(ch === "\t" ? "  " : " ");
      this.col += ch === "\t" ? 2 : 1;
      return;
    }
    if (ch === "\r") return;
    this.addVisible(ch);
  }

  push(text: string) {
    for (const ch of text) {
      if (this.skipLine) {
        if (ch === "\n") {
          this.skipLine = false;
          this.col = 0;
          this.lineStart = true;
        }
        continue;
      }
      // Fenced code blocks: ``` at the start of a line toggles a gray, gutter-marked block.
      if (colorEnabled && this.lineStart && !this.word && ch === "`" && this.ticks.length < 3) {
        this.ticks += ch;
        if (this.ticks.length === 3) {
          this.ticks = "";
          this.fence = !this.fence;
          this.skipLine = true;
          if (this.first) { this.first = false; this.emit(c.accent(sym.mark) + "\n"); }
        }
        continue;
      }
      if (this.ticks) this.flushTicks();
      this.normal(ch);
    }
  }

  /** Flushes what is buffered and closes open styles; returns true when the line is still open. */
  end(): boolean {
    if (this.ticks) this.flushTicks();
    this.flushStar();
    this.flushWord();
    if (this.code) this.emit(sgr.fgOff());
    if (this.bold || this.heading) this.emit(sgr.boldOff());
    if (this.fence) this.emit(sgr.fgOff());
    this.code = this.bold = this.heading = this.fence = false;
    return !this.lineStart;
  }
}

export interface RenderOptions {
  verbose?: boolean;
  /** Show the mini diff after each edit (default true). */
  diffs?: boolean;
}

export interface TurnSummary {
  status: "idle" | "stopped" | "error";
  ms: number;
  files: number;
  added: number;
  removed: number;
  input: number;
  output: number;
  hint?: string;
}

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/** Turns agent events into terminal output. */
export class TerminalRenderer {
  private calls = new Map<string, { name: string; args: any; at: number }>();
  private pendingChange: { path: string; before: string | null; after: string } | null = null;
  private lastContext = "";
  private streaming = false;
  private stream: AnswerStream | null = null;
  private atLineStart = true;
  /** What the last block was, to keep one blank line between answer text and tool rows. */
  private lastKind: "none" | "text" | "tool" | "note" = "none";
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

  private gap(kind: "text" | "tool" | "note") {
    if (this.lastKind !== "none" && this.lastKind !== kind) this.write("\n");
    this.lastKind = kind;
  }

  private line(s: string, kind: "tool" | "note" = "note") {
    this.endStream();
    if (!this.atLineStart) this.write("\n");
    this.gap(kind);
    this.write(s + "\n");
  }

  private endStream() {
    if (this.streaming) {
      this.streaming = false;
      const open = this.stream?.end();
      this.stream = null;
      if (open || !this.atLineStart) this.write("\n");
    }
  }

  private beginStream() {
    this.spinner.stop();
    if (!this.atLineStart) this.write("\n");
    this.gap("text");
    this.streaming = true;
    this.stream = new AnswerStream((s) => this.write(s), !!this.out.isTTY);
  }

  /** Ensures following output starts on a fresh line. */
  flush() {
    this.spinner.stop();
    this.endStream();
    if (!this.atLineStart) this.write("\n");
  }

  /** Prints the user's task the way the REPL prompt shows it (one-shot runs). */
  task(text: string) {
    const lines = text.trim().split(/\r?\n/);
    const first = `${c.accent(c.bold(sym.prompt))} ${c.bold(oneLine(lines[0], readWidth() - 4))}`;
    this.write(first + (lines.length > 1 ? c.gray(` (+${lines.length - 1} lines)`) : "") + "\n\n");
    this.lastKind = "none";
  }

  /** The closing line of a turn: status, time, files and tokens. */
  summary(s: TurnSummary) {
    this.flush();
    const w = readWidth();
    const icon = s.status === "idle" ? c.green(sym.ok) : s.status === "stopped" ? c.yellow(sym.warn) : c.red(sym.fail);
    const word = s.status === "idle" ? "Done" : s.status === "stopped" ? "Stopped" : "Failed";
    const bits = [fmtDuration(s.ms)];
    if (s.files) bits.push(`${s.files} file${s.files === 1 ? "" : "s"} changed ${c.green("+" + s.added)} ${c.red(sym.minus + s.removed)}`);
    bits.push(`${fmtTokens(s.input)} in ${sym.dot} ${fmtTokens(s.output)} out`);
    const left = `${IND}${icon} ${c.bold(word)} ${c.gray(sym.dot)} ${bits.join(c.gray(` ${sym.dot} `))}`;
    this.write("\n" + c.gray(IND + sym.rule.repeat(Math.max(10, w - IND.length))) + "\n");
    this.write((s.hint ? spread(left, c.gray(s.hint), w) : left) + "\n");
    this.lastKind = "none";
  }

  handle(ev: AgentEvent) {
    switch (ev.type) {
      case "status":
        if (ev.status === "running") this.spinner.start("thinking");
        else this.spinner.stop();
        break;
      case "textDelta":
        if (!this.streaming) this.beginStream();
        this.stream!.push(ev.text);
        this.streamedText = true;
        break;
      case "text":
        // Providers may emit thinking between the deltas and the final text,
        // which ends the stream early; the text was still printed already.
        if (this.streaming || this.streamedText) this.endStream();
        else if (ev.text.trim()) {
          this.beginStream();
          this.stream!.push(ev.text.trimEnd());
          this.endStream();
        }
        this.streamedText = false;
        break;
      case "thinking": {
        const t = this.opts.verbose ? ev.text.trim() : oneLine(ev.text, readWidth() - 8);
        if (t) this.line(`${IND}${c.gray(c.italic(`${sym.think} ${t}`))}`, "tool");
        this.spinner.start("thinking");
        break;
      }
      case "toolCall":
        this.calls.set(ev.callId, { name: ev.name, args: ev.args, at: Date.now() });
        this.spinner.start(this.activity(ev.name, ev.args ?? {}));
        break;
      case "approvalRequest":
        this.spinner.stop();
        break;
      case "fileChanged":
        this.pendingChange = { path: ev.relPath, before: ev.before, after: ev.after };
        break;
      case "toolResult":
        this.toolLine(ev.callId, ev.name, ev.output, ev.isError);
        this.spinner.start("thinking");
        break;
      case "plan":
        if (ev.items.length) this.line(`${IND}${c.bold("Plan")}\n${formatPlan(ev.items)}`, "tool");
        break;
      case "warning":
        this.line(`${IND}${c.yellow(`${sym.warn} ${ev.message}`)}`);
        break;
      case "error":
        this.line(`${IND}${c.red(`${sym.fail} ${ev.message}`)}`);
        break;
      case "usage":
        this.usage.input += ev.inputTokens;
        this.usage.output += ev.outputTokens;
        break;
      case "steered":
        this.line(`${IND}${c.gray(`${sym.steer} sent to the agent: ${oneLine(ev.text)}`)}`);
        break;
      case "context": {
        const bits: string[] = [];
        if (ev.instructions.length) bits.push(`instructions: ${ev.instructions.join(", ")}`);
        if (ev.skills.length) bits.push(`skills: ${ev.skills.length}`);
        if (ev.mcpTools) bits.push(`MCP tools: ${ev.mcpTools}`);
        if (ev.agent) bits.push(`agent: ${ev.agent}`);
        if (ev.planMode) bits.push("plan mode (read-only)");
        const text = bits.join(` ${sym.dot} `);
        if (text && text !== this.lastContext) this.line(`${IND}${c.gray(text)}`);
        this.lastContext = text;
        break;
      }
      case "debug":
        if (this.opts.verbose) this.line(c.gray(`${IND}[debug] ${JSON.stringify(ev.entry).slice(0, 400)}`));
        break;
    }
  }

  private activity(name: string, args: any): string {
    const p = typeof args.path === "string" ? args.path : "";
    switch (name) {
      case "run_command":
        return `running ${oneLine(args.command ?? "", 60)}`;
      case "read_file":
        return `reading ${p}`;
      case "list_dir":
        return `listing ${p || "."}`;
      case "find_files":
        return `finding ${oneLine(args.pattern ?? "", 40)}`;
      case "search":
        return `searching ${oneLine(args.query ?? "", 40)}`;
      case "edit_file":
      case "write_file":
        return `editing ${p}`;
      case "update_plan":
        return "planning";
      default:
        return name.startsWith("mcp__") ? name.split("__").slice(1).join("/") : name;
    }
  }

  /** A tool row with its duration right-aligned. */
  private row(text: string, ms: number | null) {
    const left = `${IND}${text}`;
    this.line(ms == null ? left : spread(left, c.gray(fmtDuration(ms)), readWidth()), "tool");
  }

  private toolLine(callId: string, name: string, output: string, isError: boolean) {
    const call = this.calls.get(callId);
    this.calls.delete(callId);
    const args = call?.args ?? {};
    const ms = call ? Date.now() - call.at : null;
    const p = typeof args.path === "string" ? args.path : "";
    if (name === "update_plan") return;
    if (isError) {
      const label = name === "run_command" ? `run ${oneLine(args.command ?? "", 60)}` : `${name}${p ? " " + p : ""}`;
      const first = output.split(/\r?\n/).find((l) => l.trim()) ?? "";
      this.row(`${c.red(sym.fail)} ${label} ${c.gray(sym.arrow)} ${c.red(oneLine(first, Math.max(30, readWidth() - label.length - 16)))}`, ms);
      return;
    }
    switch (name) {
      case "read_file": {
        const range = args.start_line || args.end_line ? c.gray(` (lines ${args.start_line ?? 1}-${args.end_line ?? "end"})`) : "";
        this.row(`${c.green(sym.ok)} read ${p}${range}`, ms);
        break;
      }
      case "list_dir":
        this.row(`${c.green(sym.ok)} list ${p || "."}`, ms);
        break;
      case "find_files": {
        const n = output.startsWith("No files") ? 0 : output.split("\n").length;
        this.row(`${c.green(sym.ok)} find "${oneLine(args.pattern ?? "", 40)}" ${c.gray(`${sym.arrow} ${n} file${n === 1 ? "" : "s"}`)}`, ms);
        break;
      }
      case "search": {
        const n = output.startsWith("No matches") ? 0 : output.split("\n").length;
        this.row(`${c.green(sym.ok)} search "${oneLine(args.query ?? "", 40)}" ${c.gray(`${sym.arrow} ${n} match${n === 1 ? "" : "es"}`)}`, ms);
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
          this.row(`${c.accent(sym.edit)} ${verb} ${c.bold(ch.path)} ${c.green("+" + st.added)} ${c.red(sym.minus + st.removed)}`, ms);
          if (this.opts.diffs !== false) this.write(formatDiff(ch.before, ch.after, ch.before == null ? 8 : 14) + "\n");
        } else this.row(`${c.accent(sym.edit)} ${verb} ${p}`, ms);
        break;
      }
      case "run_command": {
        const code = exitCodeOf(output);
        const ok = code === 0;
        const status = code == null ? "" : ok ? c.green(`exit ${code}`) : c.red(`exit ${code}`);
        const icon = code == null || ok ? c.accent(sym.run) : c.red(sym.run);
        this.row(`${icon} run ${c.bold(oneLine(args.command ?? "", readWidth() - 30))} ${c.gray(sym.arrow)} ${status}`, ms);
        const body = output.replace(/^Exit code: -?\d+\n?/, "");
        if (!ok || this.opts.verbose) {
          const tail = lastLines(body, this.opts.verbose ? 20 : 6);
          if (tail.length && tail[0] !== "(no output)") this.write(tail.map((l) => c.gray(`    ${sym.bar} ` + oneLine(l, termWidth() - 8))).join("\n") + "\n");
        }
        break;
      }
      case "load_skill":
        this.row(`${c.green(sym.ok)} skill ${args.name ?? ""}`, ms);
        break;
      default:
        if (name.startsWith("mcp__")) {
          const [, server, tool] = name.split("__");
          this.row(`${c.green(sym.ok)} ${c.magenta("mcp")} ${server}/${tool} ${c.gray(oneLine(output, 50))}`, ms);
        } else this.row(`${c.green(sym.ok)} ${name}`, ms);
    }
  }
}
