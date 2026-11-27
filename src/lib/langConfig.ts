//! VS Code `language-configuration.json` → Monaco LanguageConfiguration. Pure (no Monaco import) so
//! it can be tested in Node; IndentAction values mirror monaco.languages.IndentAction.

import type * as Monaco from "monaco-editor";

type Pair = [string, string];
const INDENT_ACTION: Record<string, number> = { none: 0, indent: 1, indentoutdent: 2, outdent: 3 };

/** A VS Code regex: a string or `{ pattern, flags }`. Invalid ones (Oniguruma-only syntax) → undefined. */
export function toRegExp(v: unknown): RegExp | undefined {
  let pattern: string | undefined;
  let flags = "";
  if (typeof v === "string") pattern = v;
  else if (v && typeof v === "object" && typeof (v as any).pattern === "string") {
    pattern = (v as any).pattern;
    flags = typeof (v as any).flags === "string" ? (v as any).flags : "";
  }
  if (pattern === undefined) return undefined;
  // Oniguruma's leading inline flag `(?i)` has no JS equivalent except as a flag.
  const m = pattern.match(/^\(\?([imx]+)\)/);
  if (m) {
    pattern = pattern.slice(m[0].length);
    if (m[1].includes("i") && !flags.includes("i")) flags += "i";
  }
  for (const f of [flags + "u", flags]) {
    try {
      return new RegExp(pattern, [...new Set(f)].filter((c) => "dgimsuy".includes(c)).join(""));
    } catch { /* try without the unicode flag */ }
  }
  return undefined;
}

function pair(v: unknown): Pair | undefined {
  if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  if (v && typeof v === "object" && typeof (v as any).open === "string" && typeof (v as any).close === "string") return [(v as any).open, (v as any).close];
  return undefined;
}

const pairs = (v: unknown): Pair[] => (Array.isArray(v) ? v.map(pair).filter((p): p is Pair => !!p) : []);

export function convertLanguageConfiguration(raw: any): Monaco.languages.LanguageConfiguration {
  const c = raw ?? {};
  const out: Monaco.languages.LanguageConfiguration = {};

  if (c.comments && typeof c.comments === "object") {
    const lc = c.comments.lineComment;
    const line = typeof lc === "string" ? lc : typeof lc?.comment === "string" ? lc.comment : undefined;
    const block = pair(c.comments.blockComment);
    out.comments = { ...(line ? { lineComment: line } : {}), ...(block ? { blockComment: block } : {}) };
  }
  const brackets = pairs(c.brackets);
  if (brackets.length) out.brackets = brackets;
  if (Array.isArray(c.colorizedBracketPairs)) out.colorizedBracketPairs = pairs(c.colorizedBracketPairs);

  if (Array.isArray(c.autoClosingPairs)) {
    out.autoClosingPairs = c.autoClosingPairs
      .map((p: any) => {
        const pp = pair(p);
        if (!pp) return null;
        const notIn = Array.isArray(p?.notIn) ? p.notIn.filter((x: unknown) => typeof x === "string") : typeof p?.notIn === "string" ? [p.notIn] : undefined;
        return { open: pp[0], close: pp[1], ...(notIn?.length ? { notIn } : {}) };
      })
      .filter(Boolean) as Monaco.languages.IAutoClosingPairConditional[];
  }
  if (Array.isArray(c.surroundingPairs)) out.surroundingPairs = pairs(c.surroundingPairs).map(([open, close]) => ({ open, close }));
  if (typeof c.autoCloseBefore === "string") out.autoCloseBefore = c.autoCloseBefore;

  const word = toRegExp(c.wordPattern);
  // Monaco requires the word pattern to be global (it scans lines with lastIndex).
  if (word) out.wordPattern = word.global ? word : new RegExp(word.source, word.flags + "g");

  if (c.indentationRules && typeof c.indentationRules === "object") {
    const ir = c.indentationRules;
    const inc = toRegExp(ir.increaseIndentPattern);
    const dec = toRegExp(ir.decreaseIndentPattern);
    if (inc && dec) {
      out.indentationRules = { increaseIndentPattern: inc, decreaseIndentPattern: dec };
      const nl = toRegExp(ir.indentNextLinePattern);
      const un = toRegExp(ir.unIndentedLinePattern);
      if (nl) out.indentationRules.indentNextLinePattern = nl;
      if (un) out.indentationRules.unIndentedLinePattern = un;
    }
  }

  if (c.folding && typeof c.folding === "object") {
    const start = toRegExp(c.folding.markers?.start);
    const end = toRegExp(c.folding.markers?.end);
    out.folding = {
      ...(typeof c.folding.offSide === "boolean" ? { offSide: c.folding.offSide } : {}),
      ...(start && end ? { markers: { start, end } } : {}),
    };
  }

  if (Array.isArray(c.onEnterRules)) {
    out.onEnterRules = c.onEnterRules
      .map((r: any) => {
        const beforeText = toRegExp(r?.beforeText);
        const action = r?.action;
        const indent = INDENT_ACTION[String(action?.indent ?? action?.indentAction ?? "").toLowerCase()];
        if (!beforeText || indent === undefined) return null;
        const afterText = toRegExp(r.afterText);
        const previousLineText = toRegExp(r.previousLineText);
        return {
          beforeText,
          ...(afterText ? { afterText } : {}),
          ...(previousLineText ? { previousLineText } : {}),
          action: {
            indentAction: indent,
            ...(typeof action.appendText === "string" ? { appendText: action.appendText } : {}),
            ...(typeof action.removeText === "number" ? { removeText: action.removeText } : {}),
          },
        };
      })
      .filter(Boolean) as Monaco.languages.OnEnterRule[];
  }
  return out;
}
