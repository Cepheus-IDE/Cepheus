import { useEffect, useState } from "react";
import { api, errMsg } from "../lib/api";
import { GitCommit, gitx, restoreContent, revealCommit } from "../lib/gitApi";
import { timeAgo } from "../lib/gitExtras";
import { getModelEntry, openDiff } from "../lib/workspace";
import { basename } from "../lib/paths";
import { toast, useStore } from "../store";
import { copy } from "./GitWidgets";

type Entry =
  | { kind: "git"; at: number; c: GitCommit }
  | { kind: "local"; at: number; ts: number; label: string };

const LOCAL_LABELS: Record<string, string> = { save: "Saved", agent: "Agent edit", "before-agent": "Before agent edit", restore: "Before restore" };

/** Timeline of the active file: git history (follows renames) merged with Time Machine snapshots. */
export default function Timeline() {
  const ws = useStore((s) => s.workspace);
  const isRepo = useStore((s) => !!s.git?.isRepo);
  const path = useStore((s) => s.tabs.find((t) => t.id === s.activeId && (t.kind === "file" || t.kind === "diff"))?.path ?? null);
  const gitBranch = useStore((s) => s.git?.branch);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [show, setShow] = useState({ git: true, local: true });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!path) return setEntries([]);
    setBusy(true);
    const [commits, snaps] = await Promise.all([
      ws && isRepo ? gitx.log(ws, { path, maxCount: 200 }).catch(() => [] as GitCommit[]) : Promise.resolve([] as GitCommit[]),
      api.historyList(path).catch(() => []),
    ]);
    setEntries([
      ...commits.map((c) => ({ kind: "git" as const, at: c.time * 1000, c })),
      ...snaps.map((s) => ({ kind: "local" as const, at: s.ts, ts: s.ts, label: s.label })),
    ].sort((a, b) => b.at - a.at));
    setBusy(false);
  };
  useEffect(() => { load(); }, [path, ws, isRepo, gitBranch]); // eslint-disable-line react-hooks/exhaustive-deps

  const contentOf = (e: Entry) => (e.kind === "git" ? gitx.show(ws!, e.c.hash, e.c.file || path!) : api.historyRead(path!, e.ts));
  const current = async () => getModelEntry(path!)?.model.getValue() ?? (await api.readFile(path!).catch(() => ""));
  const label = (e: Entry) => (e.kind === "git" ? e.c.hash.slice(0, 7) : `${LOCAL_LABELS[e.label] ?? e.label} ${new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);

  const open = async (e: Entry) => {
    try { openDiff(path!, await contentOf(e), await current(), label(e)); } catch (err) { toast(errMsg(err), "error"); }
  };
  const restore = async (e: Entry) => {
    try { await restoreContent(path!, await contentOf(e), `version ${label(e)}`); } catch (err) { toast(errMsg(err), "error"); }
  };

  if (!path) return <div className="muted small pad">Open a file to see its timeline.</div>;
  const shown = entries.filter((e) => show[e.kind]);
  return (
    <div className="git-timeline">
      <div className="git-toolbar">
        <span className="ellipsis" title={path}><b>{basename(path)}</b></span>
        <span className="spacer" />
        <label className="check small"><input type="checkbox" checked={show.git} onChange={(e) => setShow({ ...show, git: e.target.checked })} /> Git</label>
        <label className="check small"><input type="checkbox" checked={show.local} onChange={(e) => setShow({ ...show, local: e.target.checked })} /> Local</label>
        <button className="icon-btn" title="Refresh" onClick={load}><i className={`codicon codicon-${busy ? "loading codicon-modifier-spin" : "refresh"}`} /></button>
      </div>
      <div className="tree">
        {shown.map((e) => (
          <div
            key={e.kind === "git" ? e.c.hash : "l" + e.ts}
            className="tree-row timeline-row"
            onClick={() => open(e)}
            title={e.kind === "git" ? `${e.c.subject}\n${e.c.author} · ${new Date(e.at).toLocaleString()}\n${e.c.hash}${e.c.file ? `\n${e.c.file}` : ""}` : `Local history · ${new Date(e.at).toLocaleString()}`}
          >
            <i className={`codicon codicon-${e.kind === "git" ? "git-commit" : "history"}`} />
            <span className="name ellipsis">{e.kind === "git" ? e.c.subject : LOCAL_LABELS[e.label] ?? e.label}</span>
            <span className="muted small nowrap">{e.kind === "git" ? `${e.c.author.split(" ")[0]} · ` : ""}{timeAgo(e.at / 1000)}</span>
            <span className="row-actions">
              {e.kind === "git" && (
                <>
                  <button title="Copy commit hash" onClick={(ev) => { ev.stopPropagation(); copy(e.c.hash, `Copied ${e.c.hash.slice(0, 7)}`); }}><i className="codicon codicon-copy" /></button>
                  <button title="Open commit" onClick={(ev) => { ev.stopPropagation(); revealCommit(e.c.hash); }}><i className="codicon codicon-git-commit" /></button>
                </>
              )}
              <button title="Restore this version" onClick={(ev) => { ev.stopPropagation(); restore(e); }}><i className="codicon codicon-discard" /></button>
            </span>
          </div>
        ))}
        {!busy && shown.length === 0 && <div className="muted small pad">No history for this file yet.</div>}
      </div>
    </div>
  );
}
