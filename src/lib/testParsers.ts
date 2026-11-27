//! Pure parsers for the debugger and Test Explorer: test discovery in source files, runner
//! reports (Jest/Vitest JSON, JUnit XML, go test -json, cargo test text), coverage formats
//! (lcov, istanbul, coverage.py, go cover profiles), JSONC and .env files.
//! No imports on purpose: the scratchpad tests load this file directly with Node's type stripping.

export interface SourceTest { name: string; kind: "suite" | "test"; line: number; children: SourceTest[] }
export type TestStatus = "passed" | "failed" | "skipped";
export interface RawResult {
  /** Absolute or root-relative file path when the runner reports it. */
  file?: string;
  suite: string[];
  name: string;
  status: TestStatus;
  /** Milliseconds */
  duration?: number;
  message?: string;
  /** 1-based line of the failing assertion, when known. */
  line?: number;
  /** Runner-specific scope (go package, cargo test binary source). */
  scope?: string;
}
export interface FileCoverage { lines: Record<number, number>; covered: number; total: number }
export type Coverage = Record<string, FileCoverage>;

const norm = (p: string) => p.replace(/\\/g, "/");
const lineAt = (text: string, idx: number) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

// ----------------------------------------------------------------------------------------------
// JSONC + .env
// ----------------------------------------------------------------------------------------------

/** JSON with comments and trailing commas (launch.json, tsconfig style). */
export function parseJsonc(text: string): any {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m || raw.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, m[2][0] === '"' ? "\n" : "\\n");
    else v = v.replace(/\s+#.*$/, "");
    env[m[1]] = v;
  }
  return env;
}

// ----------------------------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------------------------

/** Skips a string/comment starting at i (JS syntax); returns the index after it, or -1. */
function skipJs(text: string, i: number): number {
  const c = text[i];
  if (c === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); return e < 0 ? text.length : e; }
  if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); return e < 0 ? text.length : e + 2; }
  if (c === '"' || c === "'" || c === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== c) {
      if (text[j] === "\\") j++;
      else if (c !== "`" && text[j] === "\n") break;
      j++;
    }
    return j + 1;
  }
  return -1;
}

