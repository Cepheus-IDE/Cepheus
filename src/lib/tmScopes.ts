//! TextMate scope stack → Monaco token name. Monaco themes match token names by dotted prefix, so we
//! emit the exact selector string of the theme rule that wins under TextMate's rules (deepest scope
//! first, then the longest selector); Monaco then colors it with that same rule. Pure — no Monaco.

interface Sel { raw: string; last: string; parents: string[]; segs: number }

/** Monaco/Monarch token names the built-in Cepheus themes color (used when no theme rule matches). */
const STANDARD: [string, string][] = [
  ["comment", "comment"],
  ["string.regexp", "regexp"],
  ["constant.character.escape", "string.escape"],
  ["string", "string"],
  ["constant.numeric", "number"],
  ["constant", "constant"],
  ["keyword.operator", "operator"],
  ["keyword", "keyword"],
  ["storage", "storage"],
  ["entity.name.type", "type"],
  ["entity.name.class", "type"],
  ["entity.other.inherited-class", "type"],
  ["support.type", "type"],
  ["support.class", "type"],
  ["entity.name.function", "function"],
  ["support.function", "function"],
  ["entity.name.tag", "tag"],
  ["entity.other.attribute-name", "attribute.name"],
  ["markup.heading", "keyword"],
  ["markup.bold", "strong"],
  ["markup.italic", "emphasis"],
  ["variable", "variable"],
  ["punctuation", "delimiter"],
  ["invalid", "invalid"],
  ["entity.name", "identifier"],
];

const prefixOf = (sel: string, scope: string) => scope === sel || scope.startsWith(sel + ".");

function standardToken(scopes: string[]): string {
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const [p, tok] of STANDARD) if (prefixOf(p, scopes[i])) return tok;
  }
  return "";
}

/** Every selector of a VS Code theme's `tokenColors`, trimmed exactly like themes.ts builds rules. */
export function themeSelectors(tokenColors: any[]): string[] {
  const out: string[] = [];
  for (const tc of tokenColors ?? []) {
    const st = tc?.settings ?? {};
    if (!st.foreground && typeof st.fontStyle !== "string") continue;
    if (!tc.scope) continue;
    const scopes: string[] = Array.isArray(tc.scope) ? tc.scope : String(tc.scope).split(",");
    for (const s of scopes) if (s.trim()) out.push(s.trim());
  }
  return out;
}

/** Returns `pick(scopes)` → token name, memoized per scope stack. */
export function createScopeMatcher(selectors: string[]) {
  const byRoot = new Map<string, Sel[]>();
  for (const raw of new Set(selectors)) {
    // Exclusions ("a - b") and child combinators are approximated by their positive part.
    const parts = raw.split(" - ")[0].replace(/>/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const last = parts[parts.length - 1];
    const sel: Sel = { raw, last, parents: parts.slice(0, -1), segs: last.split(".").length };
    const root = last.split(".")[0];
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(sel);
  }
  const memo = new Map<string, string>();

  const parentsMatch = (parents: string[], ancestors: string[]) => {
    let j = ancestors.length - 1;
    for (let p = parents.length - 1; p >= 0; p--) {
      while (j >= 0 && !prefixOf(parents[p], ancestors[j])) j--;
      if (j < 0) return false;
      j--;
    }
    return true;
  };

  return function pick(scopes: string[]): string {
    const key = scopes.join(" ");
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result = "";
    for (let i = scopes.length - 1; i >= 0 && !result; i--) {
      const s = scopes[i];
      let best: Sel | null = null;
      let bestScore = -1;
      for (const c of byRoot.get(s.split(".")[0]) ?? []) {
        if (!prefixOf(c.last, s)) continue;
        if (c.parents.length && !parentsMatch(c.parents, scopes.slice(0, i))) continue;
        const score = c.segs * 100 + c.parents.length;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (best) result = best.raw;
    }
    if (!result) result = standardToken(scopes);
    if (memo.size > 20000) memo.clear();
    memo.set(key, result);
    return result;
  };
}
