//! Extension bridges: turn popular VS Code extensions into working Cepheus features without running
//! their code (Cepheus has no extension host). See registry.ts for the list and docs in each module.
//!
//! - harness: the extension's CLI becomes the agent harness (Claude Code, Codex)
//! - formatter / linter: the tool from the project or PATH, wired into Format Document, format on
//!   save, Problems and editor markers
//! - languageServer: the Node server inside the .vsix, run by Cepheus' LSP client
//! - builtin: Cepheus already has the feature (some are implemented in extras.ts)

import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { monaco } from "../monaco";
import { editorRef } from "../ai";
import { commands } from "../commands";
import { get, set, toast, useStore } from "../../store";
import type { FormatterId, LinterId } from "./core";
import { BRIDGES, BridgeDef, BuiltinAction, bridgeFor, bridgeKey, FORMATTERS, installFor, LINTERS, TOOLS, ToolDef } from "./registry";
import { activeLinterIds, bridgeEnabled, hasToggle, lintKey, useBridgeRuntime } from "./state";
import { checkTools, currentOS, installTool, localWorkspace, useTools } from "./tools";
import { disposeFormatters, formatActiveWith, formatOnSave as bridgeFormatOnSave, formattersFor, installFormatterSelector, preferredFormatter, syncFormatterProviders } from "./formatters";
import { clearLinter, lintOpenModels, lintSoon } from "./linters";
import { syncServers } from "./servers";
import { applyEditorConfig, editorConfigOnSave, initAutoRenameTag, initInlineErrors, initPathCompletion, onEditorConfigSaved } from "./extras";

export { bridgeFor, bridgeKey, BRIDGES, FORMATTERS, LINTERS, TOOLS } from "./registry";
export type { BridgeDef } from "./registry";
export { bridgeEnabled, hasToggle, useBridgeRuntime } from "./state";
export { installTool, useTools, checkTools } from "./tools";
export { preferredFormatter, formattersFor } from "./formatters";

// ---------------------------------------------------------------------------------------------
// Status (badges, cards)
// ---------------------------------------------------------------------------------------------

export type BridgeBadgeKind = "ready" | "setup" | "builtin" | "alternative";
export interface MissingTool { id: string; def: ToolDef; install?: string }
export interface BridgeStatus { bridge: BridgeDef; badge: BridgeBadgeKind | null; missing: MissingTool[]; enabled: boolean }

/** Every tool id a bridge may check ("a|b" alternatives expanded). */
export const toolIds = (b: BridgeDef) => (b.requires ?? []).flatMap((r) => r.split("|"));

/** Requirements not met; null while unchecked. */
export function missingTools(b: BridgeDef): MissingTool[] | null {
  const st = useTools.getState().status;
  const out: MissingTool[] = [];
  for (const req of b.requires ?? []) {
    const alts = req.split("|");
    if (alts.some((a) => !st[a])) return null;
    if (alts.some((a) => st[a].ok)) continue;
    const id = alts[0];
    out.push({ id, def: TOOLS[id], install: installFor(TOOLS[id], currentOS()) });
  }
  return out;
}

export function bridgeStatus(b: BridgeDef): BridgeStatus {
  const missing = missingTools(b);
  const enabled = bridgeEnabled(b);
  let badge: BridgeBadgeKind | null = null;
  if (b.alternative) badge = "alternative";
  else if (missing === null) badge = null;
  else if (missing.length) badge = "setup";
  else badge = b.kind === "builtin" ? "builtin" : "ready";
  return { bridge: b, badge, missing: missing ?? [], enabled };
}

export const BADGE_LABEL: Record<BridgeBadgeKind, string> = {
  ready: "Works in Cepheus",
  setup: "Works after setup",
  builtin: "Built into Cepheus",
  alternative: "Cepheus alternative",
};

