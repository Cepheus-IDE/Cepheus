import { invoke } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { api, ExtInfo, errMsg } from "./api";
import { monaco } from "./monaco";
import { parseJsonc, Settings, ExtensionOptions, DEFAULT_SETTINGS } from "./settings";
import { setExtensionThemes, applyTheme, allThemes } from "./themes";
import { setIconTheme } from "./iconTheme";
import { activateLanguages, setGrammarThemeSelectors, LANG_ALIAS, InstalledManifest } from "./extGrammars";
import { planKeymap, toMonacoKeybinding, KeymapPlan, Platform } from "./extKeymaps";
import { compatibility, registryManifest, withProgress } from "./marketplace";
import { commands } from "./commands";
import { get, set, toast } from "../store";
import { saveSettings } from "./workspace";
import { bridgeFor } from "./bridges/registry";

let snippetDisposables: monaco.IDisposable[] = [];
let keymapDisposable: monaco.IDisposable | null = null;

export const extOptions = (): ExtensionOptions => ({ ...DEFAULT_SETTINGS.extensionOptions, ...(get().settings.extensionOptions ?? {}) });
async function saveExtOptions(patch: Partial<ExtensionOptions>, extra: Partial<Settings> = {}) {
  const s = get().settings;
  await saveSettings({ ...s, ...extra, extensionOptions: { ...extOptions(), ...patch } });
}

// ---------------------------------------------------------------------------------------------
// Installed manifests (package.json of each installed extension)
// ---------------------------------------------------------------------------------------------

let rootDir: Promise<string> | null = null;
/** Install folder of an extension (the backend's <app data>/extensions/<id>). */
export async function extDir(id: string): Promise<string> {
  rootDir ??= appDataDir().then((d) => {
    const sep = d.includes("\\") ? "\\" : "/";
    return d.replace(/[\\/]+$/, "") + sep + "extensions";
  });
  const root = await rootDir;
  return root + (root.includes("\\") ? "\\" : "/") + id;
}

/** package.json by extension id, for compatibility badges, keymaps and packs. */
export const useManifests = create<Record<string, any>>(() => ({}));

async function readManifests(exts: ExtInfo[]): Promise<InstalledManifest[]> {
  const out = await Promise.all(exts.map(async (ext) => {
    try {
      const dir = await extDir(ext.id);
      const sep = dir.includes("\\") ? "\\" : "/";
      return { ext, dir, pkg: parseJsonc(await api.readFile(dir + sep + "package.json")) };
    } catch {
      return null;
    }
  }));
  const ok = out.filter((m): m is InstalledManifest => !!m);
  useManifests.setState(Object.fromEntries(ok.map((m) => [m.ext.id, m.pkg])), true);
  return ok;
}

// ---------------------------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------------------------

function snippetBody(b: unknown): string {
  return Array.isArray(b) ? b.join("\n") : String(b ?? "");
}

