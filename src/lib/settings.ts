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
  /** Extension features (src/lib/extensions.ts): grammar overrides, auto-update, pins, active keymap. */
  extensionOptions: ExtensionOptions;
  /** "automatic" downloads and asks to restart · "startup" checks on start · "manual" · "none". */
  updateMode: "automatic" | "startup" | "manual" | "none";
  /** Language Models: extra named OpenAI-compatible providers. */
  customProviders: CustomProvider[];
  /** Language Models: models hidden from pickers, as "<provider id>|<model>". */
  hiddenModels: string[];
  /** Default chat model pick: "" = provider + models[provider], "auto", or "custom:<id>|<model>". */
  modelPick: string;

  // ---- Settings editor (SettingsModal / settingsSchema.ts). Wiring is listed per key there. ----
  // Motion & accessibility
  reduceMotion: boolean;
  cursorBlinking: "blink" | "smooth" | "phase" | "expand" | "solid";
  cursorSmoothCaretAnimation: "off" | "explicit" | "on";
  cursorStyle: "line" | "block" | "underline" | "line-thin" | "block-outline" | "underline-thin";
  cursorWidth: number;
  smoothScrolling: boolean;
  mouseWheelScrollSensitivity: number;
  fastScrollSensitivity: number;
  highContrastFocus: boolean;
  uiFontScale: number;
  reducedTransparency: boolean;
  // Editor text
  fontWeight: string;
  lineHeight: number;
  letterSpacing: number;
  fontLigatures: boolean;
  insertSpaces: boolean;
  detectIndentation: boolean;
  wordWrapMode: "viewport" | "column" | "bounded";
  wordWrapColumn: number;
  rulers: number[];
  renderWhitespace: "none" | "boundary" | "selection" | "trailing" | "all";
  renderControlCharacters: boolean;
  lineNumbers: "on" | "off" | "relative" | "interval";
  renderLineHighlight: "none" | "gutter" | "line" | "all";
  bracketPairColorization: boolean;
  bracketPairGuides: boolean;
  indentationGuides: boolean;
  stickyScroll: boolean;
  stickyScrollMaxLines: number;
  minimapSide: "right" | "left";
  minimapSize: "proportional" | "fill" | "fit";
  minimapRenderCharacters: boolean;
  minimapShowSlider: "mouseover" | "always";
  folding: boolean;
  foldingStrategy: "auto" | "indentation";
  glyphMargin: boolean;
  codeLens: boolean;
  inlayHints: "on" | "off" | "onUnlessPressed" | "offUnlessPressed";
  hoverDelay: number;
  quickSuggestions: boolean;
  quickSuggestionsDelay: number;
  acceptSuggestionOnEnter: "on" | "smart" | "off";
  suggestPreview: boolean;
  snippetSuggestions: "top" | "bottom" | "inline" | "none";
  parameterHints: boolean;
  autoClosingBrackets: "languageDefined" | "always" | "beforeWhitespace" | "never";
  autoClosingQuotes: "languageDefined" | "always" | "beforeWhitespace" | "never";
  autoSurround: "languageDefined" | "quotes" | "brackets" | "never";
  formatOnSave: boolean;
  formatOnPaste: boolean;
  formatOnType: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
  /** Line ending for new/empty files; existing files keep theirs. */
  eol: "auto" | "lf" | "crlf";
  multiCursorModifier: "alt" | "ctrlCmd";
  dragAndDrop: boolean;
  links: boolean;
  occurrencesHighlight: boolean;
  selectionHighlight: boolean;
  unicodeHighlightAmbiguous: boolean;
  unicodeHighlightInvisible: boolean;
  scrollBeyondLastLine: boolean;
  cursorSurroundingLines: number;
  // Files & explorer
  autoSaveMode: "afterDelay" | "onFocusChange" | "onWindowChange";
  autoSaveDelay: number;
  confirmDelete: boolean;
  explorerSortOrder: "default" | "mixed" | "filesFirst" | "type";
  /** Glob patterns hidden from the explorer. */
  filesExclude: string[];
  /** Glob patterns whose file-change events are ignored. */
  watcherExclude: string[];
  // Workbench & layout
  sidebarPosition: "left" | "right";
  activityBarVisible: boolean;
  statusBarVisible: boolean;
  tabPreview: boolean;
  tabCloseButton: "right" | "left" | "off";
  wrapTabs: boolean;
  breadcrumbs: boolean;
  restoreTabs: boolean;
  startupPage: "welcome" | "none" | "lastFolder";
  compactDensity: boolean;
  commandCenter: boolean;
  // Terminal
  shellArgs: string[];
  terminalFontFamily: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalCursorStyle: "block" | "underline" | "bar";
  terminalCursorBlink: boolean;
  terminalScrollback: number;
  terminalCopyOnSelect: boolean;
  terminalRightClick: "menu" | "paste";
  terminalConfirmKill: boolean;
  /** Start folder for new terminals; empty = the open folder. Relative paths resolve against it. */
  terminalCwd: string;
  terminalBell: "none" | "visual" | "sound";
  terminalEnv: Record<string, string>;
  // Agent & AI
  agentPlanModeDefault: boolean;
  agentVerifyDefault: boolean;
  /** Stop a run after this many tool calls (0 = the built-in limit). */
  agentMaxTurns: number;
  agentNotifyApproval: boolean;
  agentNotifyDone: boolean;
  agentNotifySystem: boolean;
  agentAutoOpenChanges: boolean;
  agentIncludeOpenFile: boolean;
  inlineCompletionDebounce: number;
  commitMessageStyle: "plain" | "conventional";
  // Git
  gitAutofetch: boolean;
  gitAutofetchInterval: number;
  gitConfirmSync: boolean;
  /** Placeholders: {author} {ago} {date} {summary} {hash}. */
  blameFormat: string;
  gitSmartCommit: boolean;
  gitDefaultBranch: string;
  gitPostCommit: "none" | "push" | "sync";
  // Notifications & sounds
  toastDuration: number;
  doNotDisturb: boolean;
  soundEffects: boolean;
  soundVolume: number;
  // Extension bridges (src/lib/bridges): VS Code extensions Cepheus stands in for without running their code
  /** Extension id → bridge on/off (installing an extension with a bridge turns it on). */
  bridges: Record<string, boolean>;
  /** Monaco language id → formatter: a bridge formatter ("prettier", "black", "ruff"…) or "editor" (built-in / language server). */
  defaultFormatter: Record<string, string>;
  /** Agent harness for sessions that haven't picked one. */
  agentHarness: "cepheus" | "claude-code" | "codex";
  /** Error Lens: first diagnostic message at the end of its line. */
  inlineErrors: boolean;
  /** Path IntelliSense: relative path completion in strings. */
  pathCompletion: boolean;
  /** Auto Rename Tag: linked editing of HTML/XML/JSX tag pairs. */
  autoRenameTag: boolean;
  /** Apply .editorconfig files (indent, line endings, final newline, trailing whitespace). */
  editorConfig: boolean;
  // Database client (src/lib/db): connection metadata only — passwords live in the OS keychain.
  dbConnections?: import("./db/types").DbConnection[];
  /** ER diagram table positions per "connection|database|schema". */
  dbErLayouts?: Record<string, Record<string, { x: number; y: number }>>;
}

