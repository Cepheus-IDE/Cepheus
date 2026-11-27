/** ANSI colors with NO_COLOR / FORCE_COLOR support. */

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

const wrap = (open: number, close: number) => (s: string | number) => (colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
};

/** Plain symbols fall back to ASCII on terminals that can't show Unicode (TERM=dumb / CEPHEUS_ASCII). */
const ascii = process.env.CEPHEUS_ASCII === "1" || process.env.TERM === "dumb";
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
  prompt: ascii ? ">" : "❯",
};

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

export function termWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns || 100, 160));
}
