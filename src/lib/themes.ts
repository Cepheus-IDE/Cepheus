import { monaco } from "./monaco";
import { api } from "./api";
import { CustomTheme, parseJsonc } from "./settings";
import type { ITheme } from "@xterm/xterm";

// ---------------------------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------------------------

function norm(c: string | undefined): string | undefined {
  if (!c || typeof c !== "string") return undefined;
  let h = c.trim();
  if (!h.startsWith("#")) return undefined;
  h = h.slice(1);
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("");
  if (h.length === 8) h = h.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(h) ? "#" + h.toLowerCase() : undefined;
}
function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}
function luminance(h: string) {
  const [r, g, b] = rgb(h);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const bare = (h: string) => h.replace("#", "");

// ---------------------------------------------------------------------------------------------
// Theme model
// ---------------------------------------------------------------------------------------------

export interface UiVars {
  kind: "dark" | "light";
  bg: string; bg1: string; bg2: string; bg3: string; hover: string; active: string;
  border: string; fg: string; fgDim: string; fgFaint: string; accent: string; green: string; red: string;
}

interface Resolved { ui: UiVars; monaco: monaco.editor.IStandaloneThemeData; terminal: ITheme }

export interface ThemeEntry {
  id: string;
  name: string;
  kind: "dark" | "light";
  source: "builtin" | "extension" | "custom";
  swatch: string[]; // bg, fg, accent, keyword, string
  resolve: () => Promise<Resolved>;
}

function deriveUi(kind: "dark" | "light", bg: string, surface: string, border: string, fg: string, accent: string, green?: string, red?: string): UiVars {
  return {
    kind, bg, bg1: surface, border, fg, accent,
    bg2: mix(surface, fg, 0.03),
    bg3: mix(bg, fg, kind === "dark" ? 0.08 : 0.06),
    hover: mix(bg, fg, 0.045),
    active: mix(bg, fg, 0.09),
    fgDim: mix(fg, bg, 0.42),
    fgFaint: mix(fg, bg, 0.64),
    green: green ?? (kind === "dark" ? "#8fa382" : "#5d7a4e"),
    red: red ?? (kind === "dark" ? "#c46a5c" : "#a84a3c"),
  };
}

function terminalFor(ui: UiVars, ansi?: Partial<ITheme>): ITheme {
  const dark = ui.kind === "dark";
  return {
    background: ui.bg, foreground: mix(ui.fg, ui.bg, 0.08), cursor: ui.accent, cursorAccent: ui.bg,
    selectionBackground: ui.accent + "40",
    black: dark ? mix(ui.bg, ui.fg, 0.1) : "#3a3936", red: ui.red, green: ui.green, yellow: ui.accent,
    blue: dark ? "#8d98a6" : "#4a5a70", magenta: dark ? "#a8939b" : "#7a5866", cyan: dark ? "#93a6a3" : "#4c6b67", white: ui.fgDim,
    brightBlack: ui.fgFaint, brightRed: mix(ui.red, ui.fg, 0.2), brightGreen: mix(ui.green, ui.fg, 0.2), brightYellow: mix(ui.accent, ui.fg, 0.25),
    brightBlue: dark ? "#a5aeba" : "#3a4a60", brightMagenta: dark ? "#bba8af" : "#6a4856", brightCyan: dark ? "#a8b8b5" : "#3c5b57", brightWhite: ui.fg,
    ...ansi,
  };
}

function monacoChrome(ui: UiVars): Record<string, string> {
  const a = ui.accent;
  return {
    "editor.background": ui.bg,
    "editor.foreground": ui.fg,
    "editorGutter.background": ui.bg,
    "editorLineNumber.foreground": mix(ui.fg, ui.bg, 0.78),
    "editorLineNumber.activeForeground": ui.fgDim,
    "editor.lineHighlightBackground": mix(ui.bg, ui.fg, 0.03),
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": a + "33",
    "editor.inactiveSelectionBackground": a + "1a",
    "editor.selectionHighlightBackground": a + "1a",
    "editor.wordHighlightBackground": mix(ui.bg, ui.fg, 0.06),
    "editor.findMatchBackground": a + "55",
    "editor.findMatchHighlightBackground": a + "26",
    "editorCursor.foreground": a,
    "editorWhitespace.foreground": mix(ui.bg, ui.fg, 0.12),
    "editorIndentGuide.background1": mix(ui.bg, ui.fg, 0.07),
    "editorIndentGuide.activeBackground1": mix(ui.bg, ui.fg, 0.18),
    "editorBracketMatch.background": a + "1a",
    "editorBracketMatch.border": a + "66",
    "editorBracketHighlight.foreground1": ui.fgDim,
    "editorBracketHighlight.foreground2": mix(ui.fg, ui.bg, 0.25),
    "editorBracketHighlight.foreground3": a,
    "editorWidget.background": ui.bg1,
    "editorWidget.border": ui.border,
    "editorHoverWidget.background": ui.bg1,
    "editorHoverWidget.border": ui.border,
    "editorSuggestWidget.background": ui.bg1,
    "editorSuggestWidget.border": ui.border,
    "editorSuggestWidget.foreground": mix(ui.fg, ui.bg, 0.15),
    "editorSuggestWidget.highlightForeground": a,
    "editorSuggestWidget.selectedBackground": ui.bg3,
    "editorGhostText.foreground": ui.fgFaint,
    "editorStickyScroll.background": ui.bg,
    "input.background": ui.bg,
    "input.border": ui.border,
    "focusBorder": ui.fgFaint,
    "list.hoverBackground": ui.hover,
    "list.activeSelectionBackground": ui.bg3,
    "list.highlightForeground": a,
    "minimap.background": ui.bg,
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": ui.fg + "12",
    "scrollbarSlider.hoverBackground": ui.fg + "20",
    "scrollbarSlider.activeBackground": ui.fg + "2a",
    "editorOverviewRuler.border": "#00000000",
    "editorError.foreground": ui.red,
    "editorWarning.foreground": a,
    "diffEditor.insertedTextBackground": ui.green + "22",
    "diffEditor.removedTextBackground": ui.red + "22",
    "diffEditor.insertedLineBackground": ui.green + "12",
    "diffEditor.removedLineBackground": ui.red + "12",
  };
}

/** Builds a full theme from the compact Theme Studio description. */
export function resolveCustom(t: CustomTheme): Resolved {
  const ui = deriveUi(t.kind, t.ui.bg, t.ui.surface, t.ui.border, t.ui.fg, t.ui.accent);
  const hc = isHighContrast(t.id);
  // High contrast: secondary text stays close to the foreground (WCAG AA+ on the background).
  if (hc) Object.assign(ui, { fgDim: mix(t.ui.fg, t.ui.bg, 0.12), fgFaint: mix(t.ui.fg, t.ui.bg, 0.25), hover: mix(t.ui.bg, t.ui.fg, 0.12), active: mix(t.ui.bg, t.ui.fg, 0.2), bg3: mix(t.ui.bg, t.ui.fg, 0.16) });
  const s = t.syntax;
  const ident = mix(t.ui.fg, t.ui.bg, 0.1);
  const punct = ui.fgDim;
  const rules: monaco.editor.ITokenThemeRule[] = [
    { token: "", foreground: bare(t.ui.fg) },
    { token: "comment", foreground: bare(s.comment), fontStyle: "italic" },
    { token: "keyword", foreground: bare(s.keyword) },
    { token: "storage", foreground: bare(s.keyword) },
    { token: "tag", foreground: bare(s.keyword) },
    { token: "string", foreground: bare(s.string) },
    { token: "regexp", foreground: bare(s.string) },
    { token: "attribute.value", foreground: bare(s.string) },
    { token: "string.value.json", foreground: bare(s.string) },
    { token: "string.escape", foreground: bare(s.keyword) },
    { token: "number", foreground: bare(s.number) },
    { token: "constant", foreground: bare(s.number) },
    { token: "type", foreground: bare(s.type) },
    { token: "type.identifier", foreground: bare(s.type) },
    { token: "identifier", foreground: bare(ident) },
    { token: "variable", foreground: bare(ident) },
    { token: "attribute.name", foreground: bare(ident) },
    { token: "key", foreground: bare(ident) },
    { token: "string.key.json", foreground: bare(ident) },
    { token: "delimiter", foreground: bare(punct) },
    { token: "operator", foreground: bare(punct) },
    { token: "metatag", foreground: bare(punct) },
  ];
  return {
    ui,
    monaco: hc
      ? { base: t.kind === "dark" ? "hc-black" : "hc-light", inherit: true, rules, colors: { ...monacoChrome(ui), ...hcChrome(ui) } }
      : { base: t.kind === "dark" ? "vs-dark" : "vs", inherit: true, rules, colors: monacoChrome(ui) },
    terminal: terminalFor(ui),
  };
}

export const isHighContrast = (id: string) => id.startsWith("builtin:hc-");

/** Monaco high-contrast extras: visible borders around widgets, selections and the focused element. */
function hcChrome(ui: UiVars): Record<string, string> {
  return {
    contrastBorder: ui.border,
    contrastActiveBorder: ui.accent,
    focusBorder: ui.accent,
    "editor.selectionBackground": ui.accent + "66",
    "editor.lineHighlightBorder": ui.border,
    "editorLineNumber.foreground": ui.fgDim,
    "editorLineNumber.activeForeground": ui.fg,
    "editorCursor.foreground": ui.accent,
    "editorWidget.border": ui.border,
    "editorSuggestWidget.selectedBackground": ui.accent + "55",
    "editorWhitespace.foreground": ui.fgFaint,
  };
}

// ---------------------------------------------------------------------------------------------
// Built-in themes — each limited to a handful of colors.
// ---------------------------------------------------------------------------------------------

export const BUILTIN: CustomTheme[] = [
  {
    id: "builtin:ink", name: "Ink", kind: "dark",
    ui: { bg: "#0d0d0c", surface: "#121211", border: "#232321", fg: "#e7e4dc", accent: "#c8a464" },
    syntax: { keyword: "#c8a464", string: "#a3b195", number: "#d9c49a", comment: "#5f5d57", type: "#f2efe8" },
  },
  {
    id: "builtin:graphite", name: "Graphite", kind: "dark",
    ui: { bg: "#111315", surface: "#15171a", border: "#24272b", fg: "#dde1e6", accent: "#8fb3d1" },
    syntax: { keyword: "#8fb3d1", string: "#b4c4a8", number: "#c8b8e0", comment: "#5a6068", type: "#eef1f4" },
  },
  {
    id: "builtin:noir", name: "Noir", kind: "dark",
    ui: { bg: "#000000", surface: "#070707", border: "#1a1a1a", fg: "#f0f0f0", accent: "#ffffff" },
    syntax: { keyword: "#ffffff", string: "#a8a8a8", number: "#d0d0d0", comment: "#555555", type: "#ffffff" },
  },
  {
    id: "builtin:moss", name: "Moss", kind: "dark",
    ui: { bg: "#0e100d", surface: "#121510", border: "#22271f", fg: "#e2e6da", accent: "#a9c18a" },
    syntax: { keyword: "#a9c18a", string: "#d4c49a", number: "#c9b0a0", comment: "#5c6356", type: "#eef2e6" },
  },
  {
    id: "builtin:paper", name: "Paper", kind: "light",
    ui: { bg: "#f6f3ec", surface: "#efebe2", border: "#e0dbcf", fg: "#1d1c1a", accent: "#9a6b1f" },
    syntax: { keyword: "#9a6b1f", string: "#4f6b45", number: "#8a4f2f", comment: "#9e988a", type: "#1d1c1a" },
  },
  // Accessibility: high-contrast pair (Monaco hc-black / hc-light bases, strong borders and focus rings).
  {
    id: "builtin:hc-dark", name: "High Contrast Dark", kind: "dark",
    ui: { bg: "#000000", surface: "#000000", border: "#6fc3df", fg: "#ffffff", accent: "#f38518" },
    syntax: { keyword: "#569cd6", string: "#ce9178", number: "#b5cea8", comment: "#7ca668", type: "#4ec9b0" },
  },
  {
    id: "builtin:hc-light", name: "High Contrast Light", kind: "light",
    ui: { bg: "#ffffff", surface: "#ffffff", border: "#0f4a85", fg: "#000000", accent: "#b5200d" },
    syntax: { keyword: "#0f4a85", string: "#a31515", number: "#096d48", comment: "#515151", type: "#185e73" },
  },
];

// ---------------------------------------------------------------------------------------------
// VS Code theme → Cepheus theme
// ---------------------------------------------------------------------------------------------

async function loadVsTheme(path: string, depth = 0): Promise<{ colors: Record<string, string>; tokenColors: any[] }> {
  const json = parseJsonc(await api.readFile(path));
  let colors: Record<string, string> = {};
  let tokenColors: any[] = [];
  if (json.include && depth < 4) {
    const base = path.replace(/[\\/][^\\/]*$/, "");
    const sep = path.includes("\\") ? "\\" : "/";
    const inc = await loadVsTheme(base + sep + String(json.include).replace(/^\.\//, "").replace(/\//g, sep), depth + 1).catch(() => null);
    if (inc) { colors = inc.colors; tokenColors = inc.tokenColors; }
  }
  return { colors: { ...colors, ...(json.colors ?? {}) }, tokenColors: [...tokenColors, ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])] };
}

export function convertVsTheme(src: { colors: Record<string, string>; tokenColors: any[] }, uiTheme: string): Resolved {
  const c = src.colors;
  const kind: "dark" | "light" = uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
  const pick = (...keys: string[]) => keys.map((k) => norm(c[k])).find(Boolean);
  const bg = pick("editor.background") ?? (kind === "dark" ? "#1e1e1e" : "#ffffff");
  const fg = pick("editor.foreground", "foreground") ?? (kind === "dark" ? "#d4d4d4" : "#1f1f1f");
  const surface = pick("sideBar.background", "activityBar.background", "panel.background") ?? mix(bg, fg, 0.03);
  const border = pick("panel.border", "sideBar.border", "editorGroup.border", "contrastBorder") ?? mix(bg, fg, 0.12);
  let accent = pick("focusBorder", "button.background", "activityBarBadge.background", "textLink.foreground") ?? (kind === "dark" ? "#c8a464" : "#9a6b1f");
  if (Math.abs(luminance(accent) - luminance(bg)) < 0.15) accent = mix(accent, fg, 0.4);
  const ui = deriveUi(kind, bg, surface, border, fg, accent, pick("gitDecoration.addedResourceForeground", "terminal.ansiGreen"), pick("errorForeground", "editorError.foreground", "terminal.ansiRed"));

  const rules: monaco.editor.ITokenThemeRule[] = [];
  for (const tc of src.tokenColors) {
    const st = tc?.settings ?? {};
    const fgc = norm(st.foreground);
    const rule = { ...(fgc ? { foreground: bare(fgc) } : {}), ...(typeof st.fontStyle === "string" ? { fontStyle: st.fontStyle } : {}) };
    if (!fgc && !rule.fontStyle) continue;
    const scopes: string[] = !tc.scope ? [""] : Array.isArray(tc.scope) ? tc.scope : String(tc.scope).split(",");
    for (const s of scopes) rules.push({ token: s.trim(), ...rule });
  }
  const colors: Record<string, string> = { ...monacoChrome(ui) };
  for (const [k, v] of Object.entries(c)) if (typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v)) colors[k] = v;
  const ansi: Partial<ITheme> = {};
  for (const n of ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"]) {
    const a = norm(c[`terminal.ansi${n}`]);
    const b = norm(c[`terminal.ansiBright${n}`]);
    if (a) (ansi as any)[n.toLowerCase()] = a;
    if (b) (ansi as any)[`bright${n}`] = b;
  }
  const tb = norm(c["terminal.background"]);
  if (tb) ansi.background = tb;
  return {
    ui,
    monaco: { base: kind === "dark" ? (uiTheme === "hc-black" ? "hc-black" : "vs-dark") : "vs", inherit: true, rules, colors },
    terminal: terminalFor(ui, ansi),
  };
}

