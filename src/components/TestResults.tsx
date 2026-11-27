import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { allTests, debugTest, fixWithAgent, itemById, runTests, useTesting } from "../lib/testing";
import { extractDiff } from "../lib/testParsers";
import { openDiff, openFile } from "../lib/workspace";
import { relative } from "../lib/paths";
import { statusIcon } from "./TestExplorer";

/** Bottom panel "TEST RESULTS": results list, failure details with expected/actual diff, raw output. */
export default function TestResults() {
  const ws = useStore((s) => s.workspace);
  const { files, results, output, summary, selected, running } = useTesting();
  const [view, setView] = useState<"details" | "output">("details");
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => { if (view === "output") box.current?.scrollTo({ top: box.current.scrollHeight }); }, [output, view]);

  const tests = files.flatMap(allTests).filter((t) => results[t.id] && !t.children.length);
  tests.sort((a, b) => (results[a.id].status === "failed" ? 0 : 1) - (results[b.id].status === "failed" ? 0 : 1));
  const sel = selected ? itemById(selected) : null;
  const r = sel ? results[sel.id] : undefined;
  const diff = r?.status === "failed" ? extractDiff(r.message) : null;

  return (
    <div className="test-results">
      <div className="tr-list">
        <div className="tr-head muted small">
          {running ? "Running…" : summary ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped` : "No test run yet"}
          <span className="tr-tabs">
            <button className={view === "details" ? "on" : ""} onClick={() => setView("details")}>Details</button>
            <button className={view === "output" ? "on" : ""} onClick={() => setView("output")}>Output</button>
          </span>
        </div>
        {tests.map((t) => (
          <div key={t.id} className={`tree-row ${t.id === selected ? "selected" : ""}`} onClick={() => { useTesting.setState({ selected: t.id }); setView("details"); }} onDoubleClick={() => openFile(t.file, results[t.id].line ?? t.line)}>
            {statusIcon(results[t.id].status)}
            <span className="name">{t.path.join(" › ")}</span>
            <span className="muted small ellipsis">{relative(ws, t.file)}</span>
            {results[t.id].duration != null && <span className="muted small">{results[t.id].duration} ms</span>}
          </div>
        ))}
      </div>
      {view === "output" || !sel ? (
        <pre className="tr-output" ref={box}>{output || "Run tests from the Testing view (beaker icon) or the ▶ Run lenses above each test."}</pre>
      ) : (
        <div className="tr-detail">
          <div className="tr-title">
            {statusIcon(r?.status)} <b>{sel.path.join(" › ") || sel.label}</b>
            <span className="muted small">{relative(ws, sel.file)}:{r?.line ?? sel.line}{r?.duration != null ? ` · ${r.duration} ms` : ""}</span>
          </div>
          <div className="tr-actions">
            <button className="btn small" disabled={running} onClick={() => runTests([sel])}><i className="codicon codicon-play" /> Run</button>
            {["node", "jest", "vitest", "pytest"].includes(sel.framework) && <button className="btn small" onClick={() => debugTest(sel)}><i className="codicon codicon-debug-alt-small" /> Debug</button>}
            <button className="btn small" onClick={() => openFile(sel.file, r?.line ?? sel.line)}><i className="codicon codicon-go-to-file" /> Go to</button>
            {r?.status === "failed" && <button className="btn primary small" onClick={() => fixWithAgent(sel)}><i className="codicon codicon-sparkle" /> Fix with Agent</button>}
            {diff && <button className="btn small" onClick={() => openDiff(sel.file + ".expected", diff.expected.replace(/\\n/g, "\n"), diff.actual.replace(/\\n/g, "\n"), "Expected")}><i className="codicon codicon-diff" /> Compare</button>}
          </div>
          {diff && (
            <div className="tr-diff">
              <div className="tr-exp"><span>Expected</span><code>{diff.expected}</code></div>
              <div className="tr-act"><span>Actual</span><code>{diff.actual}</code></div>
            </div>
          )}
          {r?.message ? <pre className="tr-msg">{r.message}</pre> : <div className="muted small pad">{r ? `Test ${r.status}.` : "Not run yet."}</div>}
        </div>
      )}
    </div>
  );
}
