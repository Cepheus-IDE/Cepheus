import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { get } from "../store";
import type { ProviderConfig } from "./api";
import { CustomProvider, MODEL_SUGGESTIONS, Provider, Settings } from "./settings";

/** Language models: provider registry, live model lists, capabilities, per-session pick,
 *  Auto selection, usage + prompt-cache stats. Backend: src-tauri/src/agent/providers.rs. */

export type ProviderId = Provider | `custom:${string}`;

export interface ModelInfo {
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  tools?: boolean | null;
  vision?: boolean | null;
  reasoning?: boolean | null;
}

export interface ProviderEntry {
  id: ProviderId;
  name: string;
  /** Has what it needs to send requests (key, base URL, or the free NVIDIA tier). */
  configured: boolean;
  custom?: CustomProvider;
}

/** Extra fields understood by the backend's ProviderConfig. */
export type ModelConfig = ProviderConfig & {
  source?: string;
  label?: string;
  auto?: { tier: "fast" | "strong"; fast: ModelConfig[]; strong: ModelConfig[] };
};

export const AUTO = "auto";
const BUILTIN_NAMES: Record<Provider, string> = {
  nvidia: "NVIDIA (free)",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openai: "OpenAI-compatible",
};

export const pickKey = (pid: string, model: string) => `${pid}|${model}`;
export function splitPick(pick: string): [ProviderId, string] {
  const i = pick.indexOf("|");
  return [pick.slice(0, i) as ProviderId, pick.slice(i + 1)];
}

export function providerEntries(s: Settings): ProviderEntry[] {
  const builtins: ProviderEntry[] = (["nvidia", "anthropic", "gemini", "openai"] as Provider[]).map((p) => ({
    id: p,
    name: BUILTIN_NAMES[p],
    configured: p === "nvidia" || !!s.keys[p]?.trim() || (p === "openai" && !!s.baseUrls.openai?.trim()),
  }));
  const customs: ProviderEntry[] = (s.customProviders ?? []).map((c) => ({
    id: `custom:${c.id}` as ProviderId,
    name: c.name || c.baseUrl,
    configured: !!c.baseUrl.trim(),
    custom: c,
  }));
  return [...builtins, ...customs];
}

export function providerName(s: Settings, pid: string): string {
  if (pid === "claude-code") return "Claude Code";
  if (pid === "codex") return "Codex";
  return providerEntries(s).find((p) => p.id === pid)?.name ?? pid;
}

/** History wire format of a provider; Auto only falls back within one family. */
export function family(pid: string): "openai" | "anthropic" | "gemini" {
  return pid === "anthropic" ? "anthropic" : pid === "gemini" ? "gemini" : "openai";
}

export function baseConfig(s: Settings, pid: ProviderId, model: string): ModelConfig {
  if (pid.startsWith("custom:")) {
    const c = s.customProviders.find((x) => `custom:${x.id}` === pid);
    return { provider: "openai", apiKey: c?.apiKey ?? "", baseUrl: c?.baseUrl || undefined, model, effort: s.effort, source: pid, label: c?.name };
  }
  const p = pid as Provider;
  return { provider: p, apiKey: s.keys[p] ?? "", baseUrl: s.baseUrls[p] || undefined, model, effort: s.effort, source: p };
}

// ------------------------------------------------------------------------------------------
// Capabilities: live API data first, then this table of known model families.
// ------------------------------------------------------------------------------------------

const KNOWN: [RegExp, Partial<ModelInfo>][] = [
  [/claude-(opus|sonnet|fable|mythos|haiku)-5|claude-(opus|sonnet)-4-[678]/, { tools: true, vision: true, reasoning: true, contextWindow: 1_000_000 }],
  [/claude/, { tools: true, vision: true, contextWindow: 200_000 }],
  [/gpt-5/, { tools: true, vision: true, reasoning: true, contextWindow: 400_000 }],
  [/(^|\/)o[134](-|$)/, { tools: true, vision: true, reasoning: true, contextWindow: 200_000 }],
  [/gpt-oss/, { tools: true, reasoning: true, contextWindow: 131_072 }],
  [/gpt-4\.1/, { tools: true, vision: true, contextWindow: 1_047_576 }],
  [/gpt-4o/, { tools: true, vision: true, contextWindow: 128_000 }],
  [/gemini-(3|2\.5)/, { tools: true, vision: true, reasoning: true, contextWindow: 1_048_576 }],
  [/gemini/, { tools: true, vision: true, contextWindow: 1_048_576 }],
  [/gemma/, { tools: false }],
  [/deepseek-r1|qwq|thinking|reason/, { reasoning: true }],
  [/nemotron/, { tools: true, reasoning: true }],
  [/qwen3/, { tools: true, reasoning: true }],
  [/qwen|llama-?3\.[123]|llama3\.[123]|llama-?4|mistral|mixtral|devstral|kimi|glm|minimax|step-|deepseek/, { tools: true }],
  [/-vl\b|-vl-|vision|llava|pixtral|-omni/, { vision: true }],
];

