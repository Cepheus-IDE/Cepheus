/** Interactive REPL, one-shot runs and `--json` event mode. */
import { existsSync, readFileSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, ApprovalMode, ApprovalRequest } from "../core/types.js";
import { createSession, runAgentTurn, type AgentSession } from "../core/agent.js";
import { expandAuto, listModels, presetById, PRESETS } from "../core/providers.js";
import { applyEdit } from "../core/tools.js";
import { diffStats } from "../core/diff.js";
import { loadCustomizations } from "../core/customize.js";
import { NodeToolHost } from "../node/host.js";
import { McpManager } from "../node/mcp.js";
import { loadConfig, resolveProvider, saveConfig, mask, type CepheusConfig, type Resolved } from "../node/config.js";
import { TerminalRenderer, formatDiff } from "./render.js";
import { Input } from "./input.js";
import { box, c, readWidth, sym, truncStart } from "./ansi.js";
import { VERSION } from "../version.js";

export const INIT_PROMPT =
  "Explore this repository (structure, languages, frameworks, how to build, test, lint and run it, code conventions) " +
  "and create an AGENTS.md file at the workspace root with concise, accurate guidance for AI coding agents: " +
  "a short project overview, setup/build/test/lint commands, code style and conventions, important directories, " +
  "and gotchas. Only include facts you verified in the files. If AGENTS.md already exists, improve it while keeping useful content.";

export interface SessionOptions {
  root: string;
  resolved: Resolved;
  cfgFile: CepheusConfig;
  mode: ApprovalMode;
  plan: boolean;
  verbose: boolean;
  agent?: string;
}

interface Change {
  rel: string;
  before: string | null;
  after: string | null;
}