// ---------------------------------------------------------------------------------------------
// Registry & application
// ---------------------------------------------------------------------------------------------

let extThemes: ThemeEntry[] = [];
const cache = new Map<string, Resolved>();

export function customEntry(t: CustomTheme, source: "builtin" | "custom"): ThemeEntry {
  return {
    id: t.id, name: t.name, kind: t.kind, source,
    swatch: [t.ui.bg, t.ui.fg, t.ui.accent, t.syntax.keyword, t.syntax.string],
    resolve: async () => resolveCustom(t),
  };
}

export async function setExtensionThemes(list: { extId: string; label: string; uiTheme: string; path: string }[]) {
  const entries: ThemeEntry[] = [];
  for (const t of list) {
    const id = `ext:${t.extId}:${t.label}`;
    try {
      const src = await loadVsTheme(t.path);
      const r = convertVsTheme(src, t.uiTheme);
      cache.set(id, r);
      const kw = r.monaco.rules.find((x) => x.token.startsWith("keyword"))?.foreground;
      const st = r.monaco.rules.find((x) => x.token.startsWith("string"))?.foreground;
      entries.push({
        id, name: t.label, kind: r.ui.kind, source: "extension",
        swatch: [r.ui.bg, r.ui.fg, r.ui.accent, kw ? "#" + kw : r.ui.fgDim, st ? "#" + st : r.ui.fgFaint],
        resolve: async () => r,
      });
    } catch (e) {
      console.warn("theme failed", t.path, e);
    }
  }
  extThemes = entries;
}

