/**
 * Provider calls that the web backends answer without the agent loop: `models_list`,
 * `nvidia_models`, `ai_oneshot` (fallback when the core does not export a one-shot helper) and
 * the Open VSX registry. Pure `fetch`, no `node:*` imports, so the browser backend reuses it.
 */

export interface WebProviderConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string | null;
  effort?: string | null;
  label?: string | null;
  [k: string]: any;
}

export interface ModelInfo {
  id: string;
  name?: string | null;
  contextWindow?: number | null;
  maxOutput?: number | null;
  tools?: boolean | null;
  vision?: boolean | null;
  reasoning?: boolean | null;
}

export const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const ANTHROPIC_VERSION = "2026-10-21";

/** Set by the browser backend: Anthropic only accepts browser requests with this opt-in header. */
let browserMode = false;
export function setBrowserMode(on: boolean) {
  browserMode = on;
}

const base = (c: WebProviderConfig, dflt: string) => (c.baseUrl && c.baseUrl.trim() ? c.baseUrl.trim().replace(/\/+$/, "") : dflt);

function isChatModel(id: string): boolean {
  const s = id.toLowerCase();
  const skip = ["embed", "safety", "guard", "clip", "retriever", "rerank", "pii", "detector", "translate", "calibration", "starcoder",
    "parakeet", "riva", "whisper", "tts", "asr", "gliner", "cosmos", "dall-e", "moderation", "davinci", "babbage", "realtime",
    "transcribe", "gpt-image", "-audio", "imagen", "veo", "aqa"];
  return !skip.some((k) => s.includes(k));
}

/** Explains network failures; in the browser most of them are CORS refusals. */
export function explainFetchError(e: unknown, cfg: WebProviderConfig | null, url: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (!browserMode || !/fetch|network|load failed|cors/i.test(msg)) return new Error(`Cannot reach ${url}: ${msg}`);
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  let hint = "The provider refused the request from a web page (CORS) or is unreachable.";
  const p = cfg?.provider;
  if (/localhost|127\.0\.0\.1/.test(host) && /11434/.test(host)) {
    hint = "Ollama rejects web pages by default. Restart it with OLLAMA_ORIGINS set to this site (for example OLLAMA_ORIGINS=* or the page's origin).";
  } else if (p === "nvidia" || host.includes("nvidia.com")) {
    hint = "NVIDIA's API does not allow requests from web pages (CORS). Use `cepheus web` (the local server) to use NVIDIA models.";
  } else if (host.includes("localhost") || host.includes("127.0.0.1")) {
    hint = "Local model servers must allow this page's origin (CORS) — e.g. enable CORS in LM Studio's server settings.";
  }
  return new Error(`${hint} (${host}: ${msg}) — run \`cepheus web\` for the full experience.`);
}

