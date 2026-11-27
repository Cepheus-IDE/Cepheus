// Explorer sorting and files/watcher exclude globs (VS Code style, relative to the open folder).
import type { DirEntry } from "./api";
import type { Settings } from "./settings";

const reCache = new Map<string, RegExp>();

/** `**` any path, `*` within a segment, `?` one char, `{a,b}` alternatives. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const hit = reCache.get(glob);
  if (hit) return hit;
  let re = "";
  const g = glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = g.indexOf("}", i); if (end > i) { re += "(?:" + g.slice(i + 1, end).split(",").map(esc).join("|") + ")"; i = end; } else re += "\\{"; }
    else re += esc(c);
  }
  // A matching folder hides everything inside it too.
  const out = new RegExp("^" + re + "(?:/.*)?$", "i");
  reCache.set(glob, out);
  return out;
}
const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const rel = (root: string | null, path: string) => {
  const p = path.replace(/\\/g, "/");
  const r = root?.replace(/\\/g, "/").replace(/\/$/, "");
  return r && p.toLowerCase().startsWith(r.toLowerCase() + "/") ? p.slice(r.length + 1) : p;
};

export function isExcluded(root: string | null, path: string, globs: string[]): boolean {
  if (!globs.length) return false;
  const r = rel(root, path);
  return globs.some((g) => g.trim() && globToRegExp(g).test(r));
}

const ext = (n: string) => { const i = n.lastIndexOf("."); return i > 0 ? n.slice(i + 1).toLowerCase() : ""; };
const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Applies files exclude + sort order to one folder listing. */
export function arrangeEntries(list: DirEntry[], root: string | null, s: Pick<Settings, "filesExclude" | "explorerSortOrder">): DirEntry[] {
  const visible = list.filter((e) => !isExcluded(root, e.path, s.filesExclude ?? []));
  const order = s.explorerSortOrder ?? "default";
  const dirsFirst = (a: DirEntry, b: DirEntry) => Number(b.isDir) - Number(a.isDir);
  return visible.sort((a, b) => {
    if (order === "mixed") return byName(a, b);
    if (order === "filesFirst") return -dirsFirst(a, b) || byName(a, b);
    if (order === "type") return dirsFirst(a, b) || (a.isDir ? 0 : ext(a.name).localeCompare(ext(b.name))) || byName(a, b);
    return dirsFirst(a, b) || byName(a, b);
  });
}
