import { useEffect, useState } from "react";
import { api, errMsg, GitFile } from "../lib/api";
import { basename, dirname, relative } from "../lib/paths";
import { openFile, openGitDiff, refreshGit } from "../lib/workspace";
import { generateCommitMessage } from "../lib/ai";
import { set, toast, useStore } from "../store";
import { newSession, sendMessage } from "../lib/agent";
import { aheadBehind, bumpRefs, gitx, openMergeEditor, ScmTab, syncNow, useGitUi } from "../lib/gitApi";
import FileIcon from "./FileIcon";
import GitCommits from "./GitCommits";
import GitBranches from "./GitBranches";
import Timeline from "./Timeline";
import { ConfirmButton } from "./GitWidgets";
import { openBranchPicker } from "./BranchPicker";
import { guardCommit } from "../lib/toolbox/secretGuard";
import { SecretGuardBanner } from "./ToolboxOverlay";

const isConflict = (f: GitFile) => f.index === "U" || f.worktree === "U" || (f.index === "A" && f.worktree === "A") || (f.index === "D" && f.worktree === "D");
const NEEDS_IDENTITY = /Author identity unknown|tell me who you are|empty ident/i;

const LABEL: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked", "?": "Untracked" };
const TABS: { id: ScmTab; label: string; icon: string }[] = [
  { id: "changes", label: "Changes", icon: "diff" },
  { id: "commits", label: "Commits", icon: "git-commit" },
  { id: "branches", label: "Branches", icon: "git-branch" },
  { id: "timeline", label: "Timeline", icon: "history" },
];

/** Commit options: what to commit and how. "smart" = staged changes if any, otherwise everything. */
interface CommitOpts { mode: "smart" | "staged" | "all"; amend: boolean; signoff: boolean }

