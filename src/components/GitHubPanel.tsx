import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errMsg } from "../lib/api";
import { gh, GhIssue, GhRepo, GhUser, parseRemote, TOKEN_URL } from "../lib/github";
import { openFolder, refreshGit, saveSettings } from "../lib/workspace";
import { newSession, sendMessage } from "../lib/agent";
import { basename } from "../lib/paths";
import { get, set, toast, useStore } from "../store";
import PullRequests from "./PullRequests";

export default function GitHubPanel() {
  const token = useStore((s) => s.settings.githubToken);
  const ws = useStore((s) => s.workspace);
  const [user, setUser] = useState<GhUser | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!token) return setUser(null);
    gh<GhUser>("/user").then(setUser).catch((e) => { toast(errMsg(e), "error"); setUser(null); });
  }, [token]);

  const connect = async () => {
    setBusy("connect");
    try {
      const u = await gh<GhUser>("/user", {}, draft.trim());
      await saveSettings({ ...get().settings, githubToken: draft.trim() });
      setUser(u);
      setDraft("");
      toast(`Connected as ${u.login}`);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  if (!token || !user) {
    return (
      <div className="panel">
        <div className="panel-header"><span>GitHub</span></div>
        <div className="gh-connect">
          <i className="codicon codicon-github" />
          <h3>Connect GitHub</h3>
          <p className="muted small">Clone and publish repositories, open pull requests, and hand issues straight to the agent.</p>
          <ol className="muted small">
            <li><button className="link" onClick={() => openUrl(TOKEN_URL)}>Create a personal access token</button> (scopes <code>repo</code>, <code>read:user</code>).</li>
            <li>Paste it below.</li>
          </ol>
          <input type="password" placeholder="ghp_… or github_pat_…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} />
          <button className="btn primary" disabled={!draft.trim() || !!busy} onClick={connect}>{busy ? "Connecting…" : "Connect"}</button>
          <p className="muted small">The token is stored only on this computer and is sent only to github.com.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <span>GitHub</span>
        <div className="actions">
          <button title="Disconnect" onClick={() => saveSettings({ ...get().settings, githubToken: "" })}><i className="codicon codicon-debug-disconnect" /></button>
        </div>
      </div>
      <div className="gh-user">
        <img src={user.avatar_url} alt="" />
        <div>
          <div>{user.name ?? user.login}</div>
          <button className="link small" onClick={() => openUrl(user.html_url)}>@{user.login}</button>
        </div>
      </div>
      <div className="tree">
        {ws && <ThisRepo ws={ws} user={user} />}
        <RepoList />
      </div>
    </div>
  );
}

function ThisRepo({ ws, user }: { ws: string; user: GhUser }) {
  const token = useStore((s) => s.settings.githubToken);
  const gitInfo = useStore((s) => s.git);
  const [remote, setRemote] = useState<{ owner: string; repo: string } | null | undefined>(undefined);
  const [repo, setRepo] = useState<GhRepo | null>(null);
  const [issues, setIssues] = useState<GhIssue[]>([]);
  const [prOpen, setPrOpen] = useState(false);
  const [pr, setPr] = useState({ title: "", body: "" });
  const [pub, setPub] = useState({ name: basename(ws).replace(/[^\w.-]+/g, "-"), priv: true });
  const [busy, setBusy] = useState("");

  const load = async () => {
    const url = await api.gitRemote(ws);
    const r = parseRemote(url);
    setRemote(r);
    if (r) {
      gh<GhRepo>(`/repos/${r.owner}/${r.repo}`).then(setRepo).catch(() => setRepo(null));
      gh<GhIssue[]>(`/repos/${r.owner}/${r.repo}/issues?state=open&per_page=30`).then((l) => setIssues(l.filter((i) => !i.pull_request))).catch(() => setIssues([]));
    }
  };
  useEffect(() => { load(); }, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); refreshGit(); }
  };

  const publish = () => run("publish", async () => {
    const created = await gh<GhRepo>("/user/repos", { method: "POST", body: JSON.stringify({ name: pub.name, private: pub.priv }) });
    await api.gitPublish(ws, created.clone_url, token);
    toast(`Published to ${created.full_name}`);
    await load();
  });

  const createPr = () => run("pr", async () => {
    if (!remote || !repo) return;
    const branch = await api.gitCurrentBranch(ws);
    if (!branch || branch === repo.default_branch) throw new Error(`You're on ${branch || "no branch"}. Create a feature branch first (Source Control → checkout -b), commit, then open a PR.`);
    await api.gitSync(ws, "push", token);
    const res = await gh<{ html_url: string; number: number }>(`/repos/${remote.owner}/${remote.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: pr.title || branch, body: pr.body, head: branch, base: repo.default_branch }),
    });
    toast(`Pull request #${res.number} created`);
    setPrOpen(false);
    setPr({ title: "", body: "" });
    openUrl(res.html_url);
  });

  const solve = (i: GhIssue) => {
    const s = newSession();
    set({ agentOpen: true, view: "editor" });
    sendMessage(
      s.id,
      `Resolve GitHub issue #${i.number}: "${i.title}"\n\n${i.body ?? "(no description)"}\n\nInvestigate the codebase, make the fix, and verify it. Finish with a short summary I can paste into the pull request, ending with "Fixes #${i.number}".`,
      null
    );
  };

  if (remote === undefined) return null;

  if (!remote) {
    return (
      <div className="gh-section">
        <div className="section-title" style={{ padding: "0 0 8px" }}>Publish this folder</div>
        <p className="muted small" style={{ margin: "0 0 8px" }}>Create a new repository under <b>{user.login}</b> and push <b>{basename(ws)}</b> to it.</p>
        <input value={pub.name} onChange={(e) => setPub({ ...pub, name: e.target.value })} />
        <label className="check small"><input type="checkbox" checked={pub.priv} onChange={(e) => setPub({ ...pub, priv: e.target.checked })} /> Private</label>
        <button className="btn primary" disabled={!pub.name || !!busy} onClick={publish}>{busy ? "Publishing…" : "Publish to GitHub"}</button>
      </div>
    );
  }

  return (
    <div className="gh-section">
      <div className="gh-repo-head">
        <button className="link" onClick={() => repo && openUrl(repo.html_url)}>{remote.owner}/{remote.repo}</button>
        <span className="muted small">{gitInfo?.branch}</span>
      </div>
      <div className="row gap" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={() => setPrOpen((v) => !v)}><i className="codicon codicon-git-pull-request" /> Pull request</button>
        <button className="btn small" disabled={!!busy} onClick={() => run("push", async () => { toast((await api.gitSync(ws, "push", token)) || "Pushed"); })}>
          <i className="codicon codicon-arrow-up" /> Push
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => run("pull", async () => { toast((await api.gitSync(ws, "pull", token)) || "Up to date"); })}>
          <i className="codicon codicon-arrow-down" /> Pull
        </button>
      </div>
      {prOpen && (
        <div className="pr-form">
          <input placeholder="Title (defaults to branch name)" value={pr.title} onChange={(e) => setPr({ ...pr, title: e.target.value })} />
          <textarea rows={4} placeholder="Description" value={pr.body} onChange={(e) => setPr({ ...pr, body: e.target.value })} />
          <button className="btn primary small" disabled={!!busy} onClick={createPr}>{busy === "pr" ? "Creating…" : `Push & open PR → ${repo?.default_branch ?? ""}`}</button>
        </div>
      )}
      <PullRequests owner={remote.owner} repo={remote.repo} />
      <div className="section-title" style={{ padding: "16px 0 6px" }}>Open issues <span className="count">{issues.length}</span></div>
      {issues.length === 0 && <div className="muted small">No open issues.</div>}
      {issues.map((i) => (
        <div key={i.number} className="gh-issue">
          <div className="gh-issue-title" onClick={() => openUrl(i.html_url)} title="Open on GitHub">
            <span className="num">#{i.number}</span> {i.title}
          </div>
          <div className="gh-issue-meta">
            <span>{i.user.login}{i.comments ? ` · ${i.comments} comments` : ""}</span>
            <button className="solve" onClick={() => solve(i)} title="Create an agent task that fixes this issue">
              <i className="codicon codicon-hubot" /> Solve with agent
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RepoList() {
  const token = useStore((s) => s.settings.githubToken);
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    gh<GhRepo[]>("/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member").then(setRepos).catch(() => {});
  }, [token]);

  const clone = async (r: GhRepo) => {
    const parent = await openDialog({ directory: true, title: `Clone ${r.full_name} into…` });
    if (typeof parent !== "string") return;
    setBusy(r.full_name);
    try {
      const dest = await api.gitClone(r.clone_url, parent, r.name, token);
      toast(`Cloned ${r.full_name}`);
      await openFolder(dest);
      set({ sidebar: "explorer" });
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const shown = repos.filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="gh-section">
      <div className="section-title" style={{ padding: "0 0 8px" }}>Your repositories <span className="count">{repos.length}</span></div>
      <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 6 }} />
      {shown.map((r) => (
        <div key={r.id} className="gh-repo">
          <div className="gh-repo-info">
            <div className="ellipsis">{r.full_name}{r.private && <span className="tag">private</span>}</div>
            <div className="muted small ellipsis">{r.description ?? ""}{r.language ? ` · ${r.language}` : ""}</div>
          </div>
          <button className="btn small" disabled={!!busy} onClick={() => clone(r)}>{busy === r.full_name ? "…" : "Clone"}</button>
        </div>
      ))}
    </div>
  );
}
