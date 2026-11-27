// Typed wrappers for the history / refs / merge / patch git commands (src-tauri/src/git.rs), plus
// small UI helpers shared by the Source Control views (commits, branches, timeline, merge editor).
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { api, errMsg } from "./api";
import { basename, relative } from "./paths";
import { get, set, toast, Tab } from "../store";
import { refreshGit } from "./workspace";

export interface GitCommit {
  hash: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: string[];
  /** Repo-relative path at this commit (per-file logs only) */
  file?: string | null;
}
export interface ChangedFile { path: string; oldPath?: string | null; status: string }
export interface CommitDetails { hash: string; body: string; author: string; email: string; time: number; committer: string; parents: string[]; files: ChangedFile[] }
export interface GitBranch { name: string; remote: boolean; current: boolean; upstream: string; ahead: number; behind: number; gone: boolean; hash: string; subject: string; time: number }
export interface GitTag { name: string; hash: string; subject: string }

export const gitx = {
  /** rev: "HEAD", a hash, or an index stage ":0" / ":1" (base) / ":2" (ours) / ":3" (theirs). */
  show: (root: string, rev: string, path: string) => invoke<string>("git_show_rev", { root, rev, path }),
  log: (root: string, opts: { path?: string; maxCount?: number; skip?: number; all?: boolean } = {}) =>
    invoke<GitCommit[]>("git_log", { root, path: opts.path ?? null, maxCount: opts.maxCount ?? null, skip: opts.skip ?? null, all: opts.all ?? null }),
  details: (root: string, hash: string) => invoke<CommitDetails>("git_commit_details", { root, hash }),
  refs: (root: string) => invoke<{ branches: GitBranch[]; tags: GitTag[] }>("git_refs", { root }),
  run: (root: string, args: string[], token?: string) => invoke<string>("git_run", { root, args, token: token || null }),
  apply: (root: string, patch: string, cached: boolean, reverse = false) => invoke<void>("git_apply", { root, patch, cached, reverse }),
};

/** Runs a git operation with a toast for its output/error and a status refresh afterwards. */
export async function gitOp(label: string, args: string[], opts: { network?: boolean; quiet?: boolean } = {}): Promise<boolean> {
  const ws = get().workspace;
  if (!ws) return false;
  try {
    const out = await gitx.run(ws, args, opts.network ? get().settings.githubToken : undefined);
    if (!opts.quiet) toast(out.trim() ? out.trim().split("\n").slice(-2).join(" ") : label);
    return true;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  } finally {
    refreshGit();
    bumpRefs();
  }
}

/** Absolute path of a repo-relative path. */
export function absPath(ws: string, rel: string) {
  const sep = ws.startsWith("ssh://") || !ws.includes("\\") ? "/" : "\\";
  return ws.replace(/[\\/]+$/, "") + sep + rel.replace(/\//g, sep);
}

/** Diff tab between two arbitrary versions (e.g. parent ↔ commit). */
export function openRevDiff(path: string, original: string, modified: string, leftLabel: string, rightLabel: string) {
  const id = `diff:${path.toLowerCase()}:${leftLabel}:${rightLabel}`;
  const tab: Tab = { id, kind: "diff", path, title: `${basename(path)} (${leftLabel} ↔ ${rightLabel})`, original, modified, originalLabel: leftLabel };
  set((s) => ({ tabs: s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => (t.id === id ? tab : t)) : [...s.tabs, tab], activeId: id, view: "editor" }));
}

/** Opens the diff of one file in a commit: first parent ↔ commit. */
export async function openCommitFileDiff(ws: string, c: { hash: string; parents: string[] }, f: ChangedFile) {
  try {
    const short = c.hash.slice(0, 7);
    const parent = c.parents[0];
    const left = parent && f.status !== "A" ? await gitx.show(ws, parent, f.oldPath || f.path).catch(() => "") : "";
    const right = f.status === "D" ? "" : await gitx.show(ws, c.hash, f.path).catch(() => "");
    openRevDiff(absPath(ws, f.path), left, right, parent ? `${short}^` : "empty", short);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export const shortRel = (ws: string | null, p: string) => (ws ? relative(ws, p) : p);

// Cross-view UI state of the Source Control panel.
export type ScmTab = "changes" | "commits" | "branches" | "timeline";
export const useGitUi = create<{ tab: ScmTab; focusCommit: string | null; refsVersion: number }>(() => ({ tab: "changes", focusCommit: null, refsVersion: 0 }));
export const bumpRefs = () => useGitUi.setState((s) => ({ refsVersion: s.refsVersion + 1 }));

/** Shows a commit in the Commits view. */
export function revealCommit(hash: string) {
  useGitUi.setState({ tab: "commits", focusCommit: hash });
  set({ sidebar: "git", view: "editor" });
}

/** Replaces the buffer of `path` with `content` as an undoable edit (keeps a Time Machine snapshot). */
export async function restoreContent(path: string, content: string, what: string) {
  const { openFile, getModelEntry } = await import("./workspace");
  await openFile(path);
  const model = getModelEntry(path)?.model;
  if (!model) return;
  await api.historySave(path, model.getValue(), "restore").catch(() => {});
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null);
  toast(`Restored ${what} — save to keep it, Ctrl+Z to undo`);
}

/** Opens the 3-way merge editor tab for a conflicted file. */
export function openMergeEditor(path: string) {
  const id = "merge:" + path.toLowerCase();
  const tab: Tab = { id, kind: "merge", path, title: `Merging: ${basename(path)}` };
  set((s) => ({ tabs: s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, tab], activeId: id, view: "editor" }));
}

/** Opens a pull request tab (GitHub panel → PR details). */
export function openPullRequest(owner: string, repo: string, number: number, title: string) {
  const id = `pr:${owner}/${repo}#${number}`.toLowerCase();
  const tab: Tab = { id, kind: "pr", path: `${owner}/${repo}/pull/${number}`, title: `PR #${number}: ${title}`, pr: { owner, repo, number } };
  set((s) => ({ tabs: s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, tab], activeId: id, view: "editor" }));
}

/** Parses git status' "ahead 2, behind 1". */
export function aheadBehind(s: string | undefined) {
  const n = (w: string) => Number(s?.match(w === "ahead" ? /ahead (\d+)/ : /behind (\d+)/)?.[1] ?? 0);
  return { ahead: n("ahead"), behind: n("behind") };
}

let syncing = false;
/** "Sync": pull (fast-forward only), then push. */
export async function syncNow() {
  const ws = get().workspace;
  if (!ws || syncing) return;
  syncing = true;
  const token = get().settings.githubToken;
  try {
    toast("Syncing…");
    await api.gitSync(ws, "pull", token);
    await api.gitSync(ws, "push", token);
    toast("Synced with remote");
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    syncing = false;
    refreshGit();
    bumpRefs();
  }
}