/** React hook: the bridge of an extension with live status (checks its tools on first use). */
export function useBridge(extId: string | null | undefined): BridgeStatus | null {
  const b = bridgeFor(extId);
  useTools((s) => s.status);
  useStore((s) => s.settings.bridges);
  useStore((s) => s.settings.agentHarness);
  useStore((s) => s.settings.disabledExtensions);
  useStore((s) => (b?.setting ? s.settings[b.setting] : null));
  useStore((s) => s.workspace);
  useEffect(() => { if (b) checkTools(toolIds(b)); }, [b, get().workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  return b ? bridgeStatus(b) : null;
}

/** One line about what the bridge is doing right now (for the card). */
export function liveSummary(b: BridgeDef): string[] {
  const lines: string[] = [];
  const rt = useBridgeRuntime.getState();
  const model = editorRef.current?.getModel();
  const path = model?.uri.scheme === "file" ? model.uri.fsPath : null;
  for (const id of b.formatters ?? []) {
    const def = FORMATTERS[id];
    const langs = def.languages.slice(0, 6).join(", ") + (def.languages.length > 6 ? "…" : "");
    const notDefault = Object.entries(get().settings.defaultFormatter ?? {}).filter(([l, v]) => v !== id && v && def.languages.includes(l)).map(([l]) => l);
    lines.push(`${def.name}: formats ${langs}${notDefault.length ? ` (not default for ${notDefault.join(", ")})` : ""}`);
  }
  for (const id of b.linters ?? []) {
    const def = LINTERS[id];
    if (rt.lintError[id]) { lines.push(`${def.name}: ${rt.lintError[id]}`); continue; }
    if (path && model && def.languages.includes(model.getLanguageId())) {
      const n = rt.lint[lintKey(id, path)] ?? 0;
      lines.push(`${def.name}: ${n ? `${n} problem${n === 1 ? "" : "s"}` : "no problems"} in ${path.replace(/\\/g, "/").split("/").pop()}`);
    } else {
      const files = Object.keys(rt.lint).filter((k) => k.startsWith(id + "|")).length;
      lines.push(`${def.name}: lints ${def.languages.join(", ")} on open and save${files ? ` · problems in ${files} file${files === 1 ? "" : "s"}` : ""}`);
    }
  }
  if (b.server) {
    const s = rt.servers[bridgeKey(b)];
    const lsp = b.server.languages.map((l) => get().lsp[l]).find(Boolean);
    lines.push(lsp ? `${lsp.name}: ${lsp.status}${lsp.message ? ` (${lsp.message})` : ""}` : s?.message ?? `${b.server.name}: starts when you open a ${b.server.languages.join(" / ")} file`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Turning bridges on and off
// ---------------------------------------------------------------------------------------------

async function save(patch: Partial<ReturnType<typeof get>["settings"]>) {
  const { saveSettings } = await import("../workspace");
  await saveSettings({ ...get().settings, ...patch });
}

export async function setBridgeEnabled(b: BridgeDef, on: boolean) {
  if (b.harness) {
    const { setDefaultHarness } = await import("../harness");
    await setDefaultHarness(on ? b.harness : "cepheus");
    toast(on ? `${b.harness === "codex" ? "Codex" : "Claude Code"} is now the agent for new and current sessions.` : "The built-in Cepheus agent is the default again.");
    return;
  }
  if (b.setting) return save({ [b.setting]: on } as any);
  const bridges = { ...(get().settings.bridges ?? {}), [bridgeKey(b)]: on };
  // Turning on an extension the user disabled would be confusing: re-enable it as well.
  const disabledExtensions = on ? get().settings.disabledExtensions.filter((x) => !b.ids.includes(x)) : get().settings.disabledExtensions;
  await save({ bridges, disabledExtensions });
}

/** Called after an extension is installed: turns its bridge on. Returns a note for the install toast. */
export async function onExtensionInstalled(extId: string): Promise<string | null> {
  const b = bridgeFor(extId);
  if (!b) return null;
  await checkTools(toolIds(b));
  const missing = missingTools(b) ?? [];
  if (b.harness) {
    if (missing.length) return `install the ${TOOLS[missing[0].id].name} to use it as the agent (see the extension page)`;
    await setBridgeEnabled(b, true);
    return `${b.title.replace(/ as the Cepheus agent$/, "")} is now the agent`;
  }
  if (b.alternative) return b.description.split(". ")[0] + ".";
  if (b.kind === "builtin" && !b.setting && !b.formatters?.length) return `${b.title} is built into Cepheus`;
  await setBridgeEnabled(b, true);
  return missing.length ? `bridge on — install ${missing.map((m) => m.def.name).join(", ")} to finish setup (extension page)` : `${b.title} bridge on`;
}

/** Called after extensions are uninstalled: bridges whose extensions are all gone turn off. */
export async function onExtensionsUninstalled(ids: string[]) {
  const installed = new Set(get().extensions.map((e) => e.id));
  const bridges = { ...(get().settings.bridges ?? {}) };
  let changed = false;
  for (const id of ids) {
    const b = bridgeFor(id);
    if (!b || b.harness || b.setting) continue;
    if (b.ids.some((x) => installed.has(x) && !ids.includes(x))) continue;
    if (bridges[bridgeKey(b)]) { bridges[bridgeKey(b)] = false; changed = true; }
  }
  if (changed) await save({ bridges });
}

/** Runs a built-in action (a command, a sidebar view or a setting). */
export function runAction(a: BuiltinAction) {
  if (a.sidebar) { set({ sidebar: a.sidebar as any, view: "editor" }); return; }
  if (a.command) {
    const c = commands.find((x) => x.id === a.command);
    if (!c) { toast(`"${a.label}" isn't available in this build of Cepheus.`, "error"); return; }
    Promise.resolve(c.run()).catch((e) => toast(String(e?.message ?? e), "error"));
  }
}

export function suggestBridgeUrl(extId: string, displayName: string) {
  const title = `Bridge request: ${displayName} (${extId})`;
  const body = `Extension: ${displayName}\nId: ${extId}\nRegistry: https://open-vsx.org/extension/${extId.replace(".", "/")}\n\nWhat I use it for:\n\n`;
  return `https://github.com/Cepheus-IDE/Cepheus/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
export const openSuggestBridge = (extId: string, displayName: string) => openUrl(suggestBridgeUrl(extId, displayName)).catch(() => {});

// ---------------------------------------------------------------------------------------------
// Hooks called from the editor (lsp.ts notifySaved, saveActions.ts)
// ---------------------------------------------------------------------------------------------

export function onFileSaved(path: string) {
  onEditorConfigSaved(path);
  const m = monaco.editor.getModels().find((x) => x.uri.scheme === "file" && x.uri.fsPath.replace(/\\/g, "/").toLowerCase() === path.replace(/\\/g, "/").toLowerCase());
  if (m) lintSoon(m.uri.fsPath, m.getLanguageId(), 250);
}

/** Format on save through a bridge formatter (true = handled, skip the editor's formatter). */
export const formatOnSave = (model: monaco.editor.ITextModel) => bridgeFormatOnSave(model);

/** .editorconfig save rules (line endings are applied to the model here). */
export const saveOverrides = (model: monaco.editor.ITextModel) => editorConfigOnSave(model);

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function showActiveBridges() {
  const { pickOne } = await import("../../components/BridgePicker");
  const all = BRIDGES.filter((b) => (hasToggle(b) || b.harness) && bridgeEnabled(b));
  await checkTools([...new Set(all.flatMap(toolIds))]);
  const items = all.map((b) => {
    const st = bridgeStatus(b);
    const live = liveSummary(b)[0];
    return { label: b.title, detail: [st.missing.length ? `needs ${st.missing.map((m) => m.def.name).join(", ")}` : st.badge ? BADGE_LABEL[st.badge] : "", live].filter(Boolean).join(" · "), icon: "plug", value: b };
  });
  if (!items.length) { toast("No bridges are on. Install or open a supported extension (e.g. Prettier, ESLint, Claude Code) in the Extensions view."); return; }
  const b = await pickOne("Active bridges — pick one to open its extension page", items);
  if (!b) return;
  const [ns, ...rest] = bridgeKey(b).split(".");
  const { openExtension } = await import("../workspace");
  openExtension(ns, rest.join("."));
}

async function formatDocumentWith() {
  const model = editorRef.current?.getModel();
  if (!model) return toast("Open a file to format.");
  const lang = model.getLanguageId();
  const { pickOne } = await import("../../components/BridgePicker");
  const current = preferredFormatter(lang);
  const on = formattersFor(lang);
  const off = (Object.keys(FORMATTERS) as FormatterId[]).filter((id) => !on.includes(id) && FORMATTERS[id].languages.includes(lang));
  type Choice = { kind: "format" | "default"; id: FormatterId | "editor" } | { kind: "enable"; id: FormatterId };
  const items: { label: string; detail?: string; icon?: string; value: Choice }[] = [
    ...on.map((id) => ({ label: FORMATTERS[id].name, detail: `bridge${current === id ? " · default" : ""}`, icon: "symbol-ruler", value: { kind: "format" as const, id } })),
    { label: "Editor default", detail: `built-in / language server${current === "editor" ? " · default" : ""}`, icon: "symbol-ruler", value: { kind: "format", id: "editor" } },
    ...[...on, "editor" as const].filter((id) => id !== current).map((id) => ({
      label: `Set ${id === "editor" ? "Editor default" : FORMATTERS[id].name} as default for ${lang}`, icon: "settings-gear", value: { kind: "default" as const, id },
    })),
    ...off.map((id) => ({ label: `${FORMATTERS[id].name} (off)`, detail: "open its extension page to turn the bridge on", icon: "plug", value: { kind: "enable" as const, id } })),
  ];
  const pick = await pickOne(`Format ${model.uri.path.split("/").pop()} with…`, items);
  if (!pick) return;
  if (pick.kind === "enable") {
    const b = BRIDGES.find((x) => x.formatters?.includes(pick.id));
    if (b) { const [ns, ...rest] = bridgeKey(b).split("."); (await import("../workspace")).openExtension(ns, rest.join(".")); }
    return;
  }
  if (pick.kind === "default") {
    await save({ defaultFormatter: { ...(get().settings.defaultFormatter ?? {}), [lang]: pick.id } });
    toast(`Default formatter for ${lang}: ${pick.id === "editor" ? "Editor default" : FORMATTERS[pick.id].name}`);
  }
  await formatActiveWith(pick.id);
}

function addCommands() {
  const add = (c: (typeof commands)[number]) => { if (!commands.some((x) => x.id === c.id)) commands.push(c); };
  add({ id: "bridges.show", label: "Bridges: Show Active Bridges", run: showActiveBridges });
  add({ id: "editor.formatWith", label: "Format Document With…", run: formatDocumentWith });
  add({ id: "bridges.lintFile", label: "Bridges: Lint Current File Now", run: () => { const m = editorRef.current?.getModel(); if (m?.uri.scheme === "file") lintSoon(m.uri.fsPath, m.getLanguageId(), 0); } });
}

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

let activeLinters = new Set<LinterId>();

function applyBridges() {
  syncFormatterProviders();
  const now = new Set(activeLinterIds());
  for (const id of activeLinters) if (!now.has(id)) clearLinter(id);
  const added = [...now].some((id) => !activeLinters.has(id));
  activeLinters = now;
  if (added) lintOpenModels();
  syncServers().catch((e) => console.warn("bridge servers", e));
}

/** Started once from initLsp(). */
export function initBridges(): () => void {
  addCommands();
  const selector = installFormatterSelector();
  const inline = initInlineErrors();
  const paths = initPathCompletion();
  const tags = initAutoRenameTag();
  const subs: monaco.IDisposable[] = [
    monaco.editor.onDidCreateModel((m) => {
      if (m.uri.scheme !== "file") return;
      applyEditorConfig(m);
      lintSoon(m.uri.fsPath, m.getLanguageId(), 600); // file on disk = buffer right after opening
    }),
  ];
  const sig = (s: ReturnType<typeof get>) => JSON.stringify([s.settings.bridges, s.settings.disabledExtensions, s.settings.agentHarness, s.extensions.map((e) => e.id + e.version)]);
  let lastSig = sig(get());
  let ws = get().workspace;
  let opts = [get().settings.inlineErrors, get().settings.autoRenameTag, get().settings.editorConfig, get().settings.tabSize, get().settings.insertSpaces].join();
  const unsub = useStore.subscribe((s) => {
    if (s.workspace !== ws) {
      ws = s.workspace;
      for (const id of activeLinters) clearLinter(id);
      activeLinters = new Set();
      // Only the bridges that are on (`which` runs one process per name); the cache resets per folder.
      if (localWorkspace()) checkTools([...new Set(BRIDGES.filter(bridgeEnabled).flatMap(toolIds))]).then(applyBridges);
      else applyBridges();
      return;
    }
    const next = sig(s);
    if (next !== lastSig) { lastSig = next; applyBridges(); }
    const o = [s.settings.inlineErrors, s.settings.autoRenameTag, s.settings.editorConfig, s.settings.tabSize, s.settings.insertSpaces].join();
    if (o !== opts) {
      opts = o;
      inline.refresh();
      tags.refresh();
      setTimeout(() => monaco.editor.getModels().forEach((m) => applyEditorConfig(m)), 0); // after applyModelOptions
    }
  });
  applyBridges();
  return () => {
    unsub();
    subs.forEach((s) => s.dispose());
    selector.then((f) => f());
    inline();
    paths();
    tags();
    disposeFormatters();
    for (const id of activeLinters) clearLinter(id);
  };
}
