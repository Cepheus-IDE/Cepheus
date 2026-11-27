//! File links in terminal output: `path`, `path:line`, `path:line:col`, `path(line,col)` and
//! Python's `File "path", line N`. Pure matching here; existence is checked by the caller.

export interface LinkMatch { start: number; end: number; path: string; line?: number; col?: number }

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const PY_RE = /File "([^"]+)", line (\d+)/g;
// Optional drive / ./ / ../ / ~/ prefix, path segments, a file name with an extension, then an optional position.
const PATH_RE = /(?<![\w\/\\.:-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?(?:[\w.\-@+$]+[\\/])*[\w\-@+$][\w.\-@+$]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s*(\d+))?\))?/g;

export function findLinks(text: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  for (const m of text.matchAll(URL_RE)) taken.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(PY_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (!free(s, e)) continue;
    taken.push([s, e]);
    out.push({ start: s, end: e, path: m[1], line: +m[2] });
  }
  for (const m of text.matchAll(PATH_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    if (!free(s, e)) continue;
    taken.push([s, e]);
    const line = m[2] ?? m[4];
    const col = m[3] ?? m[5];
    out.push({ start: s, end: e, path: m[1], line: line ? +line : undefined, col: col ? +col : undefined });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Resolves a matched path against `cwd` (absolute paths pass through). Forward slashes. */
export function resolveAgainst(path: string, cwd: string | null): string | null {
  let p = path.replace(/\\/g, "/");
  const abs = /^[A-Za-z]:\//.test(p) || p.startsWith("/") || p.startsWith("ssh://");
  if (!abs) {
    if (!cwd || p.startsWith("~/")) return null;
    p = cwd.replace(/\\/g, "/").replace(/\/$/, "") + "/" + p;
  }
  // Normalize ./ and ../ segments (keep the "ssh://host" or "C:" head intact).
  const head = p.match(/^(ssh:\/\/[^/]+|[A-Za-z]:)?/)![0];
  const parts: string[] = [];
  for (const seg of p.slice(head.length).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return head + "/" + parts.join("/");
}
