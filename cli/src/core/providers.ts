/**
 * Provider adapters (mirrors src-tauri/src/agent/providers.rs) built on the global `fetch`.
 *
 * Each session keeps its history in the provider's *native* message format, so provider-specific
 * blocks (Claude thinking blocks, Gemini thought signatures, ...) are echoed back unchanged.
 * On top of the adapters: Auto fallback across candidates of the same message format
 * (429 / 5xx / timeouts / model not found), friendly error messages and live model listing.
 */
import type { ProviderConfig, ProviderKind, ToolDef, ToolOutcome, Turn, ToolCall } from "./types.js";

export const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const ANTHROPIC_VERSION = "2026-10-21";

// ---------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Environment variable holding the key. */
  envKey?: string;
  needsKey: boolean;
  local?: boolean;
  defaultModel: string;
  /** Suggested models (Auto tries them in order). */
  models: string[];
  keyUrl?: string;
}

export const PRESETS: ProviderPreset[] = [
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "nvidia",
    baseUrl: NVIDIA_BASE,
    envKey: "NVIDIA_API_KEY",
    needsKey: true,
    defaultModel: "auto",
    models: [NVIDIA_DEFAULT_MODEL, "nvidia/nemotron-3.5-lightning-30b-a3b", "minimaxai/minimax-m3.1-flash", "stepfun-ai/step-5-preview"],
    keyUrl: "https://build.nvidia.com",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    needsKey: true,
    defaultModel: "claude-opus-5-5",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
    keyUrl: "https://console.anthropic.com",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    envKey: "GEMINI_API_KEY",
    needsKey: true,
    defaultModel: "gemini-3-pro-preview",
    models: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    needsKey: true,
    defaultModel: "gpt-5",
    models: ["gpt-5", "gpt-5-mini", "o4-mini"],
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    needsKey: true,
    defaultModel: "openai/gpt-5",
    models: ["openai/gpt-5", "anthropic/claude-sonnet-5-5", "google/gemini-2.5-pro"],
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    needsKey: true,
    defaultModel: "openai/gpt-oss-120b",
    models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "ollama",
    label: "Ollama",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
    local: true,
    defaultModel: "qwen2.5-coder",
    models: ["qwen2.5-coder", "llama3.1"],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    kind: "openai",
    baseUrl: "http://localhost:1234/v1",
    needsKey: false,
    local: true,
    defaultModel: "local-model",
    models: [],
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    kind: "openai",
    baseUrl: "http://localhost:8080/v1",
    needsKey: false,
    local: true,
    defaultModel: "local-model",
    models: [],
  },
  {
    id: "vllm",
    label: "vLLM",
    kind: "openai",
    baseUrl: "http://localhost:8000/v1",
    needsKey: false,
    local: true,
    defaultModel: "local-model",
    models: [],
  },
];

export function presetById(id: string | undefined | null): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === (id ?? "").toLowerCase());
}

/**
 * Model "auto" (or an explicit `fallbacks` list) becomes a candidate list: the preset's
 * suggested models in order, each a fallback for the previous one.
 */
