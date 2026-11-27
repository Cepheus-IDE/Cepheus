/**
 * Pure path helpers (no `node:path`): absolute paths use `/` separators everywhere, with an
 * optional Windows drive prefix (`C:/...`) or a UNC prefix (`//server/share/...`).
 */

/** Splits off the root prefix: "C:/", "/", "//server/share/" or "" (relative). */
function splitRoot(p: string): [string, string] {
  const drive = /^[A-Za-z]:\//.exec(p);
  if (drive) return [drive[0].toUpperCase(), p.slice(3)];
  if (/^[A-Za-z]:$/.test(p)) return [p.toUpperCase() + "/", ""];
  const unc = /^\/\/[^/]+\/[^/]+\/?/.exec(p);
  if (unc) return [unc[0].endsWith("/") ? unc[0] : unc[0] + "/", p.slice(unc[0].length)];
  if (p.startsWith("/")) return ["/", p.replace(/^\/+/, "")];
  return ["", p];
}

/** Converts backslashes, resolves `.`/`..` lexically and removes duplicate/trailing slashes. */
export function normalize(p: string): string {
  const [root, rest] = splitRoot(p.replace(/\\/g, "/"));
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!root) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (root) return root + joined;
  return joined || ".";
}

export function isAbsolute(p: string): boolean {
  return splitRoot(p.replace(/\\/g, "/"))[0] !== "";
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((x) => x !== "").join("/"));
}

export function dirname(p: string): string {
  const n = normalize(p);
  const i = n.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  const d = n.slice(0, i);
  return /^[A-Z]:$/.test(d) ? d + "/" : d;
}

export function basename(p: string): string {
  const n = normalize(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

function cmp(a: string, ci: boolean) {
  return ci ? a.toLowerCase() : a;
}

/** True when `p` is `root` itself or inside it. */
export function isInside(root: string, p: string, caseInsensitive = false): boolean {
  const r = cmp(normalize(root), caseInsensitive);
  const n = cmp(normalize(p), caseInsensitive);
  if (n === r) return true;
  const prefix = r.endsWith("/") ? r : r + "/";
  return n.startsWith(prefix);
}

/**
 * Resolves a model-supplied path against the workspace root and refuses anything outside it
 * (mirrors `tools::resolve` in the app). Returns the absolute normalized path.
 */
export function resolveInWorkspace(root: string, p: string, caseInsensitive = false): string {
  const raw = String(p ?? "").trim() || ".";
  const candidate = isAbsolute(raw) ? normalize(raw) : join(root, raw);
  if (!isInside(root, candidate, caseInsensitive)) {
    throw new Error(`Path '${raw}' is outside the workspace; access denied.`);
  }
  return candidate;
}

/** Workspace-relative display path with `/` separators ("." for the root). */
export function relative(root: string, p: string, caseInsensitive = false): string {
  const r = normalize(root);
  const n = normalize(p);
  if (cmp(n, caseInsensitive) === cmp(r, caseInsensitive)) return ".";
  const prefix = r.endsWith("/") ? r : r + "/";
  if (cmp(n, caseInsensitive).startsWith(cmp(prefix, caseInsensitive))) return n.slice(prefix.length);
  return n;
}