/** Respect the OS "reduce motion" preference until the user chooses. */
const prefersReducedMotion = () => {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
};

export interface ExtensionOptions {
  /** Language id → use the extension's TextMate grammar instead of Monaco's tokenizer. */
  grammars: Record<string, boolean>;
  autoUpdate: boolean;
  /** Extension id → version installed on purpose (skipped by updates). */
  pins: Record<string, string>;
  /** Keymap extension whose bindings are applied, and what it changed (to undo it). */
  keymap: { extId: string; label: string; applied: Record<string, string>; previous: Record<string, string | null> } | null;
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
  extensionOptions: { grammars: {}, autoUpdate: false, pins: {}, keymap: null },
  updateMode: "startup",
  lspWorkspaceDiagnostics: true,
  tsSemanticValidation: true,
  accessibilitySupport: "auto",
  customProviders: [],
  hiddenModels: [],
  modelPick: "",

  reduceMotion: prefersReducedMotion(),
  cursorBlinking: "blink",
  cursorSmoothCaretAnimation: "on",
  cursorStyle: "line",
  cursorWidth: 2,
  smoothScrolling: true,
  mouseWheelScrollSensitivity: 1,
  fastScrollSensitivity: 5,
  highContrastFocus: false,
  uiFontScale: 1,
  reducedTransparency: false,
  fontWeight: "normal",
  lineHeight: 0,
  letterSpacing: 0,
  fontLigatures: true,
  insertSpaces: true,
  detectIndentation: true,
  wordWrapMode: "viewport",
  wordWrapColumn: 80,
  rulers: [],
  renderWhitespace: "selection",
  renderControlCharacters: true,
  lineNumbers: "on",
  renderLineHighlight: "line",
  bracketPairColorization: true,
  bracketPairGuides: true,
  indentationGuides: true,
  stickyScroll: true,
  stickyScrollMaxLines: 5,
  minimapSide: "right",
  minimapSize: "proportional",
  minimapRenderCharacters: true,
  minimapShowSlider: "mouseover",
  folding: true,
  foldingStrategy: "auto",
  glyphMargin: true,
  codeLens: true,
  inlayHints: "on",
  hoverDelay: 300,
  quickSuggestions: true,
  quickSuggestionsDelay: 10,
  acceptSuggestionOnEnter: "on",
  suggestPreview: false,
  snippetSuggestions: "inline",
  parameterHints: true,
  autoClosingBrackets: "languageDefined",
  autoClosingQuotes: "languageDefined",
  autoSurround: "languageDefined",
  formatOnSave: false,
  formatOnPaste: false,
  formatOnType: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  trimFinalNewlines: false,
  eol: "auto",
  multiCursorModifier: "alt",
  dragAndDrop: true,
  links: true,
  occurrencesHighlight: true,
  selectionHighlight: true,
  unicodeHighlightAmbiguous: true,
  unicodeHighlightInvisible: true,
  scrollBeyondLastLine: true,
  cursorSurroundingLines: 0,
  autoSaveMode: "afterDelay",
  autoSaveDelay: 1000,
  confirmDelete: true,
  explorerSortOrder: "default",
  filesExclude: ["**/.git", "**/.DS_Store", "**/Thumbs.db"],
  watcherExclude: [],
  sidebarPosition: "left",
  activityBarVisible: true,
  statusBarVisible: true,
  tabPreview: false,
  tabCloseButton: "right",
  wrapTabs: false,
  breadcrumbs: true,
  restoreTabs: true,
  startupPage: "welcome",
  compactDensity: false,
  commandCenter: true,
  shellArgs: [],
  terminalFontFamily: "",
  terminalFontSize: 13,
  terminalLineHeight: 1,
  terminalCursorStyle: "block",
  terminalCursorBlink: true,
  terminalScrollback: 5000,
  terminalCopyOnSelect: false,
  terminalRightClick: "menu",
  terminalConfirmKill: false,
  terminalCwd: "",
  terminalBell: "none",
  terminalEnv: {},
  agentPlanModeDefault: false,
  agentVerifyDefault: false,
  agentMaxTurns: 0,
  agentNotifyApproval: true,
  agentNotifyDone: true,
  agentNotifySystem: true,
  agentAutoOpenChanges: false,
  agentIncludeOpenFile: true,
  inlineCompletionDebounce: 600,
  commitMessageStyle: "plain",
  gitAutofetch: false,
  gitAutofetchInterval: 180,
  gitConfirmSync: false,
  blameFormat: "{author}, {ago} • {summary}",
  gitSmartCommit: true,
  gitDefaultBranch: "",
  gitPostCommit: "none",
  toastDuration: 3.5,
  doNotDisturb: false,
  soundEffects: false,
  soundVolume: 0.5,
  bridges: {},
  defaultFormatter: {},
  agentHarness: "cepheus",
  inlineErrors: false,
  pathCompletion: true,
  autoRenameTag: false,
  editorConfig: true,
};

/** Normalizes a stored value to the default's shape (wrong type → default). */
function sameShape(raw: any, key: keyof Settings): any {
  const def: any = DEFAULT_SETTINGS[key];
  const v = raw?.[key];
  if (v === undefined) return def;
  if (Array.isArray(def)) return Array.isArray(v) ? v : def;
  if (def && typeof def === "object") return v && typeof v === "object" && !Array.isArray(v) ? v : def;
  return typeof v === typeof def ? v : def;
}
const SHAPED: (keyof Settings)[] = ["rulers", "filesExclude", "watcherExclude", "shellArgs", "terminalEnv", "bridges", "defaultFormatter", "inlineErrors", "pathCompletion", "autoRenameTag", "editorConfig"];

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
    extensionOptions: { ...DEFAULT_SETTINGS.extensionOptions, ...(raw.extensionOptions && typeof raw.extensionOptions === "object" ? raw.extensionOptions : {}) },
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
    agentHarness: ["cepheus", "claude-code", "codex"].includes(raw.agentHarness) ? raw.agentHarness : "cepheus",
    ...Object.fromEntries(SHAPED.map((k) => [k, sameShape(raw, k)])),
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
