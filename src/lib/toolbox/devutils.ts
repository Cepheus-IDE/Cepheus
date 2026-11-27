//! Pure helpers behind the Toolbox dev utilities: JWT, Base64/URL, UUID, timestamps, colors,
//! a minimal YAML and TOML reader/writer, and JSON error positions. No imports; uses only web
//! globals (TextEncoder, atob/btoa, crypto) so it runs in the webview and in Node tests.

// ------------------------------------------------------------------ Base64 / URL
export function b64encode(text: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const s = btoa(bin);
  return urlSafe ? s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : s;
}

export function b64decode(s: string): string {
  const clean = s.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("Not valid Base64");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ------------------------------------------------------------------ JWT
export interface JwtInfo {
  header: any;
  payload: any;
  signature: string;
  /** Registered time claims as dates */
  times: { claim: "exp" | "iat" | "nbf"; date: Date }[];
  expired: boolean | null;
  notYetValid: boolean;
}

/** Decodes a JWT without verifying it (no secret involved). */
export function decodeJwt(token: string, now = Date.now()): JwtInfo {
  const parts = token.trim().replace(/^Bearer\s+/i, "").split(".");
  if (parts.length < 2) throw new Error("A JWT has three dot-separated parts");
  const json = (p: string, what: string) => {
    try { return JSON.parse(b64decode(p)); } catch { throw new Error(`The ${what} is not Base64url-encoded JSON`); }
  };
  const header = json(parts[0], "header");
  const payload = json(parts[1], "payload");
  const times: JwtInfo["times"] = [];
  for (const claim of ["iat", "nbf", "exp"] as const) {
    if (typeof payload?.[claim] === "number") times.push({ claim, date: new Date(payload[claim] * 1000) });
  }
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : null;
  const nbf = typeof payload?.nbf === "number" ? payload.nbf * 1000 : null;
  return { header, payload, signature: parts[2] ?? "", times, expired: exp === null ? null : exp < now, notYetValid: nbf !== null && nbf > now };
}

// ------------------------------------------------------------------ UUID
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function hexUuid(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidv4(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hexUuid(b);
}

/** Time-ordered UUID (RFC 9562): 48-bit Unix ms timestamp, then random bits. */
export function uuidv7(ms = Date.now()): string {
  const b = randomBytes(16);
  let t = ms;
  for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  return hexUuid(b);
}

/** Timestamp embedded in a v7 UUID, or null. */
export function uuidv7Time(id: string): Date | null {
  const h = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(h) || h[12] !== "7") return null;
  return new Date(parseInt(h.slice(0, 12), 16));
}

// ------------------------------------------------------------------ Timestamps
export interface TimeInfo { date: Date; unixS: number; unixMs: number; iso: string; utc: string; local: string; relative: string }

export function relativeTime(ms: number, now = Date.now()): string {
  const d = (ms - now) / 1000;
  const a = Math.abs(d);
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"], [1, "second"]];
  for (const [s, name] of units) {
    if (a >= s || s === 1) {
      const n = Math.round(a / s);
      const label = `${n} ${name}${n === 1 ? "" : "s"}`;
      return d < 0 ? `${label} ago` : `in ${label}`;
    }
  }
  return "now";
}

/** Parses Unix seconds/milliseconds (auto-detected) or any date string. Empty → now. */
export function parseTime(input: string, now = Date.now()): TimeInfo {
  const s = input.trim();
  let ms: number;
  if (!s || s.toLowerCase() === "now") ms = now;
  else if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // ≥ 1e11 can't be seconds in any practical range (year 5138), so it is milliseconds.
    ms = Math.abs(n) >= 1e14 ? n / 1000 : Math.abs(n) >= 1e11 ? n : n * 1000;
  } else {
    ms = Date.parse(s);
    if (Number.isNaN(ms)) throw new Error("Not a Unix timestamp or a recognizable date");
  }
  const date = new Date(ms);
  return {
    date,
    unixS: Math.floor(ms / 1000),
    unixMs: Math.round(ms),
    iso: date.toISOString(),
    utc: date.toUTCString(),
    local: date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
    relative: relativeTime(ms, now),
  };
}

// ------------------------------------------------------------------ Colors
export interface Rgba { r: number; g: number; b: number; a: number } // 0..1, sRGB

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: Rgba): { l: number; c: number; h: number } {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h: c < 1e-4 ? 0 : h };
}