export function expandAuto(cfg: ProviderConfig, extraFallbackModels: string[] = []): ProviderConfig {
  const preset = presetById(cfg.source ?? cfg.provider);
  let models: string[] = [];
  if (!cfg.model || cfg.model === "auto") models = [...(preset?.models ?? [])];
  else models = [cfg.model];
  models.push(...extraFallbackModels);
  models = models.filter((m, i) => m && models.indexOf(m) === i);
  if (!models.length) return { ...cfg, model: cfg.model === "auto" ? preset?.defaultModel ?? "" : cfg.model };
  const [first, ...rest] = models;
  return { ...cfg, model: first, fallbacks: rest.map((m) => ({ ...cfg, model: m, fallbacks: undefined })) };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type ErrKind = "http" | "timeout" | "network" | "bad_response";

export class ApiError extends Error {
  constructor(
    public kind: ErrKind,
    public detail: string,
    public status?: number,
    public retryAfter?: number,
  ) {
    super(detail);
  }
  get code() {
    return this.status ?? 0;
  }
  /** The model itself can't be used with this key. */
  modelUnavailable(): boolean {
    const d = this.detail.toLowerCase();
    if (this.code === 404 || this.code === 410) return true;
    if (this.code === 400 || this.code === 422)
      return (
        d.includes("model") &&
        ["not found", "does not exist", "not supported", "unknown model", "invalid model", "no such model"].some((s) => d.includes(s))
      );
    return false;
  }
  /** Worth retrying the same request a moment later. */
  transient(): boolean {
    const c = this.code;
    return this.kind === "timeout" || this.kind === "network" || [408, 409, 425, 429].includes(c) || (c >= 500 && c <= 599);
  }
  /** The key/endpoint is unusable (skip other models on the same endpoint). */
  endpointDead(): boolean {
    return this.code === 401 || this.code === 402 || (this.kind === "network" && this.status == null);
  }
}

export function providerLabel(cfg: ProviderConfig): string {
  if (cfg.label?.trim()) return cfg.label;
  switch (cfg.provider) {
    case "nvidia":
      return "NVIDIA";
    case "anthropic":
      return "Anthropic";
    case "gemini":
      return "Google";
    case "openai": {
      const b = (cfg.baseUrl ?? "").toLowerCase();
      if (b.includes("11434") || b.includes("ollama")) return "Ollama";
      if (b.includes("1234") || b.includes("lmstudio")) return "LM Studio";
      if (b.includes("openrouter")) return "OpenRouter";
      if (b.includes("groq")) return "Groq";
      if (!b || b.includes("api.openai.com")) return "OpenAI";
      return "OpenAI-compatible";
    }
  }
  return String(cfg.provider);
}

export function isLocal(cfg: ProviderConfig): boolean {
  const b = cfg.baseUrl ?? "";
  return b.includes("localhost") || b.includes("127.0.0.1") || b.includes("0.0.0.0");
}

function shortReason(e: ApiError): string {
  if (e.kind === "timeout") return "timed out";
  if (e.kind === "network") return "network error";
  if (e.kind === "bad_response") return "bad response";
  if (e.modelUnavailable()) return `${e.code} not available`;
  if (e.code === 429) return "429 rate limited";
  if (e.code === 401) return "401 key rejected";
  if (e.code === 403) return "403 access denied";
  return `error ${e.code}`;
}

/** Maps any provider error to a clear message with a suggested action. */
export function friendly(cfg: ProviderConfig, e: ApiError): string {
  const who = cfg.model ? `${providerLabel(cfg)} · ${cfg.model}` : providerLabel(cfg);
  let what: string;
  let hint: string;
  switch (e.kind) {
    case "timeout":
      what = "The request timed out.";
      hint = "Retry, or pick a faster model (/model), or use model 'auto'.";
      break;
    case "network":
      if (isLocal(cfg)) {
        what = "Could not reach the local model server.";
        hint = `Make sure Ollama / LM Studio is running at ${cfg.baseUrl ?? ""} (for Ollama: \`ollama serve\`, then \`ollama pull <model>\`).`;
      } else {
        what = "Could not reach the provider (network error).";
        hint = "Check your internet connection or proxy, then retry.";
      }
      break;
    case "bad_response":
      what = "The provider sent an unexpected response.";
      hint = "Retry, or switch to another model.";
      break;
    default: {
      const c = e.code;
      if (c === 401 && cfg.provider === "nvidia") {
        what = "The NVIDIA API key was rejected (401).";
        hint = "Check NVIDIA_API_KEY or run `cepheus login`. Get a free developer key at https://build.nvidia.com.";
      } else if (c === 401) {
        what = "The API key was rejected (401).";
        hint = "Check the key for this provider (environment variable or `cepheus login`).";
      } else if (c === 402) {
        what = "This account is out of credits (402).";
        hint = "Add credits with the provider, or switch provider (/provider).";
      } else if (c === 403) {
        what = "Access denied (403): this key can't use this model.";
        hint = "Switch to another model (/model), or use a key that has access.";
      } else if (e.modelUnavailable()) {
        what = `This model isn't available for your account (${c}).`;
        hint = "Pick another model with /model or `cepheus models`, or use model 'auto' to skip unavailable models.";
      } else if (c === 429) {
        what = "Rate limit reached (429).";
        hint =
          cfg.provider === "nvidia"
            ? "Free developer keys are rate limited: wait a minute and retry, or use model 'auto' to fall back to other models."
            : "Wait a moment and retry, or switch to another model.";
      } else if (c === 413) {
        what = "The request is too large for this model (413).";
        hint = "Start fresh with /clear or pick a model with a larger context window.";
      } else if (c === 400) {
        what = "The provider rejected the request (400).";
        hint = "Try another model; this one may not support tool calling or this context size.";
      } else if (c >= 500) {
        what = `The provider had a server error (${c}).`;
        hint = "Retry in a moment, or switch to another model.";
      } else {
        what = `API error ${c}.`;
        hint = "Retry, or switch to another model.";
      }
    }
  }
  // NVIDIA's 404 names internal function/account ids, which only add noise.
  const raw = e.detail.includes("Not found for account") ? "Not found for this account." : e.detail;
  let detail = raw.slice(0, 300);
  if (raw.length > 300) detail += "…";
  return detail.trim() ? `${who}: ${what} ${hint}\nDetails: ${detail}` : `${who}: ${what} ${hint}`;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

export type FetchLike = (url: string, init?: any) => Promise<Response>;

export interface CallOptions {
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with each streamed text chunk (OpenAI-compatible providers). */
  onTextDelta?: (text: string) => void;
  fetch?: FetchLike;
  /** Delay before the quiet retry of a transient failure (default: Retry-After or 2s). */
  retryDelayMs?: number;
  /** Per-attempt timeout when another candidate is waiting (default 240s). */
  attemptTimeoutMs?: number;
  /** Timeout of the last candidate (default 600s). */
  timeoutMs?: number;
}

function base(cfg: ProviderConfig, def: string): string {
  const b = (cfg.baseUrl ?? "").trim() || def;
  return b.replace(/\/+$/, "");
}

export class AbortedError extends Error {
  constructor() {
    super("Cancelled by the user.");
    this.name = "AbortError";
  }
}

/** Combines the user's signal with a timeout. */
function timed(user: AbortSignal | undefined, ms: number) {
  const ctl = new AbortController();
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  const onAbort = () => ctl.abort();
  if (user) {
    if (user.aborted) ctl.abort();
    else user.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(t);
      user?.removeEventListener("abort", onAbort);
    },
  };
}

function errDetail(text: string): string {
  try {
    const v = JSON.parse(text);
    const cands = [v?.error?.message, v?.[0]?.error?.message, v?.detail, v?.message, v?.error];
    for (const c of cands) if (typeof c === "string" && c) return c;
  } catch {
    /* not JSON */
  }
  return text;
}

interface Ctx {
  fetch: FetchLike;
  signal: AbortSignal;
  timedOut: () => boolean;
  user?: AbortSignal;
}

async function send(ctx: Ctx, url: string, init: { method?: string; headers: Record<string, string>; body?: any }): Promise<Response> {
  let resp: Response;
  try {
    resp = await ctx.fetch(url, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: init.body !== undefined ? { "content-type": "application/json", ...init.headers } : init.headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctx.signal,
    });
  } catch (e: any) {
    throw netError(ctx, e);
  }
  if (!resp.ok) {
    const ra = parseInt(resp.headers.get("retry-after") ?? "", 10);
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    throw new ApiError("http", errDetail(text) || resp.statusText || "", resp.status, Number.isFinite(ra) ? ra : undefined);
  }
  return resp;
}

