//! Keymap extensions (Sublime / Atom / IntelliJ …): `contributes.keybindings` → Cepheus command
//! overrides (settings.keybindings) plus Monaco keybinding rules for editor commands, which share
//! VS Code's ids. Pure apart from the Monaco namespace passed in, so it can be tested in Node.

import type * as Monaco from "monaco-editor";

/** VS Code command id → Cepheus command id (src/lib/commands.ts). */
export const VSCODE_TO_CEPHEUS: Record<string, string> = {
  "workbench.action.files.openFolder": "file.openFolder",
  "workbench.action.files.openFileFolder": "file.openFolder",
  "workbench.action.closeFolder": "file.closeFolder",
  "workbench.action.files.save": "file.save",
  "workbench.action.files.saveAll": "file.saveAll",
  "workbench.action.closeActiveEditor": "file.closeTab",
  "workbench.action.quickOpen": "go.file",
  "workbench.action.gotoLine": "go.line",
  "workbench.view.explorer": "view.explorer",
  "workbench.view.search": "view.search",
  "workbench.action.findInFiles": "view.search",
  "workbench.view.scm": "view.git",
  "workbench.view.extensions": "view.extensions",
  "workbench.view.debug": "view.debug",
  "workbench.view.testing.focus": "view.testing",
  "workbench.action.toggleSidebarVisibility": "view.toggleSidebar",
  "workbench.action.terminal.toggleTerminal": "view.toggleTerminal",
  "workbench.action.togglePanel": "view.toggleTerminal",
  "workbench.action.toggleAuxiliaryBar": "view.toggleAgent",
  "workbench.action.terminal.new": "terminal.new",
  "workbench.action.terminal.split": "terminal.split",
  "workbench.action.terminal.rename": "terminal.rename",
  "workbench.actions.view.problems": "view.problems",
  "workbench.action.showErrorsWarnings": "view.problems",
  "workbench.action.zoomIn": "view.zoomIn",
  "workbench.action.zoomOut": "view.zoomOut",
  "workbench.action.zoomReset": "view.zoomReset",
  "workbench.action.openSettings": "settings.open",
  "workbench.action.openGlobalSettings": "settings.open",
  "workbench.action.openGlobalKeybindings": "settings.keybindings",
  "workbench.action.gotoSymbol": "editor.symbol",
  "editor.action.formatDocument": "editor.format",
  "editor.action.format": "editor.format",
  "actions.find": "editor.find",
  "editor.action.startFindReplaceAction": "editor.replace",
  "editor.action.quickOutline": "editor.symbol",
  "editor.action.toggleWordWrap": "editor.wrap",
  "editor.action.rename": "editor.rename",
  "editor.action.quickFix": "editor.quickFix",
  "editor.action.refactor": "editor.refactor",
  "editor.action.sourceAction": "editor.sourceAction",
  "editor.action.organizeImports": "editor.organizeImports",
  "editor.action.revealDefinition": "editor.revealDefinition",
  "editor.action.goToDeclaration": "editor.revealDefinition",
  "editor.action.goToReferences": "editor.references",
  "references-view.findReferences": "editor.references",
  "workbench.action.debug.start": "debug.start",
  "workbench.action.debug.continue": "debug.start",
  "workbench.action.debug.stop": "debug.stop",
  "workbench.action.debug.restart": "debug.restart",
  "workbench.action.debug.pause": "debug.pause",
  "workbench.action.debug.stepOver": "debug.stepOver",
  "workbench.action.debug.stepInto": "debug.stepInto",
  "workbench.action.debug.stepOut": "debug.stepOut",
  "editor.debug.action.toggleBreakpoint": "debug.toggleBreakpoint",
  "git.sync": "git.sync",
  "git.refresh": "git.refresh",
  "git.checkout": "git.checkoutTo",
  "workbench.view.scm.toggleBlame": "git.toggleBlame",
};

/** Editor commands Monaco implements itself under the same id (bound with addKeybindingRules). */
export function isMonacoCommand(id: string): boolean {
  return /^(editor\.action\.|editor\.(un)?fold|editor\.toggleFold|editor\.foldLevel|cursor|deleteWord|deleteAll|deleteLeft|deleteRight|expandLineSelection|scrollLine|scrollPage|undo$|redo$|acceptSelectedSuggestion|selectNextSuggestion|selectPrevSuggestion|lineBreakInsert|tab$|outdent$|editor\.action$)/.test(id);
}

export interface RawKeybinding { command?: string; key?: string; mac?: string; linux?: string; win?: string; when?: string }
export type Platform = "win" | "mac" | "linux";

export interface KeymapPlan {
  /** Cepheus command id → combo (single-chord, Cepheus notation). */
  cepheus: Record<string, string>;
  /** Monaco keybinding rules: VS Code key string (may be a chord) → command. */
  editor: { key: string; command: string; when?: string }[];
  /** Bindings with no Cepheus equivalent (or a key Cepheus can't express). */
  unmapped: { command: string; key: string; reason: string }[];
}