async function registerSnippets(exts: ExtInfo[]) {
  snippetDisposables.forEach((d) => d.dispose());
  snippetDisposables = [];
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  const byLang = new Map<string, { label: string; prefix: string; body: string; description: string }[]>();
  for (const ext of exts) {
    for (const sn of ext.snippets) {
      try {
        const json = parseJsonc(await api.readFile(sn.path));
        const lang = LANG_ALIAS[sn.language] ?? sn.language;
        if (!known.has(lang)) continue;
        for (const [name, def] of Object.entries<any>(json)) {
          const prefixes = Array.isArray(def?.prefix) ? def.prefix : [def?.prefix];
          for (const p of prefixes) {
            if (!p) continue;
            if (!byLang.has(lang)) byLang.set(lang, []);
            byLang.get(lang)!.push({ label: String(p), prefix: String(p), body: snippetBody(def.body), description: def.description ?? name });
          }
        }
      } catch {
        /* malformed snippet file */
      }
    }
  }
  for (const [lang, items] of byLang) {
    snippetDisposables.push(
      monaco.languages.registerCompletionItemProvider(lang, {
        provideCompletionItems(model, position) {
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
          return {
            suggestions: items.map((s) => ({
              label: s.label,
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: s.description,
              documentation: s.body,
              insertText: s.body,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            })),
          };
        },
      })
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

let updating = false;
let autoUpdateStarted = false;

export async function loadExtensions() {
  try {
    let exts = await api.extList();
    // Older installs extracted fewer files (no icon images): refresh them once, quietly.
    const stale = exts.filter((e) => e.needsUpdate);
    if (stale.length && !updating) {
      updating = true;
      for (const e of stale) {
        try { await api.extInstall(e.publisher || e.id.split(".")[0], e.name); } catch { /* offline: keep old copy */ }
      }
      exts = await api.extList();
      updating = false;
    }
    set({ extensions: exts });
    const disabled = new Set(get().settings.disabledExtensions);
    const enabled = exts.filter((e) => !disabled.has(e.id));
    await setExtensionThemes(enabled.flatMap((e) => e.themes.map((t) => ({ extId: e.id, label: t.label, uiTheme: t.uiTheme, path: t.path }))));
    await registerSnippets(enabled);
    const manifests = await readManifests(exts);
    const opts = extOptions();
    await activateLanguages(manifests.filter((m) => !disabled.has(m.ext.id)), opts.grammars);
    applyKeymapEditorRules(manifests.find((m) => m.ext.id === opts.keymap?.extId && !disabled.has(m.ext.id))?.pkg);
    set((s) => ({ themeVersion: s.themeVersion + 1 }));
    const st = get().settings;
    await applyTheme(st.theme, st.customThemes);
    await applyIconTheme(st.iconTheme, enabled);
    if (opts.autoUpdate && !autoUpdateStarted) {
      autoUpdateStarted = true;
      setTimeout(() => updateAllExtensions(true), 8000); // after startup settles
    }
  } catch (e) {
    console.warn("extensions load failed", e);
  }
}

/** TextMate tokens are named after the active theme's selectors: refresh them on theme changes. */
async function refreshGrammarTheme() {
  try {
    const s = get().settings;
    const themes = allThemes(s.customThemes);
    const entry = themes.find((t) => t.id === s.theme) ?? themes[0];
    const r = await entry.resolve();
    setGrammarThemeSelectors(r.monaco.rules.map((x) => x.token).filter(Boolean));
  } catch { /* keep previous */ }
}
window.addEventListener("cepheus-theme", () => { refreshGrammarTheme(); });

async function applyIconTheme(spec: string, enabled: ExtInfo[]) {
  if (!spec) return setIconTheme(null);
  const i = spec.indexOf(":");
  const ext = enabled.find((e) => e.id === spec.slice(0, i));
  const t = ext?.iconThemes.find((x) => x.id === spec.slice(i + 1));
  await setIconTheme(t?.path ?? null);
}

export async function setIconThemeSetting(spec: string) {
  await saveSettings({ ...get().settings, iconTheme: spec });
  const disabled = new Set(get().settings.disabledExtensions);
  await applyIconTheme(spec, get().extensions.filter((e) => !disabled.has(e.id)));
}

/** "Use extension grammar" for a language (overrides Monaco's built-in tokenizer when on). */
export async function setGrammarPreference(lang: string, on: boolean, builtin: boolean) {
  await saveExtOptions({ grammars: { ...extOptions().grammars, [lang]: on } });
  await loadExtensions();
  if (!on && builtin) toast(`Reload the window to bring back the built-in ${lang} highlighting.`);
}

export async function setExtensionEnabled(id: string, enabled: boolean) {
  const s = get().settings;
  const disabledExtensions = enabled ? s.disabledExtensions.filter((x) => x !== id) : [...new Set([...s.disabledExtensions, id])];
  const patch: Partial<Settings> = { disabledExtensions };
  if (!enabled && s.theme.startsWith(`ext:${id}:`)) patch.theme = "builtin:ink";
  if (!enabled && s.iconTheme.startsWith(`${id}:`)) patch.iconTheme = "";
  await saveSettings({ ...s, ...patch });
  if (!enabled && extOptions().keymap?.extId === id) await removeKeymap();
  else if (enabled && compatibility(useManifests.getState()[id]).works.includes("keymap") && !extOptions().keymap) await applyKeymap(id);
  await loadExtensions();
}

/** Removes an extension (and optionally pack members installed with it). */
export async function uninstallExtension(id: string, alsoRemove: string[] = []) {
  for (const x of [id, ...alsoRemove]) {
    if (extOptions().keymap?.extId === x) await removeKeymap();
    await api.extUninstall(x);
  }
  const gone = new Set([id, ...alsoRemove]);
  const s = get().settings;
  const pins = { ...extOptions().pins };
  for (const x of gone) delete pins[x];
  const patch: Partial<Settings> = { disabledExtensions: s.disabledExtensions.filter((x) => !gone.has(x)) };
  if ([...gone].some((x) => s.theme.startsWith(`ext:${x}:`))) patch.theme = "builtin:ink";
  if ([...gone].some((x) => s.iconTheme.startsWith(`${x}:`))) patch.iconTheme = "";
  await saveExtOptions({ pins }, patch);
  await loadExtensions();
  await import("./bridges").then((m) => m.onExtensionsUninstalled([...gone])).catch(() => {});
  toast(alsoRemove.length ? `Removed ${gone.size} extensions` : "Extension uninstalled");
}

/** What Cepheus can actually use from an extension's `contributes`. */
export function featureSummary(contributes: Record<string, unknown> | undefined) {
  const c = contributes ?? {};
  const count = (k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]).length : c[k] ? 1 : 0);
  const SUPPORTED: [string, string][] = [
    ["themes", "Color themes"], ["iconThemes", "File icon themes"], ["snippets", "Snippets"],
    ["grammars", "Syntax grammars (TextMate)"], ["languages", "Language definitions & editing rules"], ["keybindings", "Keybindings (keymap)"],
  ];
  const supported = SUPPORTED.map(([key, label]) => ({ key, label, n: count(key) })).filter((x) => x.n > 0);
  const unsupported = Object.keys(c).filter((k) => !SUPPORTED.some(([key]) => key === k));
  return { supported, unsupported };
}

// ---------------------------------------------------------------------------------------------
// Keymaps
// ---------------------------------------------------------------------------------------------

export function platform(): Platform {
  const ua = navigator.userAgent;
  return ua.includes("Mac") ? "mac" : ua.includes("Windows") ? "win" : "linux";
}

export function keymapPlan(pkg: any): KeymapPlan {
  return planKeymap(pkg?.contributes?.keybindings ?? [], platform(), new Set(commands.map((c) => c.id)));
}

function applyKeymapEditorRules(pkg: any) {
  keymapDisposable?.dispose();
  keymapDisposable = null;
  if (!pkg) return;
  const rules = keymapPlan(pkg).editor
    .map((r) => ({ keybinding: toMonacoKeybinding(r.key, monaco, platform()), command: r.command, when: r.when }))
    .filter((r): r is { keybinding: number; command: string; when: string | undefined } => r.keybinding !== null);
  if (rules.length) keymapDisposable = monaco.editor.addKeybindingRules(rules);
}

/** Applies a keymap extension: app commands via keybinding overrides, editor commands via Monaco. */
export async function applyKeymap(extId: string) {
  if (extOptions().keymap) await removeKeymap();
  const pkg = useManifests.getState()[extId];
  if (!pkg) throw new Error("Extension manifest not found");
  const plan = keymapPlan(pkg);
  const s = get().settings;
  const kb = { ...s.keybindings };
  const applied: Record<string, string> = {};
  const previous: Record<string, string | null> = {};
  const set1 = (id: string, combo: string) => {
    if (!(id in previous)) previous[id] = id in kb ? kb[id] : null;
    kb[id] = combo;
    applied[id] = combo;
  };
  for (const [id, combo] of Object.entries(plan.cepheus)) {
    // Unbind other commands that already use this combo, so the keymap's wins.
    for (const c of commands) {
      if (c.id === id || plan.cepheus[c.id]) continue;
      const cur = kb[c.id] ?? c.keys;
      if (cur === combo) set1(c.id, "");
    }
    set1(id, combo);
  }
  const label = `Keymap: ${get().extensions.find((e) => e.id === extId)?.displayName ?? extId}`;
  await saveExtOptions({ keymap: { extId, label, applied, previous } }, { keybindings: kb });
  applyKeymapEditorRules(pkg);
  toast(`${label} — ${Object.keys(plan.cepheus).length} app and ${plan.editor.length} editor shortcuts applied`);
}

/** Restores the shortcuts a keymap changed (unless the user edited them since). */
export async function removeKeymap() {
  const km = extOptions().keymap;
  if (!km) return;
  const kb = { ...get().settings.keybindings };
  for (const [id, combo] of Object.entries(km.applied)) {
    if (kb[id] !== combo) continue;
    const prev = km.previous[id];
    if (prev === null || prev === undefined) delete kb[id];
    else kb[id] = prev;
  }
  await saveExtOptions({ keymap: null }, { keybindings: kb });
  applyKeymapEditorRules(null);
  toast(`${km.label} removed`);
}

// ---------------------------------------------------------------------------------------------
// Updates, versions
// ---------------------------------------------------------------------------------------------

export interface ExtUpdate { id: string; ns: string; name: string; current: string; latest: string }
export const useUpdates = create<{ checking: boolean; list: ExtUpdate[]; checked: boolean }>(() => ({ checking: false, list: [], checked: false }));

export async function checkExtensionUpdates(): Promise<ExtUpdate[]> {
  useUpdates.setState({ checking: true });
  const pins = extOptions().pins;
  const list: ExtUpdate[] = [];
  try {
    await Promise.all(get().extensions.filter((e) => e.source === "openvsx" && !pins[e.id]).map(async (e) => {
      const ns = e.publisher || e.id.split(".")[0];
      try {
        const m = await api.openvsxMeta(ns, e.name);
        if (m?.version && !m.error && m.version !== e.version) list.push({ id: e.id, ns, name: e.name, current: e.version, latest: m.version });
      } catch { /* offline */ }
    }));
  } finally {
    useUpdates.setState({ checking: false, list, checked: true });
  }
  return list;
}

export async function updateAllExtensions(silent = false) {
  const list = await checkExtensionUpdates();
  if (!list.length) { if (!silent) toast("All extensions are up to date"); return; }
  const failed: string[] = [];
  await withProgress("Updating extensions", list, async (u) => {
    try { await api.extInstall(u.ns, u.name); } catch { failed.push(u.id); }
  });
  await loadExtensions();
  useUpdates.setState({ list: list.filter((u) => failed.includes(u.id)) });
  toast(`Updated ${list.length - failed.length} extension${list.length - failed.length === 1 ? "" : "s"}${failed.length ? ` · failed: ${failed.join(", ")}` : ""}`, failed.length ? "error" : "info");
}

export async function setAutoUpdate(on: boolean) {
  await saveExtOptions({ autoUpdate: on });
  if (on) updateAllExtensions(true);
}

/** Installs a specific version ("" = latest) and pins it so updates leave it alone. */
export async function installVersion(namespace: string, name: string, version: string) {
  const info = await api.extInstall(namespace, name, version || undefined);
  const pins = { ...extOptions().pins };
  if (version) pins[info.id] = info.version;
  else delete pins[info.id];
  await saveExtOptions({ pins });
  await loadExtensions();
  useUpdates.setState((s) => ({ list: s.list.filter((u) => u.id !== info.id) }));
  toast(`${info.displayName} v${info.version} installed${version ? " (pinned)" : ""}`);
}

// ---------------------------------------------------------------------------------------------
// VS Code settings import
// ---------------------------------------------------------------------------------------------

const VS_BUILTIN_THEME: Record<string, string> = {
  "Default Light+": "builtin:paper",
  "Default Light Modern": "builtin:paper",
  "Light+ (default light)": "builtin:paper",
  "Quiet Light": "builtin:paper",
  "Solarized Light": "builtin:paper",
};

export async function importFromEditor(editor: string): Promise<string[]> {
  const res = await api.vscodeImport(editor);
  await loadExtensions();
  const notes: string[] = [`${res.imported.length} theme/snippet extensions`];
  if (!res.settings) return notes;
  let vs: Record<string, any>;
  try {
    vs = parseJsonc(res.settings);
  } catch (e) {
    throw new Error("Could not parse settings.json: " + errMsg(e));
  }
  const s: Settings = { ...get().settings };
  const n = (v: any) => (typeof v === "number" && v > 0 ? v : undefined);
  if (n(vs["editor.fontSize"])) s.fontSize = vs["editor.fontSize"];
  if (n(vs["editor.tabSize"])) s.tabSize = vs["editor.tabSize"];
  if (typeof vs["editor.fontFamily"] === "string") s.fontFamily = vs["editor.fontFamily"];
  if (typeof vs["editor.wordWrap"] === "string") s.wordWrap = vs["editor.wordWrap"] !== "off";
  if (typeof vs["editor.minimap.enabled"] === "boolean") s.minimap = vs["editor.minimap.enabled"];
  if (typeof vs["files.autoSave"] === "string") s.autoSave = vs["files.autoSave"] !== "off";
  const prof = vs["terminal.integrated.defaultProfile.windows"];
  if (typeof prof === "string") {
    const map: Record<string, string> = { PowerShell: "powershell.exe", "Command Prompt": "cmd.exe", pwsh: "pwsh.exe" };
    if (map[prof]) s.shell = map[prof];
  }
  const themeName = vs["workbench.colorTheme"];
  if (typeof themeName === "string") {
    const match = allThemes(s.customThemes).find((t) => t.source === "extension" && t.name.toLowerCase() === themeName.toLowerCase());
    if (match) s.theme = match.id;
    else if (VS_BUILTIN_THEME[themeName]) s.theme = VS_BUILTIN_THEME[themeName];
    notes.push(match || VS_BUILTIN_THEME[themeName] ? `theme “${themeName}”` : `theme “${themeName}” is built into ${editor}; kept current theme`);
  }
  notes.push("font, tab size, word wrap, minimap, auto save, terminal");
  await saveSettings(s);
  return notes;
}

/** Members of an extension pack / dependencies that are not installed yet. */
export function missingPackMembers(pkg: any): string[] {
  const have = new Set(get().extensions.map((e) => e.id));
  return compatibility(pkg).pack.map((x) => x.toLowerCase()).filter((x) => !have.has(x));
}

/** Installs pack members Cepheus can use (skips ones that are only extension code). */
async function installPackMembers(packName: string, ids: string[], depth: number) {
  const skipped: string[] = [];
  const failed: string[] = [];
  let ok = 0;
  await withProgress(`Installing ${packName}`, ids, async (id) => {
    const [ns, ...rest] = id.split(".");
    const name = rest.join(".");
    try {
      const meta = await api.openvsxMeta(ns, name);
      if (!meta || meta.error) throw new Error(meta?.error ?? "not found");
      const level = compatibility(await registryManifest(ns, name, meta.version)).level;
      if (((level === "code" || level === "empty") && !bridgeFor(id)) || (level === "pack" && depth > 0)) { skipped.push(id); return; }
      await installFromOpenVsx(ns, name, undefined, { quiet: true, depth: depth + 1 });
      ok++;
    } catch {
      failed.push(id);
    }
  });
  const parts = [`${ok} of ${ids.length} pack extensions installed`];
  if (skipped.length) parts.push(`${skipped.length} skipped (need extension code)`);
  if (failed.length) parts.push(`failed: ${failed.join(", ")}`);
  toast(`${packName}: ${parts.join(" · ")}`, failed.length && !ok ? "error" : "info");
}

/** Installs and activates what it can (like VS Code asking "Set color theme?"). */
export async function installFromOpenVsx(namespace: string, name: string, version?: string, o: { quiet?: boolean; depth?: number } = {}) {
  const info = await api.extInstall(namespace, name, version);
  const s = get().settings;
  const patch: Partial<Settings> = { disabledExtensions: s.disabledExtensions.filter((x) => x !== info.id) };
  if (!o.quiet && info.themes.length) patch.theme = `ext:${info.id}:${info.themes[0].label}`;
  if (!o.quiet && info.iconThemes.length) patch.iconTheme = `${info.id}:${info.iconThemes[0].id}`;
  await saveSettings({ ...s, ...patch });
  await loadExtensions();
  // Extension bridges (src/lib/bridges): installing turns the extension's bridge on.
  const bridgeNote = await import("./bridges").then((m) => m.onExtensionInstalled(info.id)).catch(() => null);
  if (o.quiet) return info;
  const pkg = useManifests.getState()[info.id];
  const compat = compatibility(pkg);
  const parts = [];
  if (info.themes.length) parts.push(`color theme “${info.themes[0].label}” applied`);
  if (info.iconThemes.length) parts.push(`file icons applied`);
  if (info.snippets.length) parts.push(`${info.snippets.length} snippet set${info.snippets.length > 1 ? "s" : ""} active`);
  if (compat.works.includes("grammar")) parts.push("syntax highlighting active");
  else if (compat.works.includes("language")) parts.push("language rules active");
  if (bridgeNote) parts.push(bridgeNote);
  if (compat.works.includes("keymap")) {
    try { await applyKeymap(info.id); } catch (e) { toast(errMsg(e), "error"); }
  } else {
    toast(parts.length ? `${info.displayName}: ${parts.join(" · ")}` : compat.pack.length ? `${info.displayName} installed` : `${info.displayName} installed, but it has nothing Cepheus can run (see Features).`);
  }
  const members = missingPackMembers(pkg);
  if (members.length && (o.depth ?? 0) < 2) await installPackMembers(info.displayName, members, o.depth ?? 0);
  return info;
}

// ---------------------------------------------------------------------------------------------
// Registry, organization allowlist, preinstall, workspace recommendations
// ---------------------------------------------------------------------------------------------

/** Tells the backend which Open VSX-compatible registry to use (policy overrides it there). */
export async function configureRegistry(url: string) {
  try {
    await invoke("ext_configure", { registryUrl: url });
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Installs the policy's preinstallExtensions once (first launch, or when the policy adds some). */
export async function runPreinstall() {
  try {
    const ids = await invoke<string[]>("ext_preinstall");
    if (ids.length) {
      await loadExtensions();
      toast(`Installed ${ids.length} extension${ids.length > 1 ? "s" : ""} required by your organization`);
    }
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export const useRecommendations = create<{ workspace: string | null; ids: string[] }>(() => ({ workspace: null, ids: [] }));

/** Reads `recommendations` from .vscode/extensions.json and .cepheus/extensions.json. */
export async function loadRecommendations(ws: string | null) {
  if (!ws) return useRecommendations.setState({ workspace: null, ids: [] });
  const sep = ws.includes("\\") && !ws.startsWith("ssh://") ? "\\" : "/";
  const ids = new Set<string>();
  const unwanted = new Set<string>();
  for (const dir of [".vscode", ".cepheus"]) {
    try {
      const j = parseJsonc(await api.readFile(`${ws}${sep}${dir}${sep}extensions.json`));
      for (const r of Array.isArray(j?.recommendations) ? j.recommendations : []) if (typeof r === "string") ids.add(r.toLowerCase());
      for (const r of Array.isArray(j?.unwantedRecommendations) ? j.unwantedRecommendations : []) if (typeof r === "string") unwanted.add(r.toLowerCase());
    } catch { /* missing or malformed */ }
  }
  useRecommendations.setState({ workspace: ws, ids: [...ids].filter((i) => !unwanted.has(i) && i.includes(".")) });
}

/** Installs extensions by id (sync / profile import), skipping ones the policy blocks. */
export async function installMissingExtensions(ids: string[]) {
  let ok = 0;
  const failed: string[] = [];
  for (const id of ids) {
    const [ns, ...rest] = id.split(".");
    if (!ns || !rest.length) { failed.push(id); continue; } // the backend enforces the allowlist
    try {
      await api.extInstall(ns, rest.join("."));
      ok++;
    } catch {
      failed.push(id);
    }
  }
  if (ok) await loadExtensions();
  if (failed.length) toast(`Could not install: ${failed.join(", ")}`, "error");
  return ok;
}