function netError(ctx: Ctx, e: any): Error {
  if (ctx.user?.aborted) return new AbortedError();
  if (ctx.timedOut()) return new ApiError("timeout", "no answer in time");
  if (e instanceof ApiError || e instanceof AbortedError) return e;
  const cause = e?.cause?.code || e?.cause?.message || "";
  return new ApiError("network", [e?.message, cause].filter(Boolean).join(": "));
}

async function readJson(ctx: Ctx, resp: Response): Promise<any> {
  let text: string;
  try {
    text = await resp.text();
  } catch (e) {
    throw netError(ctx, e);
  }
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new ApiError("bad_response", `Bad JSON from API: ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------------------------

/** History wire format. Fallback only moves between providers that share one. */
export function family(provider: string): "anthropic" | "gemini" | "openai" {
  if (provider === "anthropic") return "anthropic";
  if (provider === "gemini") return "gemini";
  return "openai";
}

export function userText(cfg: Pick<ProviderConfig, "provider">, text: string): any {
  return cfg.provider === "gemini" ? { role: "user", parts: [{ text }] } : { role: "user", content: text };
}

/** Appends user text, merging into a trailing user entry so roles keep alternating. */
export function pushUserText(cfg: Pick<ProviderConfig, "provider">, history: any[], text: string) {
  const last = history[history.length - 1];
  if (last && last.role === "user") {
    if (cfg.provider === "gemini" && Array.isArray(last.parts)) {
      last.parts.push({ text });
      return;
    }
    if (cfg.provider === "anthropic") {
      if (Array.isArray(last.content)) {
        last.content.push({ type: "text", text });
        return;
      }
      if (typeof last.content === "string") {
        last.content += "\n\n" + text;
        return;
      }
    }
  }
  history.push(userText(cfg, text));
}

/** History entries to append for a batch of tool results. */
export function toolResults(cfg: Pick<ProviderConfig, "provider">, results: ToolOutcome[]): any[] {
  const fam = family(cfg.provider);
  if (fam === "openai") return results.map((r) => ({ role: "tool", tool_call_id: r.call.id, content: r.output }));
  if (fam === "gemini")
    return [
      {
        role: "user",
        parts: results.map((r) => {
          const fr: any = { name: r.call.name, response: r.isError ? { error: r.output } : { output: r.output } };
          if (!r.call.id.startsWith("gemini-")) fr.id = r.call.id;
          return { functionResponse: fr };
        }),
      },
    ];
  return [
    {
      role: "user",
      content: results.map((r) => ({ type: "tool_result", tool_use_id: r.call.id, content: r.output, is_error: r.isError })),
    },
  ];
}

const unavailable = new Set<string>();

export function availKey(cfg: ProviderConfig): string {
  return `${cfg.source ?? cfg.provider}|${cfg.model}`;
}

export function resetUnavailable() {
  unavailable.clear();
}

export function candidates(cfg: ProviderConfig): ProviderConfig[] {
  const fam = family(cfg.provider);
  const all = [cfg, ...(cfg.fallbacks ?? [])].map((c) => ({ ...c, fallbacks: undefined, effort: c.effort ?? cfg.effort }));
  const seen = new Set<string>();
  const out: ProviderConfig[] = [];
  for (const c of all) {
    if (family(c.provider) !== fam || !c.model?.trim()) continue;
    const k = availKey(c);
    if (unavailable.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  if (!out.length) out.push(all[0]);
  return out;
}

function emptyTurn(): Turn {
  return { texts: [], thinking: [], calls: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, provider: "", model: "", notices: [] };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        rej(new AbortedError());
      },
      { once: true },
    );
  });

/**
 * Calls the model once, with Auto fallback when `cfg.fallbacks` is set. Returns the assistant
 * entry to append to history plus the parsed turn. Errors are thrown with friendly messages;
 * a user cancel throws {@link AbortedError}.
 */
export async function callModel(
  cfg: ProviderConfig,
  system: string,
  tools: ToolDef[],
  history: any[],
  opts: CallOptions = {},
): Promise<{ entry: any; turn: Turn }> {
  const cands = candidates(cfg);
  const n = cands.length;
  const notices: string[] = [];
  const deadEndpoints = new Set<string>();
  let lastErr: string | null = null;
  for (let i = 0; i < n; i++) {
    const c = cands[i];
    const endpoint = `${c.source ?? c.provider}|${c.baseUrl ?? ""}`;
    if (deadEndpoints.has(endpoint)) continue;
    const more = i + 1 < n;
    try {
      const r = await attempt(c, system, tools, history, opts, more);
      r.turn.provider = c.source ?? c.provider;
      r.turn.model = c.model;
      r.turn.notices = notices;
      return r;
    } catch (e: any) {
      if (e instanceof AbortedError || opts.signal?.aborted) throw new AbortedError();
      const err = e instanceof ApiError ? e : new ApiError("bad_response", String(e?.message ?? e));
      if (err.modelUnavailable()) unavailable.add(availKey(c));
      if (err.endpointDead()) deadEndpoints.add(endpoint);
      const msg = friendly(c, err);
      if (n === 1) throw new Error(msg);
      notices.push(`Auto: ${providerLabel(c)} · ${c.model} ${shortReason(err)}; trying the next model.`);
      lastErr = msg;
    }
  }
  throw new Error(`Auto: every candidate model failed (${notices.length} tried). Last error: ${lastErr ?? "no usable model is configured."}`);
}

async function attempt(c: ProviderConfig, system: string, tools: ToolDef[], history: any[], opts: CallOptions, more: boolean) {
  const once = () => callOne(c, system, tools, history, opts, more ? opts.attemptTimeoutMs ?? 240_000 : opts.timeoutMs ?? 600_000);
  if (more) return once();
  try {
    return await once();
  } catch (e) {
    if (e instanceof ApiError && e.transient()) {
      const ms = opts.retryDelayMs ?? Math.min(10, Math.max(1, e.retryAfter ?? 2)) * 1000;
      await sleep(ms, opts.signal);
      return once();
    }
    throw e;
  }
}

async function callOne(c: ProviderConfig, system: string, tools: ToolDef[], history: any[], opts: CallOptions, timeoutMs: number) {
  const t = timed(opts.signal, timeoutMs);
  const ctx: Ctx = { fetch: opts.fetch ?? ((u, i) => globalThis.fetch(u, i)), signal: t.signal, timedOut: t.timedOut, user: opts.signal };
  try {
    switch (c.provider) {
      case "anthropic":
        return await anthropic(ctx, c, system, tools, history, opts.maxTokens ?? 16000);
      case "gemini":
        return await gemini(ctx, c, system, tools, history, opts.maxTokens ?? 16000);
      case "nvidia":
        return await openai(ctx, nvidiaConfig(c), system, tools, history, opts.maxTokens ?? 16000, opts.onTextDelta);
      case "openai":
        return await openai(ctx, c, system, tools, history, opts.maxTokens ?? 16000, opts.onTextDelta);
      default:
        throw new ApiError("bad_response", `Unknown provider '${(c as any).provider}'`);
    }
  } catch (e) {
    if (e instanceof ApiError || e instanceof AbortedError) throw e;
    throw netError(ctx, e);
  } finally {
    t.done();
  }
}

// ---------------------------------------------------------------------------------------------
// Anthropic (Claude) - Messages API
// ---------------------------------------------------------------------------------------------

function claudeSupportsAdaptive(model: string) {
  return ["opus-5", "opus-4-6", "opus-4-7", "opus-4-8", "sonnet-5", "sonnet-4-6", "fable", "mythos", "haiku-5"].some((m) => model.includes(m));
}

function claudeSupportsFallbacks(model: string) {
  return ["claude-opus-5-5", "claude-opus-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"].includes(model);
}

export function buildAnthropicRequest(cfg: ProviderConfig, system: string, tools: ToolDef[], history: any[], maxTokens: number) {
  const url = `${base(cfg, "https://api.anthropic.com")}/v1/messages`;
  const body: any = { model: cfg.model, max_tokens: maxTokens, system, messages: history, cache_control: { type: "ephemeral" } };
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  if (claudeSupportsAdaptive(cfg.model)) {
    body.thinking = { type: "adaptive", display: "summarized" };
    if (cfg.effort) body.output_config = { effort: cfg.effort };
  }
  const headers: Record<string, string> = {
    "x-api-key": cfg.apiKey ?? "",
    "anthropic-version": ANTHROPIC_VERSION,
    // Lets the web build call the API from a browser; harmless elsewhere.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (claudeSupportsFallbacks(cfg.model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  }
  return { url, headers, body };
}

export function parseAnthropicResponse(resp: any): { entry: any; turn: Turn } {
  const content = Array.isArray(resp?.content) ? resp.content : [];
  const turn = emptyTurn();
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") turn.texts.push(block.text);
    else if (block?.type === "thinking" && block.thinking) turn.thinking.push(block.thinking);
    else if (block?.type === "tool_use") turn.calls.push({ id: block.id ?? "", name: block.name ?? "", args: block.input ?? {} });
  }
  if (resp?.stop_reason === "refusal") {
    turn.warning = `The model declined this request (category: ${resp?.stop_details?.category ?? "unspecified"}).`;
    turn.calls = [];
  } else if (resp?.stop_reason === "max_tokens") {
    turn.warning = "Response hit the max_tokens limit and was cut off.";
  }
  const u = (k: string) => Number(resp?.usage?.[k] ?? 0) || 0;
  turn.cacheReadTokens = u("cache_read_input_tokens");
  turn.cacheWriteTokens = u("cache_creation_input_tokens");
  turn.inputTokens = u("input_tokens") + turn.cacheReadTokens + turn.cacheWriteTokens;
  turn.outputTokens = u("output_tokens");
  return { entry: { role: "assistant", content }, turn };
}

async function anthropic(ctx: Ctx, cfg: ProviderConfig, system: string, tools: ToolDef[], history: any[], maxTokens: number) {
  const r = buildAnthropicRequest(cfg, system, tools, history, maxTokens);
  const resp = await send(ctx, r.url, { headers: r.headers, body: r.body });
  return parseAnthropicResponse(await readJson(ctx, resp));
}

// ---------------------------------------------------------------------------------------------
// NVIDIA NIM - OpenAI-compatible (the user's own key; nothing is embedded)
// ---------------------------------------------------------------------------------------------

export function nvidiaConfig(cfg: ProviderConfig): ProviderConfig {
  return { ...cfg, apiKey: (cfg.apiKey ?? "").trim(), baseUrl: (cfg.baseUrl ?? "").trim() || NVIDIA_BASE };
}

/** Models that cannot chat (embeddings, guards, detectors, image/audio models, ...) are filtered out. */
export function isChatModel(id: string): boolean {
  const s = id.toLowerCase();
  const SKIP = [
    "embed", "safety", "guard", "clip", "retriever", "rerank", "pii", "detector", "translate", "calibration", "starcoder",
    "parakeet", "riva", "whisper", "tts", "asr", "gliner", "cosmos", "dall-e", "moderation", "davinci", "babbage",
    "realtime", "transcribe", "gpt-image", "-audio", "imagen", "veo", "aqa",
  ];
  return !SKIP.some((k) => s.includes(k));
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama, LM Studio, llama.cpp, vLLM, NVIDIA)
// ---------------------------------------------------------------------------------------------

function openaiReasoning(model: string) {
  const m = model.toLowerCase();
  const short = m.slice(m.lastIndexOf("/") + 1);
  return (
    (short.startsWith("o1") || short.startsWith("o3") || short.startsWith("o4") || short.startsWith("gpt-5") || short.includes("gpt-oss")) &&
    !short.includes("chat")
  );
}

export function buildOpenAIRequest(cfg: ProviderConfig, system: string, tools: ToolDef[], history: any[], maxTokens: number, stream = false) {
  const url = `${base(cfg, "https://api.openai.com/v1")}/chat/completions`;
  const body: any = { model: cfg.model, messages: [{ role: "system", content: system }, ...history] };
  // NIM endpoints default to a small completion limit; OpenAI's newer models reject max_tokens.
  if (base(cfg, "") === NVIDIA_BASE) body.max_tokens = Math.min(maxTokens, 16384);
  if (tools.length)
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
  if (cfg.effort && openaiReasoning(cfg.model)) body.reasoning_effort = cfg.effort === "low" ? "low" : cfg.effort === "medium" ? "medium" : "high";
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  return { url, headers, body };
}

function parseArgs(s: any): any {
  if (s && typeof s === "object") return s;
  if (typeof s !== "string" || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

let idCounter = 0;
const genId = () => `call_${Date.now().toString(36)}_${++idCounter}`;

export function parseOpenAIResponse(resp: any): { entry: any; turn: Turn } {
  const msg = resp?.choices?.[0]?.message;
  if (!msg) throw new ApiError("bad_response", "Empty response from model");
  const turn = emptyTurn();
  if (typeof msg.content === "string" && msg.content) turn.texts.push(msg.content);
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (typeof reasoning === "string" && reasoning) turn.thinking.push(reasoning);
  const entry: any = { role: "assistant", content: msg.content ?? null };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    const calls = msg.tool_calls.map((c: any) => {
      const id = c.id || genId();
      const fn = c.function ?? {};
      turn.calls.push({ id, name: fn.name ?? "", args: parseArgs(fn.arguments) });
      return {
        ...c,
        id,
        type: c.type ?? "function",
        function: { ...fn, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) },
      };
    });
    entry.tool_calls = calls;
  }
  if (resp?.choices?.[0]?.finish_reason === "length") turn.warning = "Response was cut off (length limit).";
  turn.inputTokens = Number(resp?.usage?.prompt_tokens ?? 0) || 0;
  turn.outputTokens = Number(resp?.usage?.completion_tokens ?? 0) || 0;
  turn.cacheReadTokens = Number(resp?.usage?.prompt_tokens_details?.cached_tokens ?? 0) || 0;
  return { entry, turn };
}

/** Accumulates an OpenAI-compatible SSE stream into the same shape as a non-streamed response. */
export class OpenAIStreamAccumulator {
  content = "";
  reasoning = "";
  calls: { id?: string; type?: string; function: { name: string; arguments: string } }[] = [];
  finishReason: string | null = null;
  usage: any = null;

  push(chunk: any, onText?: (t: string) => void) {
    if (chunk?.usage) this.usage = chunk.usage;
    const ch = chunk?.choices?.[0];
    if (!ch) return;
    if (ch.finish_reason) this.finishReason = ch.finish_reason;
    const d = ch.delta ?? ch.message ?? {};
    if (typeof d.content === "string" && d.content) {
      this.content += d.content;
      onText?.(d.content);
    }
    const r = d.reasoning_content ?? d.reasoning;
    if (typeof r === "string") this.reasoning += r;
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc: any) => {
        // No index (some local servers): a new id starts a new call, otherwise continue the last one.
        const idx = typeof tc.index === "number" ? tc.index : tc.id || !this.calls.length ? this.calls.length : this.calls.length - 1;
        const cur = (this.calls[idx] ??= { function: { name: "", arguments: "" } });
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.function.name += tc.function.name;
        const a = tc.function?.arguments;
        if (typeof a === "string") cur.function.arguments += a;
        else if (a && typeof a === "object") cur.function.arguments += JSON.stringify(a);
      });
    }
  }

  toResponse(): any {
    const message: any = { role: "assistant", content: this.content || null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    const calls = this.calls.filter(Boolean);
    if (calls.length) message.tool_calls = calls.map((c) => ({ id: c.id, type: c.type ?? "function", function: c.function }));
    return { choices: [{ message, finish_reason: this.finishReason }], usage: this.usage ?? undefined };
  }
}

/** Parses SSE text into `data:` payloads; returns the unconsumed tail. */
export function parseSse(buffer: string, onData: (data: string) => void): string {
  const parts = buffer.split(/\r?\n\r?\n/);
  const tail = parts.pop() ?? "";
  for (const ev of parts) {
    const data = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) onData(data);
  }
  return tail;
}

async function openai(
  ctx: Ctx,
  cfg: ProviderConfig,
  system: string,
  tools: ToolDef[],
  history: any[],
  maxTokens: number,
  onTextDelta?: (t: string) => void,
): Promise<{ entry: any; turn: Turn }> {
  const wantStream = cfg.stream !== false && !!onTextDelta;
  const run = async (stream: boolean, withEffort: boolean) => {
    const r = buildOpenAIRequest(cfg, system, tools, history, maxTokens, stream);
    if (!withEffort) delete r.body.reasoning_effort;
    const resp = await send(ctx, r.url, { headers: r.headers, body: r.body });
    const ct = resp.headers.get("content-type") ?? "";
    if (!stream || !ct.includes("text/event-stream") || !resp.body) {
      const out = parseOpenAIResponse(await readJson(ctx, resp));
      return out;
    }
    const acc = new OpenAIStreamAccumulator();
    let streamed = false;
    const reader = (resp.body as any).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (data: string) => {
      if (data.trim() === "[DONE]") return;
      let j: any;
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j?.error) throw new ApiError("http", typeof j.error === "string" ? j.error : j.error.message ?? JSON.stringify(j.error), Number(j.error.code) || 500);
      acc.push(j, (t) => {
        streamed = true;
        onTextDelta?.(t);
      });
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        buf = parseSse(buf, handle);
      }
      buf += dec.decode();
      if (buf.trim()) parseSse(buf + "\n\n", handle);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw netError(ctx, e);
    }
    const out = parseOpenAIResponse(acc.toResponse());
    out.turn.streamed = streamed;
    return out;
  };
  const hasEffort = !!(cfg.effort && openaiReasoning(cfg.model));
  try {
    return await run(wantStream, true);
  } catch (e) {
    if (!(e instanceof ApiError) || (e.code !== 400 && e.code !== 422)) throw e;
    const d = e.detail.toLowerCase();
    // Some compatible servers reject the reasoning flag or streaming options: retry once without.
    if (hasEffort && d.includes("reasoning")) return run(wantStream, false);
    if (wantStream && !e.modelUnavailable()) return run(false, true);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Google Gemini - generateContent
// ---------------------------------------------------------------------------------------------

function geminiThinking(model: string, effort: string | undefined, maxTokens: number): any {
  if (!effort) return undefined;
  const m = model.toLowerCase();
  if (m.includes("gemini-3")) return { thinkingLevel: effort === "low" || effort === "medium" ? "low" : "high", includeThoughts: true };
  if (m.includes("gemini-2.5")) {
    const b = ({ low: 1024, medium: 4096, high: 8192, xhigh: 16384 } as Record<string, number>)[effort] ?? -1;
    return { thinkingBudget: b > 0 ? Math.min(b, Math.max(1024, Math.floor(maxTokens / 2))) : b, includeThoughts: true };
  }
  return undefined;
}

export function buildGeminiRequest(cfg: ProviderConfig, system: string, tools: ToolDef[], history: any[], maxTokens: number) {
  const url = `${base(cfg, "https://generativelanguage.googleapis.com")}/v1beta/models/${cfg.model}:generateContent`;
  const body: any = {
    systemInstruction: { parts: [{ text: system }] },
    contents: history,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const th = geminiThinking(cfg.model, cfg.effort, maxTokens);
  if (th) body.generationConfig.thinkingConfig = th;
  if (tools.length)
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }];
  return { url, headers: { "x-goog-api-key": cfg.apiKey ?? "" } as Record<string, string>, body };
}

export function parseGeminiResponse(resp: any): { entry: any; turn: Turn } {
  const content = resp?.candidates?.[0]?.content ?? { role: "model", parts: [] };
  const turn = emptyTurn();
  const parts: any[] = Array.isArray(content.parts) ? content.parts : [];
  parts.forEach((part, i) => {
    if (part?.functionCall) {
      const fc = part.functionCall;
      turn.calls.push({ id: typeof fc.id === "string" ? fc.id : `gemini-${i}`, name: fc.name ?? "", args: fc.args ?? {} });
    } else if (typeof part?.text === "string") {
      if (part.thought === true) turn.thinking.push(part.text);
      else turn.texts.push(part.text);
    }
  });
  const fr = resp?.candidates?.[0]?.finishReason;
  if (fr === "SAFETY" || fr === "PROHIBITED_CONTENT" || fr === "RECITATION") turn.warning = "The model stopped for safety reasons.";
  else if (fr === "MAX_TOKENS") turn.warning = "Response was cut off (max tokens).";
  const u = (k: string) => Number(resp?.usageMetadata?.[k] ?? 0) || 0;
  turn.inputTokens = u("promptTokenCount");
  turn.outputTokens = u("candidatesTokenCount") + u("thoughtsTokenCount");
  turn.cacheReadTokens = u("cachedContentTokenCount");
  const entry = { ...content, role: "model", parts: parts.length ? parts : [{ text: "" }] };
  return { entry, turn };
}

async function gemini(ctx: Ctx, cfg: ProviderConfig, system: string, tools: ToolDef[], history: any[], maxTokens: number) {
  const r = buildGeminiRequest(cfg, system, tools, history, maxTokens);
  const resp = await send(ctx, r.url, { headers: r.headers, body: r.body });
  return parseGeminiResponse(await readJson(ctx, resp));
}

// ---------------------------------------------------------------------------------------------
// Live model listing
// ---------------------------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
}

export async function listModels(cfg: ProviderConfig, opts: { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ModelInfo[]> {
  const t = timed(opts.signal, opts.timeoutMs ?? 30_000);
  const ctx: Ctx = { fetch: opts.fetch ?? ((u, i) => globalThis.fetch(u, i)), signal: t.signal, timedOut: t.timedOut, user: opts.signal };
  const out: ModelInfo[] = [];
  try {
    if (cfg.provider === "anthropic") {
      const root = base(cfg, "https://api.anthropic.com");
      let after: string | null = null;
      for (let i = 0; i < 5; i++) {
        const url: string = `${root}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
        const v = await readJson(ctx, await send(ctx, url, { headers: { "x-api-key": cfg.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION, "anthropic-dangerous-direct-browser-access": "true" } }));
        for (const m of v?.data ?? []) if (m?.id) out.push({ id: m.id, name: m.display_name, contextWindow: m.max_input_tokens });
        if (v?.has_more !== true || !v?.last_id) break;
        after = v.last_id;
      }
    } else if (cfg.provider === "gemini") {
      const root = base(cfg, "https://generativelanguage.googleapis.com");
      let token: string | null = null;
      for (let i = 0; i < 5; i++) {
        const url: string = `${root}/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`;
        const v = await readJson(ctx, await send(ctx, url, { headers: { "x-goog-api-key": cfg.apiKey ?? "" } }));
        for (const m of v?.models ?? []) {
          const id = String(m?.name ?? "").replace(/^models\//, "");
          const gen = Array.isArray(m?.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent");
          if (!id || !gen || !isChatModel(id) || id.includes("image")) continue;
          out.push({ id, name: m.displayName, contextWindow: m.inputTokenLimit });
        }
        token = v?.nextPageToken || null;
        if (!token) break;
      }
    } else {
      const c = cfg.provider === "nvidia" ? nvidiaConfig(cfg) : cfg;
      const headers: Record<string, string> = {};
      if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      const v = await readJson(ctx, await send(ctx, `${base(c, "https://api.openai.com/v1")}/models`, { headers }));
      for (const m of v?.data ?? []) {
        if (!m?.id || !isChatModel(m.id)) continue;
        out.push({ id: m.id, name: m.name, contextWindow: m.context_length ?? m.context_window });
      }
    }
  } catch (e: any) {
    if (e instanceof AbortedError) throw e;
    const err = e instanceof ApiError ? e : netError(ctx, e);
    throw new Error(err instanceof ApiError ? friendly({ ...cfg, model: "" }, err) : String(err.message));
  } finally {
    t.done();
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.filter((m, i) => i === 0 || out[i - 1].id !== m.id);
}

export type { Turn, ToolCall };