export function oklchToRgb(L: number, C: number, H: number, a = 1): Rgba {
  const hr = (H * Math.PI) / 180;
  const A = C * Math.cos(hr), B = C * Math.sin(hr);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a,
  };
}

export function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb(h: number, s: number, l: number, a = 1): Rgba {
  const k = (n: number) => (n + h / 30) % 12;
  const q = s * Math.min(l, 1 - l);
  const f = (n: number) => l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0), g: f(8), b: f(4), a };
}

const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", transparent: "#00000000" };

function num(s: string, scale: number): number {
  const t = s.trim();
  if (t.endsWith("%")) return (parseFloat(t) / 100) * scale;
  const n = parseFloat(t);
  if (Number.isNaN(n)) throw new Error(`Invalid number "${s}"`);
  return n;
}

/** Parses hex (#rgb/#rgba/#rrggbb/#rrggbbaa), rgb[a](), hsl[a](), oklch() or a few names. */
export function parseColor(input: string): Rgba {
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  const hex = s.match(/^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) : 1 };
  }
  const fn = s.match(/^(rgba?|hsla?|oklch)\(([^)]*)\)$/);
  if (!fn) throw new Error("Use #hex, rgb(), hsl() or oklch()");
  const [main, alpha] = fn[2].split("/");
  const parts = main.split(/[\s,]+/).filter(Boolean);
  const extra = parts.length === 4 ? parts.pop()! : alpha;
  const a = extra !== undefined ? clamp01(num(extra, 1)) : 1;
  if (parts.length !== 3) throw new Error("Expected three components");
  if (fn[1].startsWith("rgb")) return { r: clamp01(num(parts[0], 255) / 255), g: clamp01(num(parts[1], 255) / 255), b: clamp01(num(parts[2], 255) / 255), a };
  if (fn[1].startsWith("hsl")) return hslToRgb(parseFloat(parts[0]), clamp01(num(parts[1], 100) / 100), clamp01(num(parts[2], 100) / 100), a);
  return oklchToRgb(num(parts[0], 1), num(parts[1], 0.4), parseFloat(parts[2]) || 0, a);
}

const r255 = (x: number) => Math.round(clamp01(x) * 255);
const fix = (x: number, d: number) => String(Number(x.toFixed(d)));

export function formatColor(c: Rgba): { hex: string; rgb: string; hsl: string; oklch: string } {
  const hx = (x: number) => r255(x).toString(16).padStart(2, "0");
  const alphaHex = c.a < 1 ? hx(c.a) : "";
  const alpha = c.a < 1 ? ` / ${fix(c.a, 3)}` : "";
  const hsl = rgbToHsl(c);
  const ok = rgbToOklch(c);
  return {
    hex: `#${hx(c.r)}${hx(c.g)}${hx(c.b)}${alphaHex}`,
    rgb: `rgb(${r255(c.r)} ${r255(c.g)} ${r255(c.b)}${alpha})`,
    hsl: `hsl(${fix(hsl.h, 1)} ${fix(hsl.s * 100, 1)}% ${fix(hsl.l * 100, 1)}%${alpha})`,
    oklch: `oklch(${fix(ok.l * 100, 2)}% ${fix(ok.c, 4)} ${fix(ok.h, 2)}${alpha})`,
  };
}

// ------------------------------------------------------------------ JSON
/** JSON.parse with a "line X, column Y" error message. */
export function parseJsonWithPos(text: string): any {
  try {
    return JSON.parse(text);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const pos = msg.match(/position (\d+)/);
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      const line = before.split("\n").length;
      const col = Number(pos[1]) - before.lastIndexOf("\n");
      throw new Error(`${msg.replace(/\s*\(line \d+ column \d+\)/, "").replace(/ in JSON at position \d+/, "")} (line ${line}, column ${col})`);
    }
    throw new Error(msg);
  }
}

