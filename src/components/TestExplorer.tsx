import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import {
  TestItem, Status, allTests, cancelRun, clearCoverage, clearResults, debugTest, discoverAll, fixWithAgent, runTests,
  runWithCoverage, statusOf, toggleCoverageOverlay, toggleWatch, useTesting,
} from "../lib/testing";
import { openFile } from "../lib/workspace";
import { relative } from "../lib/paths";

const ICON: Record<Status, string> = { passed: "pass-filled", failed: "error", skipped: "debug-step-over", running: "loading" };
export const statusIcon = (st: Status | undefined) => <i className={`codicon codicon-${st ? ICON[st] : "circle-large-outline"} test-icon test-${st ?? "none"}`} />;
const debuggable = (fw: string) => ["node", "jest", "vitest", "pytest"].includes(fw);
const pct = (c: { covered: number; total: number }) => (c.total ? Math.round((c.covered / c.total) * 1000) / 10 : 100);

/** "Testing" sidebar view. */
export default function TestExplorer() {
  const ws = useStore((s) => s.workspace);
  const { files, discovering, discovered, results, running, summary, coverage, showCoverage, watch, filter } = useTesting();
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => { if (ws && !discovered && !discovering) discoverAll(); }, [ws, discovered]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    const keep = (n: TestItem): TestItem | null => {
      if (n.label.toLowerCase().includes(q) || relative(ws, n.file).toLowerCase().includes(q) && n.kind === "file") return n;
      const kids = n.children.map(keep).filter(Boolean) as TestItem[];
      return kids.length ? { ...n, children: kids } : null;
    };
    return files.map(keep).filter(Boolean) as TestItem[];
  }, [files, filter, ws]);

  const total = files.reduce((n, f) => n + allTests(f).length, 0);
  const covFiles = Object.entries(coverage);
  const isOpen = (n: TestItem) => open[n.id] ?? (n.kind !== "file" || files.length <= 12 || statusOf(n, results) === "failed" || !!filter);

  const Row = ({ n, depth }: { n: TestItem; depth: number }) => {
    const st = statusOf(n, results);
    const r = results[n.id];
    const expandable = n.children.length > 0;
    const cov = n.kind === "file" ? coverage[n.file.toLowerCase()] : undefined;
    return (
      <>
        <div
          className={`tree-row test-row ${useTesting.getState().selected === n.id ? "selected" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={r?.message?.split("\n")[0] ?? (n.kind === "file" ? relative(ws, n.file) : n.path.join(" › "))}
          onClick={() => { if (expandable) setOpen((o) => ({ ...o, [n.id]: !isOpen(n) })); useTesting.setState({ selected: n.id }); }}
          onDoubleClick={() => openFile(n.file, n.line)}
        >
          {expandable ? <i className={`codicon codicon-chevron-${isOpen(n) ? "down" : "right"}`} /> : <span className="dbg-spacer" />}
          {statusIcon(st)}
          <span className="name">{n.kind === "file" ? relative(ws, n.file) : n.label}</span>
          {n.kind === "file" && <span className="muted small test-fw">{n.framework}</span>}
          {cov && <span className={`muted small test-cov ${pct(cov) >= 80 ? "good" : pct(cov) >= 50 ? "mid" : "bad"}`} title={`${cov.covered}/${cov.total} lines covered`}>{pct(cov)}%</span>}
          {r?.duration != null && n.kind === "test" && <span className="muted small test-dur">{r.duration} ms</span>}
          <span className="row-actions">
            {st === "failed" && n.kind === "test" && (
              <button title="Fix with Agent" onClick={(e) => { e.stopPropagation(); fixWithAgent(n); }}><i className="codicon codicon-sparkle" /></button>
            )}
            <button title="Run" disabled={running} onClick={(e) => { e.stopPropagation(); runTests([n]); }}><i className="codicon codicon-play" /></button>
            {debuggable(n.framework) && <button title="Debug" onClick={(e) => { e.stopPropagation(); debugTest(n); }}><i className="codicon codicon-debug-alt-small" /></button>}
            {n.kind === "file" && <button title="Run with Coverage" disabled={running} onClick={(e) => { e.stopPropagation(); runWithCoverage([n]); }}><i className="codicon codicon-run-coverage" /></button>}
            <button title="Go to Test" onClick={(e) => { e.stopPropagation(); openFile(n.file, n.line); }}><i className="codicon codicon-go-to-file" /></button>
          </span>
        </div>
        {expandable && isOpen(n) && n.children.map((c) => <Row key={c.id} n={c} depth={depth + 1} />)}
      </>
    );
  };

  return (
    <div className="panel test-explorer">
      <div className="panel-header">
        <span>TESTING</span>
        <div className="test-actions">
          {running
            ? <button className="icon-btn small" title="Cancel Test Run" onClick={cancelRun}><i className="codicon codicon-debug-stop" /></button>
            : <button className="icon-btn small" title="Run All Tests" onClick={() => runTests()}><i className="codicon codicon-run-all" /></button>}
          <button className="icon-btn small" title="Run All Tests with Coverage" disabled={running} onClick={() => runWithCoverage()}><i className="codicon codicon-run-all-coverage" /></button>
          <button className={`icon-btn small ${watch ? "on test-on" : ""}`} title={watch ? "Continuous Run: on (re-runs affected tests on save)" : "Continuous Run: off"} onClick={toggleWatch}><i className="codicon codicon-eye" /></button>
          <button className={`icon-btn small ${showCoverage && covFiles.length ? "on test-on" : ""}`} title="Toggle Coverage Overlay" onClick={toggleCoverageOverlay}><i className="codicon codicon-layers" /></button>
          <button className="icon-btn small" title="Refresh Tests" onClick={discoverAll}><i className={`codicon codicon-refresh ${discovering ? "spin" : ""}`} /></button>
          <button className="icon-btn small" title="Clear All Results" onClick={() => { clearResults(); clearCoverage(); }}><i className="codicon codicon-clear-all" /></button>
        </div>
      </div>
      <div className="test-filter">
        <input placeholder="Filter (e.g. text, file name)" value={filter} onChange={(e) => useTesting.setState({ filter: e.target.value })} />
      </div>
      <div className="test-summary muted small">
        {running ? <><i className="codicon codicon-loading spin" /> Running…</> : summary ? (
          <>
            <span className="test-passed">{summary.passed} passed</span>
            {summary.failed > 0 && <span className="test-failed"> · {summary.failed} failed</span>}
            {summary.skipped > 0 && <span> · {summary.skipped} skipped</span>}
            <span> · {(summary.duration / 1000).toFixed(1)} s</span>
          </>
        ) : discovering ? "Discovering tests…" : `${total} test${total === 1 ? "" : "s"} in ${files.length} file${files.length === 1 ? "" : "s"}`}
        {watch && <span className="test-watch"> · watching</span>}
      </div>
      <div className="tree test-tree">
        {!ws && <div className="muted small pad">Open a folder to discover tests.</div>}
        {ws && discovered && files.length === 0 && (
          <div className="muted small pad">
            No tests found. Supported: Vitest/Jest/node:test (*.test.ts, *.spec.js), pytest (test_*.py), cargo test (#[test]) and go test (*_test.go).
          </div>
        )}
        {shown.map((f) => <Row key={f.id} n={f} depth={0} />)}
        {covFiles.length > 0 && (
          <>
            <div className="section-title">COVERAGE <span className="muted">{pct(covFiles.reduce((a, [, c]) => ({ covered: a.covered + c.covered, total: a.total + c.total }), { covered: 0, total: 0 }))}% lines</span></div>
            {covFiles.sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => (
              <div key={p} className="tree-row test-row" style={{ paddingLeft: 12 }} onClick={() => openFile(p)} title={`${c.covered}/${c.total} lines`}>
                <span className="name">{relative(ws, p)}</span>
                <span className="test-cov-bar"><span style={{ width: `${pct(c)}%` }} /></span>
                <span className={`muted small test-cov ${pct(c) >= 80 ? "good" : pct(c) >= 50 ? "mid" : "bad"}`}>{pct(c)}%</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