const JS_CALL = /^(describe|suite|context|it|test|specify)((?:\.(?:only|skip|todo|concurrent|sequential|fails|serial))*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/;

/** describe/it/test blocks with string-literal titles in Jest, Vitest, Mocha and node:test files. */
export function discoverJs(text: string): SourceTest[] {
  const calls: { name: string; kind: "suite" | "test"; start: number; end: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const s = skipJs(text, i);
    if (s >= 0) { i = s - 1; continue; }
    if (!/[a-z]/.test(text[i]) || (i > 0 && /[\w$.]/.test(text[i - 1]))) continue;
    const m = JS_CALL.exec(text.slice(i, i + 400));
    if (!m) continue;
    // Find the matching close paren of the call to know which tests a suite contains.
    let depth = 0, j = i + text.slice(i).indexOf("(");
    for (; j < text.length; j++) {
      const sk = skipJs(text, j);
      if (sk >= 0) { j = sk - 1; continue; }
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    const suite = m[1] === "describe" || m[1] === "suite" || m[1] === "context";
    calls.push({ name: m[4].replace(/\\(.)/g, "$1"), kind: suite ? "suite" : "test", start: i, end: j });
    i += m[0].length - 1; // continue inside the call: nested blocks are found by the same scan
  }
  const roots: SourceTest[] = [];
  const stack: { node: SourceTest; end: number }[] = [];
  for (const c of calls) {
    while (stack.length && stack[stack.length - 1].end < c.start) stack.pop();
    const node: SourceTest = { name: c.name, kind: c.kind, line: lineAt(text, c.start), children: [] };
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    if (c.kind === "suite") stack.push({ node, end: c.end });
  }
  return roots;
}

/** pytest: module-level `def test_*` and methods of `class Test*`. */
export function discoverPython(text: string): SourceTest[] {
  const roots: SourceTest[] = [];
  let cls: { node: SourceTest; indent: number; body: number } | null = null;
  text.split(/\r?\n/).forEach((l, i) => {
    if (!l.trim() || l.trim().startsWith("#")) return;
    const indent = l.match(/^\s*/)![0].length;
    if (cls && indent <= cls.indent) cls = null;
    const c = l.match(/^class\s+(Test\w*)\s*[(:]/);
    if (c) {
      const node: SourceTest = { name: c[1], kind: "suite", line: i + 1, children: [] };
      roots.push(node);
      cls = { node, indent, body: -1 };
      return;
    }
    if (cls && cls.body < 0) cls.body = indent;
    const d = l.match(/^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/);
    if (!d) return;
    const t: SourceTest = { name: d[2], kind: "test", line: i + 1, children: [] };
    if (indent === 0) roots.push(t);
    else if (cls && indent === cls.body) cls.node.children.push(t);
  });
  return roots.filter((r) => r.kind === "test" || r.children.length);
}

/** Rust: `#[test]`-style functions, nested in their `mod` blocks (names are module paths). */
export function discoverRust(text: string): SourceTest[] {
  const roots: SourceTest[] = [];
  const stack: { node: SourceTest; depth: number }[] = [];
  let depth = 0, pendingTest = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) { i = skipJs(text, i) - 1; continue; }
    if (c === '"') { i = skipJs(text, i) - 1; continue; }
    if (c === "r" && /^r#*"/.test(text.slice(i, i + 8)) && !/\w/.test(text[i - 1] ?? "")) {
      const hashes = text.slice(i + 1).match(/^#*/)![0];
      const end = text.indexOf('"' + hashes, i + 2 + hashes.length);
      i = end < 0 ? text.length : end + hashes.length;
      continue;
    }
    if (c === "'") { const m = text.slice(i, i + 12).match(/^'(\\.[^']*|[^\\'])'/); if (m) { i += m[0].length - 1; continue; } }
    if (c === "{") depth++;
    else if (c === "}") { depth--; while (stack.length && stack[stack.length - 1].depth > depth) stack.pop(); }
    else if (c === "#" && text[i + 1] === "[") {
      const m = text.slice(i, i + 80).match(/^#\[\s*((?:\w+::)*test|rstest|test_case[^\]]*)\b[^\]]*\]/);
      if (m) { pendingTest = true; i += m[0].length - 1; }
    } else if (/[a-z]/.test(c) && !/\w/.test(text[i - 1] ?? "")) {
      const rest = text.slice(i, i + 200);
      const mod = rest.match(/^mod\s+(\w+)\s*\{/);
      if (mod) {
        const node: SourceTest = { name: mod[1], kind: "suite", line: lineAt(text, i), children: [] };
        (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
        depth++;
        stack.push({ node, depth });
        i += mod[0].length - 1;
        continue;
      }
      const fn = rest.match(/^fn\s+(\w+)/);
      if (fn) {
        if (pendingTest) (stack.length ? stack[stack.length - 1].node.children : roots).push({ name: fn[1], kind: "test", line: lineAt(text, i), children: [] });
        pendingTest = false;
        i += fn[0].length - 1;
      }
    }
  }
  const prune = (ns: SourceTest[]): SourceTest[] => ns.filter((n) => n.kind === "test" || (n.children = prune(n.children)).length > 0);
  return prune(roots);
}

/** Go: `func TestXxx(t *testing.T)`. */
export function discoverGo(text: string): SourceTest[] {
  const out: SourceTest[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = l.match(/^func\s+(Test\w*|Example\w*)\s*\(\s*(?:\w+\s+\*testing\.T)?\s*\)/);
    if (m && (m[1] === "Test" || /^(Test|Example)[^a-z]/.test(m[1]))) out.push({ name: m[1], kind: "test", line: i + 1, children: [] });
  });
  return out;
}

// ----------------------------------------------------------------------------------------------
// Results
// ----------------------------------------------------------------------------------------------

function decodeXml(s: string) {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k === "amp") return "&";
    return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  });
}
const attrs = (s: string) => {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = decodeXml(m[2]);
  return o;
};

/** First `file:line` in a stack/message that points at `file` (path or basename). */
export function failureLine(message: string | undefined, file: string | undefined): number | undefined {
  if (!message || !file) return undefined;
  const f = norm(file).toLowerCase();
  const base = f.split("/").pop()!;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let decoded = message;
  try { decoded = decodeURIComponent(message.replace(/%(?![0-9a-f]{2})/gi, "%25")); } catch { /* keep raw */ }
  const lines = norm(decoded).toLowerCase();
  const full = new RegExp(esc(f) + ":(\\d+)").exec(lines);
  if (full) return +full[1];
  const short = new RegExp("(?:^|[\\s(/\\\\])" + esc(base) + ":(\\d+)").exec(lines);
  return short ? +short[1] : undefined;
}

/** Jest `--json` and Vitest `--reporter=json` (same shape). */
export function parseJestJson(report: any): RawResult[] {
  const out: RawResult[] = [];
  for (const tr of report?.testResults ?? []) {
    const file: string = tr.name ?? tr.testFilePath;
    const asserts: any[] = tr.assertionResults ?? tr.testResults ?? [];
    for (const a of asserts) {
      const message = (a.failureMessages ?? []).join("\n") || undefined;
      out.push({
        file,
        suite: a.ancestorTitles ?? [],
        name: a.title,
        status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
        duration: typeof a.duration === "number" ? a.duration : undefined,
        message,
        line: a.status === "failed" ? failureLine(message, file) ?? a.location?.line : undefined,
      });
    }
    // The file itself failed (syntax error, import error): no assertions ran.
    if (!asserts.length && (tr.status === "failed" || tr.failureMessage || tr.message))
      out.push({ file, suite: [], name: "", status: "failed", message: tr.failureMessage || tr.message || "Test file failed to run" });
  }
  return out;
}

/** JUnit XML (node --test-reporter=junit, pytest --junitxml). `skipRoot` ignores a single wrapper suite. */
export function parseJunit(xml: string, skipRoot = false): RawResult[] {
  const out: RawResult[] = [];
  const suites: string[] = [];
  let cur: RawResult | null = null;
  let depth = 0;
  const re = /<(\/?)(testsuite|testcase|failure|error|skipped|system-out|system-err)\b([^>]*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m: RegExpExecArray | null;
  let textFrom = -1;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) continue;
    const [, close, tag, a, selfClose] = m;
    if (tag === "testsuite") {
      if (close) { suites.pop(); depth--; }
      else if (!selfClose) { depth++; suites.push(attrs(a).name ?? ""); }
      continue;
    }
    if (tag === "testcase") {
      if (close) { if (cur) out.push(cur); cur = null; continue; }
      const at = attrs(a);
      cur = {
        file: at.file,
        suite: (skipRoot ? suites.slice(1) : suites).filter(Boolean),
        name: at.name ?? "",
        status: "passed",
        duration: at.time ? Math.round(parseFloat(at.time) * 1000 * 10) / 10 : undefined,
        line: at.line ? +at.line + 1 : undefined,
        scope: at.classname,
      };
      if (selfClose) { out.push(cur); cur = null; }
      continue;
    }
    if (!cur) continue;
    if (tag === "skipped") { cur.status = "skipped"; if (!close && !selfClose) textFrom = re.lastIndex; continue; }
    if (tag === "failure" || tag === "error") {
      if (!close) {
        cur.status = "failed";
        cur.message = attrs(a).message ?? "";
        if (!selfClose) textFrom = re.lastIndex;
      } else if (textFrom >= 0) {
        let body = xml.slice(textFrom, m.index);
        body = body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
        body = decodeXml(body).trim();
        if (body) cur.message = cur.message && !body.includes(cur.message) ? `${cur.message}\n${body}` : body;
        textFrom = -1;
        cur.line = failureLine(cur.message, cur.file) ?? cur.line;
      }
    }
  }
  void depth;
  return out;
}