// ------------------------------------------------------------------ YAML (minimal)
interface YLine { indent: number; text: string; no: number }

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q && s[i - 1] !== "\\") q = null; continue; }
    if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function yamlScalar(raw: string, no: number): any {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new Error(`Line ${no}: unterminated string`);
    return JSON.parse(s.replace(/\\'/g, "'").replace(/\t/g, "\\t"));
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`Line ${no}: unterminated string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith("[") || s.startsWith("{")) return parseFlow(s, no);
  if (/^(true|True|TRUE)$/.test(s)) return true; // YAML 1.2: yes/on stay strings
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9][0-9_]*)$/.test(s)) return Number(s.replace(/_/g, ""));
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\d[\d_]*)?\.\d+([eE][-+]?\d+)?$|^[-+]?\d[\d_]*(\.\d*)?[eE][-+]?\d+$|^[-+]?\d[\d_]*\.$/.test(s)) return Number(s.replace(/_/g, ""));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/** Flow collections: [a, b, {c: d}] and {a: 1, b: [x]}. */
function parseFlow(s: string, no: number): any {
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const value = (): any => {
    ws();
    if (s[i] === "[") {
      i++;
      const arr: any[] = [];
      ws();
      if (s[i] === "]") { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (s[i] === ",") { i++; ws(); if (s[i] === "]") { i++; return arr; } continue; }
        if (s[i] === "]") { i++; return arr; }
        throw new Error(`Line ${no}: expected , or ] in flow sequence`);
      }
    }
    if (s[i] === "{") {
      i++;
      const obj: Record<string, any> = {};
      ws();
      if (s[i] === "}") { i++; return obj; }
      for (;;) {
        ws();
        const k = scalarToken(":,}");
        ws();
        if (s[i] !== ":") throw new Error(`Line ${no}: expected : in flow mapping`);
        i++;
        obj[String(k)] = value();
        ws();
        if (s[i] === ",") { i++; ws(); if (s[i] === "}") { i++; return obj; } continue; }
        if (s[i] === "}") { i++; return obj; }
        throw new Error(`Line ${no}: expected , or } in flow mapping`);
      }
    }
    return scalarToken(",]}");
  };
  const scalarToken = (stops: string): any => {
    ws();
    const q = s[i];
    if (q === '"' || q === "'") {
      const start = i++;
      while (i < s.length && !(s[i] === q && (q === "'" ? s[i + 1] !== "'" : s[i - 1] !== "\\"))) i += q === "'" && s[i] === "'" ? 2 : 1;
      i++;
      return yamlScalar(s.slice(start, i), no);
    }
    const start = i;
    while (i < s.length && !stops.includes(s[i]) && !(s[i] === ":" && /\s/.test(s[i + 1] ?? " ") && stops.includes(":"))) i++;
    return yamlScalar(s.slice(start, i), no);
  };
  const v = value();
  ws();
  if (i < s.length) throw new Error(`Line ${no}: unexpected "${s.slice(i, i + 10)}" after flow collection`);
  return v;
}

/** `key: rest` split at the first ": " (or trailing ":") outside quotes. */
function splitKey(text: string): [string, string] | null {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; continue; }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === ":" && (i === text.length - 1 || text[i + 1] === " " || text[i + 1] === "\t")) {
      let k = text.slice(0, i).trim();
      if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = String(yamlScalar(k, 0));
      return [k, text.slice(i + 1).trim()];
    }
    if (c === "[" || c === "{") return null;
  }
  return null;
}

/** Parses a practical YAML subset: block mappings/sequences, scalars, flow collections, | and > blocks. */
export function parseYaml(src: string): any {
  const rawLines = src.replace(/\t/g, "  ").split(/\r?\n/);
  const lines: YLine[] = [];
  const blockRaw = new Map<number, string>(); // raw line text, for | and > blocks
  rawLines.forEach((raw, idx) => {
    blockRaw.set(idx + 1, raw);
    if (/^(---|\.\.\.)(\s|$)/.test(raw)) return;
    const t = stripComment(raw);
    if (!t.trim()) return;
    lines.push({ indent: t.length - t.trimStart().length, text: t.trim(), no: idx + 1 });
  });
  let pos = 0;

  const blockScalar = (header: string, parentIndent: number, no: number): string => {
    const folded = header.startsWith(">");
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const body: string[] = [];
    let ind = -1;
    let ln = no + 1;
    for (; ln <= rawLines.length; ln++) {
      const raw = blockRaw.get(ln) ?? "";
      if (!raw.trim()) { body.push(""); continue; }
      const i = raw.length - raw.trimStart().length;
      if (i <= parentIndent) break;
      if (ind < 0) ind = i;
      body.push(raw.slice(Math.min(ind, i)));
    }
    while (pos < lines.length && lines[pos].no < ln) pos++;
    while (body.length && body[body.length - 1] === "" && chomp !== "keep") body.pop();
    let text = folded ? body.join("\n").replace(/([^\n])\n(?=[^\n ])/g, "$1 ") : body.join("\n");
    if (chomp !== "strip") text += "\n";
    return text;
  };

  const parseBlock = (indent: number): any => {
    const first = lines[pos];
    if (!first) return null;
    if (first.text === "-" || first.text.startsWith("- ")) return parseSeq(first.indent);
    if (splitKey(first.text)) return parseMap(first.indent);
    pos++;
    if (indent >= 0 && lines[pos] && lines[pos].indent >= first.indent && !splitKey(lines[pos].text)) {
      // Plain multi-line scalar.
      let s = first.text;
      while (lines[pos] && lines[pos].indent >= first.indent && !splitKey(lines[pos].text)) s += " " + lines[pos++].text;
      return yamlScalar(s, first.no);
    }
    return yamlScalar(first.text, first.no);
  };

  const valueAfter = (rest: string, ownIndent: number, no: number, seqParent = false): any => {
    if (rest === "") {
      const next = lines[pos];
      // A sequence may sit at the same indent as its mapping key.
      if (next && (next.indent > ownIndent || (!seqParent && next.indent === ownIndent && (next.text === "-" || next.text.startsWith("- "))))) return parseBlock(next.indent);
      return null;
    }
    if (/^[|>][-+0-9]*$/.test(rest)) return blockScalar(rest, ownIndent, no);
    if (/^&\S+$|^!\S+$/.test(rest)) return valueAfter("", ownIndent, no, seqParent); // anchors/tags: ignore
    return yamlScalar(rest.replace(/^(?:&\S+|!\S+)\s+/, ""), no);
  };

  const parseMap = (indent: number): Record<string, any> => {
    const obj: Record<string, any> = {};
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent < indent) break;
      if (l.indent > indent) throw new Error(`Line ${l.no}: unexpected indentation`);
      if (l.text === "-" || l.text.startsWith("- ")) break;
      const kv = splitKey(l.text);
      if (!kv) throw new Error(`Line ${l.no}: expected "key: value"`);
      pos++;
      if (kv[0] === "<<") { Object.assign(obj, valueAfter(kv[1], indent, l.no)); continue; }
      obj[kv[0]] = valueAfter(kv[1], indent, l.no);
    }
    return obj;
  };

  const parseSeq = (indent: number): any[] => {
    const arr: any[] = [];
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.indent !== indent || !(l.text === "-" || l.text.startsWith("- "))) {
        if (l.indent > indent) throw new Error(`Line ${l.no}: unexpected indentation`);
        break;
      }
      const rest = l.text.slice(1).trimStart();
      const inner = indent + (l.text.length - rest.length);
      if (rest && (rest.startsWith("- ") || rest === "-" || splitKey(rest))) {
        // "- key: v" / "- - x": the rest starts a nested block at its own column.
        lines[pos] = { indent: inner, text: rest, no: l.no };
        arr.push(parseBlock(inner));
      } else {
        pos++;
        arr.push(valueAfter(rest, indent, l.no, true));
      }
    }
    return arr;
  };

  if (!lines.length) return null;
  const v = parseBlock(-1);
  if (pos < lines.length) throw new Error(`Line ${lines[pos].no}: unexpected content`);
  return v;
}

const YAML_PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_ ./@()+-]*$/;
function yamlStr(s: string): string {
  if (s === "" || !YAML_PLAIN.test(s) || /^(true|false|yes|no|on|off|null|~)$/i.test(s) || /^[-+]?[\d.]/.test(s) || /\s$/.test(s)) return JSON.stringify(s);
  return s;
}

/** YAML text for a JSON-compatible value (2-space indent, | blocks for multi-line strings). */
export function toYaml(v: any, indent = 0): string {
  const pad = " ".repeat(indent);
  const scalar = (x: any, ind: number): string => {
    if (x === null || x === undefined) return "null";
    if (typeof x === "string") {
      if (x.includes("\n")) return "|" + (x.endsWith("\n") ? "" : "-") + "\n" + x.replace(/\n$/, "").split("\n").map((l) => " ".repeat(ind + 2) + l).join("\n");
      return yamlStr(x);
    }
    if (typeof x === "number") return Number.isFinite(x) ? String(x) : Number.isNaN(x) ? ".nan" : x > 0 ? ".inf" : "-.inf";
    return String(x);
  };
  const isColl = (x: any) => x !== null && typeof x === "object" && Object.keys(x).length > 0;
  if (Array.isArray(v)) {
    if (!v.length) return pad + "[]";
    return v.map((x) => {
      if (isColl(x)) {
        const inner = toYaml(x, indent + 2);
        return pad + "- " + inner.slice(indent + 2);
      }
      return pad + "- " + (x !== null && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalar(x, indent));
    }).join("\n");
  }
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return pad + "{}";
    return keys.map((k) => {
      const x = v[k];
      const key = yamlStr(k);
      if (isColl(x)) return `${pad}${key}:\n${toYaml(x, Array.isArray(x) ? indent : indent + 2)}`;
      return `${pad}${key}: ${x !== null && typeof x === "object" ? (Array.isArray(x) ? "[]" : "{}") : scalar(x, indent)}`;
    }).join("\n");
  }
  return pad + scalar(v, indent);
}

// ------------------------------------------------------------------ TOML (lite)
function tomlValue(s: string, start: number, no: number): [any, number] {
  let i = start;
  const ws = () => { while (i < s.length && /[\s]/.test(s[i])) { i++; } };
  const skipComments = () => { for (;;) { ws(); if (s[i] === "#") { while (i < s.length && s[i] !== "\n") i++; } else return; } };
  skipComments();
  const c = s[i];
  if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
    const q = s.slice(i, i + 3);
    const end = s.indexOf(q, i + 3);
    if (end < 0) throw new Error(`Line ${no}: unterminated multi-line string`);
    let body = s.slice(i + 3, end).replace(/^\r?\n/, "");
    if (q === '"""') body = JSON.parse(`"${body.replace(/\\\r?\n\s*/g, "").replace(/\r?\n/g, "\\n").replace(/"/g, '\\"').replace(/\\\\"/g, '\\"')}"`);
    return [body, end + 3];
  }
  if (c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
    if (j >= s.length) throw new Error(`Line ${no}: unterminated string`);
    return [JSON.parse(s.slice(i, j + 1)), j + 1];
  }
  if (c === "'") {
    const j = s.indexOf("'", i + 1);
    if (j < 0) throw new Error(`Line ${no}: unterminated string`);
    return [s.slice(i + 1, j), j + 1];
  }
  if (c === "[") {
    i++;
    const arr: any[] = [];
    for (;;) {
      skipComments();
      if (s[i] === "]") return [arr, i + 1];
      const [v, ni] = tomlValue(s, i, no);
      arr.push(v);
      i = ni;
      skipComments();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "]") return [arr, i + 1];
      throw new Error(`Line ${no}: expected , or ] in array`);
    }
  }
  if (c === "{") {
    i++;
    const obj: Record<string, any> = {};
    for (;;) {
      ws();
      if (s[i] === "}") return [obj, i + 1];
      const eq = s.indexOf("=", i);
      if (eq < 0) throw new Error(`Line ${no}: expected = in inline table`);
      const path = tomlKeyPath(s.slice(i, eq), no);
      const [v, ni] = tomlValue(s, eq + 1, no);
      setPath(obj, path, v, no);
      i = ni;
      ws();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") return [obj, i + 1];
      throw new Error(`Line ${no}: expected , or } in inline table`);
    }
  }
  const m = s.slice(i).match(/^[^\s,\]}#]+(?: \d{2}:\d{2}[^\s,\]}#]*)?/);
  if (!m) throw new Error(`Line ${no}: missing value`);
  const tok = m[0];
  let v: any;
  if (tok === "true") v = true;
  else if (tok === "false") v = false;
  else if (/^[-+]?(inf|nan)$/.test(tok)) v = tok.includes("nan") ? NaN : tok.startsWith("-") ? -Infinity : Infinity;
  else if (/^0x[0-9a-fA-F_]+$/.test(tok)) v = parseInt(tok.slice(2).replace(/_/g, ""), 16);
  else if (/^0o[0-7_]+$/.test(tok)) v = parseInt(tok.slice(2).replace(/_/g, ""), 8);
  else if (/^0b[01_]+$/.test(tok)) v = parseInt(tok.slice(2).replace(/_/g, ""), 2);
  else if (/^[-+]?\d[\d_]*(\.\d[\d_]*)?([eE][-+]?\d+)?$/.test(tok)) v = Number(tok.replace(/_/g, ""));
  else if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(tok)) v = tok; // dates/times stay strings
  else throw new Error(`Line ${no}: invalid value "${tok}"`);
  return [v, i + tok.length];
}

