import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import {
  addWatch, clearBreakpoints, clearWatches, editWatch, evaluate, loadVariables, pause, refreshConfigs, removeWatch,
  restartDebugging, resume, selectConfig, selectFrame, setAllBreakpointsEnabled, startDebugging, stepInto, stepOut,
  stepOver, stopDebugging, toggleBreakpoint, toggleBreakpointsActive, updateBreakpoint, useDebug, Breakpoint, EvalResult, Variable,
} from "../lib/debugger";
import { addConfiguration } from "../lib/launch";
import { openFile } from "../lib/workspace";
import { basename, relative } from "../lib/paths";
import { editorRef } from "../lib/ai";

/** Run and Debug sidebar: configuration picker, toolbar, variables, watch, call stack, breakpoints. */
export default function DebugPanel() {
  const ws = useStore((s) => s.workspace);
  const activePath = useStore((s) => s.tabs.find((t) => t.id === s.activeId && t.kind === "file")?.path);
  const { status, file, frames, frameIndex, vars, breakpoints, breakpointsActive, configs, selectedConfig, sessionName } = useDebug();
  const frame = frames[frameIndex];
  const target = file ?? activePath;

  useEffect(() => { refreshConfigs(); }, [ws]);

  const canRunFile = !!activePath && /\.(m?[jt]s|c[jt]s|[jt]sx|py)$/i.test(activePath);
  const allBps = Object.entries(breakpoints).flatMap(([p, l]) => l.map((b) => ({ p, b })));

  return (
    <div className="panel debug-panel">
      <div className="panel-header"><span>RUN AND DEBUG</span></div>
      <div className="debug-config">
        <button
          className="icon-btn"
          title={status === "idle" ? "Start Debugging (F5)" : status === "paused" ? "Continue (F5)" : "Running"}
          disabled={status === "starting" || status === "running"}
          onClick={() => (status === "paused" ? resume() : startDebugging())}
        >
          <i className="codicon codicon-debug-start" />
        </button>
        <select value={selectedConfig} onChange={(e) => selectConfig(e.target.value)} title="Launch configuration">
          <option value="">{activePath ? `Current file (${basename(activePath)})` : "Current file"}</option>
          {configs.map((c) => <option key={c.name + c.source} value={c.name}>{c.name}</option>)}
        </select>
        <button className="icon-btn" title="Open or add launch.json (Add Configuration…)" onClick={addConfiguration}><i className="codicon codicon-gear" /></button>
        <button className="icon-btn" title="Reload configurations" onClick={refreshConfigs}><i className="codicon codicon-refresh" /></button>
      </div>
      {status === "idle" ? (
        <div className="debug-start">
          <button className="btn primary" onClick={() => startDebugging()}>
            <i className="codicon codicon-debug-alt" /> Run and Debug
          </button>
          <div className="muted small">
            {selectedConfig
              ? <>Runs the <b>{selectedConfig}</b> configuration (F5).</>
              : canRunFile
                ? <>Runs <b>{basename(activePath!)}</b> (F5): JavaScript/TypeScript with Node.js, Python with debugpy. Click the gutter to add a breakpoint (F9); right-click it for conditions and logpoints.</>
                : "Open a .js, .ts or .py file and press F5, or use the gear to create .vscode/launch.json."}
          </div>
        </div>
      ) : (
        <div className="debug-toolbar">
          {status === "paused"
            ? <button title="Continue (F5)" onClick={resume}><i className="codicon codicon-debug-continue" /></button>
            : <button title="Pause (F6)" onClick={pause} disabled={status !== "running"}><i className="codicon codicon-debug-pause" /></button>}
          <button title="Step Over (F10)" disabled={status !== "paused"} onClick={stepOver}><i className="codicon codicon-debug-step-over" /></button>
          <button title="Step Into (F11)" disabled={status !== "paused"} onClick={stepInto}><i className="codicon codicon-debug-step-into" /></button>
          <button title="Step Out (Shift+F11)" disabled={status !== "paused"} onClick={stepOut}><i className="codicon codicon-debug-step-out" /></button>
          <button title="Restart (Ctrl+Shift+F5)" onClick={restartDebugging}><i className="codicon codicon-debug-restart" /></button>
          <button title="Stop (Shift+F5)" className="stop" onClick={stopDebugging}><i className="codicon codicon-debug-stop" /></button>
          <span className="muted small ellipsis" title={sessionName}>{status === "paused" ? "Paused" : status === "starting" ? "Starting…" : "Running"} · {target ? basename(target) : sessionName}</span>
        </div>
      )}

      <div className="tree debug-sections">
        <div className="section-title">VARIABLES</div>
        {status !== "paused" && <div className="muted small pad">{status === "idle" ? "Not debugging." : "Variables appear when execution pauses."}</div>}
        {frame?.scopes.map((s, i) => (
          <Scope key={s.objectId + i} name={s.type[0].toUpperCase() + s.type.slice(1)} objectId={s.objectId} vars={vars[s.objectId]} defaultOpen={i < 2 && !s.expensive} />
        ))}

        <WatchSection />

        <div className="section-title">CALL STACK</div>
        {frames.length === 0 && <div className="muted small pad">—</div>}
        {frames.map((f, i) => (
          <div key={f.id + i} className={`tree-row dbg-frame ${i === frameIndex ? "selected" : ""}`} onClick={() => selectFrame(i)}>
            <span className="name">{f.name}</span>
            <span className="muted small ellipsis">{f.path ? `${basename(f.path)}:${f.line}` : ""}</span>
          </div>
        ))}

        <div className="section-title">
          BREAKPOINTS
          <span className="section-actions">
            <button className="icon-btn small" title="Toggle Breakpoint at Cursor (F9)" onClick={() => {
              const m = editorRef.current?.getModel(); const p = editorRef.current?.getPosition();
              if (m && p && m.uri.scheme === "file") toggleBreakpoint(m.uri.fsPath, p.lineNumber);
            }}><i className="codicon codicon-add" /></button>
            <button className={`icon-btn small ${breakpointsActive ? "" : "on"}`} title={breakpointsActive ? "Deactivate Breakpoints" : "Activate Breakpoints"} onClick={toggleBreakpointsActive}>
              <i className="codicon codicon-debug-breakpoint-unsupported" />
            </button>
            {allBps.length > 0 && (
              <button className="icon-btn small" title={allBps.every((x) => x.b.enabled) ? "Disable All Breakpoints" : "Enable All Breakpoints"} onClick={() => setAllBreakpointsEnabled(!allBps.every((x) => x.b.enabled))}>
                <i className="codicon codicon-check-all" />
              </button>
            )}
            {allBps.length > 0 && <button className="icon-btn small" title="Remove All Breakpoints" onClick={clearBreakpoints}><i className="codicon codicon-close-all" /></button>}
          </span>
        </div>
        {!breakpointsActive && allBps.length > 0 && <div className="muted small pad">Breakpoints are deactivated.</div>}
        {allBps.map(({ p, b }) => <BreakpointRow key={p + b.line} path={p} bp={b} ws={ws} active={breakpointsActive} />)}
        {allBps.length === 0 && <div className="muted small pad">Click in the gutter to add one; right-click for conditional breakpoints and logpoints.</div>}
      </div>
    </div>
  );
}