const out = (s = "") => process.stdout.write(s + "\n");

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export class Controller {
  readonly host: NodeToolHost;
  readonly session: AgentSession = createSession();
  readonly mcp: McpManager;
  resolved: Resolved;
  cfgFile: CepheusConfig;
  mode: ApprovalMode;
  plan: boolean;
  verbose: boolean;
  agent?: string;
  renderer: TerminalRenderer;
  input: Input | null = null;
  abort: AbortController | null = null;
  private alwaysAllow = new Set<string>();
  /** Per-turn file backups, newest last (for /undo). */
  private turns: Map<string, Change>[] = [];
  private current: Map<string, Change> | null = null;
  /** Aggregated changes of the whole session (for /diff). */
  readonly changes = new Map<string, Change>();
  usageByModel = new Map<string, { input: number; output: number }>();
  private note: string | null = null;
  /** File changes of the last finished turn (for the summary line). */
  lastTurn = { files: 0, added: 0, removed: 0 };
  private nonInteractiveWarned = false;

  constructor(o: SessionOptions) {
    this.host = new NodeToolHost(o.root);
    this.resolved = o.resolved;
    this.cfgFile = o.cfgFile;
    this.mode = o.mode;
    this.plan = o.plan;
    this.verbose = o.verbose;
    this.agent = o.agent;
    this.renderer = new TerminalRenderer(process.stdout, { verbose: o.verbose });
    this.mcp = new McpManager(this.host.root, (m) => this.renderer.handle({ type: "warning", sessionId: this.session.id, message: m }));
  }

  // --- approvals ---------------------------------------------------------------------------

  private async preview(req: ApprovalRequest): Promise<string> {
    const a = req.args ?? {};
    try {
      if (req.name === "run_command") return `    ${c.accent(sym.run)} ${c.bold(String(a.command ?? ""))}`;
      if (req.name === "edit_file" || req.name === "write_file") {
        const abs = path.resolve(this.host.root, String(a.path ?? ""));
        const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        let after: string;
        if (req.name === "write_file") after = String(a.content ?? "");
        else {
          if (before == null) return `    ${c.accent(sym.edit)} edit ${a.path} ${c.red("(file not found)")}`;
          try {
            after = applyEdit(before, String(a.old_str ?? ""), String(a.new_str ?? ""));
          } catch (e: any) {
            return `    ${c.accent(sym.edit)} edit ${a.path} ${c.red(`(${e.message})`)}`;
          }
        }
        const st = diffStats(before, after);
        const verb = req.name === "write_file" ? (before == null ? "create" : "overwrite") : "edit";
        return `    ${c.accent(sym.edit)} ${verb} ${c.bold(String(a.path))} ${c.green("+" + st.added)} ${c.red(sym.minus + st.removed)}\n${formatDiff(before, after, 40, 2)}`;
      }
      return `    ${c.magenta(req.name)} ${c.gray(JSON.stringify(a).slice(0, 400))}`;
    } catch {
      return `  ${req.name}`;
    }
  }

  approve = async (req: ApprovalRequest): Promise<boolean> => {
    const group = req.name === "edit_file" || req.name === "write_file" ? "edits" : req.name;
    if (this.alwaysAllow.has(group)) return true;
    const input = this.input;
    if (!input || input.isClosed) {
      if (!this.nonInteractiveWarned) {
        this.nonInteractiveWarned = true;
        this.renderer.handle({
          type: "warning",
          sessionId: this.session.id,
          message: `'${req.name}' needs approval but there is no interactive terminal. Re-run with --yes (turbo) or --mode auto-edit to allow it.`,
        });
      }
      return false;
    }
    this.renderer.flush();
    out();
    out(`  ${c.accent(c.bold("?"))} ${c.bold("Approval needed")}`);
    out(await this.preview(req));
    const what = req.name === "run_command" ? "commands" : group === "edits" ? "file edits" : `'${req.name}'`;
    const key = (k: string, rest: string) => `${c.accent(c.bold("[" + k + "]"))}${c.gray(rest)}`;
    const ans = await input.ask(`\n  ${c.bold("Allow?")}  ${key("y", "es")}  ${key("n", "o")}  ${key("a", `lways allow ${what} this session`)}  ${c.accent(sym.prompt)} `);
    const a = (ans ?? "").trim().toLowerCase();
    if (a === "a" || a === "always") {
      this.alwaysAllow.add(group);
      return true;
    }
    return a === "y" || a === "yes";
  };

  // --- turns -------------------------------------------------------------------------------

  private track(ev: AgentEvent) {
    if (ev.type === "fileChanged") {
      const cur = (this.current ??= new Map());
      const prev = cur.get(ev.path);
      cur.set(ev.path, { rel: ev.relPath, before: prev ? prev.before : ev.before, after: ev.after });
      const agg = this.changes.get(ev.path);
      this.changes.set(ev.path, { rel: ev.relPath, before: agg ? agg.before : ev.before, after: ev.after });
    } else if (ev.type === "usage") {
      const k = `${ev.provider ?? ""} · ${ev.model ?? ""}`;
      const u = this.usageByModel.get(k) ?? { input: 0, output: 0 };
      u.input += ev.inputTokens;
      u.output += ev.outputTokens;
      this.usageByModel.set(k, u);
    }
  }

  async runTurn(message: string, emit?: (ev: AgentEvent) => void): Promise<"idle" | "stopped" | "error"> {
    const ctl = new AbortController();
    this.abort = ctl;
    this.current = new Map();
    let final: "idle" | "stopped" | "error" = "idle";
    const note = this.note;
    this.note = null;
    const handler = (ev: AgentEvent) => {
      this.track(ev);
      if (ev.type === "status" && (ev.status === "idle" || ev.status === "stopped" || ev.status === "error")) final = ev.status;
      (emit ?? ((e) => this.renderer.handle(e)))(ev);
    };
    try {
      await runAgentTurn(
        {
          host: this.host,
          config: this.resolved.config,
          message: note ? `${note}\n\n${message}` : message,
          session: this.session,
          approvalMode: this.mode,
          planMode: this.plan,
          approve: this.approve,
          customInstructions: this.cfgFile.customInstructions,
          agent: this.agent,
          mcp: this.mcp,
        },
        handler,
        ctl.signal,
      );
    } finally {
      this.abort = null;
      let added = 0;
      let removed = 0;
      for (const ch of this.current.values()) {
        const st = diffStats(ch.before, ch.after ?? "");
        added += st.added;
        removed += st.removed;
      }
      this.lastTurn = { files: this.current.size, added, removed };
      if (this.current.size) this.turns.push(this.current);
      this.current = null;
      if (!emit) this.renderer.flush();
    }
    return final;
  }

  // --- slash commands ----------------------------------------------------------------------

  async undo(force = false) {
    const t = this.turns.pop();
    if (!t) {
      out(c.gray("Nothing to undo (no file changes recorded in this session)."));
      return;
    }
    const reverted: string[] = [];
    for (const [abs, ch] of t) {
      const cur = existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (cur !== ch.after && !force) {
        out(c.yellow(`${sym.warn} ${ch.rel} changed after the agent edited it; skipped (use /undo --force to revert anyway).`));
        continue;
      }
      if (ch.before == null) await fs.rm(abs, { force: true });
      else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, ch.before, "utf8");
      }
      reverted.push(ch.rel);
      out(`${c.green(sym.ok)} reverted ${ch.rel}${ch.before == null ? c.gray(" (deleted, it was new)") : ""}`);
      const agg = this.changes.get(abs);
      if (agg) {
        agg.after = ch.before;
        if (agg.after === agg.before) this.changes.delete(abs);
      }
    }
    if (reverted.length) {
      this.note = `[Note: the user reverted (/undo) the file changes you made in the previous turn: ${reverted.join(", ")}. Those files are back to their earlier content.]`;
    }
    out(c.gray("Commands the agent ran (run_command) are not undone."));
  }

  showDiff() {
    if (!this.changes.size) {
      out(c.gray("No file changes in this session."));
      return;
    }
    for (const ch of this.changes.values()) {
      const st = diffStats(ch.before, ch.after ?? "");
      const tag = ch.before == null ? c.green(" (new)") : ch.after == null ? c.red(" (deleted)") : "";
      out(`${c.bold(ch.rel)}${tag} ${c.green("+" + st.added)} ${c.red(sym.minus + st.removed)}`);
      out(formatDiff(ch.before, ch.after ?? "", 400, 3));
      out();
    }
  }

  showCost() {
    const u = this.session.usage;
    out(`${c.bold("Tokens this session")}: ${fmtTokens(u.inputTokens)} input ${sym.dot} ${fmtTokens(u.outputTokens)} output`);
    for (const [k, v] of this.usageByModel) out(c.gray(`  ${k}: ${fmtTokens(v.input)} in ${sym.dot} ${fmtTokens(v.output)} out`));
    out(
      c.gray(
        this.resolved.preset.local
          ? "Local model: no API cost."
          : "Prices differ per provider and plan; check your provider's dashboard for the cost (free NVIDIA developer keys are not billed).",
      ),
    );
  }

  async showSkills() {
    const cust = await loadCustomizations(this.host);
    if (!cust.skills.length) out(c.gray("No skills. Add .cepheus/skills/<name>/SKILL.md (workspace) or ~/.cepheus/skills/<name>/SKILL.md (user)."));
    for (const s of cust.skills) out(`  ${c.bold(s.name)} ${c.gray(`(${s.source})`)} ${s.description}`);
    if (cust.instructions.length) out(c.gray(`Instructions: ${cust.instructions.map((i) => i.path + (i.applyTo ? ` [${i.applyTo}]` : "")).join(", ")}`));
    if (cust.agents.length) out(c.gray(`Custom agents: ${cust.agents.map((a) => a.name).join(", ")}`));
    if (cust.hooks.length) out(c.gray(`Hooks: ${cust.hooks.map((h) => `${h.event}${h.matcher ? `(${h.matcher})` : ""}`).join(", ")}`));
    const st = await this.mcp.status();
    for (const s of st) out(c.gray(`MCP ${s.name}: ${s.status}${s.tools.length ? ` (${s.tools.length} tools)` : ""}${s.error ? ` ${s.error}` : ""}`));
  }

  private setModel(model: string) {
    const base = { ...this.resolved.config, model, fallbacks: undefined };
    this.resolved = { ...this.resolved, config: expandAuto(base) };
  }

  async cmdModel(arg: string) {
    const input = this.input!;
    if (arg && arg !== "list") {
      this.setModel(arg);
      out(`${c.green(sym.ok)} model ${c.bold(this.resolved.config.model)}${arg === "auto" ? c.gray(` (auto: ${[this.resolved.config.model, ...(this.resolved.config.fallbacks ?? []).map((f) => f.model)].join(" → ")})`) : ""}`);
      return;
    }
    process.stdout.write(c.gray(`Fetching ${this.resolved.preset.label} models… `));
    let all: string[] = [];
    try {
      all = (await listModels(this.resolved.config, { timeoutMs: 20_000 })).map((m) => m.id);
      out(c.green(`${all.length} models`));
    } catch (e: any) {
      out(c.yellow(String(e?.message ?? e).split("\n")[0]));
      all = [...this.resolved.preset.models];
    }
    const options = this.resolved.preset.id === "nvidia" ? ["auto", ...all] : all;
    let filter = "";
    for (;;) {
      const shown = options.filter((m) => !filter || m.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
      shown.forEach((m, i) => out(`  ${c.cyan(String(i + 1).padStart(2))}) ${m === this.resolved.config.model ? c.green(m + " ●") : m}`));
      const more = options.filter((m) => !filter || m.toLowerCase().includes(filter.toLowerCase())).length - shown.length;
      if (more > 0) out(c.gray(`  … ${more} more; type text to filter`));
      const a = (await input.ask("Number, model id, or text to filter (Enter to cancel): "))?.trim();
      if (!a) return;
      const n = parseInt(a, 10);
      let pick: string | null = null;
      if (/^\d+$/.test(a) && n >= 1 && n <= shown.length) pick = shown[n - 1];
      else if (options.includes(a) || a.includes("/") || a.includes(":")) pick = a;
      if (!pick) {
        filter = a;
        continue;
      }
      this.setModel(pick);
      out(`${c.green(sym.ok)} model ${c.bold(pick)}`);
      if (await input.confirm("Save as your default model?")) {
        this.cfgFile = { ...loadConfig(), provider: this.resolved.preset.id, model: pick };
        saveConfig(this.cfgFile);
        out(c.gray("Saved."));
      }
      return;
    }
  }

  async cmdProvider(arg: string) {
    const input = this.input!;
    let id = arg.trim().toLowerCase();
    if (!id) {
      const idx = await input.choose(
        "Provider:",
        PRESETS.map((p) => `${p.label.padEnd(18)} ${p.id === this.resolved.preset.id ? c.green("●") : ""}`),
        Math.max(0, PRESETS.findIndex((p) => p.id === this.resolved.preset.id)),
      );
      if (idx == null) return;
      id = PRESETS[idx].id;
    }
    const preset = presetById(id);
    if (!preset) {
      out(c.red(`Unknown provider '${id}'. Choose: ${PRESETS.map((p) => p.id).join(", ")}`));
      return;
    }
    let r = resolveProvider(this.cfgFile, { provider: id });
    if (r?.missingKey) {
      if (preset.keyUrl) out(`Get a key at ${c.cyan(preset.keyUrl)}`);
      const key = (await input.askSecret(`${preset.label} API key: `))?.trim();
      if (!key) {
        out(c.yellow("No key entered; provider unchanged."));
        return;
      }
      const next = { ...this.cfgFile, keys: { ...(this.cfgFile.keys ?? {}), [id]: key } };
      if (await input.confirm(`Save the key (${mask(key)}) to ~/.cepheus/config.json?`)) {
        saveConfig({ ...loadConfig(), keys: next.keys });
      }
      this.cfgFile = next;
      r = resolveProvider(this.cfgFile, { provider: id });
    }
    if (!r) return;
    this.resolved = r;
    out(`${c.green(sym.ok)} provider ${c.bold(preset.label)} ${sym.dot} model ${c.bold(r.config.model)} ${c.gray("(/model to change)")}`);
  }

  /** Short folder name for headers: ~ for the home folder. */
  folderLabel(max: number): string {
    const home = path.resolve(os.homedir());
    let f = this.host.root;
    if (f.toLowerCase().startsWith(home.toLowerCase()) && f.length > home.length) f = "~" + f.slice(home.length);
    return truncStart(f, max);
  }

  modeLabel(): string {
    const m = this.mode === "turbo" ? c.yellow("turbo") : this.mode === "auto-edit" ? c.yellow("auto-edit") : "ask";
    return this.plan ? `${m} ${c.gray(sym.dot)} ${c.magenta("plan mode")}` : m;
  }

  /** Header of one-shot runs: brand, model, mode and folder. */
  header() {
    const r = this.resolved;
    out(`${c.accent(sym.mark)} ${c.bold("Cepheus")} ${c.gray("v" + VERSION)}  ${c.gray(sym.dot)}  ${r.config.model}  ${c.gray(sym.dot)}  ${this.modeLabel()}`);
    out(c.gray(`  ${r.preset.label} ${sym.dot} ${this.folderLabel(readWidth() - 30)}`));
    out();
  }

  banner() {
    const r = this.resolved;
    const w = Math.min(readWidth(), 78);
    const inner = w - 4;
    const n = r.config.fallbacks?.length ?? 0;
    const fallbacks = n ? c.gray(` +${n} fallback${n === 1 ? "" : "s"}`) : "";
    const label = (k: string) => c.gray(k.padEnd(10));
    const lines = [
      `${c.accent(sym.mark)} ${c.bold("Cepheus")}  ${c.gray("v" + VERSION)}`,
      "",
      `  ${label("model")}${truncStart(r.config.model, inner - 26)}${fallbacks}`,
      `  ${label("provider")}${r.preset.label}`,
      `  ${label("folder")}${this.folderLabel(inner - 14)}`,
      `  ${label("mode")}${this.modeLabel()}`,
      "",
      c.gray(`  /help commands  ${sym.dot}  Ctrl+C cancel  ${sym.dot}  \\ at line end for more`),
    ];
    out(box(lines, w));
    const home = path.resolve(os.homedir()).replace(/\\/g, "/").toLowerCase();
    if (this.host.root.toLowerCase() === home || /^[a-z]:\/?$|^\/$/i.test(this.host.root))
      out(c.yellow(`  ${sym.warn} You're in your home or a root folder; start Cepheus in a project folder (or use --cwd).`));
  }
}