function tomlKeyPath(raw: string, no: number): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`Line ${no}: invalid key "${s}"`);
    out.push(m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2] ?? m[3]);
    i = re.lastIndex;
  }
  if (!out.length) throw new Error(`Line ${no}: empty key`);
  return out;
}

function setPath(root: Record<string, any>, path: string[], v: any, no: number) {
  let o = root;
  for (const k of path.slice(0, -1)) {
    if (o[k] === undefined) o[k] = {};
    else if (typeof o[k] !== "object" || Array.isArray(o[k])) throw new Error(`Line ${no}: "${k}" is not a table`);
    o = o[k];
  }
  const last = path[path.length - 1];
  if (last in o) throw new Error(`Line ${no}: duplicate key "${path.join(".")}"`);
  o[last] = v;
}

/** Parses TOML: tables, arrays of tables, dotted keys, strings, numbers, bools, arrays, inline tables. */
export function parseToml(src: string): Record<string, any> {
  const root: Record<string, any> = {};
  let cur = root;
  const text = src.replace(/\r\n/g, "\n");
  let i = 0;
  const lineAt = (p: number) => text.slice(0, p).split("\n").length;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;
    const no = lineAt(i);
    if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (text[i] === "[") {
      const arr = text[i + 1] === "[";
      const end = text.indexOf(arr ? "]]" : "]", i);
      if (end < 0) throw new Error(`Line ${no}: unterminated table header`);
      const path = tomlKeyPath(text.slice(i + (arr ? 2 : 1), end), no);
      let o = root;
      for (const k of path.slice(0, -1)) {
        if (o[k] === undefined) o[k] = {};
        o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k];
      }
      const last = path[path.length - 1];
      if (arr) {
        if (o[last] === undefined) o[last] = [];
        if (!Array.isArray(o[last])) throw new Error(`Line ${no}: "${last}" is not an array of tables`);
        o[last].push((cur = {}));
      } else {
        if (o[last] === undefined) o[last] = {};
        cur = o[last];
      }
      i = end + (arr ? 2 : 1);
      continue;
    }
    const eq = text.indexOf("=", i);
    const nl = text.indexOf("\n", i);
    if (eq < 0 || (nl >= 0 && eq > nl)) throw new Error(`Line ${no}: expected "key = value"`);
    const path = tomlKeyPath(text.slice(i, eq), no);
    const [v, ni] = tomlValue(text, eq + 1, no);
    setPath(cur, path, v, no);
    i = ni;
    while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
    if (i < text.length && text[i] !== "\n") throw new Error(`Line ${no}: unexpected text after value`);
  }
  return root;
}