const NAMED: Record<string, string> = {
  enter: "Enter", escape: "Escape", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
  "`": "`", ",": ",", "=": "=", "-": "-", "[": "[", "]": "]", "\\": "\\", ";": ";", "'": "'", ".": ".", "/": "/",
};

/** One VS Code chord ("ctrl+shift+k", "cmd+alt+up") → Cepheus combo ("Ctrl+Shift+K"), or null. */
export function toCepheusCombo(chord: string): string | null {
  const parts = chord.toLowerCase().split("+");
  // "ctrl++" style keys: a trailing empty segment means the key itself is "+".
  if (parts[parts.length - 1] === "" && parts.length > 1) { parts.pop(); parts[parts.length - 1] = "="; }
  const key = parts.pop()!;
  const mods = new Set(parts);
  let k: string | undefined;
  if (/^[a-z0-9]$/.test(key)) k = key.toUpperCase();
  else if (/^f([1-9]|1[0-9])$/.test(key)) k = key.toUpperCase();
  else k = NAMED[key];
  if (!k) return null;
  // Shift changes the reported key for punctuation (except ` and , which Cepheus reads by code).
  if (mods.has("shift") && /^[=\-[\]\\;'./]$/.test(k)) return null;
  const out: string[] = [];
  if (mods.has("ctrl") || mods.has("cmd") || mods.has("meta") || mods.has("win")) out.push("Ctrl");
  if (mods.has("shift")) out.push("Shift");
  if (mods.has("alt")) out.push("Alt");
  out.push(k);
  return out.join("+");
}

export function keyForPlatform(b: RawKeybinding, platform: Platform): string | undefined {
  return (platform === "mac" ? b.mac : platform === "win" ? b.win : b.linux) ?? b.key;
}

/** Splits a keymap extension's bindings into Cepheus overrides, Monaco rules and unmapped ones. */
export function planKeymap(bindings: RawKeybinding[], platform: Platform, cepheusIds: Set<string>): KeymapPlan {
  const plan: KeymapPlan = { cepheus: {}, editor: [], unmapped: [] };
  for (const b of Array.isArray(bindings) ? bindings : []) {
    const command = String(b?.command ?? "");
    const key = keyForPlatform(b, platform);
    if (!command || !key || command.startsWith("-")) continue; // "-cmd" removes a default; nothing to add
    const target = VSCODE_TO_CEPHEUS[command];
    if (target && cepheusIds.has(target)) {
      const chords = key.trim().split(/\s+/);
      const combo = chords.length === 1 ? toCepheusCombo(chords[0]) : null;
      if (combo) {
        // The first binding wins: keymap packs list the most important one first.
        if (!(target in plan.cepheus)) plan.cepheus[target] = combo;
        continue;
      }
      if (isMonacoCommand(command)) { plan.editor.push({ key, command, when: b.when }); continue; }
      plan.unmapped.push({ command, key, reason: chords.length > 1 ? "chords are not supported for app commands" : "key not supported" });
    } else if (isMonacoCommand(command)) {
      plan.editor.push({ key, command, when: b.when });
    } else {
      plan.unmapped.push({ command, key, reason: "no equivalent in Cepheus" });
    }
  }
  return plan;
}

const MONACO_KEY: Record<string, string> = {
  enter: "Enter", escape: "Escape", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert",
  up: "UpArrow", down: "DownArrow", left: "LeftArrow", right: "RightArrow", pageup: "PageUp", pagedown: "PageDown", home: "Home", end: "End",
  "`": "Backquote", ",": "Comma", "=": "Equal", "-": "Minus", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash",
  ";": "Semicolon", "'": "Quote", ".": "Period", "/": "Slash",
};

/** VS Code key string (with chords) → Monaco keybinding number, or null if a key is unknown. */
export function toMonacoKeybinding(key: string, m: typeof Monaco, platform: Platform): number | null {
  const chords = key.trim().toLowerCase().split(/\s+/).map((chord) => {
    const parts = chord.split("+");
    const k = parts.pop()!;
    let code: number | undefined;
    if (/^[a-z]$/.test(k)) code = (m.KeyCode as any)["Key" + k.toUpperCase()];
    else if (/^[0-9]$/.test(k)) code = (m.KeyCode as any)["Digit" + k];
    else if (/^f([1-9]|1[0-9])$/.test(k)) code = (m.KeyCode as any)[k.toUpperCase()];
    else if (MONACO_KEY[k]) code = (m.KeyCode as any)[MONACO_KEY[k]];
    if (code === undefined) return null;
    let n = code;
    for (const p of parts) {
      if (p === "shift") n |= m.KeyMod.Shift;
      else if (p === "alt") n |= m.KeyMod.Alt;
      else if (p === "cmd" || p === "meta" || p === "win") n |= platform === "mac" ? m.KeyMod.CtrlCmd : m.KeyMod.WinCtrl;
      else if (p === "ctrl") n |= platform === "mac" ? m.KeyMod.WinCtrl : m.KeyMod.CtrlCmd;
    }
    return n;
  });
  if (chords.some((c) => c === null)) return null;
  return chords.length === 1 ? chords[0]! : m.KeyMod.chord(chords[0]!, chords[1]!);
}