const helpRow = (cmd: string, desc: string) => {
  const [name, ...rest] = cmd.split(" ");
  const args = rest.length ? " " + rest.join(" ") : "";
  return `  ${c.accent(name)}${c.soft(args)}${" ".repeat(Math.max(2, 26 - cmd.length))}${c.gray(desc)}`;
};
export const HELP_REPL = [
  `${c.accent(sym.mark)} ${c.bold("Commands")}`,
  "",
  helpRow("/help", "this help"),
  helpRow("/model [id|auto]", "list models (live) and pick one, or set it directly"),
  helpRow("/provider [id]", `switch provider (${PRESETS.slice(0, 4).map((p) => p.id).join(", ")}, ${sym.ellipsis})`),
  helpRow("/mode ask|auto-edit|turbo", ""),
  `${" ".repeat(28)}${c.gray(`ask: approve edits and commands ${sym.dot} auto-edit: approve commands ${sym.dot} turbo: no prompts`)}`,
  helpRow("/plan on|off", "read-only planning mode (no edits, no commands)"),
  helpRow("/undo [--force]", "revert the files changed in the last turn"),
  helpRow("/diff", "show all file changes of this session"),
  helpRow("/cost", "token usage"),
  helpRow("/skills", "skills, instructions, hooks and MCP servers found"),
  helpRow("/init", "explore the project and write AGENTS.md"),
  helpRow("/clear", "start a new conversation"),
  helpRow("/exit", "quit (or Ctrl+C twice)"),
  "",
  c.gray("  Type while the agent works to send it an extra message. End a line with \\ to continue on the next line."),
].join("\n");

