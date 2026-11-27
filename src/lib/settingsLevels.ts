//! Settings levels: user settings (app config folder) and workspace settings
//! (<folder>/.cepheus/settings.json) that override them while that folder is open. Also the
//! "Open Settings (JSON)" editors with schema validation/completion and live apply on save.
//!
//! The store always holds the *effective* settings. `userLevel()` (called by saveSettings)
//! strips the workspace overrides again so they never leak into the user file; a change the
//! Settings UI makes to an overridden key is written to the workspace file instead.

import { api, errMsg } from "./api";
import { DEFAULT_SETTINGS, mergeSettings, parseJsonc, Settings } from "./settings";
import { get, set, toast, useStore } from "../store";
import { registerJsonSchema } from "./jsonSchemas";
import { settingDef } from "./settingsSchema";

/**
 * Keys a workspace may override. An allowlist on purpose: a cloned repo must not be able to
 * change which commands run (language servers, shell, agent approval mode), where code and API
 * keys are sent (providers, base URLs) or what the agent is told.
 */
export const WORKSPACE_KEYS = new Set<string>([
  "fontSize", "fontFamily", "tabSize", "wordWrap", "minimap", "theme", "iconTheme", "autoSave",
  "inlineBlame", "quickDiff", "inlineCompletion", "uiZoom", "lspWorkspaceDiagnostics",
  "tsSemanticValidation", "accessibilitySupport",
  // Settings editor: per-project formatting / display conventions (they never run commands).
  "insertSpaces", "detectIndentation", "rulers", "wordWrapMode", "wordWrapColumn", "renderWhitespace", "lineNumbers",
  "formatOnSave", "formatOnPaste", "formatOnType", "trimTrailingWhitespace", "insertFinalNewline", "trimFinalNewlines", "eol",
  "filesExclude", "explorerSortOrder", "autoSaveMode", "autoSaveDelay",
]);

let configDir: Promise<string> | null = null;
export function userConfigDir(): Promise<string> {
  if (!configDir) configDir = (window as any).__TAURI_INTERNALS__
    ? import("@tauri-apps/api/core").then(({ invoke }) => invoke<string>("user_config_dir"))
    : Promise.reject(new Error("not running in the app"));
  return configDir;
}
export const userSettingsPath = async () => (await userConfigDir()) + "/settings.json";
export const workspaceSettingsPath = (ws: string) => ws.replace(/\\/g, "/").replace(/\/$/, "") + "/.cepheus/settings.json";

/** Workspace overrides currently applied; `shadowed` = the user values they hide. */
let overrides: Record<string, any> = {};
let shadowed: Record<string, any> = {};
let wsFile: string | null = null;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const workspaceOverrides = () => ({ ...overrides });

/** Effective settings → what belongs in the user file. */
export function userLevel(s: Settings): Settings {
  const keys = Object.keys(overrides);
  if (!keys.length) return s;
  const out: any = { ...s };
  let wsChanged = false;
  for (const k of keys) {
    const v = (s as any)[k];
    if (!same(v, overrides[k])) { overrides[k] = v; wsChanged = true; } // edited in the UI → workspace level
    out[k] = shadowed[k];
  }
  if (wsChanged) persistWorkspace();
  return out;
}

async function persistWorkspace() {
  if (!wsFile) return;
  try {
    await api.createDir(wsFile.replace(/\/[^/]*$/, "")).catch(() => {});
    await api.writeFile(wsFile, JSON.stringify(overrides, null, 2) + "\n");
    toast("Saved to workspace settings (.cepheus/settings.json).");
  } catch (e) {
    toast("Failed to save workspace settings: " + errMsg(e), "error");
  }
}

/** Replaces the applied overrides (pass {} to drop them) and re-applies side effects. */
async function applyOverrides(next: Record<string, any>) {
  const user = userLevel(get().settings);
  overrides = {};
  shadowed = {};
  for (const [k, v] of Object.entries(next)) {
    if (!WORKSPACE_KEYS.has(k) || !(k in DEFAULT_SETTINGS)) continue;
    shadowed[k] = (user as any)[k];
    overrides[k] = v;
  }
  const eff = mergeSettings({ ...user, ...overrides });
  // mergeSettings may normalize a value (e.g. an invalid theme); compare against what's applied.
  for (const k of Object.keys(overrides)) overrides[k] = (eff as any)[k];
  const { saveSettings } = await import("./workspace");
  await saveSettings(eff);
}