export function capabilities(id: string, api?: ModelInfo): ModelInfo {
  const out: ModelInfo = { id, ...(api ?? {}) };
  const lower = id.toLowerCase();
  for (const [re, caps] of KNOWN) {
    if (!re.test(lower)) continue;
    for (const k of Object.keys(caps) as (keyof ModelInfo)[]) {
      if (out[k] == null) (out as any)[k] = caps[k];
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Live model lists (cached per provider for the app session)
// ------------------------------------------------------------------------------------------

interface ListState { models: ModelInfo[] | null; error?: string; loading: boolean }

export const useModelLists = create<{ lists: Record<string, ListState> }>(() => ({ lists: {} }));
const inflight = new Map<string, Promise<void>>();

export function fetchModels(pid: ProviderId, force = false): Promise<void> {
  const s = get().settings;
  const cur = useModelLists.getState().lists[pid];
  if (!force && cur && (cur.models || cur.loading)) return inflight.get(pid) ?? Promise.resolve();
  const setList = (l: ListState) => useModelLists.setState((st) => ({ lists: { ...st.lists, [pid]: l } }));
  setList({ models: cur?.models ?? null, loading: true });
  const p = invoke<ModelInfo[]>("models_list", { config: baseConfig(s, pid, "") })
    .then((models) => setList({ models, loading: false }))
    .catch((e) => setList({ models: cur?.models ?? null, loading: false, error: String(e) }))
    .finally(() => inflight.delete(pid));
  inflight.set(pid, p);
  return p;
}

/** Loads lists for every configured provider (once). */
export function ensureModelLists(force = false) {
  for (const p of providerEntries(get().settings)) if (p.configured) fetchModels(p.id, force);
}

/** All models of a provider: live list (or suggestions when unavailable) + the configured one. */
export function modelsOf(s: Settings, pid: ProviderId): ModelInfo[] {
  const live = useModelLists.getState().lists[pid]?.models;
  const ids = new Map<string, ModelInfo>();
  const add = (m: ModelInfo) => { if (m.id && !ids.has(m.id)) ids.set(m.id, capabilities(m.id, m)); };
  if (!pid.startsWith("custom:")) {
    const p = pid as Provider;
    if (s.models[p]) add({ id: s.models[p] });
  } else {
    s.customProviders.find((c) => `custom:${c.id}` === pid)?.models?.forEach((id) => add({ id }));
  }
  if (live) live.forEach(add);
  else if (!pid.startsWith("custom:")) MODEL_SUGGESTIONS[pid as Provider].filter((m) => !m.includes("(")).forEach((id) => add({ id }));
  return [...ids.values()];
}

// ------------------------------------------------------------------------------------------
// Unavailable models (404 "not found for account" etc.), remembered across restarts
// ------------------------------------------------------------------------------------------

const UNAVAILABLE_KEY = "cepheus.models.unavailable";
function loadUnavailable(): string[] {
  try { return JSON.parse(localStorage.getItem(UNAVAILABLE_KEY) || "[]"); } catch { return []; }
}
export const useUnavailable = create<{ keys: string[] }>(() => ({ keys: loadUnavailable() }));
function addUnavailable(keys: string[]) {
  const cur = useUnavailable.getState().keys;
  const next = [...new Set([...cur, ...keys])];
  if (next.length === cur.length) return;
  useUnavailable.setState({ keys: next });
  try { localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify(next)); } catch { /* storage full/blocked */ }
}
export function resetUnavailable(keys?: string[]) {
  const next = keys ? useUnavailable.getState().keys.filter((k) => !keys.includes(k)) : [];
  useUnavailable.setState({ keys: next });
  try { localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  invoke("models_reset_unavailable", { keys: keys ?? null }).catch(() => {});
}

export const isHidden = (s: Settings, key: string) => s.hiddenModels.includes(key);

/** Enabled (not hidden) models of every configured provider, for the pickers. */
export function enabledModels(s: Settings): { provider: ProviderEntry; models: ModelInfo[] }[] {
  return providerEntries(s)
    .filter((p) => p.configured)
    .map((p) => ({ provider: p, models: modelsOf(s, p.id).filter((m) => !isHidden(s, pickKey(p.id, m.id))) }))
    .filter((g) => g.models.length > 0);
}

// ------------------------------------------------------------------------------------------
// Per-session pick ("auto" | "<provider id>|<model>")
// ------------------------------------------------------------------------------------------

export const useSessionPicks = create<{ picks: Record<string, string> }>(() => ({ picks: {} }));

export function defaultPick(s: Settings): string {
  if (s.modelPick === AUTO) return AUTO;
  if (s.modelPick.startsWith("custom:")) {
    const [pid] = splitPick(s.modelPick);
    if (s.customProviders.some((c) => `custom:${c.id}` === pid)) return s.modelPick;
  }
  return pickKey(s.provider, s.models[s.provider]);
}

export const pickOf = (sessionId: string, s: Settings) => useSessionPicks.getState().picks[sessionId] ?? defaultPick(s);

export function setSessionPick(sessionId: string, pick: string) {
  useSessionPicks.setState((st) => ({ picks: { ...st.picks, [sessionId]: pick } }));
}

/** Settings after choosing `pick` as the default for new sessions. */
export function withDefaultPick(s: Settings, pick: string): Settings {
  if (pick === AUTO || pick.startsWith("custom:")) return { ...s, modelPick: pick };
  const [pid, model] = splitPick(pick);
  const p = pid as Provider;
  return { ...s, modelPick: "", provider: p, models: { ...s.models, [p]: model } };
}

// ------------------------------------------------------------------------------------------
// Auto model selection
// ------------------------------------------------------------------------------------------

/** Rough capability score from the model id (higher = stronger, lower = faster). */
function strength(id: string): number {
  const m = id.toLowerCase();
  let s = 0;
  if (/opus|fable|mythos|ultra|-pro\b|pro-|gpt-5(?!.*(mini|nano))|\bo3\b(?!-mini)|405b|550b|480b|253b|large|super|kimi-k2|deepseek-(v3|r1)/.test(m)) s += 3;
  if (/sonnet|70b|72b|120b|235b|medium|gpt-4\.1(?!-mini)/.test(m)) s += 2;
  if (/haiku|flash|mini|nano|lite|lightning|small|tiny|\b[1-9]b\b|-[1-9]b|a3b/.test(m)) s -= 2;
  return s;
}

/** Simple heuristic: quick questions go to a fast model, real coding work to the strongest. */
export function promptTier(text: string, priorTurns: number): "fast" | "strong" {
  const t = text.trim();
  if (t.length > 400 || t.includes("```") || priorTurns >= 6) return "strong";
  if (t.length > 60 && /\b(refactor|implement|architect|design|migrate|debug|fix|optimi[sz]e|rewrite|build|create|add|tests?|feature|across|entire|whole|multiple|all files)\b/i.test(t)) return "strong";
  return "fast";
}

const MAX_PER_TIER = 6;

export function autoConfig(s: Settings, text: string, priorTurns: number): ModelConfig {
  const def = defaultPick(s);
  const [defPid, defModel] = def === AUTO ? [s.provider as ProviderId, s.models[s.provider]] : splitPick(def);
  const fam = family(defPid);
  const dead = new Set(useUnavailable.getState().keys);
  const curated = new Set(Object.values(MODEL_SUGGESTIONS).flat());
  const pool: { cfg: ModelConfig; score: number; curated: boolean }[] = [];
  for (const g of enabledModels(s)) {
    if (family(g.provider.id) !== fam) continue;
    for (const m of g.models) {
      const key = pickKey(g.provider.id, m.id);
      if (m.tools === false || dead.has(key)) continue;
      pool.push({ cfg: baseConfig(s, g.provider.id, m.id), score: strength(m.id), curated: curated.has(m.id) || (g.provider.id === defPid && m.id === defModel) });
    }
  }
  const isDefault = (c: ModelConfig) => c.source === defPid && c.model === defModel;
  const order = (dir: 1 | -1) => (a: typeof pool[0], b: typeof pool[0]) =>
    Number(b.curated) - Number(a.curated) || dir * (b.score - a.score);
  const strong = [...pool].sort(order(1));
  // The user's own default model leads the strong tier.
  strong.sort((a, b) => Number(isDefault(b.cfg)) - Number(isDefault(a.cfg)));
  const fast = [...pool].filter((p) => p.score <= 1).sort(order(-1));
  const tier = promptTier(text, priorTurns);
  const fastList = (fast.length ? fast : strong.slice().reverse()).slice(0, MAX_PER_TIER).map((p) => p.cfg);
  const strongList = strong.slice(0, MAX_PER_TIER).map((p) => p.cfg);
  const primary = (tier === "fast" ? fastList[0] : strongList[0]) ?? baseConfig(s, defPid, defModel);
  return {
    ...primary,
    // Stable provider per family keeps the session's native history across Auto picks.
    provider: fam === "openai" ? "openai" : fam,
    model: "Auto",
    source: "auto",
    auto: { tier, fast: fastList, strong: strongList },
  };
}

/** Provider config for the next request of a session (pick / Auto / custom provider). */
export function sessionConfig(sessionId: string, s: Settings, text: string): ModelConfig {
  const pick = pickOf(sessionId, s);
  if (pick === AUTO) {
    const sess = get().sessions.find((x) => x.id === sessionId);
    const priorTurns = sess ? sess.items.filter((i) => i.kind === "tool").length : 0;
    return autoConfig(s, text, priorTurns);
  }
  const [pid, model] = splitPick(pick);
  return baseConfig(s, pid, model);
}

// ------------------------------------------------------------------------------------------
// Usage + prompt cache
// ------------------------------------------------------------------------------------------

export interface Usage { input: number; output: number; requests: number; cacheRead: number; cacheWrite: number }
export interface CacheTurn { at: number; sessionId: string; model: string; input: number; cacheRead: number; cacheWrite: number }
interface UsageState {
  bySession: Record<string, Record<string, Usage>>;
  today: { date: string; byModel: Record<string, Usage> };
  cache: CacheTurn[];
}

const TODAY_KEY = "cepheus.models.usageToday";
const dayStr = () => new Date().toISOString().slice(0, 10);
function loadToday(): UsageState["today"] {
  try {
    const t = JSON.parse(localStorage.getItem(TODAY_KEY) || "null");
    if (t && t.date === dayStr() && t.byModel) return t;
  } catch { /* ignore */ }
  return { date: dayStr(), byModel: {} };
}

export const useUsage = create<UsageState>(() => ({ bySession: {}, today: loadToday(), cache: [] }));
const empty = (): Usage => ({ input: 0, output: 0, requests: 0, cacheRead: 0, cacheWrite: 0 });
const addTo = (u: Usage | undefined, d: Usage): Usage => {
  const b = u ?? empty();
  return { input: b.input + d.input, output: b.output + d.output, requests: b.requests + d.requests, cacheRead: b.cacheRead + d.cacheRead, cacheWrite: b.cacheWrite + d.cacheWrite };
};
export const sumUsage = (m: Record<string, Usage> | undefined): Usage => Object.values(m ?? {}).reduce((a, b) => addTo(a, b), empty());

function recordUsage(ev: any) {
  const key = pickKey(ev.source || ev.provider, ev.model);
  const d: Usage = { input: ev.inputTokens ?? 0, output: ev.outputTokens ?? 0, requests: 1, cacheRead: ev.cacheRead ?? 0, cacheWrite: ev.cacheWrite ?? 0 };
  useUsage.setState((st) => {
    const today = st.today.date === dayStr() ? st.today : { date: dayStr(), byModel: {} };
    const next: UsageState = {
      bySession: { ...st.bySession, [ev.sessionId]: { ...st.bySession[ev.sessionId], [key]: addTo(st.bySession[ev.sessionId]?.[key], d) } },
      today: { date: today.date, byModel: { ...today.byModel, [key]: addTo(today.byModel[key], d) } },
      cache: d.cacheRead || d.cacheWrite || ev.provider === "anthropic" || ev.provider === "claude-code"
        ? [...st.cache, { at: Date.now(), sessionId: ev.sessionId, model: key, input: d.input, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite }].slice(-200)
        : st.cache,
    };
    try { localStorage.setItem(TODAY_KEY, JSON.stringify(next.today)); } catch { /* ignore */ }
    return next;
  });
  if (Array.isArray(ev.unavailable) && ev.unavailable.length) addUnavailable(ev.unavailable);
}

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// ------------------------------------------------------------------------------------------
// Language Models view (modal) state
// ------------------------------------------------------------------------------------------

export type ModelsTab = "models" | "providers" | "usage" | "cache";
export const useModelsView = create<{ open: boolean; tab: ModelsTab }>(() => ({ open: false, tab: "models" }));
export const openLanguageModels = (tab: ModelsTab = "models") => useModelsView.setState({ open: true, tab });

// ------------------------------------------------------------------------------------------
// Backend events (re-subscribed on hot reload)
// ------------------------------------------------------------------------------------------

const g = globalThis as any;
(g.__cepheusModelsUnlisten as (() => void)[] | undefined)?.forEach((f) => f());
g.__cepheusModelsUnlisten = [];
listen<any>("model-usage", ({ payload }) => recordUsage(payload)).then((u) => g.__cepheusModelsUnlisten.push(u)).catch(() => {});
// A failed single-model request never reaches `model-usage`: sync the backend's marks on errors.
listen<any>("agent-event", ({ payload }) => {
  if (payload?.type === "error") invoke<string[]>("models_unavailable").then(addUnavailable).catch(() => {});
}).then((u) => g.__cepheusModelsUnlisten.push(u)).catch(() => {});
