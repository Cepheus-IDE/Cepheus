/**
 * Minimal .gitignore support shared by the Node server and the browser backend (no `node:*`
 * imports). Supports comments, negation (`!`), directory-only rules (`dir/`), anchored rules
 * (containing a `/`), `*`, `?`, `**` and character classes. Nested .gitignore files apply to
 * their own folder. Global excludes are not read.
 */

/** Folders never walked by search / quick open (mirrors src-tauri/src/search.rs). */
export const ALWAYS_SKIP = new Set([".git", "node_modules", "target", "dist", ".venv"]);

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" = any number of folders, "/**" at the end = everything inside.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) {
        out += "\\[";
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out += "\\" + glob[++i];
    } else {
      out += c.replace(/[.+^${}()|\]\\/]/g, "\\$&");
    }
  }
  return out;
}

export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    line = line.replace(/(?<!\\)\s+$/, "");
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const body = globToRegex(line);
    const re = new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`);
    rules.push({ re, negate, dirOnly });
  }
  return rules;
}

/** Stack of .gitignore files from the root down to the folder being walked. */
export class IgnoreStack {
  private layers: { base: string; rules: Rule[] }[] = [];

  /** Returns a new stack with `rules` from the .gitignore in `base` (workspace-relative, "" = root). */
  with(base: string, text: string | null): IgnoreStack {
    const next = new IgnoreStack();
    next.layers = this.layers.slice();
    if (text) {
      const rules = parseGitignore(text);
      if (rules.length) next.layers.push({ base, rules });
    }
    return next;
  }

  /** `rel` is workspace-relative with `/` separators. */
  ignored(rel: string, isDir: boolean): boolean {
    let result = false;
    for (const { base, rules } of this.layers) {
      if (base && !rel.startsWith(base + "/")) continue;
      const sub = base ? rel.slice(base.length + 1) : rel;
      for (const r of rules) {
        if (r.dirOnly && !isDir) {
          // "dir/" also hides files below dir: test the parent folders.
          const parent = sub.includes("/") ? sub.slice(0, sub.lastIndexOf("/")) : "";
          if (!parent || !r.re.test(parent)) continue;
        } else if (!r.re.test(sub)) {
          continue;
        }
        result = !r.negate;
      }
    }
    return result;
  }
}

/** Builds the regex used by search_files (mirrors search::build_regex). */
export function buildSearchRegex(o: { query: string; isRegex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }): RegExp {
  let pat = o.isRegex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) pat = `\\b(?:${pat})\\b`;
  try {
    return new RegExp(pat, o.caseSensitive ? "u" : "iu");
  } catch {
    return new RegExp(pat, o.caseSensitive ? "" : "i");
  }
}

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** One search hit per matching line, like the Rust backend (col is 1-based, UTF-16 units). */
export function searchText(
  text: string,
  re: RegExp,
  path: string,
  out: { path: string; line: number; col: number; len: number; text: string }[],
  max: number,
): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    const m = re.exec(line);
    if (!m) continue;
    out.push({ path, line: i + 1, col: m.index + 1, len: m[0].length, text: Array.from(line).slice(0, 400).join("") });
    if (out.length >= max) return true;
  }
  return false;
}