function parseWorkspaceFile(text: string): Record<string, any> {
  const raw = text.trim() ? parseJsonc(text) : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("must be a JSON object");
  const ignored = Object.keys(raw).filter((k) => !WORKSPACE_KEYS.has(k));
  if (ignored.length) toast(`Workspace settings ignored (user-level only): ${ignored.join(", ")}`);
  return raw;
}

async function loadWorkspace(ws: string | null, reapply = false) {
  wsFile = ws ? workspaceSettingsPath(ws) : null;
  let next: Record<string, any> = {};
  if (wsFile && (await api.exists(wsFile).catch(() => false))) {
    try {
      next = parseWorkspaceFile(await api.readFile(wsFile));
    } catch (e) {
      toast(`.cepheus/settings.json: ${errMsg(e)}`, "error");
    }
  }
  if (Object.keys(next).length || Object.keys(overrides).length || reapply) await applyOverrides(next);
  registerSchemas();
}

/** Called after any file save (from lsp.notifySaved). */
export async function onFileSaved(path: string) {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (wsFile && p === wsFile.toLowerCase()) {
    try {
      await applyOverrides(parseWorkspaceFile(await api.readFile(wsFile)));
      toast("Workspace settings applied.");
    } catch (e) {
      toast(`.cepheus/settings.json not applied: ${errMsg(e)}`, "error");
    }
    return;
  }
  const userFile = await userSettingsPath().catch(() => null);
  if (!userFile || p !== userFile.toLowerCase()) return;
  const { getModelEntry, saveSettings } = await import("./workspace");
  const entry = getModelEntry(path);
  const text = entry?.model.getValue() ?? (await api.readFile(path));
  let user: Settings;
  try {
    const raw = parseJsonc(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("must be a JSON object");
    user = mergeSettings(raw);
  } catch (e) {
    // The backend reads plain JSON: put the last good settings back on disk so nothing is lost on restart.
    await api.saveSettings(userLevel(get().settings)).catch(() => {});
    if (entry) set((s) => ({ dirty: { ...s.dirty, [entry.path]: true } }));
    toast(`settings.json has errors and was not applied (${errMsg(e)}). Fix it and save again.`, "error");
    return;
  }
  for (const k of Object.keys(overrides)) shadowed[k] = (user as any)[k];
  const eff = mergeSettings({ ...user, ...overrides });
  await saveSettings(eff);
  // Disk now holds normalized JSON (comments/trailing commas removed); show exactly that.
  const written = JSON.stringify(userLevel(eff), null, 2);
  if (entry && entry.model.getValue() !== written) {
    entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: written }], () => null);
    entry.savedVersion = entry.model.getAlternativeVersionId();
    set((s) => ({ dirty: { ...s.dirty, [entry.path]: false } }));
  }
  toast("Settings applied.");
}

