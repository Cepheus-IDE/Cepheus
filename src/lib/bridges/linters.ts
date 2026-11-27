//! Extension bridges: linters (ESLint, Ruff, Stylelint, ShellCheck, markdownlint, Hadolint) run on
//! open and save, mapped to Monaco markers (owner "bridge:<tool>") and the Problems panel.

import { monaco } from "../monaco";
import { shellQuote } from "../procBus";
import { setExternalProblems, clearExternalProblems } from "../problems";
import { get, Problem } from "../../store";
import { BridgeDiag, LINT_PARSERS, LinterId, linterArgs } from "./core";
import { LINTERS } from "./registry";
import { activeLinterIds, lintKey, useBridgeRuntime } from "./state";
import { localWorkspace, resolveTool, runTool, ToolHandle } from "./tools";

const owner = (id: LinterId) => `bridge:${id}`;
const SEV = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info };
const runs = new Map<string, { timer: number; handle?: ToolHandle; token: number }>();
let token = 0;
/** Paths that currently have results, per linter (to clear them). */
const touched = new Map<LinterId, Set<string>>();

const norm = (p: string) => p.replace(/\\/g, "/");
function inWorkspace(path: string) {
  const ws = localWorkspace();
  return !!ws && norm(path).toLowerCase().startsWith(norm(ws).toLowerCase().replace(/\/?$/, "/"));
}
const modelFor = (path: string) => monaco.editor.getModels().find((m) => m.uri.scheme === "file" && norm(m.uri.fsPath).toLowerCase() === norm(path).toLowerCase());
/** Workspace spelling of a path (Problems groups by it). */
function fixCase(p: string) {
  const root = get().workspace ? norm(get().workspace!) : null;
  const n = norm(p);
  return root && n.toLowerCase().startsWith(root.toLowerCase()) ? root + n.slice(root.length) : n;
}

/** Applies results for one file: markers when it's open, Problems always. */
export function applyDiagnostics(id: LinterId, path: string, diags: BridgeDiag[]) {
  const p = fixCase(path);
  const model = modelFor(p);
  if (model) {
    monaco.editor.setModelMarkers(model, owner(id), diags.map((d) => ({
      startLineNumber: d.line, startColumn: d.col, endLineNumber: d.endLine, endColumn: d.endCol,
      severity: SEV[d.severity], message: d.message, source: LINTERS[id].name, code: d.code,
    })));
  }
  setExternalProblems(owner(id), p, diags.map((d): Problem => ({
    path: p, line: d.line, col: d.col, endLine: d.endLine, endCol: d.endCol, severity: d.severity,
    message: d.code ? `${d.message} (${d.code})` : d.message, source: LINTERS[id].name,
  })));
  const set = touched.get(id) ?? new Set<string>();
  if (diags.length) set.add(p); else set.delete(p);
  touched.set(id, set);
  useBridgeRuntime.setState((s) => {
    const lint = { ...s.lint };
    if (diags.length) lint[lintKey(id, p)] = diags.length; else delete lint[lintKey(id, p)];
    return { lint };
  });
}

function setError(id: LinterId, msg: string | null) {
  useBridgeRuntime.setState((s) => {
    const lintError = { ...s.lintError };
    if (msg) lintError[id] = msg; else delete lintError[id];
    return { lintError };
  });
}

async function runLinter(id: LinterId, path: string, my: number, slot: { handle?: ToolHandle; token: number }) {
  const tool = await resolveTool(LINTERS[id].tool, path);
  if (!tool) { setError(id, `${LINTERS[id].name} isn't installed for this project`); return; }
  const handle = runTool(tool.exe, () => linterArgs(id, path, shellQuote), { cwd: tool.cwd, file: path, mode: "none", timeoutMs: 30000 });
  slot.handle = handle;
  const r = await handle.done;
  if (slot.token !== my || r.code === null) return; // superseded or cancelled
  // Tools print results to stdout (stylelint ≥16 and markdownlint-cli2 to stderr).
  const text = id === "markdownlint" ? r.stdout + "\n" + r.stderr : r.stdout.trim() ? r.stdout : r.stderr;
  const diags = LINT_PARSERS[id](text, path);
  const looksLikeResult = diags.length > 0 || /^\s*\[/.test(r.stdout) || /^\s*\[/.test(r.stderr) || r.code === 0 || (id === "markdownlint" && r.code === 1);
  if (!looksLikeResult) {
    const msg = (r.stderr || r.stdout).trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(" ").slice(0, 300);
    setError(id, msg || `${LINTERS[id].name} exited with code ${r.code}`);
    return;
  }
  setError(id, null);
  applyDiagnostics(id, path, diags);
}

/** Lints a saved file with every active linter for its language (debounced, previous run cancelled). */
export function lintSoon(path: string, lang: string, delay = 400) {
  if (!inWorkspace(path)) return;
  for (const id of activeLinterIds()) {
    if (!LINTERS[id].languages.includes(lang)) continue;
    const key = lintKey(id, path);
    const prev = runs.get(key);
    if (prev) { clearTimeout(prev.timer); prev.handle?.kill(); }
    const slot: { timer: number; handle?: ToolHandle; token: number } = { timer: 0, token: ++token };
    slot.timer = window.setTimeout(() => {
      runLinter(id, path, slot.token, slot).catch((e) => setError(id, String(e?.message ?? e))).finally(() => { if (runs.get(key) === slot) runs.delete(key); });
    }, delay);
    runs.set(key, slot);
  }
}

/** Lints every open workspace file (after a linter is turned on or a folder opens). */
export function lintOpenModels() {
  for (const m of monaco.editor.getModels()) if (m.uri.scheme === "file") lintSoon(m.uri.fsPath, m.getLanguageId(), 200);
}

/** Removes a linter's markers and problems (turned off, or the folder closed). */
export function clearLinter(id: LinterId) {
  for (const [k, r] of runs) if (k.startsWith(id + "|")) { clearTimeout(r.timer); r.handle?.kill(); runs.delete(k); }
  for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, owner(id), []);
  clearExternalProblems(owner(id));
  touched.delete(id);
  setError(id, null);
  useBridgeRuntime.setState((s) => ({ lint: Object.fromEntries(Object.entries(s.lint).filter(([k]) => !k.startsWith(id + "|"))) }));
}
