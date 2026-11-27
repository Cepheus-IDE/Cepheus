import { useEffect, useMemo, useState } from "react";
import { errMsg } from "../lib/api";
import { CommitDetails, GitCommit, gitOp, gitx, openCommitFileDiff, useGitUi } from "../lib/gitApi";
import { timeAgo } from "../lib/gitExtras";
import { basename } from "../lib/paths";
import { toast, useStore } from "../store";
import { Ask, AskRow, ConfirmButton, copy, RefBadge } from "./GitWidgets";

const PAGE = 300;
const LANE_W = 12, ROW_H = 22;
const COLORS = ["#4ea1ff", "#f0883e", "#3fb950", "#d2a8ff", "#ff7b72", "#e3b341", "#39c5cf", "#db61a2"];

interface Row { c: GitCommit; lane: number; before: (string | null)[]; after: (string | null)[] }

/** Assigns each commit a lane; `before`/`after` are the lanes entering / leaving the row. */
export function layoutGraph(commits: GitCommit[]): Row[] {
  let lanes: (string | null)[] = [];
  return commits.map((c) => {
    const before = lanes;
    let lane = before.indexOf(c.hash);
    if (lane < 0) { lane = before.indexOf(null); if (lane < 0) lane = before.length; }
    const after = before.map((h) => (h === c.hash ? null : h));
    while (after.length <= lane) after.push(null);
    after[lane] = c.parents[0] ?? null;
    for (const p of c.parents.slice(1)) {
      if (after.includes(p)) continue;
      const free = after.indexOf(null);
      if (free >= 0) after[free] = p; else after.push(p);
    }
    while (after.length && after[after.length - 1] === null) after.pop();
    lanes = after;
    return { c, lane, before, after };
  });
}

function GraphCell({ row, width }: { row: Row; width: number }) {
  const x = (i: number) => i * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const col = (i: number) => COLORS[i % COLORS.length];
  const paths: JSX.Element[] = [];
  row.before.forEach((h, i) => {
    if (h === null) return;
    if (h === row.c.hash) paths.push(<path key={"in" + i} d={`M${x(i)} 0 C${x(i)} ${mid / 2} ${x(row.lane)} ${mid / 2} ${x(row.lane)} ${mid}`} stroke={col(i)} />);
    else {
      const j = row.after[i] === h ? i : row.after.indexOf(h);
      if (j >= 0) paths.push(<path key={"pass" + i} d={`M${x(i)} 0 L${x(j)} ${ROW_H}`} stroke={col(i)} />);
    }
  });
  row.c.parents.forEach((p, n) => {
    const k = n === 0 ? row.lane : row.after.indexOf(p);
    if (k < 0) return;
    paths.push(<path key={"out" + n} d={`M${x(row.lane)} ${mid} C${x(row.lane)} ${mid + mid / 2} ${x(k)} ${mid + mid / 2} ${x(k)} ${ROW_H}`} stroke={col(k)} />);
  });
  return (
    <svg className="git-graph" width={width} height={ROW_H}>
      <g fill="none" strokeWidth={1.6}>{paths}</g>
      <circle cx={x(row.lane)} cy={mid} r={row.c.parents.length > 1 ? 3 : 3.6} fill={row.c.parents.length > 1 ? "var(--bg, #1e1e1e)" : col(row.lane)} stroke={col(row.lane)} strokeWidth={1.6} />
    </svg>
  );
}