/** `go test -json` event stream. */
export function parseGoJson(text: string): RawResult[] {
  const out = new Map<string, RawResult & { output: string[] }>();
  const pkgOut = new Map<string, string[]>();
  const results: RawResult[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const key = `${e.Package}\u0000${e.Test ?? ""}`;
    if (!e.Test) {
      if (e.Action === "output") pkgOut.set(e.Package, [...(pkgOut.get(e.Package) ?? []), e.Output]);
      if (e.Action === "fail" && ![...out.values()].some((r) => r.scope === e.Package))
        results.push({ suite: [], name: "", status: "failed", scope: e.Package, message: (pkgOut.get(e.Package) ?? []).join("") || "Package failed" });
      continue;
    }
    let r = out.get(key);
    if (!r) { r = { suite: [], name: e.Test, status: "skipped", scope: e.Package, output: [] }; out.set(key, r); }
    if (e.Action === "output") r.output.push(e.Output);
    if (e.Action === "pass" || e.Action === "fail" || e.Action === "skip") {
      r.status = e.Action === "pass" ? "passed" : e.Action === "fail" ? "failed" : "skipped";
      if (typeof e.Elapsed === "number") r.duration = Math.round(e.Elapsed * 1000);
      if (r.status === "failed") {
        r.message = r.output.filter((o) => !/^(=== RUN|--- FAIL|=== PAUSE|=== CONT)/.test(o.trim())).join("").trim();
        const loc = r.message.match(/(\w+_test\.go):(\d+)/);
        if (loc) { r.line = +loc[2]; r.file = loc[1]; }
      }
    }
  }
  for (const r of out.values()) { const { output, ...rest } = r; void output; results.push(rest); }
  return results;
}

/** `cargo test` human output (stable toolchain has no JSON reporter). */
export function parseCargoTest(text: string): RawResult[] {
  const results: RawResult[] = [];
  let bin = "";
  const t = text.replace(/\r\n/g, "\n");
  const failures = new Map<string, string>();
  for (const m of t.matchAll(/^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- \S+ stdout ----$|^failures:$|^test result:)/gm)) failures.set(m[1], m[2].trim());
  for (const line of t.split("\n")) {
    const run = line.match(/^\s*Running (?:unittests )?(\S+)/);
    if (run) { bin = norm(run[1]); continue; }
    const m = line.match(/^test (\S+) \.\.\. (ok|FAILED|ignored)/);
    if (!m) continue;
    const parts = m[1].split("::");
    const status: TestStatus = m[2] === "ok" ? "passed" : m[2] === "FAILED" ? "failed" : "skipped";
    const message = status === "failed" ? failures.get(m[1]) ?? "" : undefined;
    const loc = message?.match(/panicked at ([^:\n]+\.rs):(\d+)/);
    results.push({ suite: parts.slice(0, -1), name: parts[parts.length - 1], status, scope: bin, message, line: loc ? +loc[2] : undefined, file: loc ? norm(loc[1]) : undefined });
  }
  return results;
}