async function getJson(url: string, headers: Record<string, string>, cfg: WebProviderConfig | null): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { headers });
  } catch (e) {
    throw explainFetchError(e, cfg, url);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from ${new URL(url).host}`);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: any, cfg: WebProviderConfig): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  } catch (e) {
    throw explainFetchError(e, cfg, url);
  }
  const text = await r.text();
  if (!r.ok) {
    let detail = text.slice(0, 600);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? j?.detail ?? detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`${cfg.label || cfg.provider} returned HTTP ${r.status}: ${detail}`);
  }
  return JSON.parse(text);
}

function anthropicHeaders(key: string): Record<string, string> {
  const h: Record<string, string> = { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  if (browserMode) h["anthropic-dangerous-direct-browser-access"] = "true";
  return h;
}

/** Resolves the NVIDIA key: the user's own, else `defaultNvidiaKey` (server env var), else error. */
function withNvidia(cfg: WebProviderConfig, defaultNvidiaKey?: string): WebProviderConfig {
  if (cfg.provider !== "nvidia") return cfg;
  const key = (cfg.apiKey || "").trim() || (defaultNvidiaKey || "").trim();
  if (!key) {
    throw new Error(
      "The free built-in NVIDIA key is only part of the desktop app. Add your own NVIDIA key (free at build.nvidia.com) in Settings" +
        (browserMode ? "." : ", or start `cepheus web` with NVIDIA_API_KEY set."),
    );
  }
  return { ...cfg, apiKey: key, baseUrl: cfg.baseUrl || NVIDIA_BASE };
}

export async function modelsList(config: WebProviderConfig, defaultNvidiaKey?: string): Promise<ModelInfo[]> {
  const cfg = withNvidia(config, defaultNvidiaKey);
  const out: ModelInfo[] = [];
  if (cfg.provider === "anthropic") {
    const root = base(cfg, "https://api.anthropic.com");
    const v = await getJson(`${root}/v1/models?limit=1000`, anthropicHeaders(cfg.apiKey || ""), cfg);
    for (const m of v?.data ?? []) {
      if (!m?.id) continue;
      const caps = m.capabilities ?? {};
      out.push({
        id: m.id,
        name: m.display_name ?? null,
        contextWindow: m.max_input_tokens ?? null,
        maxOutput: m.max_tokens ?? null,
        tools: true,
        vision: caps?.image_input?.supported ?? null,
        reasoning: caps?.thinking?.supported ?? caps?.effort?.supported ?? null,
      });
    }
  } else if (cfg.provider === "gemini") {
    const root = base(cfg, "https://generativelanguage.googleapis.com");
    const v = await getJson(`${root}/v1beta/models?pageSize=1000`, { "x-goog-api-key": cfg.apiKey || "" }, cfg);
    for (const m of v?.models ?? []) {
      const id = String(m?.name ?? "").replace(/^models\//, "");
      const gen = (m?.supportedGenerationMethods ?? []).includes("generateContent");
      if (!id || !gen || !isChatModel(id) || id.includes("image")) continue;
      out.push({
        id,
        name: m.displayName ?? null,
        contextWindow: m.inputTokenLimit ?? null,
        maxOutput: m.outputTokenLimit ?? null,
        tools: !id.includes("gemma"),
        vision: id.startsWith("gemini"),
        reasoning: typeof m.thinking === "boolean" ? m.thinking : null,
      });
    }
  } else if (cfg.provider === "openai" || cfg.provider === "nvidia") {
    const root = base(cfg, "https://api.openai.com/v1");
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const v = await getJson(`${root}/models`, headers, cfg);
    for (const m of v?.data ?? []) {
      if (!m?.id || !isChatModel(m.id)) continue;
      const params: string[] | undefined = m.supported_parameters;
      const mods: string[] | undefined = m.architecture?.input_modalities;
      out.push({
        id: m.id,
        name: m.name ?? null,
        contextWindow: m.context_length ?? m.context_window ?? null,
        maxOutput: m.top_provider?.max_completion_tokens ?? null,
        tools: params ? params.includes("tools") : null,
        vision: mods ? mods.includes("image") : null,
        reasoning: params ? params.some((p) => p === "reasoning" || p === "include_reasoning") : null,
      });
    }
  } else {
    throw new Error(`Unknown provider '${cfg.provider}'`);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.filter((m, i) => i === 0 || out[i - 1].id !== m.id);
}

/** Single completion without tools (Ctrl+K inline edit, commit messages, completions). */
export async function aiOneshot(config: WebProviderConfig, system: string, prompt: string, maxTokens = 8000, defaultNvidiaKey?: string): Promise<string> {
  const cfg = withNvidia(config, defaultNvidiaKey);
  if (cfg.provider !== "openai" && cfg.provider !== "nvidia" && !(cfg.apiKey || "").trim()) {
    throw new Error("No API key configured. Open Settings and add your API key.");
  }
  if (cfg.provider === "anthropic") {
    const root = base(cfg, "https://api.anthropic.com");
    const v = await postJson(`${root}/v1/messages`, anthropicHeaders(cfg.apiKey || ""), {
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }, cfg);
    return (v?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  }
  if (cfg.provider === "gemini") {
    const root = base(cfg, "https://generativelanguage.googleapis.com");
    const v = await postJson(`${root}/v1beta/models/${cfg.model}:generateContent`, { "x-goog-api-key": cfg.apiKey || "" }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }, cfg);
    return (v?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => typeof p?.text === "string" && !p.thought).map((p: any) => p.text).join("");
  }
  const root = base(cfg, "https://api.openai.com/v1");
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const v = await postJson(`${root}/chat/completions`, headers, {
    model: cfg.model,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
  }, cfg);
  const c = v?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : "";
}

// ---------------------------------------------------------------------------------------------
// Open VSX
// ---------------------------------------------------------------------------------------------

const REGISTRY = "https://open-vsx.org";

export async function openvsxSearch(query: string, category?: string | null): Promise<any> {
  const q = new URLSearchParams({ query: query ?? "", size: "40", sortBy: "downloadCount" });
  if (category) q.set("category", category);
  return getJson(`${REGISTRY}/api/-/search?${q}`, {}, null).catch((e) => {
    throw new Error(`Cannot reach the extension registry: ${e instanceof Error ? e.message : e}`);
  });
}

export async function openvsxMeta(namespace: string, name: string): Promise<any> {
  return getJson(`${REGISTRY}/api/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, {}, null).catch((e) => {
    throw new Error(`Cannot reach the extension registry: ${e instanceof Error ? e.message : e}`);
  });
}

export async function openvsxText(url: string): Promise<string> {
  if (!url.startsWith(REGISTRY + "/") && !url.startsWith("https://openvsxorg.blob.core.windows.net/")) throw new Error("URL not allowed");
  let r: Response;
  try {
    r = await fetch(url);
  } catch (e) {
    throw explainFetchError(e, null, url);
  }
  return r.text();
}
