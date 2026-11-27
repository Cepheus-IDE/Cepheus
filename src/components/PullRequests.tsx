import { useEffect, useState } from "react";
import { errMsg } from "../lib/api";
import { gh } from "../lib/github";
import { openPullRequest } from "../lib/gitApi";
import { timeAgo } from "../lib/gitExtras";
import { toast } from "../store";

type Filter = "open" | "closed" | "mine" | "review";
interface Row { number: number; title: string; user: { login: string }; state: string; draft?: boolean; updated_at: string; merged_at?: string | null; pull_request?: { merged_at?: string | null } }

/** Pull requests of the current repository; a click opens the PR in an editor tab. */
export default function PullRequests({ owner, repo }: { owner: string; repo: string }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [rows, setRows] = useState<Row[] | null>(null);

  const load = () => {
    setRows(null);
    const q = filter === "mine" ? "author:@me" : filter === "review" ? "review-requested:@me" : "";
    const req = q
      ? gh<{ items: Row[] }>(`/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} is:pr is:open ${q}`)}&per_page=50`).then((r) => r.items)
      : gh<Row[]>(`/repos/${owner}/${repo}/pulls?state=${filter}&per_page=50&sort=updated&direction=desc`);
    req.then(setRows).catch((e) => { toast(errMsg(e), "error"); setRows([]); });
  };
  useEffect(load, [owner, repo, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="gh-prs">
      <div className="section-title" style={{ padding: "16px 0 6px" }}>
        Pull requests <span className="count">{rows?.length ?? "…"}</span>
        <button className="icon-btn small" title="Refresh" onClick={load}><i className="codicon codicon-refresh" /></button>
      </div>
      <div className="seg small">
        {(["open", "closed", "mine", "review"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "mine" ? "Mine" : f === "review" ? "Review requested" : f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      {rows?.length === 0 && <div className="muted small">No pull requests.</div>}
      {rows?.map((p) => (
        <div key={p.number} className="gh-issue gh-pr" onClick={() => openPullRequest(owner, repo, p.number, p.title)} title="Open pull request">
          <div className="gh-issue-title">
            <i className={`codicon codicon-${p.state === "open" ? (p.draft ? "git-pull-request-draft" : "git-pull-request") : p.merged_at || p.pull_request?.merged_at ? "git-merge" : "git-pull-request-closed"}`} />{" "}
            <span className="num">#{p.number}</span> {p.title}
          </div>
          <div className="gh-issue-meta"><span>{p.user.login} · updated {timeAgo(new Date(p.updated_at).getTime() / 1000)}</span></div>
        </div>
      ))}
    </div>
  );
}