/** Pulls expected/actual values out of common assertion messages, for the diff view. */
export function extractDiff(message: string | undefined): { expected: string; actual: string } | null {
  if (!message) return null;
  const pick = (re: RegExp) => message.match(re);
  let m = pick(/Expected:?\s*(.+)\n\s*Received:?\s*(.+)/);
  if (m) return { expected: m[1].trim(), actual: m[2].trim() };
  m = pick(/expected (.+?) to (?:be|equal|deeply equal|strictly equal|eql) (.+?)(?:\s+\/\/.*)?$/m);
  if (m) return { actual: m[1].trim(), expected: m[2].trim() };
  const a = pick(/^\s*actual: (.*?),?$/m), e = pick(/^\s*expected: (.*?),?$/m);
  if (a && e) return { actual: a[1].trim(), expected: e[1].trim() };
  m = pick(/^\s*left: (.*)\n\s*right: (.*)$/m);
  if (m) return { actual: m[1].trim(), expected: m[2].trim() };
  m = pick(/assert (.+?) == (.+?)$/m);
  if (m) return { actual: m[1].trim(), expected: m[2].trim() };
  return null;
}

// ----------------------------------------------------------------------------------------------
// Coverage
// ----------------------------------------------------------------------------------------------

const absolute = (p: string, root: string) => {
  const n = norm(p);
  if (/^[A-Za-z]:\//.test(n) || n.startsWith("/")) return n;
  return norm(root).replace(/\/+$/, "") + "/" + n.replace(/^\.\//, "");
};
const finish = (c: FileCoverage) => {
  const vals = Object.values(c.lines);
  c.total = vals.length;
  c.covered = vals.filter((v) => v > 0).length;
  return c;
};

export function parseLcov(text: string, root: string): Coverage {
  const cov: Coverage = {};
  let cur: FileCoverage | null = null;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith("SF:")) { cur = { lines: {}, covered: 0, total: 0 }; cov[absolute(l.slice(3), root)] = cur; }
    else if (l.startsWith("DA:") && cur) { const [ln, n] = l.slice(3).split(","); cur.lines[+ln] = Math.max(cur.lines[+ln] ?? 0, +n); }
    else if (l === "end_of_record" && cur) { finish(cur); cur = null; }
  }
  for (const c of Object.values(cov)) finish(c);
  return cov;
}

/** istanbul coverage-final.json (Vitest v8/istanbul, Jest). */
export function parseIstanbul(json: any, root: string): Coverage {
  const cov: Coverage = {};
  for (const [k, f] of Object.entries<any>(json ?? {})) {
    const c: FileCoverage = { lines: {}, covered: 0, total: 0 };
    for (const [id, loc] of Object.entries<any>(f.statementMap ?? {})) {
      const n = f.s?.[id] ?? 0;
      const ln = loc.start.line;
      c.lines[ln] = Math.max(c.lines[ln] ?? 0, n);
    }
    cov[absolute(f.path ?? k, root)] = finish(c);
  }
  return cov;
}

/** coverage.py `coverage json`. */
export function parseCoveragePy(json: any, root: string): Coverage {
  const cov: Coverage = {};
  for (const [p, f] of Object.entries<any>(json?.files ?? {})) {
    const c: FileCoverage = { lines: {}, covered: 0, total: 0 };
    for (const l of f.executed_lines ?? []) c.lines[l] = 1;
    for (const l of f.missing_lines ?? []) c.lines[l] = 0;
    cov[absolute(p, root)] = finish(c);
  }
  return cov;
}

/** `go test -coverprofile` (paths are import paths; `module` from go.mod maps them to `root`). */
export function parseGoCover(text: string, module: string, root: string): Coverage {
  const cov: Coverage = {};
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/);
    if (!m) continue;
    const rel = module && m[1].startsWith(module + "/") ? m[1].slice(module.length + 1) : m[1];
    const key = absolute(rel, root);
    const c = (cov[key] ??= { lines: {}, covered: 0, total: 0 });
    for (let ln = +m[2]; ln <= +m[3]; ln++) c.lines[ln] = Math.max(c.lines[ln] ?? 0, +m[4]);
  }
  for (const c of Object.values(cov)) finish(c);
  return cov;
}
