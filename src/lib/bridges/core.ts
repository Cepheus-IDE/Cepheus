//! Extension bridges, pure part: linter output parsers, formatter command lines, .editorconfig
//! parsing and matching, and the .vsix extraction command. No imports (unit-tested with plain Node).

export type Severity = "error" | "warning" | "info";
/** One diagnostic, 1-based lines and columns (end inclusive of the last character + 1, like Monaco). */
export interface BridgeDiag { line: number; col: number; endLine: number; endCol: number; severity: Severity; message: string; code?: string; source: string }

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
const sameFile = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
/** First JSON array/object in a tool's output (some tools print a banner or warnings first). */
export function extractJson(text: string): any {
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const i = t.search(/[[{]/);
  if (i < 0) return null;
  try { return JSON.parse(t.slice(i)); } catch { return null; }
}
const keep = (d: BridgeDiag): BridgeDiag => ({ ...d, endLine: Math.max(d.endLine, d.line), endCol: d.endLine > d.line ? d.endCol : Math.max(d.endCol, d.col + 1) });

/** ESLint `-f json`: [{ filePath, messages: [{ ruleId, severity 1|2, message, line, column, endLine, endColumn }] }]. */
export function parseEslint(out: string, file?: string): BridgeDiag[] {
  const j = extractJson(out);
  if (!Array.isArray(j)) return [];
  const results = file && j.length > 1 ? j.filter((r) => typeof r?.filePath === "string" && sameFile(r.filePath, file)) : j;
  return results.flatMap((r: any) => (Array.isArray(r?.messages) ? r.messages : []).map((m: any) => keep({
    line: num(m.line, 1), col: num(m.column, 1), endLine: num(m.endLine, num(m.line, 1)), endCol: num(m.endColumn, num(m.column, 1) + 1),
    severity: m.severity === 2 || m.fatal ? "error" : "warning",
    message: String(m.message ?? ""), code: m.ruleId ? String(m.ruleId) : undefined, source: "eslint",
  })));
}

/** Ruff `check --output-format json`: [{ code, message, location: {row, column}, end_location, filename }]. */
export function parseRuff(out: string): BridgeDiag[] {
  const j = extractJson(out);
  if (!Array.isArray(j)) return [];
  return j.map((m: any) => keep({
    line: num(m.location?.row, 1), col: num(m.location?.column, 1),
    endLine: num(m.end_location?.row, num(m.location?.row, 1)), endCol: num(m.end_location?.column, num(m.location?.column, 1) + 1),
    // Syntax errors have no rule code (older versions: E999); everything else is a lint warning.
    severity: !m.code || m.code === "E999" || m.code === "invalid-syntax" ? "error" : "warning",
    message: String(m.message ?? ""), code: m.code ? String(m.code) : undefined, source: "ruff",
  }));
}

/** Stylelint `-f json` (stdout before v16, stderr since): [{ source, warnings: [{ line, column, endLine, endColumn, rule, severity, text }] }]. */
export function parseStylelint(out: string, file?: string): BridgeDiag[] {
  const j = extractJson(out);
  if (!Array.isArray(j)) return [];
  const results = file && j.length > 1 ? j.filter((r) => typeof r?.source === "string" && sameFile(r.source, file)) : j;
  return results.flatMap((r: any) => [
    ...(Array.isArray(r?.warnings) ? r.warnings : []).map((w: any) => keep({
      line: num(w.line, 1), col: num(w.column, 1), endLine: num(w.endLine, num(w.line, 1)), endCol: num(w.endColumn, num(w.column, 1) + 1),
      severity: w.severity === "error" ? "error" : "warning",
      message: String(w.text ?? "").replace(new RegExp(`\\s*\\(${String(w.rule ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)$`), ""),
      code: w.rule ? String(w.rule) : undefined, source: "stylelint",
    })),
    ...(Array.isArray(r?.parseErrors) ? r.parseErrors : []).map((w: any) => keep({
      line: num(w.line, 1), col: num(w.column, 1), endLine: num(w.line, 1), endCol: num(w.column, 1) + 1,
      severity: "error" as Severity, message: String(w.text ?? "Parse error"), source: "stylelint",
    })),
  ]);
}

/** ShellCheck `-f json`: [{ line, endLine, column, endColumn, level: error|warning|info|style, code, message }]. */
export function parseShellcheck(out: string): BridgeDiag[] {
  const j = extractJson(out);
  const list = Array.isArray(j) ? j : Array.isArray(j?.comments) ? j.comments : []; // json1 wraps in { comments }
  return list.map((m: any) => keep({
    line: num(m.line, 1), col: num(m.column, 1), endLine: num(m.endLine, num(m.line, 1)), endCol: num(m.endColumn, num(m.column, 1) + 1),
    severity: m.level === "error" ? "error" : m.level === "warning" ? "warning" : "info",
    message: String(m.message ?? ""), code: m.code !== undefined ? `SC${m.code}` : undefined, source: "shellcheck",
  }));
}

/** Hadolint `-f json`: [{ line, column, code: "DL3008", message, level: error|warning|info|style }]. */
export function parseHadolint(out: string): BridgeDiag[] {
  const j = extractJson(out);
  if (!Array.isArray(j)) return [];
  return j.map((m: any) => keep({
    line: num(m.line, 1), col: num(m.column, 1), endLine: num(m.line, 1), endCol: 1e6,
    severity: m.level === "error" ? "error" : m.level === "warning" ? "warning" : "info",
    message: String(m.message ?? ""), code: m.code ? String(m.code) : undefined, source: "hadolint",
  }));
}

/**
 * markdownlint-cli2 has no JSON flag; its default output (stderr) is one line per problem:
 * `README.md:3:1 MD022/blanks-around-headings Headings should be surrounded by blank lines [Expected: 1; Actual: 0; Below] [Context: "# A"]`
 * (newer versions add `error`/`warning` after the position; the column is optional).
 */
export function parseMarkdownlint(out: string, file?: string): BridgeDiag[] {
  const base = file ? file.replace(/\\/g, "/").split("/").pop()!.toLowerCase() : null;
  const res: BridgeDiag[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(.+?):(\d+)(?::(\d+))?\s+(?:(error|warning)\s+)?(MD\d{3})(?:\/(\S+))?\s+(.*)$/.exec(raw.trim());
    if (!m) continue;
    if (base && m[1].replace(/\\/g, "/").split("/").pop()!.toLowerCase() !== base) continue;
    const line = +m[2];
    const col = m[3] ? +m[3] : 1;
    res.push({ line, col, endLine: line, endCol: m[3] ? col + 1 : 1e6, severity: m[4] === "error" ? "error" : "warning", message: m[7].replace(/\s*\[Context: .*\]$/, ""), code: m[6] ? `${m[5]}/${m[6]}` : m[5], source: "markdownlint" });
  }
  return res;
}

export type LinterId = "eslint" | "ruff" | "stylelint" | "shellcheck" | "markdownlint" | "hadolint";
export const LINT_PARSERS: Record<LinterId, (out: string, file?: string) => BridgeDiag[]> = {
  eslint: parseEslint, ruff: parseRuff, stylelint: parseStylelint, shellcheck: parseShellcheck, markdownlint: parseMarkdownlint, hadolint: parseHadolint,
};

// ---------------------------------------------------------------------------------------------
// Tool command lines
// ---------------------------------------------------------------------------------------------

export type Quote = (s: string) => string;
export type FormatterId = "prettier" | "black" | "ruff" | "rustfmt" | "gofmt" | "clang-format" | "shfmt" | "php-cs-fixer" | "taplo" | "dart";

/**
 * How a formatter is fed: "stdin" — the buffer arrives on stdin (redirected from a temp file) and the
 * result is stdout; "inplace" — the tool rewrites the temp copy, which is read back.
 */
export interface FormatPlan { args: string; mode: "stdin" | "inplace" }

/** Arguments after the executable. `file` = the real path (for config lookup); `tmp` = the temp copy. */
export function formatterArgs(id: FormatterId, file: string, tmp: string, q: Quote, o: { edition?: string } = {}): FormatPlan {
  switch (id) {
    case "prettier": return { args: `--stdin-filepath ${q(file)}`, mode: "stdin" };
    case "black": return { args: `--quiet --stdin-filename ${q(file)} -`, mode: "stdin" };
    case "ruff": return { args: `format --quiet --stdin-filename ${q(file)} -`, mode: "stdin" };
    case "rustfmt": return { args: `--emit stdout --edition ${o.edition || "2021"}`, mode: "stdin" };
    case "gofmt": return { args: "", mode: "stdin" };
    case "clang-format": return { args: `--assume-filename=${q(file)}`, mode: "stdin" };
    case "shfmt": return { args: `-filename ${q(file)}`, mode: "stdin" };
    case "taplo": return { args: "fmt -", mode: "stdin" };
    case "dart": return { args: "format --output=show", mode: "stdin" };
    case "php-cs-fixer": return { args: `fix --quiet --using-cache=no ${q(tmp)}`, mode: "inplace" };
  }
}

/** Arguments after the executable for a linter run on a saved file. */
export function linterArgs(id: LinterId, file: string, q: Quote): string {
  switch (id) {
    case "eslint": return `-f json ${q(file)}`;
    case "ruff": return `check --output-format json --no-fix --exit-zero ${q(file)}`;
    case "stylelint": return `-f json ${q(file)}`;
    case "shellcheck": return `-f json ${q(file)}`;
    case "markdownlint": return q(file);
    case "hadolint": return `-f json --no-fail ${q(file)}`;
  }
}

/**
 * The full shell line: `<exe> <args> < in > out 2> err` (cmd.exe and sh both understand these
 * redirections). Output goes to files, not pipes, so multi-byte UTF-8 survives intact.
 */
export function redirectLine(exe: string, args: string, io: { stdin?: string; stdout: string; stderr: string }, q: Quote): string {
  return [exe, args, io.stdin ? `< ${q(io.stdin)}` : "", `> ${q(io.stdout)}`, `2> ${q(io.stderr)}`].filter(Boolean).join(" ");
}

/** Decides whether a formatter's result can replace the buffer. */
export function acceptFormatted(input: string, output: string, code: number | null): { ok: true; text: string } | { ok: false; reason: string } {
  if (code !== 0) return { ok: false, reason: `exit code ${code ?? "?"}` };
  if (!output.trim() && input.trim()) return { ok: false, reason: "the formatter printed nothing" };
  return { ok: true, text: output };
}

/**
 * One replacement turning `before` into `after` (common prefix and suffix kept), so cursors, folds
 * and markers outside the changed span survive. Offsets are into `before`; null = no change.
 */
export function minimalEdit(before: string, after: string): { start: number; end: number; text: string } | null {
  if (before === after) return null;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  // Don't split a CRLF pair.
  if (p > 0 && before[p - 1] === "\r" && before[p] === "\n") p--;
  return { start: p, end: before.length - s, text: after.slice(p, after.length - s) };
}

/** Normalizes line breaks to `eol` (tools may print LF for a CRLF buffer or vice versa). */
export const withEol = (text: string, eol: string) => text.replace(/\r\n|\r|\n/g, eol);

/** `edition = "2021"` from a Cargo.toml (rustfmt needs it for stdin input). */
export function cargoEdition(toml: string): string | undefined {
  return /^\s*edition\s*=\s*["'](\d{4})["']/m.exec(toml)?.[1];
}

// ---------------------------------------------------------------------------------------------
// .editorconfig
// ---------------------------------------------------------------------------------------------

export interface EditorConfigSection { glob: string; props: Record<string, string> }
export interface EditorConfigFile { root: boolean; sections: EditorConfigSection[] }

export function parseEditorConfig(text: string): EditorConfigFile {
  const out: EditorConfigFile = { root: false, sections: [] };
  let cur: EditorConfigSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[(.*)\]$/.exec(line);
    if (sec) { cur = { glob: sec[1], props: {} }; out.sections.push(cur); continue; }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1].trim().toLowerCase();
    const v = kv[2].replace(/\s+[#;].*$/, "").trim();
    if (!cur) { if (k === "root") out.root = v.toLowerCase() === "true"; continue; }
    cur.props[k] = /^(true|false|unset|lf|crlf|cr|space|tab|utf-8|latin1)$/i.test(v) ? v.toLowerCase() : v;
  }
  return out;
}

/** EditorConfig glob → RegExp over a "/"-separated path relative to the .editorconfig folder. */
export function editorConfigGlob(glob: string): RegExp {
  // A glob without "/" matches the file name in any folder; with one, it's anchored to the folder.
  const anchored = glob.includes("/");
  return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globBody(glob.startsWith("/") ? glob.slice(1) : glob)}$`);
}

function matchingBrace(g: string, i: number): number {
  let depth = 0;
  for (let k = i; k < g.length; k++) {
    if (g[k] === "{") depth++;
    else if (g[k] === "}" && --depth === 0) return k;
  }
  return -1;
}

/** Splits "a,{b,c},d" on top-level commas. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

function globBody(g: string): string {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = g.indexOf("]", i);
      if (end < 0) { re += "\\["; continue; }
      let cls = g.slice(i + 1, end);
      if (cls.startsWith("!")) cls = "^" + cls.slice(1);
      re += `[${cls.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else if (c === "{") {
      const end = matchingBrace(g, i);
      if (end < 0) { re += "\\{"; continue; }
      const body = g.slice(i + 1, end);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
      if (range) {
        const [a, b] = [+range[1], +range[2]].sort((x, y) => x - y);
        re += `(?:${Array.from({ length: Math.min(b - a + 1, 1000) }, (_, k) => a + k).join("|")})`;
      } else re += `(?:${splitTop(body).map(globBody).join("|")})`;
      i = end;
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return re;
}

export interface EditorConfigProps {
  indent_style?: "space" | "tab";
  indent_size?: number | "tab";
  tab_width?: number;
  end_of_line?: "lf" | "crlf" | "cr";
  insert_final_newline?: boolean;
  trim_trailing_whitespace?: boolean;
  charset?: string;
}

/**
 * Resolves properties for `file` from .editorconfig files, nearest folder last (it wins); `files`
 * lists [dir, parsed] from the outermost folder to the file's own folder. Stops at `root = true`.
 */
export function resolveEditorConfig(file: string, files: [string, EditorConfigFile][]): EditorConfigProps {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const f = norm(file);
  let start = 0;
  for (let i = files.length - 1; i >= 0; i--) if (files[i][1].root) { start = i; break; }
  const raw: Record<string, string> = {};
  for (const [dir, ec] of files.slice(start)) {
    const d = norm(dir);
    if (!f.toLowerCase().startsWith(d.toLowerCase() + "/")) continue;
    const rel = f.slice(d.length + 1);
    for (const s of ec.sections) if (editorConfigGlob(s.glob).test(rel)) Object.assign(raw, s.props);
  }
  const p: EditorConfigProps = {};
  const int = (v: string | undefined) => (v && /^\d+$/.test(v) && +v > 0 ? +v : undefined);
  if (raw.indent_style === "space" || raw.indent_style === "tab") p.indent_style = raw.indent_style;
  if (raw.indent_size === "tab") p.indent_size = "tab";
  else if (int(raw.indent_size)) p.indent_size = int(raw.indent_size);
  if (int(raw.tab_width)) p.tab_width = int(raw.tab_width);
  if (raw.end_of_line === "lf" || raw.end_of_line === "crlf" || raw.end_of_line === "cr") p.end_of_line = raw.end_of_line;
  if (raw.insert_final_newline === "true" || raw.insert_final_newline === "false") p.insert_final_newline = raw.insert_final_newline === "true";
  if (raw.trim_trailing_whitespace === "true" || raw.trim_trailing_whitespace === "false") p.trim_trailing_whitespace = raw.trim_trailing_whitespace === "true";
  if (raw.charset && raw.charset !== "unset") p.charset = raw.charset;
  // Spec defaults: indent_size = tab → tab_width; tab_width defaults to indent_size.
  if (p.indent_size === "tab" && p.tab_width) p.indent_size = p.tab_width;
  if (p.tab_width === undefined && typeof p.indent_size === "number") p.tab_width = p.indent_size;
  return p;
}

/** Editor tab size / spaces from resolved properties (undefined = leave the editor's choice). */
export function editorConfigIndent(p: EditorConfigProps): { tabSize?: number; insertSpaces?: boolean } {
  const r: { tabSize?: number; insertSpaces?: boolean } = {};
  if (p.indent_style) r.insertSpaces = p.indent_style === "space";
  const size = p.indent_style === "tab" ? p.tab_width ?? (typeof p.indent_size === "number" ? p.indent_size : undefined) : typeof p.indent_size === "number" ? p.indent_size : p.tab_width;
  if (size) r.tabSize = size;
  return r;
}

// ---------------------------------------------------------------------------------------------
// Auto rename tag (linked editing of tag pairs in HTML / XML / JSX)
// ---------------------------------------------------------------------------------------------

interface TagTok { name: string; start: number; end: number; close: boolean; self: boolean }
const NAME = /[\w.:-]/;

/** Tags in markup/JSX text; attribute values with quotes and {…} (JSX `=>`) are skipped. */
export function scanTags(text: string): TagTok[] {
  const out: TagTok[] = [];
  let i = 0;
  while ((i = text.indexOf("<", i)) >= 0) {
    if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i + 4); if (e < 0) break; i = e + 3; continue; }
    const close = text[i + 1] === "/";
    const s = i + (close ? 2 : 1);
    if (!/[A-Za-z]/.test(text[s] ?? "")) { i++; continue; }
    let e = s;
    while (e < text.length && NAME.test(text[e])) e++;
    // Attributes: up to the next ">" outside quotes and braces.
    let j = e;
    let depth = 0;
    let q = "";
    for (; j < text.length; j++) {
      const c = text[j];
      if (q) { if (c === q) q = ""; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === ">" && depth === 0) break;
      else if (c === "<" && depth === 0 && !close) break; // `a < b` comparisons: not a tag
    }
    if (j >= text.length || text[j] !== ">") { i = e; continue; }
    out.push({ name: text.slice(s, e), start: s, end: e, close, self: !close && /\/\s*$/.test(text.slice(e, j)) });
    i = j + 1;
  }
  return out;
}

/** For an offset inside a tag name, the [start, end) offsets of both names of the pair. */
export function findTagPair(text: string, offset: number): [[number, number], [number, number]] | null {
  const tags = scanTags(text);
  const k = tags.findIndex((t) => offset >= t.start && offset <= t.end);
  if (k < 0) return null;
  const t = tags[k];
  if (t.self) return null;
  let depth = 1;
  if (!t.close) {
    for (let i = k + 1; i < tags.length; i++) {
      const x = tags[i];
      if (x.name !== t.name || x.self) continue;
      depth += x.close ? -1 : 1;
      if (depth === 0) return [[t.start, t.end], [x.start, x.end]];
    }
  } else {
    for (let i = k - 1; i >= 0; i--) {
      const x = tags[i];
      if (x.name !== t.name || x.self) continue;
      depth += x.close ? 1 : -1;
      if (depth === 0) return [[x.start, x.end], [t.start, t.end]];
    }
  }
  return null;
}

/** Relative path being typed in a string before the cursor: { dir: "../lib/", partial: "ut" }. */
export function pathPrefix(lineBefore: string): { dir: string; partial: string } | null {
  const m = /(?:["'`]|\]\(|url\(\s*)((?:\.\.?\/)(?:[^"'`()\s]*\/)?)([^"'`()\s/]*)$/.exec(lineBefore);
  if (!m) return null;
  return { dir: m[1], partial: m[2] };
}

// ---------------------------------------------------------------------------------------------
// .vsix extraction (language servers bundled in extensions)
// ---------------------------------------------------------------------------------------------

/**
 * Shell line that downloads a .vsix and unpacks the given folders (paths below `extension/`, ending
 * in "/") or files into `dest`. Windows: PowerShell + System.IO.Compression; elsewhere curl + unzip.
 */
export function vsixExtractCommand(url: string, dest: string, prefixes: string[], win: boolean, q: Quote): string {
  const safe = prefixes.filter((p) => /^[\w@./-]+$/.test(p) && !p.includes(".."));
  if (win) {
    const ps = (s: string) => s.replace(/'/g, "''");
    const list = safe.map((p) => `'extension/${ps(p)}'`).join(",");
    return `powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $t=[IO.Path]::GetTempFileName(); Invoke-WebRequest -UseBasicParsing -Uri '${ps(url)}' -OutFile $t; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($t); $pre=@(${list}); $n=0; foreach($e in $z.Entries){ $f=$e.FullName.Replace('\\','/'); if($f.EndsWith('/') -or $f.Contains('..')){continue}; foreach($p in $pre){ if(($p.EndsWith('/') -and $f.StartsWith($p)) -or $f -eq $p){ $o=Join-Path '${ps(dest)}' $f.Substring(10); New-Item -ItemType Directory -Force (Split-Path $o) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$o,$true); $n++; break } } }; $z.Dispose(); Remove-Item $t; Write-Output ('extracted ' + $n)"`;
  }
  const copies = safe.map((p) => {
    const rel = p.replace(/\/$/, "");
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const to = parent ? `${dest}/${parent}` : dest;
    return `mkdir -p ${q(to)} && cp -R "$d/x/extension/${rel}" ${q(to)}/`;
  }).join(" && ");
  return `d=$(mktemp -d) && curl -fsSL ${q(url)} -o "$d/x.vsix" && unzip -q -o "$d/x.vsix" -d "$d/x" && ${copies}; r=$?; rm -rf "$d"; exit $r`;
}

/** Replaces ${dir} / ${workspace} in a JSON-like value (language server init options). */
export function substitute(v: any, vars: Record<string, string>): any {
  if (typeof v === "string") return v.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  if (Array.isArray(v)) return v.map((x) => substitute(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, vars)]));
  return v;
}