export default function GitPanel() {
  const ws = useStore((s) => s.workspace);
  const git = useStore((s) => s.git);
  const tab = useGitUi((s) => s.tab);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [branchInput, setBranchInput] = useState<string | null>(null);
  const token = useStore((s) => s.settings.githubToken);
  const [stashes, setStashes] = useState<{ index: number; message: string }[]>([]);
  const [identity, setIdentity] = useState<{ name: string; email: string; global: boolean } | null>(null);
  const [opts, setOpts] = useState<CommitOpts>(() => ({ mode: useStore.getState().settings.gitSmartCommit === false ? "staged" : "smart", amend: false, signoff: false })); // Settings › Git › Smart commit
  const [optsOpen, setOptsOpen] = useState(false);
  const loadStashes = () => { if (ws && git?.isRepo) api.gitStashList(ws).then(setStashes).catch(() => setStashes([])); };
  // Reload stashes whenever git status changes.
  useEffect(loadStashes, [ws, git]); // eslint-disable-line react-hooks/exhaustive-deps

  const review = () => {
    const s = newSession();
    set({ agentOpen: true });
    sendMessage(
      s.id,
      "Review my uncommitted changes like a senior engineer doing code review. Run `git diff` and `git status` to see them (read files for context as needed). Report bugs, risky changes, missing edge cases, and leftover debug code, ordered by severity, with file:line references. Do not modify any files.",
      null
    );
  };

  if (!ws) return <div className="panel"><div className="panel-header"><span>SOURCE CONTROL</span></div><div className="empty-state">Open a folder first.</div></div>;

  const tabBar = (available: ScmTab[]) => (
    <div className="scm-tabs">
      {TABS.filter((t) => available.includes(t.id)).map((t) => (
        <button key={t.id} className={tab === t.id ? "on" : ""} title={t.label} onClick={() => useGitUi.setState({ tab: t.id })}>
          <i className={`codicon codicon-${t.icon}`} /> {t.label}
        </button>
      ))}
    </div>
  );

  if (git && !git.isRepo) {
    return (
      <div className="panel">
        <div className="panel-header"><span>SOURCE CONTROL</span></div>
        {tabBar(["changes", "timeline"])}
        {tab === "timeline" ? <Timeline /> : (
          <div className="empty-state">
            <p>This folder is not a Git repository.</p>
            <button className="btn primary" onClick={async () => { try {
              await api.gitInit(ws);
              // Settings › Git › Initial branch name (HEAD has no commits yet, so just repoint it).
              const branch = useStore.getState().settings.gitDefaultBranch?.trim();
              if (branch) await gitx.run(ws, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]).catch((e) => toast(errMsg(e), "error"));
              refreshGit();
            } catch (e) { toast(errMsg(e), "error"); } }}>
              Initialize Repository
            </button>
          </div>
        )}
      </div>
    );
  }

  const files = git?.files ?? [];
  const conflicts = files.filter(isConflict);
  const staged = files.filter((f) => !isConflict(f) && f.index !== " " && f.index !== "?");
  const changes = files.filter((f) => !isConflict(f) && (f.worktree !== " " || f.index === "?"));
  const ab = aheadBehind(git?.aheadBehind);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const out = await fn();
      if (typeof out === "string" && out.trim()) toast(out.trim().split("\n").slice(-2).join(" "));
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
      refreshGit();
      bumpRefs();
    }
  };

  const runCommit = async () => {
    const args = ["commit"];
    if (msg.trim()) args.push("-m", msg.trim());
    else if (opts.amend) args.push("--no-edit");
    if (opts.amend) args.push("--amend");
    if (opts.signoff) args.push("--signoff");
    await gitx.run(ws, args);
  };

  /** Settings › Git › After commit: push or sync. */
  const afterCommit = () => {
    const post = useStore.getState().settings.gitPostCommit;
    if (post === "sync") setTimeout(() => syncNow(), 0);
    else if (post === "push") setTimeout(() => api.gitSync(ws, "push", useStore.getState().settings.githubToken).then(() => { toast("Pushed"); refreshGit(); bumpRefs(); }).catch((e) => toast(errMsg(e), "error")), 0);
  };

  const commit = () =>
    act("commit", async () => {
      if (!msg.trim() && !opts.amend) throw new Error("Enter a commit message");
      if (conflicts.length) throw new Error("Resolve merge conflicts first");
      const stageAll = opts.mode === "all" || (opts.mode === "smart" && staged.length === 0);
      if (opts.mode === "staged" && staged.length === 0 && !opts.amend) throw new Error("Nothing is staged");
      if (stageAll && changes.length) await api.gitStage(ws, changes.map((f) => f.path));
      // Toolbox secret guard: hold the commit when the staged diff looks like it leaks credentials.
      if (!(await guardCommit(ws, commit))) return "Commit held: the staged changes may contain secrets";
      try {
        await runCommit();
      } catch (e) {
        if (NEEDS_IDENTITY.test(errMsg(e))) {
          const cur = await api.gitIdentity(ws);
          setIdentity({ name: cur.name, email: cur.email, global: true });
          return "Set your Git name and email to commit";
        }
        throw e;
      }
      setMsg("");
      if (opts.amend) setOpts({ ...opts, amend: false });
      afterCommit();
      return opts.amend ? "Amended last commit" : "Committed";
    });

  const saveIdentity = () =>
    act("identity", async () => {
      if (!identity?.name.trim() || !/.+@.+/.test(identity.email)) throw new Error("Enter a name and a valid email");
      await api.gitSetIdentity(ws, identity.name, identity.email, identity.global);
      setIdentity(null);
      await runCommit();
      setMsg("");
      return "Committed";
    });

  const undoLast = () =>
    act("undo", async () => {
      const last = await gitx.run(ws, ["log", "-1", "--format=%B"]);
      await gitx.run(ws, ["reset", "--soft", "HEAD~1"]);
      if (!msg.trim()) setMsg(last.trim());
      return "Undid last commit — its changes are staged";
    });

  const toggleAmend = async (amend: boolean) => {
    setOpts({ ...opts, amend });
    // Amending usually means "fix the last commit": prefill its message.
    if (amend && !msg.trim()) setMsg((await gitx.run(ws, ["log", "-1", "--format=%B"]).catch(() => "")).trim());
  };

  const markResolved = (f: GitFile) =>
    act("resolve", async () => {
      const text = await api.readFile(f.path).catch(() => "");
      if (/^(<<<<<<<|>>>>>>>) /m.test(text)) throw new Error(`${basename(f.path)} still has conflict markers`);
      await api.gitStage(ws, [f.path]);
      return `Marked ${basename(f.path)} as resolved`;
    });

  const row = (f: GitFile, isStaged: boolean) => {
    const code = isStaged ? f.index : f.index === "?" ? "U" : f.worktree;
    return (
      <div key={(isStaged ? "s:" : "c:") + f.path} className={`tree-row git-row git-${code}`} onClick={() => (code === "D" ? null : openGitDiff(f.path))} title={`${relative(ws, f.path)} — ${LABEL[code] ?? code}`}>
        <FileIcon name={basename(f.path)} />
        <span className="name">{basename(f.path)}</span>
        <span className="muted small ellipsis">{relative(ws, dirname(f.path))}</span>
        <span className="row-actions">
          {code !== "D" && <button title="Open File" onClick={(e) => { e.stopPropagation(); openFile(f.path); }}><i className="codicon codicon-go-to-file" /></button>}
          {!isStaged && f.index !== "?" && (
            <button title="Discard Changes" onClick={(e) => { e.stopPropagation(); act("discard", () => api.gitDiscard(ws, f.path)); }}><i className="codicon codicon-discard" /></button>
          )}
          {isStaged ? (
            <button title="Unstage" onClick={(e) => { e.stopPropagation(); act("unstage", () => api.gitUnstage(ws, [f.path])); }}><i className="codicon codicon-remove" /></button>
          ) : (
            <button title="Stage" onClick={(e) => { e.stopPropagation(); act("stage", () => api.gitStage(ws, [f.path])); }}><i className="codicon codicon-add" /></button>
          )}
        </span>
        <span className="git-letter">{code}</span>
      </div>
    );
  };

  const commitLabel = opts.amend ? "Amend" : opts.mode === "all" || (opts.mode === "smart" && staged.length === 0) ? "Commit All" : "Commit Staged";

  return (
    <div className="panel">
      <div className="panel-header">
        <span>SOURCE CONTROL</span>
        <div className="actions">
          <button title={`Sync: pull then push${git?.aheadBehind ? ` (${git.aheadBehind})` : ""}`} onClick={() => syncNow()}>
            <i className="codicon codicon-sync" />{(ab.ahead > 0 || ab.behind > 0) && <span className="small"> {ab.behind}↓{ab.ahead}↑</span>}
          </button>
          <button title="Pull" onClick={() => act("pull", () => api.gitSync(ws, "pull", token))}><i className="codicon codicon-arrow-down" /></button>
          <button title="Push" onClick={() => act("push", () => api.gitSync(ws, "push", token))}><i className="codicon codicon-arrow-up" /></button>
          <button title="Stash All Changes (incl. untracked)" disabled={files.length === 0} onClick={() => act("stash", () => api.gitStash(ws, "push", undefined, msg.trim() || undefined))}><i className="codicon codicon-archive" /></button>
          <button title="Refresh" onClick={() => { refreshGit(); bumpRefs(); }}><i className="codicon codicon-refresh" /></button>
        </div>
      </div>
      {tabBar(["changes", "commits", "branches", "timeline"])}
      {tab === "commits" && <GitCommits />}
      {tab === "branches" && <GitBranches />}
      {tab === "timeline" && <Timeline />}
      {tab === "changes" && (
        <>
          <div className="git-commit">
            <div className="branch-line">
              <button className="link" title="Checkout branch…" onClick={openBranchPicker}><i className="codicon codicon-git-branch" /> {git?.branch || "…"}</button>
              {git?.aheadBehind && <span className="muted small">({git.aheadBehind})</span>}
              <span className="spacer" />
              <button className="link small" onClick={() => setBranchInput((v) => (v === null ? "" : null))}>new branch</button>
            </div>
            {branchInput !== null && (
              <input
                autoFocus
                placeholder="feature/my-change — Enter to create & switch"
                value={branchInput}
                onChange={(e) => setBranchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBranchInput(null);
                  if (e.key === "Enter" && branchInput.trim()) {
                    const b = branchInput.trim();
                    setBranchInput(null);
                    act("branch", async () => { await api.gitCheckout(ws, b, true); return `Switched to ${b}`; });
                  }
                }}
              />
            )}
            <textarea
              placeholder={opts.amend ? "Message (empty keeps the last commit's message)" : `Message (Ctrl+Enter to commit on "${git?.branch ?? ""}")`}
              value={msg}
              rows={3}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && commit()}
            />
            <div className="row gap">
              <button className="btn primary grow" disabled={!!busy || (files.length === 0 && !opts.amend)} onClick={commit}>
                <i className="codicon codicon-check" /> {busy === "commit" ? "Committing…" : commitLabel}
                {opts.signoff && <span className="small"> (signed off)</span>}
              </button>
              <button className={`btn ${optsOpen ? "on" : ""}`} title="Commit options" onClick={() => setOptsOpen((v) => !v)}>
                <i className="codicon codicon-chevron-down" />
              </button>
              <button
                className="btn"
                title="Generate commit message with AI"
                disabled={!!busy || files.length === 0}
                onClick={() => act("gen", async () => setMsg(await generateCommitMessage()))}
              >
                <i className={`codicon codicon-${busy === "gen" ? "loading codicon-modifier-spin" : "sparkle"}`} />
              </button>
            </div>
            <SecretGuardBanner onCommitAnyway={commit} />
            {optsOpen && (
              <div className="commit-opts">
                <label className="check small"><input type="radio" checked={opts.mode === "smart"} onChange={() => setOpts({ ...opts, mode: "smart" })} /> Staged changes, or everything when nothing is staged</label>
                <label className="check small"><input type="radio" checked={opts.mode === "staged"} onChange={() => setOpts({ ...opts, mode: "staged" })} /> Commit staged only</label>
                <label className="check small"><input type="radio" checked={opts.mode === "all"} onChange={() => setOpts({ ...opts, mode: "all" })} /> Commit all (stage every change)</label>
                <label className="check small"><input type="checkbox" checked={opts.amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend last commit</label>
                <label className="check small"><input type="checkbox" checked={opts.signoff} onChange={(e) => setOpts({ ...opts, signoff: e.target.checked })} /> Sign off (Signed-off-by trailer)</label>
                <div className="row gap">
                  <ConfirmButton className="btn small" title="Undo last commit (soft reset — keeps its changes staged)" icon="discard" confirmText="Undo the last commit" onConfirm={undoLast} />
                  <span className="small muted">Undo last commit</span>
                </div>
              </div>
            )}
            {identity && (
              <div className="identity-form">
                <div className="small">Git needs your name and email to commit.</div>
                <input placeholder="Your Name" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
                <input placeholder="you@example.com" value={identity.email} onChange={(e) => setIdentity({ ...identity, email: e.target.value })} onKeyDown={(e) => e.key === "Enter" && saveIdentity()} />
                <label className="check small"><input type="checkbox" checked={identity.global} onChange={(e) => setIdentity({ ...identity, global: e.target.checked })} /> Use for all repositories (global)</label>
                <div className="row gap">
                  <button className="btn primary grow" disabled={!!busy} onClick={saveIdentity}>Save &amp; Commit</button>
                  <button className="btn" onClick={() => setIdentity(null)}>Cancel</button>
                </div>
              </div>
            )}
            <button className="link small review-link" disabled={files.length === 0} onClick={review}>
              <i className="codicon codicon-eye" /> Review my changes with AI before committing
            </button>
          </div>
          <div className="tree">
            {conflicts.length > 0 && (
              <>
                <div className="section-title">MERGE CHANGES <span className="count">{conflicts.length}</span></div>
                {conflicts.map((f) => (
                  <div key={"m:" + f.path} className="tree-row git-row git-C" onClick={() => openFile(f.path)} title={`${relative(ws, f.path)} — conflict (open to resolve)`}>
                    <FileIcon name={basename(f.path)} />
                    <span className="name">{basename(f.path)}</span>
                    <span className="muted small ellipsis">{relative(ws, dirname(f.path))}</span>
                    <span className="row-actions">
                      <button title="Resolve in Merge Editor" onClick={(e) => { e.stopPropagation(); openMergeEditor(f.path); }}><i className="codicon codicon-git-merge" /></button>
                      <button title="Mark as Resolved (stage)" onClick={(e) => { e.stopPropagation(); markResolved(f); }}><i className="codicon codicon-check" /></button>
                    </span>
                    <span className="git-letter conflict">!</span>
                  </div>
                ))}
              </>
            )}
            {staged.length > 0 && (
              <>
                <div className="section-title">
                  STAGED CHANGES <span className="count">{staged.length}</span>
                  <button className="icon-btn small" title="Unstage All" onClick={() => act("unstage", () => api.gitUnstage(ws, staged.map((f) => f.path)))}><i className="codicon codicon-remove" /></button>
                </div>
                {staged.map((f) => row(f, true))}
              </>
            )}
            <div className="section-title">
              CHANGES <span className="count">{changes.length}</span>
              {changes.length > 0 && (
                <button className="icon-btn small" title="Stage All" onClick={() => act("stage", () => api.gitStage(ws, changes.map((f) => f.path)))}><i className="codicon codicon-add" /></button>
              )}
            </div>
            {changes.map((f) => row(f, false))}
            {files.length === 0 && <div className="muted small pad">No changes.</div>}
            {stashes.length > 0 && (
              <>
                <div className="section-title">STASHES <span className="count">{stashes.length}</span></div>
                {stashes.map((s) => (
                  <div key={"st:" + s.index} className="tree-row git-row" title={s.message}>
                    <i className="codicon codicon-archive" />
                    <span className="name ellipsis">{s.message}</span>
                    <span className="row-actions">
                      <button title="Apply Stash" onClick={() => act("stash", () => api.gitStash(ws, "apply", s.index))}><i className="codicon codicon-check" /></button>
                      <button title="Pop Stash" onClick={() => act("stash", () => api.gitStash(ws, "pop", s.index))}><i className="codicon codicon-arrow-up" /></button>
                      <button title="Drop Stash" onClick={() => act("stash", () => api.gitStash(ws, "drop", s.index))}><i className="codicon codicon-trash" /></button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
