import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { create } from "zustand";
import ContextMenu, { MenuItem } from "./ContextMenu";
import {
  getBreakpoint, pause, restartDebugging, resume, stepInto, stepOut, stepOver, stopDebugging, toggleBreakpoint,
  updateBreakpoint, useDebug,
} from "../lib/debugger";

interface MenuState { x: number; y: number; path: string; line: number; edit: (kind: "condition" | "hit" | "log") => void }
const useMenu = create<{ menu: MenuState | null }>(() => ({ menu: null }));

export function showBreakpointMenu(x: number, y: number, path: string, line: number, edit: MenuState["edit"]) {
  useMenu.setState({ menu: { x, y, path, line, edit } });
}

/** Mounted once into the editor area by the debug editor integration. */
export function mountDebugOverlays(host: HTMLElement) {
  const el = document.createElement("div");
  el.className = "dbg-overlays";
  host.appendChild(el);
  const root = createRoot(el);
  root.render(<Overlays />);
  return () => { root.unmount(); el.remove(); };
}

function Overlays() {
  const menu = useMenu((s) => s.menu);
  return (
    <>
      <FloatingToolbar />
      {menu && <BreakpointMenu m={menu} />}
    </>
  );
}

function BreakpointMenu({ m }: { m: MenuState }) {
  useDebug((s) => s.breakpoints);
  const bp = getBreakpoint(m.path, m.line);
  const close = () => useMenu.setState({ menu: null });
  const items: MenuItem[] = bp
    ? [
        { label: "Remove Breakpoint", icon: "close", onClick: () => toggleBreakpoint(m.path, m.line) },
        { label: bp.logMessage ? "Edit Logpoint…" : "Edit Condition…", icon: "edit", onClick: () => m.edit(bp.logMessage ? "log" : bp.hitCondition && !bp.condition ? "hit" : "condition") },
        { label: bp.enabled ? "Disable Breakpoint" : "Enable Breakpoint", icon: bp.enabled ? "circle-slash" : "circle-filled", onClick: () => updateBreakpoint(m.path, m.line, { enabled: !bp.enabled }) },
      ]
    : [
        { label: "Add Breakpoint", icon: "circle-filled", onClick: () => toggleBreakpoint(m.path, m.line) },
        { label: "Add Conditional Breakpoint…", icon: "debug-breakpoint-conditional", onClick: () => m.edit("condition") },
        { label: "Add Logpoint…", icon: "debug-breakpoint-log", onClick: () => m.edit("log") },
      ];
  return <ContextMenu x={m.x} y={m.y} items={items} onClose={close} />;
}

const POS_KEY = "cepheus.debugToolbarX";

/** Floating toolbar over the editor while a session is active; drag the grip to move it sideways. */
function FloatingToolbar() {
  const status = useDebug((s) => s.status);
  const name = useDebug((s) => s.sessionName);
  const [x, setX] = useState<number>(() => { const v = parseFloat(localStorage.getItem(POS_KEY) ?? ""); return Number.isFinite(v) ? v : 0.5; });
  const bar = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startFrac: number; width: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const f = Math.min(1, Math.max(0, d.startFrac + (e.clientX - d.startX) / d.width));
      setX(f);
    };
    const up = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.cursor = "";
      setX((f) => { try { localStorage.setItem(POS_KEY, String(f)); } catch { /* ignore */ } return f; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  if (status === "idle") return null;
  const parentW = bar.current?.parentElement?.parentElement?.clientWidth ?? 800;
  const w = bar.current?.offsetWidth ?? 220;
  const left = Math.max(4, Math.min(parentW - w - 4, x * (parentW - w)));
  return (
    <div className="dbg-float" ref={bar} style={{ left }} title={name}>
      <span
        className="dbg-grip"
        onMouseDown={(e) => {
          e.preventDefault();
          const width = Math.max(1, parentW - w);
          drag.current = { startX: e.clientX, startFrac: x, width };
          document.body.style.cursor = "grabbing";
        }}
      >
        <i className="codicon codicon-gripper" />
      </span>
      {status === "paused"
        ? <button title="Continue (F5)" onClick={resume}><i className="codicon codicon-debug-continue" /></button>
        : <button title="Pause (F6)" onClick={pause} disabled={status !== "running"}><i className="codicon codicon-debug-pause" /></button>}
      <button title="Step Over (F10)" disabled={status !== "paused"} onClick={stepOver}><i className="codicon codicon-debug-step-over" /></button>
      <button title="Step Into (F11)" disabled={status !== "paused"} onClick={stepInto}><i className="codicon codicon-debug-step-into" /></button>
      <button title="Step Out (Shift+F11)" disabled={status !== "paused"} onClick={stepOut}><i className="codicon codicon-debug-step-out" /></button>
      <button title="Restart (Ctrl+Shift+F5)" onClick={restartDebugging}><i className="codicon codicon-debug-restart" /></button>
      <button title="Stop (Shift+F5)" className="stop" onClick={stopDebugging}><i className="codicon codicon-debug-stop" /></button>
    </div>
  );
}
