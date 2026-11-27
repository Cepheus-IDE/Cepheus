/**
 * The Cepheus agent loop (mirrors src-tauri/src/agent/mod.rs `run_loop`), environment-agnostic.
 *
 *   const session = createSession();
 *   await runAgentTurn({ host, config, message: "fix the failing test", session, approve }, (ev) => ..., signal);
 *
 * Per turn it assembles workspace instruction files, skills, an optional custom agent, hooks and
 * MCP tools, then alternates model calls and tool calls until the model answers without tools.
 */
import type {
  AgentEvent,
  ApprovalMode,
  ApprovalRequest,
  McpProvider,
  ProviderConfig,
  ToolCall,
  ToolDef,
  ToolHost,
  ToolOutcome,
} from "./types.js";
import { AbortedError, callModel, family, pushUserText, toolResults, type CallOptions, type FetchLike } from "./providers.js";
import { definitions, executeTool, isReadOnly, loadSkillDef, needsApproval, truncate } from "./tools.js";
import {
  applicableInstructions,
  hooksFor,
  loadCustomizations,
  loadSkill,
  toolAllowed,
  type AgentDef,
  type Customizations,
} from "./customize.js";
import { relative } from "./paths.js";

export type { AgentEvent, ApprovalRequest, ToolHost, ProviderConfig, McpProvider } from "./types.js";

export const MAX_STEPS = 60;

export const PLAN_MODE_PROMPT =
  "\n\n# PLAN MODE\nYou are in Plan mode. Research the codebase with the read-only tools " +
  "(list_dir, find_files, read_file, search) and DO NOT modify anything: no file writes, no commands. " +
  "When you understand the task, publish the implementation plan with update_plan (all steps `pending`) " +
  "and reply with a concise Markdown plan: the goal, the files to change and how, risks/open questions. " +
  "The user will review it and then switch Plan mode off to start the implementation.";

