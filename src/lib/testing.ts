//! Test Explorer core: discovers tests in the workspace (Vitest/Jest, node:test, pytest,
//! cargo test, go test), runs them through the backend process runner, maps runner reports back
//! onto the tree, collects coverage, re-runs on save (watch mode), debugs Node-based tests and
//! hands failures to the agent.

import { create } from "zustand";
import { api, errMsg } from "./api";
import { get as getApp, set as setApp, useStore, toast } from "../store";
import { runCommand, shellQuote, tempDir, RunHandle } from "./procBus";
import {
  Coverage, RawResult, SourceTest, discoverGo, discoverJs, discoverPython, discoverRust, parseCargoTest, parseCoveragePy,
  parseGoCover, parseGoJson, parseIstanbul, parseJestJson, parseJunit, parseLcov,
} from "./testParsers";
import { basename, dirname } from "./paths";

export type Framework = "vitest" | "jest" | "node" | "pytest" | "cargo" | "go";
export interface TestItem {
  id: string;
  label: string;
  kind: "file" | "suite" | "test";
  file: string;
  line: number;
  framework: Framework;
  /** Project root the runner runs in (package.json / Cargo.toml / go.mod / workspace). */
  root: string;
  /** Suite titles + test name. */
  path: string[];
  children: TestItem[];
  /** Created from a runner result (e.g. it.each, parametrized pytest) rather than source. */
  dynamic?: boolean;
}
export type Status = "passed" | "failed" | "skipped" | "running";
export interface TestResult { status: Status; duration?: number; message?: string; line?: number }
export interface RunSummary { passed: number; failed: number; skipped: number; duration: number; command: string; at: number }

interface TestingState {
  files: TestItem[];
  discovering: boolean;
  discovered: boolean;
  results: Record<string, TestResult>;
  running: boolean;
  output: string;
  summary: RunSummary | null;
  coverage: Coverage;
  showCoverage: boolean;
  watch: boolean;
  /** Test whose failure details are shown in the TEST RESULTS panel. */
  selected: string | null;
  filter: string;
}

export const useTesting = create<TestingState>(() => ({
  files: [],
  discovering: false,
  discovered: false,
  results: {},
  running: false,
  output: "",
  summary: null,
  coverage: {},
  showCoverage: true,
  watch: false,
  selected: null,
  filter: "",
}));
const tset = useTesting.setState;
const tget = useTesting.getState;

const norm = (p: string) => p.replace(/\\/g, "/");
const key = (p: string) => norm(p).toLowerCase();
const isWin = navigator.userAgent.includes("Windows");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

// ----------------------------------------------------------------------------------------------
// Discovery
// ----------------------------------------------------------------------------------------------

const JS_TEST = /(\.|_|-)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test(-[^/]*)?\.[cm]?js$/i;
const JS_ANY = /\.[cm]?[jt]sx?$/i;
const PY_TEST = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i;
const GO_TEST = /_test\.go$/i;
const SKIP_DIR = /\/(node_modules|\.git|target|dist|build|out|\.venv|venv|__pycache__|vendor|\.next|coverage)\//i;

/** Source text cache of test files (used to find tests affected by a saved file). */
const sources = new Map<string, string>();
const pkgCache = new Map<string, any | null>();

async function readJson(path: string) {
  const k = key(path);
  if (pkgCache.has(k)) return pkgCache.get(k);
  let v: any = null;
  try { v = JSON.parse(await api.readFile(path)); } catch { /* missing */ }
  pkgCache.set(k, v);
  return v;
}

/** Nearest ancestor directory (up to the workspace) containing `marker`. */
async function findUp(file: string, marker: string, ws: string): Promise<string | null> {
  let dir = norm(dirname(file));
  const top = key(ws);
  for (let i = 0; i < 30; i++) {
    if (await api.exists(dir + "/" + marker).catch(() => false)) return dir;
    if (key(dir) === top || !dir.includes("/")) return null;
    const up = dir.slice(0, dir.lastIndexOf("/"));
    if (!up || up === dir) return null;
    dir = up;
  }
  return null;
}

