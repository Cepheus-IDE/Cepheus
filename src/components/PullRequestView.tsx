import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errMsg } from "../lib/api";
import { gh, ghText, GhCheckRun, GhComment, GhPull, GhPullFile } from "../lib/github";
import { absPath, gitx, openRevDiff } from "../lib/gitApi";
import { timeAgo } from "../lib/gitExtras";
import { refreshGit } from "../lib/workspace";
import { get, toast, useStore } from "../store";

function Md({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || "", { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const ago = (iso: string) => timeAgo(new Date(iso).getTime() / 1000);

type Item = { kind: "comment" | "review" | "inline"; c: GhComment };

/** Pull request details: description, checks, files (with diffs), conversation, review and merge. */
export default function PullRequestView({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const ws = useStore((s) => s.workspace);
  const base = `/repos/${owner}/${repo}`;
  const [pr, setPr] = useState<GhPull | null>(null);
  const [files, setFiles] = useState<GhPullFile[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [checks, setChecks] = useState<{ name: string; state: string; url: string }[]>([]);
  const [tab, setTab] = useState<"conversation" | "files" | "checks">("conversation");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [method, setMethod] = useState<"merge" | "squash" | "rebase">("squash");
  const [confirmMerge, setConfirmMerge] = useState(false);

  const load = async () => {
    try {
      const p = await gh<GhPull>(`${base}/pulls/${number}`);
      setPr(p);
      const [f, ic, rv, rc] = await Promise.all([
        gh<GhPullFile[]>(`${base}/pulls/${number}/files?per_page=100`),
        gh<GhComment[]>(`${base}/issues/${number}/comments?per_page=100`),
        gh<GhComment[]>(`${base}/pulls/${number}/reviews?per_page=100`),
        gh<GhComment[]>(`${base}/pulls/${number}/comments?per_page=100`),
      ]);
      setFiles(f);
      const all: Item[] = [
        ...ic.map((c) => ({ kind: "comment" as const, c })),
        ...rv.filter((r) => r.body || r.state !== "COMMENTED").map((c) => ({ kind: "review" as const, c: { ...c, created_at: c.submitted_at ?? c.created_at } })),
        ...rc.map((c) => ({ kind: "inline" as const, c })),
      ].sort((a, b) => a.c.created_at.localeCompare(b.c.created_at));
      setItems(all);
      const [runs, status] = await Promise.all([
        gh<{ check_runs: GhCheckRun[] }>(`${base}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
        gh<{ statuses: { context: string; state: string; target_url: string }[] }>(`${base}/commits/${p.head.sha}/status`).catch(() => ({ statuses: [] })),
      ]);
      setChecks([
        ...runs.check_runs.map((r) => ({ name: r.name, state: r.status === "completed" ? r.conclusion ?? "neutral" : r.status, url: r.html_url })),
        ...status.statuses.map((s) => ({ name: s.context, state: s.state, url: s.target_url })),
      ]);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  useEffect(() => { load(); }, [owner, repo, number]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); }
  };

  const comment = () => run("comment", async () => {
    if (!draft.trim()) throw new Error("Write a comment first");
    await gh(`${base}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body: draft }) });
    setDraft("");
    toast("Comment added");
    await load();
  });

  const review = (event: "APPROVE" | "REQUEST_CHANGES") => run(event, async () => {
    if (event === "REQUEST_CHANGES" && !draft.trim()) throw new Error("Describe the changes you are requesting in the comment box");
    await gh(`${base}/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify({ event, body: draft }) });
    setDraft("");
    toast(event === "APPROVE" ? "Approved" : "Requested changes");
    await load();
  });

  const merge = () => {
    if (!confirmMerge) { setConfirmMerge(true); setTimeout(() => setConfirmMerge(false), 4000); return; }
    setConfirmMerge(false);
    run("merge", async () => {
      const r = await gh<{ message: string }>(`${base}/pulls/${number}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: method }) });
      toast(r.message || "Merged");
      await load();
    });
  };

  const checkout = () => run("checkout", async () => {
    if (!ws || !pr) return;
    const token = get().settings.githubToken;
    const sameRepo = pr.head.repo?.full_name.toLowerCase() === `${owner}/${repo}`.toLowerCase();
    if (sameRepo) {
      await gitx.run(ws, ["fetch", "origin", pr.head.ref], token);
      await gitx.run(ws, ["checkout", pr.head.ref]);
      await gitx.run(ws, ["merge", "--ff-only", `origin/${pr.head.ref}`]).catch(() => "");
      toast(`Checked out ${pr.head.ref}`);
    } else {
      // Fork: GitHub exposes every PR head as refs/pull/<n>/head on the base repository.
      const local = `pr/${number}`;
      const cur = (await gitx.run(ws, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (cur === local) await gitx.run(ws, ["pull", "--ff-only", "origin", `pull/${number}/head`], token);
      else {
        await gitx.run(ws, ["fetch", "origin", `+pull/${number}/head:${local}`], token);
        await gitx.run(ws, ["checkout", local]);
      }
      toast(`Checked out ${local}`);
    }
    refreshGit();
  });

  const openFileDiff = (f: GhPullFile) => run("diff", async () => {
    if (!pr) return;
    const headRepo = pr.head.repo?.full_name ?? `${owner}/${repo}`;
    const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
    const left = f.status === "added" ? "" : await ghText(`${base}/contents/${enc(f.previous_filename ?? f.filename)}?ref=${pr.base.sha}`).catch(() => "");
    const right = f.status === "removed" ? "" : await ghText(`/repos/${headRepo}/contents/${enc(f.filename)}?ref=${pr.head.sha}`).catch(() => "");
    openRevDiff(ws ? absPath(ws, f.filename) : f.filename, left, right, `${pr.base.ref}`, `#${number}`);
  });

  if (!pr) return <div className="pr-view"><div className="muted pad">Loading pull request #{number}…</div></div>;
  const state = pr.merged || pr.merged_at ? "merged" : pr.draft && pr.state === "open" ? "draft" : pr.state;
  const failing = checks.filter((c) => /failure|error|timed_out|cancelled|action_required/.test(c.state)).length;
  const pending = checks.filter((c) => /pending|queued|in_progress|waiting|requested/.test(c.state)).length;

  return (
    <div className="pr-view">
      <div className="pr-head">
        <h2>{pr.title} <span className="muted">#{pr.number}</span></h2>
        <div className="pr-meta">
          <span className={`pr-state ${state}`}>{state}</span>
          <span><b>{pr.user.login}</b> wants to merge <code>{pr.head.ref}</code> into <code>{pr.base.ref}</code></span>
          <span className="muted">· opened {ago(pr.created_at)}</span>
          {pr.additions !== undefined && <span className="muted">· <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span> in {pr.changed_files} files</span>}
          <button className="link" onClick={() => openUrl(pr.html_url)}>Open on GitHub</button>
          <button className="icon-btn" title="Refresh" onClick={load}><i className="codicon codicon-refresh" /></button>
        </div>
        <div className="row gap pr-actions">
          <button className="btn small" disabled={!!busy || !ws} onClick={checkout}><i className="codicon codicon-git-branch" /> Checkout</button>
          {pr.state === "open" && !pr.merged && (
            <>
              <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="merge">Create a merge commit</option>
                <option value="squash">Squash and merge</option>
                <option value="rebase">Rebase and merge</option>
              </select>
              <button className={`btn small ${confirmMerge ? "danger" : "primary"}`} disabled={!!busy} onClick={merge}>
                {confirmMerge ? `Confirm ${method} into ${pr.base.ref}` : "Merge"}
              </button>
              {pr.mergeable === false && <span className="small del">Has conflicts with {pr.base.ref}</span>}
            </>
          )}
        </div>
      </div>
      <div className="pr-tabs">
        {(["conversation", "files", "checks"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t === "conversation" ? `Conversation (${items.length})` : t === "files" ? `Files changed (${files.length})` : `Checks ${checks.length ? (failing ? `✗ ${failing}` : pending ? `… ${pending}` : "✓") : ""}`}
          </button>
        ))}
      </div>
      <div className="pr-body">
        {tab === "conversation" && (
          <>
            <div className="pr-comment">
              <div className="pr-comment-head"><b>{pr.user.login}</b> <span className="muted">{ago(pr.created_at)}</span></div>
              {pr.body ? <Md text={pr.body} /> : <div className="muted">No description provided.</div>}
            </div>
            {items.map(({ kind, c }) => (
              <div key={kind + c.id} className={`pr-comment ${kind}`}>
                <div className="pr-comment-head">
                  <b>{c.user.login}</b>
                  {kind === "review" && <span className={`pr-review ${c.state?.toLowerCase()}`}>{c.state === "APPROVED" ? "approved" : c.state === "CHANGES_REQUESTED" ? "requested changes" : "reviewed"}</span>}
                  {kind === "inline" && <code className="small">{c.path}{c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ""}</code>}
                  <span className="muted">{ago(c.created_at)}</span>
                </div>
                {kind === "inline" && c.diff_hunk && <pre className="pr-hunk">{c.diff_hunk.split("\n").slice(-6).join("\n")}</pre>}
                {c.body && <Md text={c.body} />}
              </div>
            ))}
            <div className="pr-reply">
              <textarea rows={4} placeholder="Leave a comment (Markdown)" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row gap">
                <button className="btn primary small" disabled={!!busy} onClick={comment}>Comment</button>
                {pr.state === "open" && (
                  <>
                    <button className="btn small" disabled={!!busy} onClick={() => review("APPROVE")}><i className="codicon codicon-check" /> Approve</button>
                    <button className="btn small" disabled={!!busy} onClick={() => review("REQUEST_CHANGES")}><i className="codicon codicon-request-changes" /> Request changes</button>
                  </>
                )}
              </div>
            </div>
          </>
        )}
        {tab === "files" && (
          <div className="pr-files">
            {files.map((f) => (
              <div key={f.filename} className="tree-row" onClick={() => openFileDiff(f)} title="Open diff">
                <span className={`git-letter pr-fs-${f.status}`}>{f.status[0].toUpperCase()}</span>
                <span className="name ellipsis">{f.previous_filename ? `${f.previous_filename} → ` : ""}{f.filename}</span>
                <span className="small"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span></span>
              </div>
            ))}
            {files.length === 0 && <div className="muted">No files.</div>}
          </div>
        )}
        {tab === "checks" && (
          <div className="pr-files">
            {checks.map((c, i) => (
              <div key={i} className="tree-row" onClick={() => c.url && openUrl(c.url)}>
                <i className={`codicon codicon-${/success/.test(c.state) ? "pass-filled add" : /failure|error|timed_out|cancelled/.test(c.state) ? "error del" : /skipped|neutral/.test(c.state) ? "circle-slash" : "loading codicon-modifier-spin"}`} />
                <span className="name ellipsis">{c.name}</span>
                <span className="muted small">{c.state}</span>
              </div>
            ))}
            {checks.length === 0 && <div className="muted">No checks reported for {pr.head.sha.slice(0, 7)}.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