export function systemPrompt(host: ToolHost, custom?: string | null): string {
  const os = host.osLabel ?? "unknown";
  let s =
    "You are Cepheus, an expert software engineering agent (Cepheus CLI). " +
    "You work directly in the user's workspace using the tools provided.\n\n" +
    `Workspace root: ${host.root}\nOperating system: ${os}\n\n` +
    "How to work:\n" +
    "- Explore before changing: use list_dir, find_files, search and read_file to understand the relevant code.\n" +
    "- For tasks with more than two steps, publish a plan with update_plan first and keep it updated as you go.\n" +
    "- Make focused changes with edit_file; use write_file for new files or full rewrites. Match the existing code style.\n" +
    "- Verify your work when practical (build, run tests, or lint with run_command) and fix what you broke.\n" +
    "- All paths are relative to the workspace root.\n" +
    "- The user may send extra messages while you work (marked as sent during the task); take them into account right away.\n" +
    "- When done, reply with a short summary of what you changed and anything the user should check. " +
    "Use Markdown. Answer in the same language the user writes in.\n" +
    "- If the request is only a question, answer it without modifying files.";
  const c = custom?.trim();
  if (c) s += "\n\nUser's custom instructions:\n" + c;
  return s;
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export interface AgentSession {
  readonly id: string;
  /** Message format of `history` ("openai" | "anthropic" | "gemini"); null while empty. */
  family: string | null;
  /** Conversation in the provider's native format. */
  history: any[];
  /** Workspace-relative files the agent touched (drives `applyTo` instruction globs). */
  touched: Set<string>;
  /** Steering messages sent while a turn runs; injected before the next model call. */
  queue: string[];
  running: boolean;
  usage: { inputTokens: number; outputTokens: number };
  /** Queues a message for the running turn. Returns false when no turn is running. */
  steer(text: string): boolean;
  clear(): void;
}

let sessionCounter = 0;

export function newId(prefix = ""): string {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return prefix + c.randomUUID();
  return `${prefix}${Date.now().toString(36)}-${(++sessionCounter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createSession(opts: { id?: string; history?: any[]; family?: string | null } = {}): AgentSession {
  const s: AgentSession = {
    id: opts.id ?? newId("s-"),
    family: opts.family ?? null,
    history: opts.history ?? [],
    touched: new Set(),
    queue: [],
    running: false,
    usage: { inputTokens: 0, outputTokens: 0 },
    steer(text: string) {
      if (!s.running) return false;
      s.queue.push(text);
      return true;
    },
    clear() {
      s.history = [];
      s.family = null;
      s.touched.clear();
      s.queue = [];
      s.usage = { inputTokens: 0, outputTokens: 0 };
    },
  };
  return s;
}

// ---------------------------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------------------------

export interface AgentRunOptions {
  host: ToolHost;
  config: ProviderConfig;
  message: string;
  /** Keeps the conversation between turns (see {@link createSession}). A fresh one if omitted. */
  session?: AgentSession;
  /** "ask" (default) | "auto-edit" | "turbo". */
  approvalMode?: ApprovalMode;
  /** Read-only research that ends with a plan. */
  planMode?: boolean;
  /** Asked for each call that needs approval. Missing = every such call is rejected. */
  approve?: (req: ApprovalRequest) => Promise<boolean>;
  customInstructions?: string;
  /** Extra context appended to the message (e.g. active file). */
  context?: string;
  /** Custom agent name from `.cepheus/agents/*.md`. */
  agent?: string;
  mcp?: McpProvider;
  maxSteps?: number;
  maxTokens?: number;
  fetch?: FetchLike;
  /** Advanced provider call options (timeouts, retry delay). */
  callOptions?: Partial<CallOptions>;
  /** Preloaded customizations (default: loaded from the workspace on every turn). */
  customizations?: Customizations;
}

interface RunCtx {
  custom: Customizations;
  allow: string[] | null;
  planMode: boolean;
}

/**
 * Runs one user turn to completion. Never throws for provider/tool errors: they are emitted as
 * `error` events and the final status is "error". Final status is "idle", "stopped" or "error".
 */
export async function runAgentTurn(opts: AgentRunOptions, emit: (ev: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
  const session = opts.session ?? createSession();
  const sid = session.id;
  const safeEmit = (ev: AgentEvent) => {
    try {
      emit(ev);
    } catch {
      /* a broken listener must not break the loop */
    }
  };
  if (session.running) {
    safeEmit({ type: "error", sessionId: sid, message: "This agent is still working. Stop it first or wait for it to finish." });
    return;
  }
  session.running = true;
  safeEmit({ type: "status", sessionId: sid, status: "running" });
  try {
    await runLoop(opts, session, safeEmit, signal);
    safeEmit({ type: "status", sessionId: sid, status: signal?.aborted ? "stopped" : "idle" });
  } catch (e: any) {
    if (e instanceof AbortedError || signal?.aborted) {
      safeEmit({ type: "status", sessionId: sid, status: "stopped" });
    } else {
      safeEmit({ type: "error", sessionId: sid, message: String(e?.message ?? e) });
      safeEmit({ type: "status", sessionId: sid, status: "error" });
    }
  } finally {
    session.queue = [];
    session.running = false;
  }
}

function now() {
  return Date.now();
}

async function runHooks(
  host: ToolHost,
  emit: (ev: AgentEvent) => void,
  sid: string,
  ctx: RunCtx,
  event: string,
  tool: string,
  payload: any,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const h of hooksFor(ctx.custom, event, tool)) {
    const t0 = now();
    const timeoutMs = Math.min(600, Math.max(1, h.timeout ?? 60)) * 1000;
    let code = -1;
    let stdout = "";
    let stderr = "";
    try {
      const r = await host.runCommand(h.command, {
        cwd: host.root,
        input: JSON.stringify(payload),
        env: { CEPHEUS_HOOK_EVENT: event, CEPHEUS_TOOL_NAME: tool, CEPHEUS_SESSION_ID: sid },
        timeoutMs,
        signal,
      });
      code = r.timedOut ? -1 : r.code;
      stdout = r.stdout;
      stderr = r.timedOut ? `Hook timed out after ${timeoutMs / 1000}s` : r.stderr;
    } catch (e: any) {
      stderr = String(e?.message ?? e);
    }
    const blocked = event === "preToolUse" && code !== 0;
    emit({
      type: "debug",
      sessionId: sid,
      entry: {
        kind: "hook",
        event,
        tool,
        command: h.command,
        exitCode: code,
        stdout: stdout.slice(0, 4000),
        stderr: stderr.slice(0, 4000),
        durationMs: now() - t0,
        blocked,
        ts: now(),
      },
    });
    if (blocked) {
      const why = stderr.trim() || stdout.trim();
      return `Blocked by preToolUse hook \`${h.command}\` (exit ${code}): ${why || "no reason given"}`;
    }
  }
  return null;
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function runLoop(opts: AgentRunOptions, session: AgentSession, emit: (ev: AgentEvent) => void, signal?: AbortSignal) {
  const sid = session.id;
  const host = opts.host;
  const ci = !!host.caseInsensitive;
  let cfg: ProviderConfig = { ...opts.config };
  const planMode = !!opts.planMode;
  const approvalMode: ApprovalMode = opts.approvalMode ?? "ask";
  const debug = (entry: Record<string, any>) => emit({ type: "debug", sessionId: sid, entry: { ...entry, ts: now() } });

  if (!opts.message.trim()) throw new Error("Empty message.");

  // A session's history is in its provider's native format; switching format starts fresh.
  const fam = family(cfg.provider);
  if (session.family && session.family !== fam && session.history.length) {
    emit({ type: "warning", sessionId: sid, message: "Switched to a provider with a different message format: the conversation starts fresh." });
    session.history = [];
  }
  session.family = fam;

  // --- customizations -----------------------------------------------------------------
  const custom = opts.customizations ?? (await loadCustomizations(host));
  let agentDef: AgentDef | undefined;
  if (opts.agent) {
    agentDef = custom.agents.find((a) => a.name === opts.agent);
    if (!agentDef)
      emit({ type: "warning", sessionId: sid, message: `Custom agent '${opts.agent}' was not found in .cepheus/agents; using the default agent.` });
  }
  if (agentDef?.model) cfg = { ...cfg, model: agentDef.model, fallbacks: undefined };

  let system = systemPrompt(host, opts.customInstructions);
  const applicable = applicableInstructions(custom, [...session.touched], ci);
  for (const i of applicable) system += `\n\n# Instructions from ${i.path}\n${i.body.trim()}`;
  if (custom.skills.length) {
    system +=
      "\n\n# Skills\nSkills are reusable instructions for specific tasks. When a task matches a skill, call load_skill with its name first.\n";
    for (const s of custom.skills) system += `- ${s.name}: ${s.description}\n`;
  }
  if (agentDef) system += `\n\n# Agent: ${agentDef.name}\n${agentDef.body.trim()}`;
  if (planMode) system += PLAN_MODE_PROMPT;

  // --- tools --------------------------------------------------------------------------
  let toolDefs: ToolDef[] = definitions();
  if (custom.skills.length) toolDefs.push(loadSkillDef());
  if (!planMode && opts.mcp) {
    try {
      toolDefs.push(...(await opts.mcp.toolDefs()));
    } catch (e: any) {
      emit({ type: "warning", sessionId: sid, message: `MCP: ${e?.message ?? e}` });
    }
  }
  const allow = agentDef?.tools ?? null;
  toolDefs = toolDefs.filter((t) => (!planMode || isReadOnly(t.name)) && toolAllowed(allow, t.name));
  const allowed = new Set(toolDefs.map((t) => t.name));
  const mcpCount = toolDefs.filter((t) => t.name.startsWith("mcp__")).length;

  emit({
    type: "context",
    sessionId: sid,
    instructions: applicable.map((i) => i.path),
    skills: custom.skills.map((s) => s.name),
    agent: agentDef?.name ?? null,
    mcpTools: mcpCount,
    planMode,
  });
  debug({
    kind: "context",
    instructions: applicable.map((i) => i.path),
    skills: custom.skills.map((s) => s.name),
    agent: agentDef?.name ?? null,
    tools: toolDefs.map((t) => t.name),
    hooks: custom.hooks.length,
    planMode,
    model: cfg.model,
    provider: cfg.provider,
    approvalMode,
  });
  const ctx: RunCtx = { custom, allow, planMode };

  let userMsg = opts.message;
  if (opts.context?.trim()) userMsg += `\n\n<editor_context>\n${opts.context}\n</editor_context>`;
  pushUserText(cfg, session.history, userMsg);

  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  let steps = 0;
  for (;;) {
    if (signal?.aborted) break;
    if (steps >= maxSteps) {
      emit({ type: "warning", sessionId: sid, message: `Stopped after ${maxSteps} steps. Send a message to continue.` });
      break;
    }
    steps++;
    for (const m of session.queue.splice(0)) {
      pushUserText(cfg, session.history, `[Message from the user, sent while you were working]\n${m}`);
      debug({ kind: "steer", text: m.slice(0, 500) });
      emit({ type: "steered", sessionId: sid, text: m });
    }

    const t0 = now();
    let res;
    try {
      res = await callModel(cfg, system, toolDefs, session.history, {
        maxTokens: opts.maxTokens ?? 16000,
        signal,
        fetch: opts.fetch,
        onTextDelta: (text) => emit({ type: "textDelta", sessionId: sid, text }),
        ...opts.callOptions,
      });
    } catch (e: any) {
      if (e instanceof AbortedError || signal?.aborted) break;
      debug({ kind: "turn", provider: cfg.provider, model: cfg.model, durationMs: now() - t0, error: String(e?.message ?? e) });
      throw e;
    }
    const { entry, turn } = res;
    session.history.push(entry);
    debug({
      kind: "turn",
      provider: turn.provider,
      model: turn.model,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      durationMs: now() - t0,
      toolCalls: turn.calls.length,
    });
    session.usage.inputTokens += turn.inputTokens;
    session.usage.outputTokens += turn.outputTokens;
    emit({ type: "usage", sessionId: sid, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, model: turn.model, provider: turn.provider });
    for (const n of turn.notices) emit({ type: "warning", sessionId: sid, message: n });
    for (const t of turn.thinking) emit({ type: "thinking", sessionId: sid, text: t });
    for (const t of turn.texts) if (t.trim()) emit({ type: "text", sessionId: sid, text: t });
    if (turn.warning) emit({ type: "warning", sessionId: sid, message: turn.warning });

    if (!turn.calls.length) {
      if (signal?.aborted) break;
      if (session.queue.length) continue; // the user steered while the model was answering
      break;
    }

    const outcomes: ToolOutcome[] = [];
    for (const call of turn.calls) {
      // After a stop request, still answer every pending call so the history stays valid.
      if (signal?.aborted) {
        outcomes.push({ call, output: "Cancelled by the user.", isError: true });
        continue;
      }
      emit({ type: "toolCall", sessionId: sid, callId: call.id, name: call.name, args: call.args });
      if (call.name === "update_plan") emit({ type: "plan", sessionId: sid, items: Array.isArray(call.args?.items) ? call.args.items : [] });
      const t1 = now();
      let output: string;
      let isError: boolean;
      try {
        [output, isError] = await runTool(opts, session, emit, ctx, allowed, approvalMode, call, signal);
      } catch (e: any) {
        if (e instanceof AbortedError || signal?.aborted) [output, isError] = ["Cancelled by the user.", true];
        else [output, isError] = [String(e?.message ?? e), true];
      }
      debug({
        kind: "tool",
        name: call.name,
        args: JSON.stringify(call.args ?? {}).slice(0, 2000),
        durationMs: now() - t1,
        resultSize: output.length,
        error: isError ? output.slice(0, 500) : null,
      });
      emit({ type: "toolResult", sessionId: sid, callId: call.id, name: call.name, output, isError });
      outcomes.push({ call, output, isError });
    }
    session.history.push(...toolResults(cfg, outcomes));
  }
  await runHooks(host, emit, sid, ctx, "stop", "", { event: "stop", sessionId: sid, workspace: host.root });
}

async function runTool(
  opts: AgentRunOptions,
  session: AgentSession,
  emit: (ev: AgentEvent) => void,
  ctx: RunCtx,
  allowed: Set<string>,
  approvalMode: ApprovalMode,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<[string, boolean]> {
  const host = opts.host;
  const sid = session.id;
  // Enforced here too: models sometimes call tools they were not offered.
  if (!allowed.has(call.name)) {
    if (ctx.planMode && !isReadOnly(call.name))
      return [`\`${call.name}\` is not available in Plan mode. Only read-only tools can be used; finish the plan instead.`, true];
    if (ctx.allow) return [`\`${call.name}\` is not in this agent's tool allowlist.`, true];
    return [`Tool '${call.name}' is not available.`, true];
  }

  const payload = { event: "preToolUse", sessionId: sid, workspace: host.root, tool: call.name, args: call.args };
  const block = await runHooks(host, emit, sid, ctx, "preToolUse", call.name, payload, signal);
  if (block) return [block, true];

  if (needsApproval(call.name, approvalMode)) {
    const req: ApprovalRequest = { approvalId: newId("a-"), callId: call.id, name: call.name, args: call.args };
    emit({ type: "status", sessionId: sid, status: "waiting" });
    emit({ type: "approvalRequest", sessionId: sid, ...req });
    let approved = false;
    try {
      approved = opts.approve ? await abortable(opts.approve(req), signal) : false;
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      approved = false;
    }
    emit({ type: "status", sessionId: sid, status: "running" });
    if (!approved) return ["The user rejected this action. Ask how they want to proceed, or try a different approach.", true];
  }

  if (typeof call.args?.path === "string") {
    session.touched.add(call.args.path.replace(/\\/g, "/").replace(/^\.\//, ""));
  }
  let output: string;
  let isError: boolean;
  if (call.name === "load_skill") {
    try {
      [output, isError] = [await loadSkill(host, ctx.custom.skills, call.args), false];
    } catch (e: any) {
      [output, isError] = [String(e?.message ?? e), true];
    }
  } else if (call.name.startsWith("mcp__")) {
    if (!opts.mcp) [output, isError] = [`MCP tool '${call.name}' is not available.`, true];
    else {
      try {
        const r = await opts.mcp.call(call.name, call.args, signal);
        [output, isError] = [truncate(r.output), r.isError];
      } catch (e: any) {
        [output, isError] = [String(e?.message ?? e), true];
      }
    }
  } else {
    try {
      const r = await executeTool(host, call.name, call.args, signal);
      if (r.change) {
        session.touched.add(relative(host.root, r.change.path, !!host.caseInsensitive));
        emit({ type: "fileChanged", sessionId: sid, path: r.change.path, relPath: r.change.relPath, before: r.change.before, after: r.change.after });
      }
      [output, isError] = [r.output, false];
    } catch (e: any) {
      if (signal?.aborted) throw new AbortedError();
      [output, isError] = [String(e?.message ?? e), true];
    }
  }
  const post = {
    event: "postToolUse",
    sessionId: sid,
    workspace: host.root,
    tool: call.name,
    args: call.args,
    result: output.slice(0, 20_000),
    isError,
  };
  await runHooks(host, emit, sid, ctx, "postToolUse", call.name, post, signal);
  return [output, isError];
}

/** Loads the workspace customizations (instructions, skills, agents, hooks) for UIs. */
export { loadCustomizations } from "./customize.js";