export function allThemes(custom: CustomTheme[]): ThemeEntry[] {
  return [...BUILTIN.map((t) => customEntry(t, "builtin")), ...custom.map((t) => customEntry(t, "custom")), ...extThemes];
}

let currentTerminal: ITheme = resolveCustom(BUILTIN[0]).terminal;
export const terminalTheme = () => currentTerminal;
export let currentUi: UiVars = resolveCustom(BUILTIN[0]).ui;

let defined = 0;
export async function applyTheme(id: string, custom: CustomTheme[]) {
  const entry = allThemes(custom).find((t) => t.id === id) ?? customEntry(BUILTIN[0], "builtin");
  let r = cache.get(entry.id + JSON.stringify(entry.swatch));
  if (!r) {
    r = await entry.resolve();
    cache.set(entry.id + JSON.stringify(entry.swatch), r);
  }
  const ui = r.ui;
  currentUi = ui;
  const root = document.documentElement.style;
  const vars: Record<string, string> = {
    "--bg": ui.bg, "--bg-1": ui.bg1, "--bg-2": ui.bg2, "--bg-3": ui.bg3, "--bg-hover": ui.hover, "--bg-active": ui.active,
    "--border": ui.border, "--fg": ui.fg, "--fg-dim": ui.fgDim, "--fg-faint": ui.fgFaint,
    "--accent": ui.accent, "--accent-soft": ui.accent + "1a", "--yellow": ui.accent, "--green": ui.green, "--red": ui.red,
  };
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  root.setProperty("color-scheme", ui.kind);
  document.documentElement.classList.toggle("hc", isHighContrast(entry.id));
  const name = `cx-theme-${++defined}`;
  monaco.editor.defineTheme(name, r.monaco);
  monaco.editor.setTheme(name);
  currentTerminal = r.terminal;
  window.dispatchEvent(new CustomEvent("cepheus-theme", { detail: r.terminal }));
}