/** The interactive REPL. Resolves with the exit code. */
export async function runRepl(ctl: Controller, input: Input): Promise<number> {
  ctl.input = input;
  ctl.banner();
  let busy = false;
  let lastSigint = 0;
  let buffer = "";
  let exitCode: number | null = null;
  let resolveExit!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveExit = r));
  const exit = (code: number) => {
    if (exitCode != null) return;
    exitCode = code;
    ctl.mcp.close();
    input.close();
    resolveExit(code);
  };
  const promptText = () =>
    `\n${ctl.plan ? c.magenta("plan ") : ""}${ctl.mode !== "ask" ? c.yellow(`${ctl.mode} `) : ""}${c.accent(c.bold(sym.prompt))} `;
  const showPrompt = () => {
    if (exitCode == null) input.prompt(promptText());
  };

  input.onSigint = () => {
    const now = Date.now();
    if (ctl.abort) {
      if (ctl.abort.signal.aborted || now - lastSigint < 1500) {
        out(c.gray("\nExiting."));
        exit(130);
        return;
      }
      lastSigint = now;
      if (input.asking) input.cancelAsk();
      ctl.abort.abort();
      ctl.renderer.flush();
      out(c.yellow("Cancelled. ") + c.gray("(Ctrl+C again to exit)"));
      return;
    }
    if (input.asking) {
      input.cancelAsk();
      return;
    }
    const line = (input.rl as any).line as string | undefined;
    if (line || buffer) {
      buffer = "";
      (input.rl as any).line = "";
      out("");
      showPrompt();
      return;
    }
    if (now - lastSigint < 2000) {
      out("");
      exit(0);
      return;
    }
    lastSigint = now;
    out(c.gray("\n(Press Ctrl+C again to exit, or type /exit)"));
    showPrompt();
  };
  input.onClose = () => exit(exitCode ?? 0);

  const handle = async (text: string): Promise<void> => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith("/")) {
      const [cmd, ...restParts] = t.slice(1).split(/\s+/);
      const arg = restParts.join(" ").trim();
      switch (cmd.toLowerCase()) {
        case "help":
        case "?":
          out(HELP_REPL);
          return;
        case "exit":
        case "quit":
        case "q":
          exit(0);
          return;
        case "model":
        case "models":
          await ctl.cmdModel(arg);
          return;
        case "provider":
          await ctl.cmdProvider(arg);
          return;
        case "mode":
          if (arg === "ask" || arg === "auto-edit" || arg === "turbo") {
            ctl.mode = arg;
            out(`${c.green(sym.ok)} mode ${arg}${arg === "turbo" ? c.yellow(" (edits and commands run without asking)") : ""}`);
          } else out(`mode: ${c.bold(ctl.mode)}  ${c.gray("(/mode ask | auto-edit | turbo)")}`);
          return;
        case "plan":
          ctl.plan = arg === "off" ? false : arg === "on" ? true : !ctl.plan;
          out(ctl.plan ? `${c.green(sym.ok)} plan mode on ${c.gray("(read-only: the agent researches and proposes a plan)")}` : `${c.green(sym.ok)} plan mode off`);
          return;
        case "clear":
        case "new":
          ctl.session.clear();
          out(`${c.green(sym.ok)} new conversation ${c.gray("(file changes stay; /undo still works)")}`);
          return;
        case "undo":
          await ctl.undo(arg === "--force" || arg === "-f");
          return;
        case "diff":
          ctl.showDiff();
          return;
        case "cost":
        case "usage":
          ctl.showCost();
          return;
        case "skills":
          await ctl.showSkills();
          return;
        case "init":
          await ctl.runTurn(INIT_PROMPT);
          return;
        default:
          out(c.yellow(`Unknown command /${cmd}. Type /help.`));
          return;
      }
    }
    const before = { ...ctl.session.usage };
    const started = Date.now();
    out();
    const st = await ctl.runTurn(t);
    const u = ctl.session.usage;
    ctl.renderer.summary({
      status: st,
      ms: Date.now() - started,
      ...ctl.lastTurn,
      input: u.inputTokens - before.inputTokens,
      output: u.outputTokens - before.outputTokens,
      hint: ctl.lastTurn.files ? "/diff  /undo" : undefined,
    });
  };

  input.onLine = (line: string) => {
    if (busy) {
      if (ctl.abort && line.trim()) {
        if (ctl.session.steer(line.trim())) out(c.gray(`↳ queued for the agent: ${line.trim().slice(0, 80)}`));
      }
      return;
    }
    if (line.endsWith("\\")) {
      buffer += line.slice(0, -1) + "\n";
      input.prompt(c.gray("… "));
      return;
    }
    const text = buffer + line;
    buffer = "";
    busy = true;
    handle(text)
      .catch((e) => out(c.red(`${sym.fail} ${e?.message ?? e}`)))
      .finally(() => {
        busy = false;
        showPrompt();
      });
  };
  showPrompt();
  return done;
}

