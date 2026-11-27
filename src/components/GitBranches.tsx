import { useEffect, useState } from "react";
import { errMsg } from "../lib/api";
import { GitBranch, GitTag, gitOp, gitx, revealCommit, useGitUi } from "../lib/gitApi";
import { timeAgo } from "../lib/gitExtras";
import { toast, useStore } from "../store";
import { Ask, AskRow, ConfirmButton } from "./GitWidgets";

// Remote branches are checked out by their short name: git creates (or reuses) the tracking branch.
const co = (b: GitBranch) => (b.remote ? b.name.split("/").slice(1).join("/") : b.name);

/** Local + remote branches with ahead/behind, and tags. */
export default function GitBranches() {
  const ws = useStore((s) => s.workspace)!;
  const git = useStore((s) => s.git);
  const refsVersion = useGitUi((s) => s.refsVersion);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [tags, setTags] = useState<GitTag[]>([]);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    gitx.refs(ws).then((r) => { setBranches(r.branches); setTags(r.tags); }).catch((e) => toast(errMsg(e), "error"));
  }, [ws, git, refsVersion]);

  const current = branches.find((b) => b.current)?.name ?? git?.branch ?? "HEAD";
  const f = filter.toLowerCase();
  const match = (n: string) => !f || n.toLowerCase().includes(f);
  const local = branches.filter((b) => !b.remote && match(b.name));
  const remote = branches.filter((b) => b.remote && match(b.name));

  const createFrom = () =>
    setAsk({
      label: "Name of the new branch",
      placeholder: "feature/my-change",
      submit: (name) => setTimeout(() => setAsk({
        label: `Create "${name}" from (branch, tag or commit)`,
        initial: current,
        submit: (from) => gitOp(`Switched to ${name}`, ["checkout", "-b", name, from]),
      }), 0),
    });

  const branchRow = (b: GitBranch) => (
    <div key={(b.remote ? "r:" : "l:") + b.name} className={`tree-row branch-row ${b.current ? "current" : ""}`} onDoubleClick={() => !b.current && gitOp(`Switched to ${b.name}`, ["checkout", co(b)])} title={`${b.name} · ${b.hash} ${b.subject}${b.upstream ? `\nupstream: ${b.upstream}` : ""}`}>
      <i className={`codicon codicon-${b.current ? "check" : b.remote ? "cloud" : "git-branch"}`} />
      <span className="name ellipsis">{b.name}</span>
      {(b.ahead > 0 || b.behind > 0) && <span className="ab small" title={`${b.ahead} ahead, ${b.behind} behind ${b.upstream}`}>{b.behind ? `${b.behind}↓` : ""}{b.ahead ? ` ${b.ahead}↑` : ""}</span>}
      {b.gone && <span className="small del" title="Upstream branch was deleted">gone</span>}
      <span className="muted small nowrap">{timeAgo(b.time)}</span>
      <span className="row-actions">
        {!b.current && <button title="Checkout" onClick={() => gitOp(`Switched to ${b.name}`, ["checkout", co(b)])}><i className="codicon codicon-arrow-right" /></button>}
        <button title="Show commit" onClick={() => revealCommit(b.hash)}><i className="codicon codicon-git-commit" /></button>
        {!b.current && <button title={`Merge into ${current}`} onClick={() => gitOp(`Merged ${b.name}`, ["merge", "--no-edit", b.name])}><i className="codicon codicon-git-merge" /></button>}
        {!b.current && <ConfirmButton title={`Rebase ${current} onto ${b.name}`} icon="git-pull-request-go-to-changes" confirmText={`Rebase ${current} onto ${b.name}`} onConfirm={() => gitOp(`Rebased onto ${b.name}`, ["rebase", b.name])} />}
        {!b.remote && <button title="Rename…" onClick={() => setAsk({ label: `Rename ${b.name}`, initial: b.name, submit: (n) => gitOp(`Renamed to ${n}`, ["branch", "-m", b.name, n]) })}><i className="codicon codicon-edit" /></button>}
        {!b.current && (
          <ConfirmButton
            title={b.remote ? "Delete remote branch" : "Delete branch"}
            icon="trash"
            confirmText={b.remote ? `Delete ${b.name} on the remote` : `Delete branch ${b.name}`}
            onConfirm={async () => {
              if (b.remote) {
                const [rem, ...rest] = b.name.split("/");
                return void gitOp(`Deleted ${b.name}`, ["push", rem, "--delete", rest.join("/")], { network: true });
              }
              try {
                await gitx.run(ws, ["branch", "-d", b.name]);
                toast(`Deleted ${b.name}`);
              } catch (e) {
                // Not merged: offer force delete as a second, explicit step.
                if (/not fully merged/.test(errMsg(e))) setAsk({ label: `${b.name} is not fully merged. Type its name to force delete`, submit: (n) => n === b.name && gitOp(`Deleted ${b.name}`, ["branch", "-D", b.name]) });
                else toast(errMsg(e), "error");
              } finally {
                useGitUi.setState((s) => ({ refsVersion: s.refsVersion + 1 }));
              }
            }}
          />
        )}
      </span>
    </div>
  );

  return (
    <div className="git-branches">
      <div className="git-toolbar">
        <input placeholder="Filter branches and tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title="Create branch from…" onClick={createFrom}><i className="codicon codicon-git-branch-create" /></button>
        <button className="icon-btn" title="Fetch all remotes and prune deleted branches" onClick={() => gitOp("Fetched", ["fetch", "--all", "--prune"], { network: true })}><i className="codicon codicon-cloud-download" /></button>
        <button className="icon-btn" title="Create tag on HEAD…" onClick={() => setAsk({ label: "Tag name (on HEAD)", placeholder: "v1.0.0", submit: (t) => setTimeout(() => setAsk({ label: `Message for ${t} (Enter "-" for a lightweight tag)`, initial: "-", submit: (m) => gitOp(`Tagged ${t}`, m === "-" ? ["tag", t] : ["tag", "-a", t, "-m", m]) }), 0) })}><i className="codicon codicon-tag" /></button>
      </div>
      <AskRow ask={ask} onClose={() => setAsk(null)} />
      <div className="tree">
        <div className="section-title">LOCAL <span className="count">{local.length}</span></div>
        {local.map(branchRow)}
        <div className="section-title">REMOTE <span className="count">{remote.length}</span></div>
        {remote.map(branchRow)}
        {remote.length === 0 && <div className="muted small pad">No remote branches (fetch to update).</div>}
        <div className="section-title">
          TAGS <span className="count">{tags.length}</span>
          {tags.length > 0 && <button className="icon-btn small" title="Push all tags to origin" onClick={() => gitOp("Pushed tags", ["push", "origin", "--tags"], { network: true })}><i className="codicon codicon-cloud-upload" /></button>}
        </div>
        {tags.filter((t) => match(t.name)).map((t) => (
          <div key={t.name} className="tree-row" title={`${t.name} · ${t.hash} ${t.subject}`}>
            <i className="codicon codicon-tag" />
            <span className="name ellipsis">{t.name}</span>
            <span className="muted small ellipsis">{t.subject}</span>
            <span className="row-actions">
              <button title="Show commit" onClick={() => revealCommit(t.hash)}><i className="codicon codicon-git-commit" /></button>
              <button title="Checkout (detached)" onClick={() => gitOp(`Checked out ${t.name}`, ["checkout", t.name])}><i className="codicon codicon-arrow-right" /></button>
              <ConfirmButton title="Delete tag" icon="trash" confirmText={`Delete tag ${t.name}`} onConfirm={() => gitOp(`Deleted tag ${t.name}`, ["tag", "-d", t.name])} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
