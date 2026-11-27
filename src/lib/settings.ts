import type { ProviderConfig } from "./api";

export type Provider = "nvidia" | "anthropic" | "openai" | "gemini";
export type ApprovalMode = "ask" | "auto-edit" | "turbo";

/** A user-made theme from Theme Studio. */
export interface CustomTheme {
  id: string; // "custom:<slug>"
  name: string;
  kind: "dark" | "light";
  ui: { bg: string; surface: string; border: string; fg: string; accent: string };
  syntax: { keyword: string; string: string; number: string; comment: string; type: string };
}

export interface Settings {
  provider: Provider;
  keys: Record<Provider, string>;
  models: Record<Provider, string>;
  baseUrls: Record<Provider, string>;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  approvalMode: ApprovalMode;
  customInstructions: string;
  inlineCompletion: boolean;
  completionModel: string;
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  /** "builtin:ink" | "ext:<extId>:<label>" | "custom:<slug>" */
  theme: string;
  customThemes: CustomTheme[];
  /** "" = Cepheus monograms, otherwise "<extId>:<iconThemeId>" */
  iconTheme: string;
  disabledExtensions: string[];
  autoSave: boolean;
  shell: string;
  recent: string[];
  githubToken: string;
  sshHosts: SshHost[];
  /** Whole-window zoom factor (Ctrl+= / Ctrl+- / Ctrl+0). */
  uiZoom: number;
  /** User overrides: command id → key combo ("" = unbound). */
  keybindings: Record<string, string>;
  /** Show git blame for the current line. */
  inlineBlame: boolean;
  /** Added/modified/deleted markers vs HEAD in the editor gutter. */
  quickDiff: boolean;
  /** Language servers by Monaco language id: command line to start it. */
  languageServers: Record<string, string>;
  /** Global MCP servers for the agent: name → {command,args,env} (stdio) or {url,headers} (HTTP). */
  mcpServers: Record<string, McpServerConfig>;
  /** Ask language servers for diagnostics of every workspace file, not only open ones. */
  lspWorkspaceDiagnostics: boolean;
  /** Type-check TS/JS in the built-in worker (unresolvable-module errors are filtered out). */
  tsSemanticValidation: boolean;
  /** Screen reader optimizations in the editor and terminal. */
  accessibilitySupport: "auto" | "on" | "off";
  /** Network proxy for all backend requests (also exported to git/docker as HTTP(S)_PROXY). */
  proxy: { http: string; https: string; noProxy: string };
  /** Extra trusted CA certificates (PEM file paths), e.g. for a corporate TLS proxy. */
  trustedCertificates: string[];
  /** Cepheus collects no telemetry; the setting documents that and can be locked by policy. */
  telemetryLevel: "off";
  /** Open VSX-compatible registry ("" = https://open-vsx.org). */
  extensionRegistryUrl: string;
  /** "automatic" downloads and asks to restart · "startup" checks on start · "manual" · "none". */
  updateMode: "automatic" | "startup" | "manual" | "none";
  /** Language Models: extra named OpenAI-compatible providers. */
  customProviders: CustomProvider[];
  /** Language Models: models hidden from pickers, as "<provider id>|<model>". */
  hiddenModels: string[];
  /** Default chat model pick: "" = provider + models[provider], "auto", or "custom:<id>|<model>". */
  modelPick: string;
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Model ids typed by the user (for servers without a /models endpoint). */
  models?: string[];
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface SshHost {
  id: string; // also the connection id used in ssh:// paths
  label: string;
  host: string;
  port: number;
  user: string;
  auth: "auto" | "password" | "key" | "agent";
  keyPath: string;
  lastFolder: string;
}

/** Free built-in provider: fast, reliable tool calling on NVIDIA NIM. */
export const NVIDIA_DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

export const DEFAULT_SETTINGS: Settings = {
  provider: "nvidia",
  keys: { nvidia: "", anthropic: "", openai: "", gemini: "" },
  models: { nvidia: NVIDIA_DEFAULT_MODEL, anthropic: "claude-opus-5-5", openai: "gpt-5", gemini: "gemini-3-pro-preview" },
  baseUrls: { nvidia: "", anthropic: "", openai: "", gemini: "" },
  effort: "high",
  approvalMode: "ask",
  customInstructions: "",
  inlineCompletion: false,
  completionModel: "",
  fontSize: 14,
  fontFamily: "",
  tabSize: 2,
  wordWrap: false,
  minimap: true,
  theme: "builtin:ink",
  customThemes: [],
  iconTheme: "",
  disabledExtensions: [],
  autoSave: false,
  shell: "",
  recent: [],
  githubToken: "",
  sshHosts: [],
  uiZoom: 1,
  keybindings: {},
  inlineBlame: true,
  quickDiff: true,
  languageServers: {},
  mcpServers: {},
  proxy: { http: "", https: "", noProxy: "" },
  trustedCertificates: [],
  telemetryLevel: "off",
  extensionRegistryUrl: "",
  updateMode: "startup",
  lspWorkspaceDiagnostics: true,
  tsSemanticValidation: true,
  accessibilitySupport: "auto",
  customProviders: [],
  hiddenModels: [],
  modelPick: "",
};

export function mergeSettings(raw: any): Settings {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_SETTINGS);
  const s: Settings = {
    ...DEFAULT_SETTINGS,
    ...raw,
    keys: { ...DEFAULT_SETTINGS.keys, ...(raw.keys ?? {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(raw.models ?? {}) },
    baseUrls: { ...DEFAULT_SETTINGS.baseUrls, ...(raw.baseUrls ?? {}) },
    recent: Array.isArray(raw.recent) ? raw.recent : [],
    customThemes: Array.isArray(raw.customThemes) ? raw.customThemes : [],
    disabledExtensions: Array.isArray(raw.disabledExtensions) ? raw.disabledExtensions : [],
    sshHosts: Array.isArray(raw.sshHosts) ? raw.sshHosts : [],
    keybindings: raw.keybindings && typeof raw.keybindings === "object" ? raw.keybindings : {},
    languageServers: raw.languageServers && typeof raw.languageServers === "object" ? raw.languageServers : {},
    mcpServers: raw.mcpServers && typeof raw.mcpServers === "object" && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {},
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(raw.proxy && typeof raw.proxy === "object" ? raw.proxy : {}) },
    trustedCertificates: Array.isArray(raw.trustedCertificates) ? raw.trustedCertificates : [],
    customProviders: Array.isArray(raw.customProviders) ? raw.customProviders : [],
    hiddenModels: Array.isArray(raw.hiddenModels) ? raw.hiddenModels : [],
    modelPick: typeof raw.modelPick === "string" ? raw.modelPick : "",
    telemetryLevel: "off",
    updateMode: ["automatic", "startup", "manual", "none"].includes(raw.updateMode) ? raw.updateMode : "startup",
    uiZoom: typeof raw.uiZoom === "number" && raw.uiZoom >= 0.5 && raw.uiZoom <= 2 ? raw.uiZoom : 1,
  };
  // Nobody configured a paid provider yet: start on the free NVIDIA models.
  if (s.provider !== "nvidia" && s.provider !== "openai" && !s.keys[s.provider]) s.provider = "nvidia";
  if (!/^(builtin|ext|custom):/.test(s.theme)) s.theme = s.theme === "vs" ? "builtin:paper" : "builtin:ink";
  return s;
}

export function providerConfig(s: Settings, modelOverride?: string, effortOverride?: string): ProviderConfig {
  const p = s.provider;
  return {
    provider: p,
    apiKey: s.keys[p] ?? "",
    model: (modelOverride && modelOverride.trim()) || s.models[p],
    baseUrl: s.baseUrls[p] || undefined,
    effort: effortOverride ?? s.effort,
  };
}

export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  nvidia: [NVIDIA_DEFAULT_MODEL, "minimaxai/minimax-m3.1-flash", "nvidia/nemotron-3.5-lightning-30b-a3b", "stepfun-ai/step-5-preview"],
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  openai: ["gpt-5", "gpt-5-mini", "o4-mini", "llama3.1 (Ollama)", "qwen2.5-coder (Ollama)"],
  gemini: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
};

/** Strips // and /* *\/ comments and trailing commas (VS Code settings/themes are JSONC). */
export function parseJsonc(text: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; }
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}
