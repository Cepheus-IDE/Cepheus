import { get } from "../store";

export interface GhUser { login: string; name: string | null; avatar_url: string; html_url: string }
export interface GhRepo {
  id: number; name: string; full_name: string; private: boolean; description: string | null;
  clone_url: string; html_url: string; default_branch: string; updated_at: string; language: string | null; stargazers_count: number;
}
export interface GhIssue { number: number; title: string; body: string | null; html_url: string; user: { login: string }; labels: { name: string }[]; pull_request?: unknown; comments: number }

export const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:user,workflow&description=Cepheus%20IDE";

export async function gh<T = any>(path: string, init: RequestInit = {}, token = get().settings.githubToken): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      msg = j.message + (j.errors ? ": " + j.errors.map((e: any) => e.message ?? e.code).join(", ") : "");
    } catch { /* ignore */ }
    throw new Error(`GitHub: ${msg}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** "owner/repo" from an origin URL, or null when it isn't a GitHub remote. */
export function parseRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Raw text response (file contents with `application/vnd.github.raw`, diffs, ...). */
export async function ghText(path: string, accept = "application/vnd.github.raw", token = get().settings.githubToken): Promise<string> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
  return res.text();
}

export interface GhPull {
  number: number; title: string; body: string | null; state: "open" | "closed"; draft?: boolean; merged?: boolean; merged_at?: string | null;
  html_url: string; user: { login: string; avatar_url: string }; created_at: string; updated_at: string;
  head: { ref: string; sha: string; repo: { full_name: string; clone_url: string } | null };
  base: { ref: string; sha: string };
  mergeable?: boolean | null; mergeable_state?: string; comments?: number; review_comments?: number;
  additions?: number; deletions?: number; changed_files?: number; labels: { name: string; color: string }[];
  requested_reviewers?: { login: string }[];
}
export interface GhPullFile { filename: string; previous_filename?: string; status: string; additions: number; deletions: number; patch?: string }
export interface GhComment { id: number; user: { login: string; avatar_url: string }; body: string; created_at: string; html_url: string; path?: string; line?: number | null; original_line?: number | null; diff_hunk?: string; state?: string; submitted_at?: string }
export interface GhCheckRun { id: number; name: string; status: string; conclusion: string | null; html_url: string }