/** "Preferences: Open User Settings (JSON)". */
export async function openUserSettingsJson() {
  try {
    const path = await userSettingsPath();
    // Make sure the file reflects the current settings (it doesn't exist before the first save).
    if (!(await api.exists(path))) await api.saveSettings(userLevel(get().settings));
    const { openFile } = await import("./workspace");
    await openFile(path);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** "Preferences: Open Workspace Settings (JSON)". */
export async function openWorkspaceSettingsJson() {
  const ws = get().workspace;
  if (!ws) return toast("Open a folder first.");
  const path = workspaceSettingsPath(ws);
  try {
    if (!(await api.exists(path))) {
      await api.createDir(path.replace(/\/[^/]*$/, "")).catch(() => {});
      await api.writeFile(path, "{\n  // Settings here override your user settings while this folder is open.\n  \n}\n");
    }
    const { openFile } = await import("./workspace");
    await openFile(path, 3, 3);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------------------------------------------------------------------------------------------
// JSON schema (validation + completion + hover) generated from DEFAULT_SETTINGS
// ---------------------------------------------------------------------------------------------

const DESCRIPTIONS: Record<string, string> = {
  provider: "AI provider used by the agent.",
  keys: "API keys per provider (stored locally).",
  models: "Model id per provider.",
  baseUrls: "Optional API base URL per provider.",
  effort: "Thinking effort (Claude).",
  approvalMode: "Review policy: ask, auto-edit (edits without asking), turbo (run everything).",
  customInstructions: "Extra instructions sent to the agent.",
  inlineCompletion: "AI inline completion (ghost text).",
  completionModel: "Model for inline completion; empty = agent model.",
  fontSize: "Editor font size in pixels.",
  fontFamily: "Editor font family; empty = default.",
  tabSize: "Number of spaces a tab equals.",
  wordWrap: "Wrap long lines.",
  minimap: "Show the minimap.",
  theme: "Color theme id: builtin:<name>, ext:<extension>:<label> or custom:<slug>.",
  iconTheme: "File icon theme: empty = Cepheus monograms, or <extId>:<iconThemeId>.",
  autoSave: "Save files automatically after a short delay.",
  shell: "Terminal shell executable; empty = default (pwsh/PowerShell on Windows).",
  uiZoom: "Whole-window zoom factor (0.5–2).",
  keybindings: "Keyboard shortcut overrides: command id → key combo (\"\" = unbound).",
  inlineBlame: "Show git blame for the current line.",
  quickDiff: "Gutter markers for changes vs HEAD.",
  languageServers: "Language server command line per Monaco language id (empty = auto-detect).",
  lspWorkspaceDiagnostics: "Ask language servers for problems in all workspace files, not only open ones.",
  tsSemanticValidation: "Type-check TypeScript in the built-in worker (unresolvable imports are ignored).",
  accessibilitySupport: "Screen reader optimizations: auto, on, off.",
};
const ENUMS: Record<string, string[]> = {
  provider: ["nvidia", "anthropic", "openai", "gemini"],
  effort: ["low", "medium", "high", "xhigh", "max"],
  approvalMode: ["ask", "auto-edit", "turbo"],
  accessibilitySupport: ["auto", "on", "off"],
};

function schemaFor(value: unknown): any {
  if (Array.isArray(value)) return { type: "array" };
  if (value === null) return {};
  switch (typeof value) {
    case "boolean": return { type: "boolean" };
    case "number": return { type: "number" };
    case "string": return { type: "string" };
    case "object": {
      const props: Record<string, any> = {};
      for (const [k, v] of Object.entries(value as object)) props[k] = schemaFor(v);
      return Object.keys(props).length ? { type: "object", properties: props } : { type: "object" };
    }
    default: return {};
  }
}

function settingsSchema(onlyKeys?: Set<string>) {
  const properties: Record<string, any> = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (onlyKeys && !onlyKeys.has(k)) continue;
    // Descriptions/enums from the Settings editor registry (settingsSchema.ts) fill the gaps.
    const def = settingDef(k);
    const desc = DESCRIPTIONS[k] ?? def?.description;
    const en = ENUMS[k] ?? (def?.control.type === "enum" ? def.control.options.map((o) => o[0]) : undefined);
    const range = def?.control.type === "number" ? { minimum: def.control.min, maximum: def.control.max } : {};
    properties[k] = { ...schemaFor(v), default: v, ...range, ...(desc ? { description: desc } : {}), ...(en ? { enum: en } : {}) };
  }
  if (properties.uiZoom) Object.assign(properties.uiZoom, { minimum: 0.5, maximum: 2 });
  if (properties.tabSize) Object.assign(properties.tabSize, { minimum: 1, maximum: 16 });
  if (properties.fontSize) Object.assign(properties.fontSize, { minimum: 6, maximum: 72 });
  return { type: "object", properties, additionalProperties: !onlyKeys };
}

async function registerSchemas() {
  const dir = await userConfigDir().catch(() => null);
  const dirName = dir?.split("/").pop();
  registerJsonSchema("cepheus://schemas/user-settings", dirName ? [`**/${dirName}/settings.json`] : [], settingsSchema());
  registerJsonSchema("cepheus://schemas/workspace-settings", ["**/.cepheus/settings.json"], settingsSchema(WORKSPACE_KEYS));
}

/** Starts tracking the open folder's workspace settings. */
export function initSettingsLevels(): () => void {
  let ws = get().workspace;
  const unsub = useStore.subscribe((s) => {
    if (s.workspace === ws) return;
    ws = s.workspace;
    // Drop the old folder's overrides synchronously so nothing reads/saves them in between.
    const dropped = Object.keys(overrides).length > 0;
    if (dropped) {
      const user = userLevel(s.settings);
      overrides = {};
      shadowed = {};
      set({ settings: user });
    }
    loadWorkspace(ws, dropped);
  });
  loadWorkspace(ws);
  return unsub;
}