function BreakpointRow({ path, bp, ws, active }: { path: string; bp: Breakpoint; ws: string | null; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const detail = bp.logMessage ? `log: ${bp.logMessage}` : [bp.condition, bp.hitCondition && `hits ${bp.hitCondition}`].filter(Boolean).join(" · ");
  return (
    <>
      <div className={`tree-row dbg-bp-row ${bp.enabled && active ? "" : "off"}`} onClick={() => openFile(path, bp.line)}>
        <input type="checkbox" checked={bp.enabled} title={bp.enabled ? "Disable" : "Enable"} onClick={(e) => e.stopPropagation()} onChange={() => updateBreakpoint(path, bp.line, { enabled: !bp.enabled })} />
        <span className={`dbg-bp-dot ${bp.logMessage ? "log" : bp.condition || bp.hitCondition ? "cond" : ""}`} />
        <span className="name">{basename(path)}</span>
        <span className="muted small ellipsis" title={detail}>{ws ? relative(ws, path) : path}:{bp.line}{detail ? `  ${detail}` : ""}</span>
        <span className="row-actions">
          <button title="Edit Condition / Logpoint" onClick={(e) => { e.stopPropagation(); setEditing(!editing); }}><i className="codicon codicon-edit" /></button>
          <button title="Remove Breakpoint" onClick={(e) => { e.stopPropagation(); toggleBreakpoint(path, bp.line); }}><i className="codicon codicon-close" /></button>
        </span>
      </div>
      {editing && <BreakpointEditor path={path} bp={bp} done={() => setEditing(false)} />}
    </>
  );
}

function BreakpointEditor({ path, bp, done }: { path: string; bp: Breakpoint; done: () => void }) {
  const [cond, setCond] = useState(bp.condition ?? "");
  const [hit, setHit] = useState(bp.hitCondition ?? "");
  const [msg, setMsg] = useState(bp.logMessage ?? "");
  const save = () => { updateBreakpoint(path, bp.line, { condition: cond.trim(), hitCondition: hit.trim(), logMessage: msg.trim() }); done(); };
  const key = (e: React.KeyboardEvent) => { if (e.key === "Enter") save(); if (e.key === "Escape") done(); };
  return (
    <div className="dbg-bp-edit">
      <input autoFocus placeholder="Condition (expression)" value={cond} onChange={(e) => setCond(e.target.value)} onKeyDown={key} />
      <input placeholder="Hit count (5, >= 5, % 3)" value={hit} onChange={(e) => setHit(e.target.value)} onKeyDown={key} />
      <input placeholder="Log message — makes it a logpoint; {expr} is interpolated" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={key} />
      <div className="row"><button className="btn primary small" onClick={save}>Save</button><button className="btn small" onClick={done}>Cancel</button></div>
    </div>
  );
}

function WatchSection() {
  const watches = useDebug((s) => s.watches);
  const values = useDebug((s) => s.watchValues);
  const status = useDebug((s) => s.status);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      <div className="section-title">
        WATCH
        <span className="section-actions">
          <button className="icon-btn small" title="Add Expression" onClick={() => setAdding(true)}><i className="codicon codicon-add" /></button>
          {watches.length > 0 && <button className="icon-btn small" title="Remove All Expressions" onClick={clearWatches}><i className="codicon codicon-close-all" /></button>}
        </span>
      </div>
      {watches.map((w) =>
        editing === w ? (
          <WatchInput key={w} initial={w} onDone={(v) => { if (v !== null) editWatch(w, v); setEditing(null); }} />
        ) : (
          <WatchRow key={w} expr={w} value={values[w]} paused={status === "paused"} onEdit={() => setEditing(w)} />
        ),
      )}
      {adding && <WatchInput initial="" onDone={(v) => { if (v) addWatch(v); setAdding(false); }} />}
      {watches.length === 0 && !adding && <div className="muted small pad">No watch expressions. Click + to add one.</div>}
    </>
  );
}

function WatchInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => { if (!done.current) { done.current = true; onDone(x); } };
  return (
    <div className="tree-row dbg-watch-input">
      <input autoFocus value={v} placeholder="Expression to watch" onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(null); }}
        onBlur={() => finish(v)} />
    </div>
  );
}

function WatchRow({ expr, value, paused, onEdit }: { expr: string; value?: EvalResult; paused: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const children = useDebug((s) => (value?.objectId ? s.vars[value.objectId] : undefined));
  const shown = !paused ? "not available" : value ? value.value : "…";
  return (
    <>
      <div className="tree-row dbg-var" style={{ paddingLeft: 8 }} onDoubleClick={onEdit}
        onClick={() => { if (value?.objectId) { setOpen(!open); if (!children) loadVariables(value.objectId); } }}>
        {value?.objectId && paused ? <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} /> : <span className="dbg-spacer" />}
        <span className="dbg-name">{expr}</span>
        <span className={`dbg-value t-${value?.type ?? ""} ${value?.error || !paused ? "dbg-err" : ""}`} title={shown}>{shown}</span>
        <span className="row-actions">
          <button title="Edit Expression" onClick={(e) => { e.stopPropagation(); onEdit(); }}><i className="codicon codicon-edit" /></button>
          <button title="Remove Expression" onClick={(e) => { e.stopPropagation(); removeWatch(expr); }}><i className="codicon codicon-close" /></button>
        </span>
      </div>
      {open && paused && children?.slice(0, 200).map((c) => <Var key={c.name} v={c} depth={2} />)}
    </>
  );
}

function Scope({ name, objectId, vars, defaultOpen }: { name: string; objectId: string; vars?: Variable[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { if (open && !vars) loadVariables(objectId); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="tree-row dbg-scope" onClick={() => setOpen(!open)}>
        <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} /> <span className="name">{name}</span>
      </div>
      {open && (vars ?? []).map((v) => <Var key={v.name} v={v} depth={1} />)}
    </div>
  );
}

function Var({ v, depth }: { v: Variable; depth: number }) {
  const [open, setOpen] = useState(false);
  const children = useDebug((s) => (v.objectId ? s.vars[v.objectId] : undefined));
  return (
    <>
      <div className="tree-row dbg-var" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => { if (v.objectId) { setOpen(!open); if (!children) loadVariables(v.objectId); } }}>
        {v.objectId ? <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} /> : <span className="dbg-spacer" />}
        <span className="dbg-name">{v.name}</span>
        <span className={`dbg-value t-${v.type}`} title={v.value}>{v.value}</span>
        <span className="row-actions">
          <button title="Add to Watch" onClick={(e) => { e.stopPropagation(); addWatch(v.name); }}><i className="codicon codicon-eye" /></button>
        </span>
      </div>
      {open && children?.slice(0, 200).map((c) => <Var key={c.name} v={c} depth={depth + 1} />)}
    </>
  );
}

/** Bottom panel: program output + REPL. */
export function DebugConsole() {
  const lines = useDebug((s) => s.console);
  const [input, setInput] = useState("");
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [lines]);
  return (
    <div className="debug-console">
      <div className="dc-lines" ref={box}>
        {lines.length === 0 && <div className="muted small">Program output, console.log and logpoints appear here. Start debugging with F5.</div>}
        {lines.map((l, i) => <div key={i} className={`dc-line dc-${l.kind}`}>{l.kind === "input" ? "› " : l.kind === "result" ? "‹ " : ""}{l.text}</div>)}
      </div>
      <div className="dc-input">
        <i className="codicon codicon-chevron-right" />
        <input
          placeholder="Evaluate expression (when paused, in the selected frame)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) { evaluate(input); setHist((h) => [input, ...h].slice(0, 50)); setHi(-1); setInput(""); }
            if (e.key === "ArrowUp" && hist.length) { const n = Math.min(hi + 1, hist.length - 1); setHi(n); setInput(hist[n]); e.preventDefault(); }
            if (e.key === "ArrowDown") { const n = Math.max(hi - 1, -1); setHi(n); setInput(n < 0 ? "" : hist[n]); e.preventDefault(); }
          }}
        />
      </div>
    </div>
  );
}
