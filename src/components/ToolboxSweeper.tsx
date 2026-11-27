import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast, useStore } from "../store";
import { errMsg } from "../lib/api";
import { relative } from "../lib/paths";
import { defaultSweepRoot, findHeavyDirs, formatBytes, HeavyDir, measure, sweep } from "../lib/toolbox/sweeper";

export default function Sweeper() {
  const ws = useStore((s) => s.workspace);
  const [root, setRoot] = useState<string | null>(() => defaultSweepRoot(ws));
  const [dirs, setDirs] = useState<HeavyDir[] | null>(null);
  const [phase, setPhase] = useState<"idle" | "finding" | "measuring" | "deleting">("idle");
  const [visited, setVisited] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const cancel = useRef<{ stop: boolean; kill?: () => void }>({ stop: false });

  useEffect(() => { if (!root) setRoot(defaultSweepRoot(ws)); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { cancel.current.stop = true; cancel.current.kill?.(); }, []);

  const scan = async () => {
    if (!root) return;
    cancel.current.kill?.();
    const token: { stop: boolean; kill?: () => void } = { stop: false };
    cancel.current = token;
    setDirs(null); setSelected(new Set()); setConfirm(false); setVisited(0);
    try {
      setPhase("finding");
      const found = await findHeavyDirs(root, setVisited, () => token.stop);
      if (token.stop) return;
      setDirs(found);
      setPhase("measuring");
      await measure(found, (path, size, modified) => {
        if (token.stop) return;
        setDirs((list) => list?.map((d) => (d.path === path ? { ...d, size, projectModified: modified } : d)) ?? list);
      }, (kill) => (token.kill = kill));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      if (!token.stop) setPhase("idle");
    }
  };

  const stop = () => { cancel.current.stop = true; cancel.current.kill?.(); setPhase("idle"); };

  const pick = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Folder to scan for regenerable folders", defaultPath: root ?? undefined });
    if (typeof dir === "string") { setRoot(dir); setDirs(null); setSelected(new Set()); }
  };

  const free = async () => {
    if (!root || !dirs) return;
    setConfirm(false);
    setPhase("deleting");
    const paths = [...selected];
    const failed = await sweep(paths, root, ws);
    const gone = new Set(paths.filter((p) => !failed.some((f) => f.path === p)));
    const bytes = dirs.filter((d) => gone.has(d.path)).reduce((n, d) => n + (d.size ?? 0), 0);
    setDirs(dirs.filter((d) => !gone.has(d.path)));
    setSelected(new Set(failed.map((f) => f.path)));
    setPhase("idle");
    if (gone.size) toast(`Moved ${gone.size} folder${gone.size > 1 ? "s" : ""} (${formatBytes(bytes)}) to the ${trashName()}`);
    if (failed.length) toast(`${failed.length} could not be removed: ${failed[0].error}`, "error");
  };

  if (ws?.startsWith("ssh://")) return <div className="empty-state"><p>The sweeper works on local folders only.</p></div>;

  const sorted = [...(dirs ?? [])].sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  const selBytes = sorted.filter((d) => selected.has(d.path)).reduce((n, d) => n + (d.size ?? 0), 0);
  const total = sorted.reduce((n, d) => n + (d.size ?? 0), 0);
  const allSel = sorted.length > 0 && sorted.every((d) => selected.has(d.path));
  const busy = phase !== "idle";

  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <button className="link small tb-root" title={root ?? ""} onClick={pick}><i className="codicon codicon-folder-opened" /> {root ?? "Choose a folder…"}</button>
        <span className="spacer" />
        {busy && phase !== "deleting" ? (
          <button className="btn small" onClick={stop}>Stop</button>
        ) : (
          <button className="btn small primary" disabled={!root || busy} onClick={scan}>{dirs ? "Rescan" : "Scan"}</button>
        )}
      </div>
      <div className="tb-hint">
        {phase === "finding" && <><i className="codicon codicon-loading codicon-modifier-spin" /> Looking for node_modules, target, .next, dist, build, .venv … ({visited} folders)</>}
        {phase === "measuring" && <><i className="codicon codicon-loading codicon-modifier-spin" /> Measuring {sorted.filter((d) => d.size === null).length} of {sorted.length} folders…</>}
        {phase === "deleting" && <><i className="codicon codicon-loading codicon-modifier-spin" /> Moving to the {trashName()}…</>}
        {phase === "idle" && !dirs && "Finds regenerable folders (dependencies, build output, caches) under the chosen folder. Nothing outside it is touched; the open workspace itself is never removed."}
        {phase === "idle" && dirs && (sorted.length ? `${sorted.length} folders · ${formatBytes(total)} in total` : "Nothing heavy found.")}
      </div>
      {sorted.length > 0 && (
        <div className="tb-toolbar">
          <label className="check small"><input type="checkbox" checked={allSel} onChange={() => setSelected(allSel ? new Set() : new Set(sorted.map((d) => d.path)))} /> Select all</label>
          <span className="spacer" />
          {confirm ? (
            <span className="tb-confirm">
              Move {selected.size} to the {trashName()}?
              <button className="btn small danger" onClick={free}>Yes</button>
              <button className="btn small" onClick={() => setConfirm(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn small primary" disabled={!selected.size || busy} onClick={() => setConfirm(true)}>
              <i className="codicon codicon-trash" /> Free {formatBytes(selBytes)}
            </button>
          )}
        </div>
      )}
      <div className="tb-scroll">
        {sorted.map((d) => (
          <label key={d.path} className="tree-row tb-row tb-sweep" title={d.path}>
            <input type="checkbox" checked={selected.has(d.path)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(d.path)) n.delete(d.path); else n.add(d.path); return n; })} />
            <span className="tb-size">{formatBytes(d.size)}</span>
            <span className="tb-name">{d.name}</span>
            <span className="tb-detail">{relative(root, d.project) || "."}</span>
            <span className="tb-age" title="Newest change in the project (excluding generated folders)">{d.projectModified ? age(d.projectModified) : ""}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

const trashName = () => (navigator.userAgent.includes("Windows") ? "Recycle Bin" : "Trash");

function age(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days < 1) return "today";
  if (days < 31) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}