/** Commits on the current branch (or all branches) with a lane graph, search and commit details. */
export default function GitCommits() {
  const ws = useStore((s) => s.workspace)!;
  const git = useStore((s) => s.git);
  const focus = useGitUi((s) => s.focusCommit);
  const refsVersion = useGitUi((s) => s.refsVersion);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  const load = async (skip = 0) => {
    try {
      const list = await gitx.log(ws, { maxCount: PAGE, skip, all });
      setCommits((prev) => (skip ? [...prev, ...list] : list));
      setMore(list.length === PAGE);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  // Reload when HEAD / refs may have moved.
  useEffect(() => { load(0); }, [ws, all, git?.branch, git?.aheadBehind, refsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return setDetails(null);
    gitx.details(ws, open).then(setDetails).catch((e) => toast(errMsg(e), "error"));
  }, [open, ws]);

  useEffect(() => {
    if (!focus) return;
    useGitUi.setState({ focusCommit: null });
    setQ("");
    setOpen(commits.find((c) => c.hash.startsWith(focus))?.hash ?? focus);
    setTimeout(() => document.querySelector(".commit-row.open")?.scrollIntoView({ block: "center" }), 50);
  }, [focus, commits]);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const width = Math.min(8, Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length, r.lane + 1)))) * LANE_W;
  const term = q.trim().toLowerCase();
  const shown = term
    ? rows.filter(({ c }) => c.subject.toLowerCase().includes(term) || c.author.toLowerCase().includes(term) || c.email.toLowerCase().includes(term) || c.hash.startsWith(term))
    : rows;

  const actions = (c: GitCommit) => (
    <span className="row-actions">
      <button title="Copy commit hash" onClick={(e) => { e.stopPropagation(); copy(c.hash, `Copied ${c.hash.slice(0, 7)}`); }}><i className="codicon codicon-copy" /></button>
      <button title="Create branch from this commit…" onClick={(e) => { e.stopPropagation(); setAsk({ label: `New branch at ${c.hash.slice(0, 7)}`, placeholder: "branch-name", submit: (b) => gitOp(`Switched to ${b}`, ["checkout", "-b", b, c.hash]) }); }}><i className="codicon codicon-git-branch-create" /></button>
      <button title="Create tag on this commit…" onClick={(e) => { e.stopPropagation(); setAsk({ label: `New tag at ${c.hash.slice(0, 7)}`, placeholder: "v1.0.0", submit: (t) => gitOp(`Tagged ${t}`, ["tag", t, c.hash]) }); }}><i className="codicon codicon-tag" /></button>
      <button title="Cherry-pick onto current branch" onClick={(e) => { e.stopPropagation(); gitOp("Cherry-picked", ["cherry-pick", c.hash]); }}><i className="codicon codicon-git-pull-request-go-to-changes" /></button>
      <ConfirmButton title="Revert this commit (new commit)" icon="discard" confirmText={`Revert ${c.hash.slice(0, 7)}`} onConfirm={() => gitOp("Reverted", ["revert", "--no-edit", c.hash])} />
    </span>
  );

  return (
    <div className="git-commits">
      <div className="git-toolbar">
        <input placeholder="Search message, author or hash" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check small" title="Show commits of every branch"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All</label>
      </div>
      <AskRow ask={ask} onClose={() => setAsk(null)} />
      <div className="tree">
        {shown.map((r) => {
          const c = r.c;
          const isOpen = open === c.hash;
          return (
            <div key={c.hash}>
              <div className={`tree-row commit-row ${isOpen ? "open" : ""}`} onClick={() => setOpen(isOpen ? null : c.hash)} title={`${c.subject}\n${c.author} <${c.email}>\n${new Date(c.time * 1000).toLocaleString()}\n${c.hash}`}>
                {!term && <GraphCell row={r} width={width} />}
                <span className="name ellipsis">
                  {c.refs.map((x) => <RefBadge key={x} r={x} />)}
                  {c.subject}
                </span>
                <span className="muted small nowrap">{c.author.split(" ")[0]} · {timeAgo(c.time)}</span>
                {actions(c)}
              </div>
              {isOpen && (
                <div className="commit-details">
                  {!details || details.hash !== c.hash ? <div className="muted small">Loading…</div> : (
                    <>
                      <pre className="commit-body">{details.body}</pre>
                      <div className="muted small">
                        {details.author} &lt;{details.email}&gt; · {new Date(details.time * 1000).toLocaleString()}
                        {details.committer !== details.author ? ` · committed by ${details.committer}` : ""}
                      </div>
                      <div className="muted small">
                        <button className="link" onClick={() => copy(details.hash, "Copied hash")}>{details.hash.slice(0, 10)}</button>
                        {details.parents.length > 0 && <> · parent {details.parents.map((p) => <button key={p} className="link" onClick={() => setOpen(p)}>{p.slice(0, 7)} </button>)}</>}
                      </div>
                      {details.files.map((f) => (
                        <div key={f.path} className={`tree-row git-row git-${f.status}`} onClick={() => openCommitFileDiff(ws, details, f)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                          <span className="name">{basename(f.path)}</span>
                          <span className="muted small ellipsis">{f.oldPath ? `${f.oldPath} → ` : ""}{f.path}</span>
                          <span className="git-letter">{f.status}</span>
                        </div>
                      ))}
                      {details.files.length === 0 && <div className="muted small">No file changes (merge commit vs first parent is empty).</div>}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {commits.length === 0 && <div className="muted small pad">No commits yet.</div>}
        {more && commits.length > 0 && <button className="link small pad" onClick={() => load(commits.length)}>Load more…</button>}
      </div>
    </div>
  );
}
