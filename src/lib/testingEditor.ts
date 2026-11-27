//! Test Explorer inside the editor: "Run | Debug" CodeLens above each test, pass/fail glyphs,
//! failure squiggles + inline messages at the assertion line, and the coverage overlay.

import { monaco } from "./monaco";
import { get as getApp } from "../store";
import { TestItem, allTests, debugTest, discoverFile, runTests, statusOf, useTesting } from "./testing";

const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const LANGS = ["javascript", "typescript", "python", "rust", "go"];
const OWNER = "cepheus-tests";

/** The file's test tree: from the explorer when known, else discovered from the editor text. */
async function fileItem(model: monaco.editor.ITextModel): Promise<TestItem | null> {
  const ws = getApp().workspace;
  if (!ws || model.uri.scheme !== "file") return null;
  const path = model.uri.fsPath;
  const known = useTesting.getState().files.find((f) => f.id === "f:" + key(path));
  if (known) return known;
  return discoverFile(path, model.getValue(), ws);
}

/** Adds a file discovered from an editor to the explorer so it can be run. */
function ensureInTree(file: TestItem) {
  const s = useTesting.getState();
  if (s.files.some((f) => f.id === file.id)) return;
  useTesting.setState({ files: [...s.files, file].sort((a, b) => a.file.localeCompare(b.file)) });
}

let registered = false;
const lensChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();

function register() {
  if (registered) return;
  registered = true;
  monaco.editor.registerCommand("cepheus.test.run", (_a, item: TestItem, file: TestItem) => { ensureInTree(file); runTests([item]); });
  monaco.editor.registerCommand("cepheus.test.debug", (_a, item: TestItem, file: TestItem) => { ensureInTree(file); debugTest(item); });
  monaco.editor.registerCommand("cepheus.test.show", (_a, id: string) => {
    useTesting.setState({ selected: id });
    import("../store").then(({ set }) => set({ panelOpen: true, panelTab: "tests" }));
  });
  const provider: monaco.languages.CodeLensProvider = {
    onDidChange: lensChanged.event,
    async provideCodeLenses(model) {
      const file = await fileItem(model);
      if (!file) return { lenses: [], dispose() {} };
      const results = useTesting.getState().results;
      const lenses: monaco.languages.CodeLens[] = [];
      const walk = (n: TestItem) => {
        if (n.kind !== "file" && !n.dynamic) {
          const range = new monaco.Range(n.line, 1, n.line, 1);
          const st = statusOf(n, results);
          const r = results[n.id];
          const prefix = st === "passed" ? "✓ " : st === "failed" ? "✗ " : st === "running" ? "⟳ " : "";
          const what = n.kind === "suite" ? "Run Suite" : "Run Test";
          lenses.push({ range, command: { id: "cepheus.test.run", title: `${prefix}▶ ${what}`, arguments: [n, file] } });
          if (["node", "jest", "vitest", "pytest"].includes(n.framework)) lenses.push({ range, command: { id: "cepheus.test.debug", title: "Debug", arguments: [n, file] } });
          if (st === "failed" && n.kind === "test") lenses.push({ range, command: { id: "cepheus.test.show", title: "Show Failure", arguments: [n.id] } });
          else if (r?.duration != null && n.kind === "test") lenses.push({ range, command: { id: "", title: `${r.duration} ms` } });
        }
        n.children.forEach(walk);
      };
      walk(file);
      return { lenses, dispose() {} };
    },
  };
  for (const l of LANGS) monaco.languages.registerCodeLensProvider(l, provider);

  // Failure squiggles on every open model.
  const syncMarkers = () => {
    const s = useTesting.getState();
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme !== "file") continue;
      const f = s.files.find((x) => x.id === "f:" + key(m.uri.fsPath));
      const markers: monaco.editor.IMarkerData[] = [];
      for (const t of f ? allTests(f) : []) {
        const r = s.results[t.id];
        if (r?.status !== "failed") continue;
        const line = Math.min(Math.max(1, r.line ?? t.line), m.getLineCount());
        const text = m.getLineContent(line);
        const start = text.length - text.trimStart().length + 1;
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `${t.path.join(" › ")}: ${(r.message ?? "failed").slice(0, 1500)}`,
          startLineNumber: line, startColumn: start, endLineNumber: line, endColumn: Math.max(start + 1, text.length + 1),
          source: "tests",
        });
      }
      monaco.editor.setModelMarkers(m, OWNER, markers);
    }
  };
  let t = 0;
  useTesting.subscribe((s, prev) => {
    if (s.results === prev.results && s.files === prev.files) return;
    clearTimeout(t);
    t = window.setTimeout(() => { syncMarkers(); lensChanged.fire(provider); }, 120);
  });
  monaco.editor.onDidCreateModel(() => setTimeout(syncMarkers, 50));
}

export function attachTestingEditor(ed: monaco.editor.IStandaloneCodeEditor) {
  register();
  const deco = ed.createDecorationsCollection();
  const render = () => {
    const model = ed.getModel();
    if (!model || model.uri.scheme !== "file") return deco.clear();
    const s = useTesting.getState();
    const k = key(model.uri.fsPath);
    const file = s.files.find((f) => f.id === "f:" + k);
    const out: monaco.editor.IModelDeltaDecoration[] = [];
    const n = model.getLineCount();
    if (file) {
      const walk = (it: TestItem) => {
        if (it.kind !== "file" && !it.dynamic && it.line <= n) {
          const st = statusOf(it, s.results);
          if (st) out.push({
            range: new monaco.Range(it.line, 1, it.line, 1),
            options: {
              glyphMarginClassName: `codicon test-glyph test-${st} codicon-${st === "passed" ? "pass-filled" : st === "failed" ? "error" : st === "running" ? "loading" : "debug-step-over"}`,
              glyphMarginHoverMessage: { value: `${it.label}: ${st}${s.results[it.id]?.duration != null ? ` (${s.results[it.id]!.duration} ms)` : ""}` },
            },
          });
        }
        const r = s.results[it.id];
        if (it.kind === "test" && r?.status === "failed" && r.message) {
          const line = Math.min(Math.max(1, r.line ?? it.line), n);
          const col = model.getLineMaxColumn(line);
          const first = r.message.split("\n").find((l) => l.trim())?.trim() ?? "failed";
          out.push({ range: new monaco.Range(line, col, line, col), options: { after: { content: `   ✗ ${first.slice(0, 120)}`, inlineClassName: "test-inline-fail" }, showIfCollapsed: true } });
        }
        it.children.forEach(walk);
      };
      walk(file);
    }
    const cov = s.showCoverage ? s.coverage[k] : undefined;
    if (cov) {
      for (const [l, c] of Object.entries(cov.lines)) {
        const line = +l;
        if (line < 1 || line > n) continue;
        out.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: c > 0 ? "cov-hit" : "cov-miss",
            linesDecorationsClassName: c > 0 ? "cov-bar-hit" : "cov-bar-miss",
            overviewRuler: c > 0 ? undefined : { color: "#f1485b88", position: monaco.editor.OverviewRulerLane.Left },
          },
        });
      }
    }
    deco.set(out);
  };
  const unsub = useTesting.subscribe(render);
  const sub = ed.onDidChangeModel(render);
  render();
  return () => { unsub(); sub.dispose(); deco.clear(); };
}

