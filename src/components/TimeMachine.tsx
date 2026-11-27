import { useEffect, useRef, useState } from "react";
import { api, errMsg } from "../lib/api";
import { monaco, languageForPath } from "../lib/monaco";
import { getModelEntry } from "../lib/workspace";
import { set, toast, useStore } from "../store";

interface Snap { ts: number; size: number; label: string }

const LABELS: Record<string, string> = { save: "Saved", agent: "Agent edit", "before-agent": "Before agent", restore: "Restored" };

function when(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/**
 * Time Machine: scrub through every version of the file on a timeline and compare it with the
 * current buffer. One click restores a version (as an undoable edit).
 */
export default function TimeMachine({ path }: { path: string }) {
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [idx, setIdx] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const fontSize = useStore((s) => s.settings.fontSize);

  useEffect(() => {
    api.historyList(path).then((list) => {
      const chron = [...list].reverse(); // oldest → newest
      setSnaps(chron);
      setIdx(Math.max(0, chron.length - 1));
    });
  }, [path]);

  useEffect(() => {
    const s = snaps[idx];
    if (!s) return setContent(null);
    api.historyRead(path, s.ts).then(setContent).catch(() => setContent(null));
  }, [snaps, idx, path]);

  useEffect(() => {
    if (!host.current) return;
    diff.current = monaco.editor.createDiffEditor(host.current, {
      automaticLayout: true, readOnly: true, renderSideBySide: true, fontSize, minimap: { enabled: false }, renderOverviewRuler: false,
    });
    return () => {
      // Clear the ref first: the model effect's cleanup runs after this one on unmount.
      const d = diff.current;
      diff.current = null;
      d?.setModel(null);
      d?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snaps.length > 0]);

  useEffect(() => {
    const ed = diff.current;
    const cur = getModelEntry(path)?.model;
    if (!ed || content === null || !cur) return;
    const original = monaco.editor.createModel(content, languageForPath(path));
    ed.setModel({ original, modified: cur });
    return () => {
      if (diff.current === ed) ed.setModel(null);
      original.dispose();
    };
  }, [content, path]);

  const restore = async () => {
    const cur = getModelEntry(path)?.model;
    if (!cur || content === null) return;
    try {
      await api.historySave(path, cur.getValue(), "restore");
      cur.pushEditOperations([], [{ range: cur.getFullModelRange(), text: content }], () => null);
      toast(`Restored version from ${when(snaps[idx].ts)} — save to keep it, Ctrl+Z to undo`);
      set({ timeMachine: false });
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <div className="time-machine">
      <div className="tm-bar">
        <span className="tm-title">Time Machine</span>
        {snaps.length === 0 ? (
          <span className="muted small">No history yet — versions are recorded every time this file is saved or edited by the agent.</span>
        ) : (
          <>
            <div className="tm-track">
              {snaps.map((s, i) => (
                <button
                  key={s.ts}
                  className={`tm-tick l-${s.label} ${i === idx ? "on" : ""}`}
                  style={{ left: snaps.length === 1 ? "50%" : `${(i / (snaps.length - 1)) * 100}%` }}
                  title={`${LABELS[s.label] ?? s.label} · ${when(s.ts)}`}
                  onClick={() => setIdx(i)}
                />
              ))}
              <input type="range" min={0} max={Math.max(0, snaps.length - 1)} value={idx} onChange={(e) => setIdx(Number(e.target.value))} />
            </div>
            <span className="tm-when">
              <b>{LABELS[snaps[idx]?.label] ?? snaps[idx]?.label}</b> {snaps[idx] && when(snaps[idx].ts)}
              <span className="muted"> · {idx + 1}/{snaps.length}</span>
            </span>
            <button className="btn small" onClick={restore} disabled={content === null}>Restore</button>
          </>
        )}
        <button className="icon-btn small" onClick={() => set({ timeMachine: false })} title="Close"><i className="codicon codicon-close" /></button>
      </div>
      {snaps.length > 0 && (
        <>
          <div className="tm-legend"><span>Selected version</span><span>Current</span></div>
          <div className="tm-diff" ref={host} />
        </>
      )}
    </div>
  );
}
