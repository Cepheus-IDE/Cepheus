//! Keymap presets and the printable keyboard-shortcut reference.

import { commands, keyFor } from "./commands";
import { get, toast } from "../store";
import { api, errMsg } from "./api";

/** Presets are just keybinding overrides on top of the defaults (command id → combo, "" = unbound). */
export const KEYMAP_PRESETS: { id: string; label: string; bindings: Record<string, string> }[] = [
  { id: "default", label: "Default", bindings: {} },
  {
    id: "sublime",
    label: "Sublime Text-like",
    bindings: {
      "editor.symbol": "Ctrl+R",
      "go.line": "Ctrl+G",
      "view.toggleSidebar": "Ctrl+K",
      "agent.inlineEdit": "Ctrl+I",
      "view.toggleTerminal": "Ctrl+`",
      "editor.refactor": "Ctrl+Shift+R",
      "file.saveAll": "Ctrl+Alt+S",
    },
  },
  {
    id: "jetbrains",
    label: "JetBrains-like",
    bindings: {
      "editor.rename": "Shift+F6",
      "editor.format": "Ctrl+Alt+L",
      "editor.organizeImports": "Ctrl+Alt+O",
      "editor.quickFix": "Alt+Enter",
      "editor.references": "Alt+F7",
      "editor.revealDefinition": "Ctrl+B",
      "view.toggleSidebar": "Alt+1",
      "view.toggleTerminal": "Alt+F12",
      "go.file": "Ctrl+Shift+N",
      "agent.new": "",
      "editor.symbol": "Ctrl+F12",
      "debug.toggleBreakpoint": "Ctrl+F8",
      "debug.stepOver": "F8",
      "debug.stepInto": "F7",
      "debug.start": "Shift+F9",
    },
  },
];

/** Which preset the current overrides equal (or null when they've been customized). */
export function currentPreset(): string | null {
  const kb = get().settings.keybindings;
  const p = KEYMAP_PRESETS.find((x) => JSON.stringify(Object.entries(x.bindings).sort()) === JSON.stringify(Object.entries(kb).sort()));
  return p?.id ?? null;
}

export async function applyPreset(id: string) {
  const p = KEYMAP_PRESETS.find((x) => x.id === id);
  if (!p) return;
  const { saveSettings } = await import("./workspace");
  await saveSettings({ ...get().settings, keybindings: { ...p.bindings } });
  toast(`Keymap: ${p.label}`);
}

/** Monaco's own editing keys (not app commands) — included so the sheet is complete. */
const EDITOR_KEYS: [string, string][] = [
  ["Toggle Line Comment", "Ctrl+/"], ["Toggle Block Comment", "Shift+Alt+A"], ["Copy Line Up / Down", "Shift+Alt+Up / Down"],
  ["Move Line Up / Down", "Alt+Up / Down"], ["Delete Line", "Ctrl+Shift+K"], ["Insert Line Below / Above", "Ctrl+Enter / Ctrl+Shift+Enter"],
  ["Add Cursor Above / Below", "Ctrl+Alt+Up / Down"], ["Add Next Occurrence", "Ctrl+D"], ["Select All Occurrences", "Ctrl+Shift+L"],
  ["Expand / Shrink Selection", "Shift+Alt+Right / Left"], ["Fold / Unfold", "Ctrl+Shift+[ / ]"], ["Trigger Suggest", "Ctrl+Space"],
  ["Parameter Hints", "Ctrl+Shift+Space"], ["Peek Definition", "Alt+F12"], ["Next / Previous Problem", "F8 / Shift+F8"],
  ["Indent / Outdent Line", "Ctrl+] / Ctrl+["], ["Undo / Redo", "Ctrl+Z / Ctrl+Y"], ["Command Palette", "Ctrl+Shift+P / F1"],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function groups(): [string, [string, string][]][] {
  const map = new Map<string, [string, string][]>();
  for (const c of commands) {
    const key = keyFor(c);
    if (!key) continue;
    const m = c.label.match(/^([^:]+):\s*(.+)$/);
    const group = m ? m[1] : "General";
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push([m ? m[2] : c.label, key]);
  }
  const out = [...map.entries()].sort((a, b) => (a[0] === "General" ? -1 : b[0] === "General" ? 1 : a[0].localeCompare(b[0])));
  out.push(["Editor", EDITOR_KEYS]);
  return out;
}

export function shortcutsHtml(): string {
  const sections = groups().map(([g, rows]) => `<section><h2>${esc(g)}</h2><table>${rows.map(([l, k]) => `<tr><td>${esc(l)}</td><td>${k.split(" / ").map((x) => x.split("+").map((p) => `<kbd>${esc(p)}</kbd>`).join("+")).join(" / ")}</td></tr>`).join("")}</table></section>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cepheus IDE — Keyboard Shortcuts</title>
<style>
  body { font: 12px/1.45 system-ui, sans-serif; color: #1d1c1a; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; } .sub { color: #6b6860; margin-bottom: 16px; }
  main { columns: 3 260px; column-gap: 24px; }
  section { break-inside: avoid; margin-bottom: 14px; }
  h2 { font-size: 13px; margin: 0 0 4px; border-bottom: 1px solid #d8d3c8; padding-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; } td:last-child { text-align: right; white-space: nowrap; padding-left: 8px; }
  kbd { font: 11px ui-monospace, Consolas, monospace; border: 1px solid #c9c3b6; border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; background: #faf8f3; }
  @media print { body { margin: 10mm; } @page { size: A4 landscape; } }
</style></head><body>
<h1>Cepheus IDE — Keyboard Shortcuts</h1>
<div class="sub">Includes your custom keybindings · generated ${new Date().toLocaleDateString()}</div>
<main>
${sections}
</main></body></html>
`;
}

export function shortcutsMarkdown(): string {
  return "# Cepheus IDE — Keyboard Shortcuts\n\n" + groups().map(([g, rows]) =>
    `## ${g}\n\n| Command | Keys |\n|---|---|\n${rows.map(([l, k]) => `| ${l.replace(/\|/g, "\\|")} | ${k.split(" / ").map((x) => "`" + x + "`").join(" / ")} |`).join("\n")}\n`).join("\n");
}

/** "Preferences: Export Keyboard Shortcuts" → printable HTML (or Markdown) file chosen in a save dialog. */
export async function exportShortcuts() {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ws = get().workspace;
    const path = await save({
      title: "Export Keyboard Shortcuts",
      defaultPath: ws && !ws.startsWith("ssh://") ? `${ws}/keyboard-shortcuts.html` : "keyboard-shortcuts.html",
      filters: [{ name: "Printable HTML", extensions: ["html"] }, { name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    await api.writeFile(path, /\.md$/i.test(path) ? shortcutsMarkdown() : shortcutsHtml());
    toast(`Shortcuts exported to ${path}. Open it in a browser and print.`);
    import("@tauri-apps/plugin-opener").then((o) => o.revealItemInDir(path)).catch(() => {});
  } catch (e) {
    toast(errMsg(e), "error");
  }
}