const TOML_BARE = /^[A-Za-z0-9_-]+$/;
const tKey = (k: string) => (TOML_BARE.test(k) ? k : JSON.stringify(k));
const isTable = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTableArray = (v: any) => Array.isArray(v) && v.length > 0 && v.every(isTable);

function tomlInline(v: any): string {
  if (v === null || v === undefined) return '""';
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlInline).join(", ")}]`;
  return `{ ${Object.entries(v).map(([k, x]) => `${tKey(k)} = ${tomlInline(x)}`).join(", ")} }`;
}

/** TOML text for an object (nested objects become [tables], object arrays [[tables]]). null → "". */
export function toToml(obj: any, prefix: string[] = []): string {
  if (!isTable(obj)) throw new Error("TOML needs an object at the top level");
  const lines: string[] = [];
  const sub: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, any>)) {
    if (isTable(v)) sub.push(...(() => {
      const path = [...prefix, k];
      const body = toToml(v, path);
      const hasScalars = Object.values(v).some((x) => !isTable(x) && !isTableArray(x));
      return [hasScalars || !Object.keys(v).length ? `[${path.map(tKey).join(".")}]\n${body}` : body];
    })());
    else if (isTableArray(v)) for (const t of v as any[]) sub.push(`[[${[...prefix, k].map(tKey).join(".")}]]\n${toToml(t, [...prefix, k])}`);
    else lines.push(`${tKey(k)} = ${tomlInline(v)}`);
  }
  return [lines.join("\n"), ...sub].filter((s) => s.trim()).join("\n\n").replace(/\n{3,}/g, "\n\n") + (prefix.length ? "" : "\n");
}
