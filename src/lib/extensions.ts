import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, ExtInfo, errMsg } from "./api";
import { monaco } from "./monaco";
import { parseJsonc, Settings } from "./settings";
import { setExtensionThemes, applyTheme, allThemes } from "./themes";
import { setIconTheme } from "./iconTheme";
import { get, set, toast } from "../store";
import { saveSettings } from "./workspace";

let snippetDisposables: monaco.IDisposable[] = [];

/** Language ids that differ between VS Code and Monaco. */
const LANG_ALIAS: Record<string, string> = {
  javascriptreact: "javascript",
  typescriptreact: "typescript",
  jsonc: "json",
  shellscript: "shell",
  "objective-c": "objective-c",
};

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

let updating = false;

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
    set((s) => ({ themeVersion: s.themeVersion + 1 }));
    const st = get().settings;
    await applyTheme(st.theme, st.customThemes);
    await applyIconTheme(st.iconTheme, enabled);
  } catch (e) {
    console.warn("extensions load failed", e);
  }
}

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

export async function setExtensionEnabled(id: string, enabled: boolean) {
  const s = get().settings;
  const disabledExtensions = enabled ? s.disabledExtensions.filter((x) => x !== id) : [...new Set([...s.disabledExtensions, id])];
  const patch: Partial<Settings> = { disabledExtensions };
  if (!enabled && s.theme.startsWith(`ext:${id}:`)) patch.theme = "builtin:ink";
  await saveSettings({ ...s, ...patch });
  await loadExtensions();
}

export async function uninstallExtension(id: string) {
  await api.extUninstall(id);
  const s = get().settings;
  const patch: Partial<Settings> = { disabledExtensions: s.disabledExtensions.filter((x) => x !== id) };
  if (s.theme.startsWith(`ext:${id}:`)) patch.theme = "builtin:ink";
  if (s.iconTheme.startsWith(`${id}:`)) patch.iconTheme = "";
  await saveSettings({ ...s, ...patch });
  await loadExtensions();
  toast("Extension uninstalled");
}

/** What Cepheus can actually use from an extension's `contributes`. */
export function featureSummary(contributes: Record<string, unknown> | undefined) {
  const c = contributes ?? {};
  const count = (k: string) => (Array.isArray(c[k]) ? (c[k] as unknown[]).length : c[k] ? 1 : 0);
  const supported = [
    { key: "themes", label: "Color themes", n: count("themes") },
    { key: "iconThemes", label: "File icon themes", n: count("iconThemes") },
    { key: "snippets", label: "Snippets", n: count("snippets") },
  ].filter((x) => x.n > 0);
  const unsupported = Object.keys(c).filter((k) => !["themes", "iconThemes", "snippets"].includes(k));
  return { supported, unsupported };
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

/** Installs and activates what it can (like VS Code asking "Set color theme?"). */
export async function installFromOpenVsx(namespace: string, name: string) {
  const info = await api.extInstall(namespace, name);
  const s = get().settings;
  const patch: Partial<Settings> = { disabledExtensions: s.disabledExtensions.filter((x) => x !== info.id) };
  if (info.themes.length) patch.theme = `ext:${info.id}:${info.themes[0].label}`;
  if (info.iconThemes.length) patch.iconTheme = `${info.id}:${info.iconThemes[0].id}`;
  await saveSettings({ ...s, ...patch });
  await loadExtensions();
  const parts = [];
  if (info.themes.length) parts.push(`color theme “${info.themes[0].label}” applied`);
  if (info.iconThemes.length) parts.push(`file icons applied`);
  if (info.snippets.length) parts.push(`${info.snippets.length} snippet set${info.snippets.length > 1 ? "s" : ""} active`);
  toast(parts.length ? `${info.displayName}: ${parts.join(" · ")}` : `${info.displayName} installed, but it has nothing Cepheus can run (see Features).`);
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