/** One-shot human-readable run. */
export async function runOnce(ctl: Controller, input: Input | null, prompt: string): Promise<number> {
  ctl.input = input;
  let lastSigint = 0;
  const onSigint = () => {
    const now = Date.now();
    if (ctl.abort && !ctl.abort.signal.aborted && now - lastSigint > 1500) {
      lastSigint = now;
      if (input?.asking) input.cancelAsk();
      ctl.abort.abort();
      ctl.renderer.flush();
      out(c.yellow("Cancelling… ") + c.gray("(Ctrl+C again to exit now)"));
    } else process.exit(130);
  };
  if (input) input.onSigint = onSigint;
  else process.on("SIGINT", onSigint);
  ctl.header();
  ctl.renderer.task(prompt);
  const started = Date.now();
  const st = await ctl.runTurn(prompt);
  const u = ctl.session.usage;
  ctl.renderer.summary({ status: st, ms: Date.now() - started, ...ctl.lastTurn, input: u.inputTokens, output: u.outputTokens });
  ctl.mcp.close();
  return st === "idle" ? 0 : st === "stopped" ? 130 : 1;
}

/** `--json`: newline-delimited AgentEvent JSON on stdout; approvals/steering/cancel as JSON lines on stdin. */
export async function runJson(ctl: Controller, prompt: string): Promise<number> {
  const write = (obj: any) => process.stdout.write(JSON.stringify(obj) + "\n");
  const pending = new Map<string, (ok: boolean) => void>();
  const stdinInteractive = !!process.stdin.isTTY;
  let stdinOpen = !stdinInteractive;
  if (!stdinInteractive) {
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m?.type === "cancel") ctl.abort?.abort();
        else if (m?.type === "steer" && typeof m.text === "string") ctl.session.steer(m.text);
        else if (typeof m?.approvalId === "string") {
          const r = pending.get(m.approvalId);
          pending.delete(m.approvalId);
          r?.(m.approved === true);
        }
      }
    });
    process.stdin.on("end", () => {
      stdinOpen = false;
      for (const r of pending.values()) r(false);
      pending.clear();
    });
    process.stdin.on("error", () => {});
  }
  ctl.approve = async (req) => {
    if (!stdinOpen) {
      write({
        type: "warning",
        sessionId: ctl.session.id,
        message: `'${req.name}' needs approval: send {"approvalId":"${req.approvalId}","approved":true} on stdin, or run with --yes / --mode auto-edit.`,
      });
      return false;
    }
    return new Promise<boolean>((resolve) => pending.set(req.approvalId, resolve));
  };
  process.on("SIGINT", () => {
    if (ctl.abort && !ctl.abort.signal.aborted) ctl.abort.abort();
    else process.exit(130);
  });
  const st = await ctl.runTurn(prompt, write);
  ctl.mcp.close();
  if (!stdinInteractive) process.stdin.destroy();
  return st === "idle" ? 0 : st === "stopped" ? 130 : 1;
}
