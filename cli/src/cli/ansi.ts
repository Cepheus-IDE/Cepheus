/** ANSI colors with NO_COLOR / FORCE_COLOR support, symbols with safe fallbacks, and layout helpers. */

function detect(): boolean {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return !!process.stdout.isTTY;
}

export let colorEnabled = detect();

export function setColor(on: boolean) {
  colorEnabled = on;
}

/** 24-bit color where the terminal says it supports it (Windows Terminal, VS Code, iTerm, most Linux terminals). */
const env = process.env;
const truecolor =
  /truecolor|24bit/i.test(env.COLORTERM ?? "") || !!env.WT_SESSION || env.TERM_PROGRAM === "vscode" || env.TERM_PROGRAM === "iTerm.app";

const wrap = (open: string, close: string) => (s: string | number) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  gray: wrap("90", "39"),
  bgRed: wrap("41", "49"),
  bgGreen: wrap("42", "49"),
  /** The Cepheus brand red (#e5352b), the single accent color. */
  accent: wrap(truecolor ? "38;2;229;53;43" : "91", "39"),
  /** Soft text for secondary information (#a8a8a4). */
  soft: wrap(truecolor ? "38;2;168;168;164" : "37", "39"),
  /** Inline code in answers (#f0c88a). */
  code: wrap(truecolor ? "38;2;240;200;138" : "33", "39"),
};

/** Raw SGR codes, for the streaming formatter that opens and closes styles across chunks. */
export const sgr = {
  boldOn: () => (colorEnabled ? "\x1b[1m" : ""),
  boldOff: () => (colorEnabled ? "\x1b[22m" : ""),
  codeOn: () => (colorEnabled ? (truecolor ? "\x1b[38;2;240;200;138m" : "\x1b[33m") : ""),
  fgOff: () => (colorEnabled ? "\x1b[39m" : ""),
  grayOn: () => (colorEnabled ? "\x1b[90m" : ""),
};

/**
 * Unicode level. Plain ASCII on TERM=dumb or CEPHEUS_ASCII=1. The classic Windows console host (no
 * Windows Terminal, no VS Code) renders basic symbols but not braille or some dingbats, so those fall back.
 */
const ascii = env.CEPHEUS_ASCII === "1" || env.TERM === "dumb";
const rich = !ascii && (process.platform !== "win32" || !!env.WT_SESSION || !!env.TERM_PROGRAM || !!env.ConEmuANSI);

export const sym = {
  ok: ascii ? "+" : "✓",
  fail: ascii ? "x" : "✗",
  edit: ascii ? "*" : "✎",
  run: ascii ? ">" : "▶",
  warn: ascii ? "!" : "⚠",
  arrow: ascii ? "->" : "→",
  dot: ascii ? "-" : "·",
  minus: ascii ? "-" : "−",
  think: ascii ? "~" : "✻",
  todo: ascii ? "[ ]" : "☐",
  doing: ascii ? "[>]" : "◐",
  done: ascii ? "[x]" : "☑",
  prompt: ascii ? ">" : rich ? "❯" : "›",
  mark: ascii ? "*" : "◆",
  bar: ascii ? "|" : "│",
  rule: ascii ? "-" : "─",
  ellipsis: ascii ? "..." : "…",
  steer: ascii ? "->" : "↳",
  box: ascii
    ? { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
    : { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  spinner: ascii || !rich ? ["-", "\\", "|", "/"] : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

/** Visible width of a string (ANSI codes removed; wide East Asian characters count as two). */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    const cp = ch.codePointAt(0) ?? 0;
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ? 2 : 1;
  }
  return w;
}

export function termWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 100, 160));
}

/** Width used for prose and rows: the terminal, but never wider than is comfortable to read. */
export function readWidth(): number {
  return Math.min(termWidth(), 100);
}

/** Pads `left` with spaces so `right` ends at `width`; falls back to a single separator when it doesn't fit. */
export function spread(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? left + " ".repeat(gap) + right : `${left}  ${right}`;
}

/** Shortens a string to `max` visible characters, keeping the end (for paths). */
export function truncStart(s: string, max: number): string {
  return s.length > max ? sym.ellipsis + s.slice(s.length - max + sym.ellipsis.length) : s;
}

/** Shortens to `max` characters, keeping the start. */
export function truncEnd(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(0, max - sym.ellipsis.length)) + sym.ellipsis : s;
}

/** A rounded box around lines of (possibly colored) text. */
export function box(lines: string[], width: number): string {
  const b = sym.box;
  const inner = width - 4;
  const row = (l: string) => {
    const pad = Math.max(0, inner - visibleWidth(l));
    return `${c.gray(b.v)} ${l}${" ".repeat(pad)} ${c.gray(b.v)}`;
  };
  return [c.gray(b.tl + b.h.repeat(width - 2) + b.tr), ...lines.map(row), c.gray(b.bl + b.h.repeat(width - 2) + b.br)].join("\n");
}

/** Human duration: 140ms, 2.4s, 1m 05s. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