async function jsFramework(file: string, text: string, ws: string): Promise<{ fw: Framework; root: string }> {
  const root = (await findUp(file, "package.json", ws)) ?? norm(ws);
  if (/from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(text)) return { fw: "node", root };
  if (/from\s+['"]vitest['"]/.test(text)) return { fw: "vitest", root };
  const pkg = await readJson(root + "/package.json");
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (deps.vitest || /vitest/.test(pkg?.scripts?.test ?? "")) return { fw: "vitest", root };
  if (deps.jest || pkg?.jest || /jest/.test(pkg?.scripts?.test ?? "")) return { fw: "jest", root };
  return { fw: "node", root };
}

/** Rust module path of a file inside its crate (`src/a/b.rs` → `a::b::`). */
function rustModPrefix(file: string, crate: string): string {
  const rel = norm(file).slice(norm(crate).length + 1);
  if (!rel.startsWith("src/")) return "";
  const parts = rel.slice(4).replace(/\.rs$/, "").split("/");
  if (["lib", "main"].includes(parts[parts.length - 1]) && parts.length === 1) return "";
  if (parts[parts.length - 1] === "mod") parts.pop();
  if (parts[0] === "bin") return "";
  return parts.map((p) => p + "::").join("");
}

function toItems(nodes: SourceTest[], file: string, fw: Framework, root: string, prefix: string[], fileId: string): TestItem[] {
  return nodes.map((n) => {
    const path = [...prefix, n.name];
    return {
      id: `${fileId}::${path.join(" › ")}`,
      label: n.name,
      kind: n.kind,
      file,
      line: n.line,
      framework: fw,
      root,
      path,
      children: toItems(n.children, file, fw, root, path, fileId),
    };
  });
}

/** Discovers the tests of one file from its text (also used for open editors). */
export async function discoverFile(file: string, text: string, ws: string): Promise<TestItem | null> {
  const f = norm(file);
  let fw: Framework, root: string, nodes: SourceTest[];
  if (JS_ANY.test(f)) {
    if (!JS_TEST.test(f) && !(/\/(test|tests|__tests__)\//i.test(f) && /node:test|\b(describe|it|test)\s*\(/.test(text))) return null;
    ({ fw, root } = await jsFramework(f, text, ws));
    nodes = discoverJs(text);
  } else if (PY_TEST.test(f)) {
    fw = "pytest"; root = norm(ws); nodes = discoverPython(text);
  } else if (/\.rs$/i.test(f)) {
    if (!/#\[\s*(\w+::)*test/.test(text)) return null;
    fw = "cargo"; root = (await findUp(f, "Cargo.toml", ws)) ?? norm(ws); nodes = discoverRust(text);
  } else if (GO_TEST.test(f)) {
    fw = "go"; root = (await findUp(f, "go.mod", ws)) ?? norm(ws); nodes = discoverGo(text);
  } else return null;
  if (!nodes.length) return null;
  sources.set(key(f), text);
  const id = "f:" + key(f);
  return { id, label: basename(f), kind: "file", file: f, line: 1, framework: fw, root, path: [], children: toItems(nodes, f, fw, root, [], id) };
}

export async function discoverAll() {
  const ws = getApp().workspace;
  if (!ws || ws.startsWith("ssh://")) { tset({ files: [], discovered: true }); return; }
  tset({ discovering: true });
  pkgCache.clear();
  try {
    const all = (await api.listFiles(ws)).map(norm).filter((p) => !SKIP_DIR.test(p));
    const cand = all.filter((p) => JS_TEST.test(p) || PY_TEST.test(p) || GO_TEST.test(p) || (/\.rs$/i.test(p)) || (JS_ANY.test(p) && /\/(test|tests|__tests__)\//i.test(p)));
    const files: TestItem[] = [];
    for (const p of cand.slice(0, 3000)) {
      let text: string;
      try { text = await api.readFile(p); } catch { continue; }
      const item = await discoverFile(p, text, ws);
      if (item) files.push(item);
    }
    files.sort((a, b) => a.file.localeCompare(b.file));
    tset({ files, discovered: true });
  } catch (e) {
    toast(`Test discovery: ${errMsg(e)}`, "error");
  } finally {
    tset({ discovering: false });
  }
}

/** Refresh one file's entry (after save or editor change). */
export async function rediscover(file: string, text?: string) {
  const ws = getApp().workspace;
  if (!ws) return;
  const t = text ?? (await api.readFile(file).catch(() => ""));
  const item = await discoverFile(file, t, ws);
  const k = "f:" + key(file);
  const old = tget().files.find((f) => f.id === k);
  if (!item && !old) return;
  // Keep dynamic children created by earlier runs.
  if (item && old) for (const d of allTests(old).filter((x) => x.dynamic)) if (!findItem(item, d.id)) attachDynamic(item, d);
  const files = tget().files.filter((f) => f.id !== k);
  if (item) files.push(item);
  files.sort((a, b) => a.file.localeCompare(b.file));
  tset({ files });
}

export function allTests(n: TestItem): TestItem[] {
  return n.kind === "test" ? [n, ...n.children.flatMap(allTests)] : n.children.flatMap(allTests);
}
function findItem(n: TestItem, id: string): TestItem | null {
  if (n.id === id) return n;
  for (const c of n.children) { const r = findItem(c, id); if (r) return r; }
  return null;
}
export function itemById(id: string): TestItem | null {
  for (const f of tget().files) { const r = findItem(f, id); if (r) return r; }
  return null;
}
function attachDynamic(file: TestItem, d: TestItem) {
  let parent = file;
  for (const s of d.path.slice(0, -1)) {
    const next = parent.children.find((c) => c.kind === "suite" && c.label === s);
    if (!next) break;
    parent = next;
  }
  parent.children.push(d);
}

/** Aggregate status for files and suites. */
export function statusOf(n: TestItem, results: Record<string, TestResult>): Status | undefined {
  const own = results[n.id]?.status;
  if (n.kind === "test" && !n.children.length) return own;
  const st = n.children.map((c) => statusOf(c, results)).concat(own ? [own] : []);
  if (st.includes("running")) return "running";
  if (st.includes("failed")) return "failed";
  if (st.some((s) => s === "passed")) return "passed";
  if (st.length && st.every((s) => s === "skipped")) return "skipped";
  return undefined;
}

// ----------------------------------------------------------------------------------------------
// Running
// ----------------------------------------------------------------------------------------------

interface RunPlan { fw: Framework; root: string; items: TestItem[]; files: TestItem[] | null; pattern: string[] | null; exact: boolean }

let pythonCmd: Promise<string | null> | null = null;
function python(): Promise<string | null> {
  pythonCmd ??= (async () => {
    for (const py of isWin ? ["python", "py -3", "python3"] : ["python3", "python"]) {
      const r = await runCommand(`${py} -c "import sys; print(sys.version)"`, null).done;
      if (r.code === 0) return py;
    }
    return null;
  })();
  return pythonCmd.then((p) => { if (!p) pythonCmd = null; return p; });
}

async function goModule(root: string): Promise<string> {
  try { return (await api.readFile(root + "/go.mod")).match(/^module\s+(\S+)/m)?.[1] ?? ""; } catch { return ""; }
}

const rel = (root: string, p: string) => { const r = norm(root).replace(/\/+$/, ""); return key(p).startsWith(key(r) + "/") ? norm(p).slice(r.length + 1) : norm(p); };

/** Builds the shell command for a plan; returns the command plus how to read its results. */
async function buildCommand(plan: RunPlan, coverage: boolean, n: number) {
  const tmp = norm(await tempDir()) + "/cepheus-tests";
  await api.createDir(tmp).catch(() => {});
  const q = shellQuote;
  const out = `${tmp}/run-${n}`;
  const files = plan.files?.map((f) => rel(plan.root, f.file)) ?? [];
  const pat = plan.pattern;
  switch (plan.fw) {
    case "vitest": {
      const t = pat ? ["-t", q("^" + esc(pat.join(" ")) + (plan.exact ? "$" : ""))] : [];
      const cov = coverage ? ["--coverage.enabled=true", "--coverage.reporter=json", `--coverage.reportsDirectory=${q(out + "-cov")}`] : [];
      return { cmd: ["npx", "--no", "--", "vitest", "run", "--reporter=json", `--outputFile=${q(out + ".json")}`, ...cov, ...t, ...files.map(q)].join(" "), report: out + ".json", cov: coverage ? out + "-cov/coverage-final.json" : null };
    }
    case "jest": {
      const t = pat ? ["-t", q("^" + esc(pat.join(" ")) + (plan.exact ? "$" : ""))] : [];
      const cov = coverage ? ["--coverage", "--coverageReporters=json", `--coverageDirectory=${q(out + "-cov")}`] : [];
      return { cmd: ["npx", "--no", "--", "jest", "--json", `--outputFile=${q(out + ".json")}`, "--testLocationInResults", ...cov, ...t, ...(files.length ? ["--runTestsByPath", ...files.map(q)] : [])].join(" "), report: out + ".json", cov: coverage ? out + "-cov/coverage-final.json" : null };
    }
    case "node": {
      const t = pat ? [`--test-name-pattern=${q("^" + esc(pat.join(" ")) + (plan.exact ? "$" : ""))}`] : [];
      const cov = coverage ? ["--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${q(out + ".lcov")}`] : [];
      return { cmd: ["node", "--test", "--test-reporter=junit", `--test-reporter-destination=${q(out + ".xml")}`, "--test-reporter=spec", "--test-reporter-destination=stdout", ...cov, ...t, ...files.map(q)].join(" "), report: out + ".xml", cov: coverage ? out + ".lcov" : null };
    }
    case "pytest": {
      const py = await python();
      if (!py) throw new Error("Python was not found. Install Python 3 (python.org), then: python -m pip install pytest");
      // pytest node ids: path::Class::test (a suite id selects the whole class).
      const ids = plan.pattern
        ? plan.items.map((i) => q([rel(plan.root, i.file), ...i.path].join("::")))
        : plan.files ? plan.files.map((f) => q(rel(plan.root, f.file))) : [];
      const base = ["-m", "pytest", "-q", "-rA", "-o", "junit_family=xunit1", `--junitxml=${q(out + ".xml")}`, ...ids].join(" ");
      const cmd = coverage ? `${py} -m coverage run ${base} & ${py} -m coverage json -o ${q(out + "-cov.json")}` : `${py} ${base}`;
      return { cmd: coverage && !isWin ? cmd.replace(" & ", "; ") : cmd, report: out + ".xml", cov: coverage ? out + "-cov.json" : null };
    }
    case "cargo": {
      // Integration test files are their own test target; unit tests filter by module path.
      const one = plan.files?.length === 1 ? plan.files[0] : null;
      const integ = one && /\/tests\/[^/]+\.rs$/i.test(one.file) ? ["--test", basename(one.file).replace(/\.rs$/, "")] : [];
      const prefix = one ? modPrefixOf(one) : "";
      const filter = pat ? [q(prefix + pat.join("::")), ...(plan.exact ? ["--exact"] : [])] : prefix ? [q(prefix.replace(/::$/, ""))] : [];
      return { cmd: ["cargo", "test", ...integ, ...(filter.length ? ["--", ...filter] : [])].join(" "), report: null, cov: null };
    }
    case "go": {
      const pkgs = plan.files ? [...new Set(plan.files.map((f) => { const d = relDir(plan.root, f.file); return d === "." ? "." : "./" + d; }))] : ["./..."];
      const names = pat ? [pat[0]] : plan.files ? plan.files.flatMap((f) => f.children.map((c) => c.label)) : [];
      const run = names.length ? ["-run", q("^(" + names.map(esc).join("|") + ")$")] : [];
      const cov = coverage ? [`-coverprofile=${q(out + ".cov")}`] : [];
      return { cmd: ["go", "test", "-json", ...cov, ...run, ...pkgs.map(q)].join(" "), report: null, cov: coverage ? out + ".cov" : null };
    }
  }
}

/** Directory of `file` relative to `root` ("." for the root itself). */
const relDir = (root: string, file: string) => (key(dirname(file)) === key(norm(root).replace(/\/+$/, "")) ? "." : rel(root, dirname(file)));
const modPrefixOf = (i: TestItem) => (i.framework === "cargo" ? rustModPrefix(i.file, i.root) : "");

let runSeq = 0;
let active: RunHandle | null = null;
let cancelled = false;

export function appendOutput(text: string) {
  tset((s) => ({ output: (s.output + stripAnsi(text)).slice(-400_000) }));
}

/** Runs tests: everything, a file, a suite or a single test. */
export async function runTests(targets?: TestItem[], opts: { coverage?: boolean } = {}) {
  const ws = getApp().workspace;
  if (!ws) return toast("Open a folder first.", "error");
  if (ws.startsWith("ssh://")) return toast("Running tests is supported for local folders.", "error");
  if (tget().running) return toast("A test run is already in progress.");
  if (!tget().discovered) await discoverAll();
  const { saveAll } = await import("./workspace");
  await saveAll();
  const list = targets ?? tget().files;
  if (!list.length) return toast("No tests found. Test files look like *.test.ts, *.spec.js, test_*.py, *_test.go or Rust #[test] functions.");

  // One runner invocation per framework/root; single items keep their name filter.
  const plans: RunPlan[] = [];
  const whole = !targets;
  for (const it of list) {
    const file = it.kind === "file" ? it : tget().files.find((f) => f.id === "f:" + key(it.file));
    if (!file) continue;
    // Whole files (or everything) of the same runner share one invocation; suites/tests run alone.
    const p = it.kind === "file" && plans.find((x) => x.fw === it.framework && key(x.root) === key(it.root) && !x.pattern);
    if (p) { p.items.push(it); if (p.files) p.files.push(file); continue; }
    plans.push({
      fw: it.framework,
      root: it.root,
      items: [it],
      files: whole ? null : [file],
      pattern: it.kind === "file" ? null : it.path,
      exact: it.kind === "test",
    });
  }

  const affected = list.flatMap((x) => (x.kind === "test" ? [x, ...allTests(x)] : allTests(x)));
  tset((s) => {
    const results = { ...s.results };
    for (const t of affected) results[t.id] = { status: "running" };
    return { running: true, results, output: "", summary: null };
  });
  setApp({ panelOpen: true, panelTab: "tests" });
  cancelled = false;
  const started = Date.now();
  const cmds: string[] = [];
  const seen = new Set<string>();
  for (const plan of plans) {
    if (cancelled) break;
    try {
      const n = ++runSeq;
      const c = await buildCommand(plan, !!opts.coverage, n);
      cmds.push(c.cmd);
      appendOutput(`> ${c.cmd}\n  (in ${plan.root})\n\n`);
      active = runCommand(c.cmd, plan.root, { env: { FORCE_COLOR: "0", NO_COLOR: "1" }, onOutput: (d) => appendOutput(d) });
      const r = await active.done;
      active = null;
      let raw: RawResult[] = [];
      if (plan.fw === "vitest" || plan.fw === "jest") {
        const text = c.report ? await api.readFile(c.report).catch(() => "") : "";
        if (text) raw = parseJestJson(JSON.parse(text));
      } else if (plan.fw === "node" || plan.fw === "pytest") {
        const text = c.report ? await api.readFile(c.report).catch(() => "") : "";
        if (text) raw = parseJunit(text, plan.fw === "pytest");
      } else if (plan.fw === "cargo") raw = parseCargoTest(r.stdout + "\n" + r.stderr);
      else if (plan.fw === "go") raw = parseGoJson(r.stdout);
      if (c.report) api.remove(c.report).catch(() => {});
      const matched = await applyResults(plan, raw);
      matched.forEach((id) => seen.add(id));
      if (!raw.length && r.code !== 0) appendOutput(`\n${hintFor(plan.fw, r.stdout + r.stderr)}\n`);
      if (c.cov) await loadCoverage(plan, c.cov);
      appendOutput(`\n[exit code ${r.code ?? "?"}]\n\n`);
    } catch (e) {
      appendOutput(`\n${errMsg(e)}\n`);
      toast(errMsg(e), "error");
    }
  }
  // Tests that were queued but got no result (filtered out, runner crashed).
  tset((s) => {
    const results = { ...s.results };
    for (const t of affected) if (results[t.id]?.status === "running" && !seen.has(t.id)) delete results[t.id];
    const vals = affected.map((t) => results[t.id]?.status);
    const summary: RunSummary = {
      passed: vals.filter((v) => v === "passed").length,
      failed: vals.filter((v) => v === "failed").length,
      skipped: vals.filter((v) => v === "skipped").length,
      duration: Date.now() - started,
      command: cmds.join(" ; "),
      at: Date.now(),
    };
    const firstFail = affected.find((t) => results[t.id]?.status === "failed");
    return { running: false, results, summary, selected: firstFail?.id ?? s.selected };
  });
}

function hintFor(fw: Framework, out: string): string {
  if ((fw === "vitest" || fw === "jest") && /npm (ERR!|error)|could not determine executable|not found|canceled/i.test(out))
    return `${fw} is not installed in this project. Run: npm install -D ${fw}${fw === "vitest" ? " (and @vitest/coverage-v8 for coverage)" : ""}`;
  if (fw === "pytest" && /No module named pytest/i.test(out)) return "pytest is not installed. Run: python -m pip install pytest";
  if (fw === "pytest" && /No module named coverage/i.test(out)) return "coverage.py is not installed. Run: python -m pip install coverage";
  if (fw === "cargo" && /not recognized|not found/i.test(out)) return "cargo was not found. Install Rust from https://rustup.rs";
  if (fw === "go" && /not recognized|not found/i.test(out)) return "go was not found. Install Go from https://go.dev/dl";
  return "The runner produced no test results; see the output above.";
}

export function cancelRun() {
  cancelled = true;
  active?.kill();
}

/** Maps runner results onto tree items (adding dynamic items for unknown names). Returns matched ids. */
async function applyResults(plan: RunPlan, raw: RawResult[]): Promise<string[]> {
  const files = tget().files;
  const inRoot = files.filter((f) => f.framework === plan.fw && key(f.root) === key(plan.root));
  const goMod = plan.fw === "go" ? await goModule(plan.root) : "";
  const results = { ...tget().results };
  const matched: string[] = [];
  let changedTree = false;

  const fileFor = (r: RawResult): TestItem | undefined => {
    if (plan.fw === "go" && r.scope) {
      const dir = r.scope === goMod ? "" : r.scope.startsWith(goMod + "/") ? r.scope.slice(goMod.length + 1) : null;
      const inPkg = inRoot.filter((f) => dir !== null && key(relDir(plan.root, f.file)) === key(dir || "."));
      const pick = inPkg.find((f) => allTests(f).some((t) => t.label === r.name.split("/")[0])) ?? inPkg[0];
      if (pick) return pick;
    }
    if (r.file) {
      const k = key(r.file);
      return inRoot.find((f) => key(f.file) === k || key(f.file).endsWith("/" + k.replace(/^\.?\//, "")));
    }
    if (plan.fw === "cargo") {
      const full = [...r.suite, r.name].join("::");
      const integ = r.scope && /^tests\//.test(r.scope) ? r.scope : null;
      return inRoot.find((f) => (!integ || key(f.file).endsWith(key(integ))) && allTests(f).some((t) => rustModPrefix(t.file, t.root) + t.path.join("::") === full));
    }
    return undefined;
  };

  for (const r of raw) {
    const file = fileFor(r);
    if (!file) continue;
    if (!r.name) {
      // Whole file failed to load.
      for (const t of allTests(file)) { results[t.id] = { status: "failed", message: r.message }; matched.push(t.id); }
      continue;
    }
    let path = [...r.suite, r.name];
    if (plan.fw === "pytest") {
      const cls = r.scope?.split(".").pop() ?? "";
      path = file.children.some((c) => c.kind === "suite" && c.label === cls) ? [cls, r.name] : [r.name];
    }
    if (plan.fw === "cargo") {
      const full = [...r.suite, r.name].join("::");
      const pre = rustModPrefix(file.file, file.root);
      path = (full.startsWith(pre) ? full.slice(pre.length) : full).split("::");
    }
    if (plan.fw === "go") path = r.name.split("/");
    const tests = allTests(file);
    const want = path.join("\u0000");
    let item = tests.find((t) => t.path.join("\u0000") === want);
    // Parametrized variants (pytest `test_x[1]`, go subtests) roll up into the source test.
    const baseName = path[path.length - 1].replace(/\[.*\]$/, "");
    const parent = !item ? tests.find((t) => t.path.join("\u0000") === [...path.slice(0, -1), baseName].join("\u0000") || (plan.fw === "go" && t.label === path[0])) : undefined;
    if (!item) {
      const id = `${file.id}::${path.join(" › ")}`;
      item = itemById(id) ?? undefined;
      if (!item) {
        item = { id, label: path[path.length - 1], kind: "test", file: file.file, line: parent?.line ?? 1, framework: plan.fw, root: plan.root, path, children: [], dynamic: true };
        if (parent && parent.id !== id) parent.children.push(item);
        else attachDynamic(file, item);
        changedTree = true;
      }
    }
    const line = r.line && (!r.file || key(file.file).endsWith(key(basename(r.file)))) ? r.line : undefined;
    results[item.id] = { status: r.status, duration: r.duration, message: r.message ? stripAnsi(r.message) : undefined, line };
    matched.push(item.id);
    if (parent && parent.id !== item.id) {
      const prev = results[parent.id];
      if (r.status === "failed" || !prev || prev.status === "running") results[parent.id] = { ...results[item.id], line };
      matched.push(parent.id);
    }
  }
  tset({ results, ...(changedTree ? { files: [...files] } : {}) });
  return matched;
}

async function loadCoverage(plan: RunPlan, path: string) {
  let cov: Coverage = {};
  try {
    const text = await api.readFile(path);
    if (plan.fw === "node") cov = parseLcov(text, plan.root);
    else if (plan.fw === "go") cov = parseGoCover(text, await goModule(plan.root), plan.root);
    else if (plan.fw === "pytest") cov = parseCoveragePy(JSON.parse(text), plan.root);
    else cov = parseIstanbul(JSON.parse(text), plan.root);
  } catch {
    appendOutput(`\nNo coverage report was produced (${path}).${plan.fw === "vitest" ? " Install @vitest/coverage-v8." : plan.fw === "pytest" ? " Install coverage: python -m pip install coverage" : ""}\n`);
    return;
  }
  const n = Object.keys(cov).length;
  appendOutput(`\nCoverage: ${n} file${n === 1 ? "" : "s"}\n`);
  tset((s) => ({ coverage: { ...s.coverage, ...Object.fromEntries(Object.entries(cov).map(([k, v]) => [key(k), v])) }, showCoverage: true }));
}

export const runWithCoverage = (targets?: TestItem[]) => runTests(targets, { coverage: true });

/** The current editor's file entry (discovered from its text if needed, then added to the tree). */
async function currentFileItem(): Promise<TestItem | null> {
  const { editorRef } = await import("./ai");
  const m = editorRef.current?.getModel();
  const ws = getApp().workspace;
  if (!m || m.uri.scheme !== "file" || !ws) return null;
  const item = await discoverFile(m.uri.fsPath, m.getValue(), ws);
  if (item) tset((s) => ({ files: [...s.files.filter((f) => f.id !== item.id), item].sort((a, b) => a.file.localeCompare(b.file)) }));
  return item;
}

export async function runCurrentFile() {
  const f = await currentFileItem();
  if (!f) return toast("The current file has no tests.");
  runTests([f]);
}

/** Innermost test or suite whose declaration is at or above the cursor. */
export async function runAtCursor(debug: boolean) {
  const { editorRef } = await import("./ai");
  const line = editorRef.current?.getPosition()?.lineNumber ?? 1;
  const f = await currentFileItem();
  if (!f) return toast("The current file has no tests.");
  let best: TestItem | null = null;
  const walk = (n: TestItem) => { for (const c of n.children) if (!c.dynamic && c.line <= line) { best = c; walk(c); } };
  walk(f);
  const t: TestItem = best ?? f;
  return debug ? debugTest(t) : runTests([t]);
}
export const clearCoverage = () => tset({ coverage: {} });
export const toggleCoverageOverlay = () => tset((s) => ({ showCoverage: !s.showCoverage }));
export const clearResults = () => tset({ results: {}, summary: null, output: "", selected: null });

// ----------------------------------------------------------------------------------------------
// Debug a test (Node-based runners use the Node debugger; pytest uses debugpy)
// ----------------------------------------------------------------------------------------------

export async function debugTest(item: TestItem) {
  const { startDebugging, useDebug } = await import("./debugger");
  if (useDebug.getState().status !== "idle") return toast("A debug session is already running.", "error");
  const file = rel(item.root, item.file);
  const q = shellQuote;
  const pattern = item.kind === "file" ? null : "^" + esc(item.path.join(" ")) + (item.kind === "test" ? "$" : "");
  const name = `Debug Test: ${item.path.join(" › ") || item.label}`;
  const brk = "--inspect-brk=127.0.0.1:0";
  let command: string;
  switch (item.framework) {
    case "node":
      command = ["node", brk, "--test", "--test-isolation=none", ...(pattern ? [`--test-name-pattern=${q(pattern)}`] : []), q(file)].join(" ");
      break;
    case "jest":
      command = ["node", brk, q(norm(item.root) + "/node_modules/jest/bin/jest.js"), "--runInBand", ...(pattern ? ["-t", q(pattern)] : []), "--runTestsByPath", q(file)].join(" ");
      break;
    case "vitest":
      command = ["npx", "--no", "--", "vitest", "run", brk, "--no-file-parallelism", ...(pattern ? ["-t", q(pattern)] : []), q(file)].join(" ");
      break;
    case "pytest":
      return startDebugging({ type: "python", request: "launch", name, module: "pytest", args: ["-q", [file, ...item.path].join("::")], cwd: item.root, console: "internalConsole", justMyCode: false });
    default:
      return toast(`Debugging ${item.framework} tests is not supported yet; use Run.`, "error");
  }
  return startDebugging({ type: "node", request: "launch", name, command, cwd: item.root });
}

// ----------------------------------------------------------------------------------------------
// Fix with agent
// ----------------------------------------------------------------------------------------------

export async function fixWithAgent(item: TestItem) {
  const r = tget().results[item.id];
  const ws = getApp().workspace;
  const { newSession, sendMessage } = await import("./agent");
  const where = `${rel(ws ?? "", item.file)}${r?.line ? `:${r.line}` : `:${item.line}`}`;
  const cmd = tget().summary?.command ?? "";
  const prompt = [
    `The test "${item.path.join(" › ") || item.label}" (${item.framework}) in ${where} is failing.`,
    "",
    "Failure output:",
    "```",
    (r?.message ?? "(no message)").slice(0, 8000),
    "```",
    cmd ? `It was run with: \`${cmd}\` (in ${rel(ws ?? "", item.root) || "."})` : "",
    "",
    "Find the root cause and fix it. Fix the code under test unless the test itself is clearly wrong. Then run the test again to confirm it passes.",
  ].filter((l) => l !== null).join("\n");
  const sess = newSession(true);
  setApp({ agentOpen: true, view: "editor" });
  await sendMessage(sess.id, prompt, null);
}

// ----------------------------------------------------------------------------------------------
// Watch mode (continuous run) + keeping discovery fresh on save
// ----------------------------------------------------------------------------------------------

export function toggleWatch() {
  const on = !tget().watch;
  tset({ watch: on });
  toast(on ? "Continuous run on: affected tests re-run when you save." : "Continuous run off.");
}

/** Test files affected by a change to `path`: itself, or test files that import it. */
function affectedBy(path: string): TestItem[] {
  const k = key(path);
  const files = tget().files;
  const self = files.find((f) => f.id === "f:" + k);
  if (self) return [self];
  const stem = basename(path).replace(/\.[^.]+$/, "");
  const ext = (path.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  if (/^(rs)$/.test(ext)) return files.filter((f) => f.framework === "cargo" && k.startsWith(key(f.root) + "/"));
  if (ext === "go") return files.filter((f) => f.framework === "go" && key(dirname(f.file)) === key(dirname(path)));
  const re = ext === "py"
    ? new RegExp(`^\\s*(from\\s+[\\w.]*\\b${esc(stem)}\\b|import\\s+[\\w.]*\\b${esc(stem)}\\b)`, "m")
    : new RegExp(`(from|require\\(|import\\()\\s*['"][^'"]*\\b${esc(stem)}(\\.[cm]?[jt]sx?)?['"]`);
  return files.filter((f) => re.test(sources.get(key(f.file)) ?? ""));
}

let pendingSaved = new Set<string>();
let saveTimer = 0;
function onSaved(path: string) {
  if (/[\\/]\.(vscode|cepheus)[\\/]launch\.json$/i.test(path)) import("./debugger").then((d) => d.refreshConfigs());
  if (tget().discovered) rediscover(path);
  if (!tget().watch) return;
  pendingSaved.add(path);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const paths = [...pendingSaved];
    pendingSaved = new Set();
    // Wait for rediscovery of saved test files, then run what they affect.
    setTimeout(() => {
      const targets = new Map<string, TestItem>();
      for (const p of paths) for (const f of affectedBy(p)) targets.set(f.id, f);
      if (targets.size && !tget().running) runTests([...targets.values()]);
    }, 200);
  }, 400);
}

let prevDirty: Record<string, boolean> = {};
let prevWs: string | null = null;
useStore.subscribe((s) => {
  if (s.dirty !== prevDirty) {
    for (const [p, d] of Object.entries(prevDirty)) if (d && s.dirty[p] === false) onSaved(p);
    prevDirty = s.dirty;
  }
  if (s.workspace !== prevWs) {
    prevWs = s.workspace;
    sources.clear();
    tset({ files: [], results: {}, coverage: {}, discovered: false, summary: null, output: "", selected: null });
  }
});
