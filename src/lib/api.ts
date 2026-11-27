import { invoke } from "@tauri-apps/api/core";

const REMOTE_TERM = 1_000_000;

export interface SshParams {
  connId: string;
  label: string;
  host: string;
  port: number;
  user: string;
  auth: "auto" | "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
  passphrase?: string;
  trustFingerprint?: string;
}

export interface DirEntry { name: string; path: string; isDir: boolean }
export interface SearchMatch { path: string; line: number; col: number; len: number; text: string }
export interface SearchOpts { query: string; isRegex: boolean; caseSensitive: boolean; wholeWord: boolean; maxResults?: number }
export interface GitFile { path: string; index: string; worktree: string }
export interface GitStatus { isRepo: boolean; branch: string; aheadBehind: string; files: GitFile[] }
export interface ExtInfo {
  id: string;
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  description: string;
  categories: string[];
  themes: { label: string; uiTheme: string; path: string }[];
  iconThemes: { id: string; label: string; path: string }[];
  snippets: { language: string; path: string }[];
  otherContributions: string[];
  icon: string | null;
  readme: string | null;
  changelog: string | null;
  repository: string | null;
  source: string;
  needsUpdate: boolean;
}
export interface ProviderConfig { provider: string; apiKey: string; model: string; baseUrl?: string; effort?: string }

export const api = {
  readDir: (path: string) => invoke<DirEntry[]>("read_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, content: string) => invoke<void>("write_file", { path, content }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  remove: (path: string) => invoke<void>("delete_path", { path }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),

  search: (root: string, opts: SearchOpts) => invoke<SearchMatch[]>("search_files", { root, opts }),
  listFiles: (root: string) => invoke<string[]>("list_files", { root }),

  /** Local PTY, or a remote shell when `cwd` is an ssh:// path. */
  termSpawn: (cwd: string | null, cols: number, rows: number, shell?: string, args?: string[]) => {
    const m = cwd?.match(/^ssh:\/\/([^/]+)(\/.*)?$/);
    if (m) return invoke<number>("ssh_term_spawn", { connId: m[1], cwd: m[2] ?? "/", cols, rows });
    return invoke<number>("term_spawn", { cwd, cols, rows, shell: shell || null, args: args ?? null });
  },
  termWrite: (id: number, data: string) => invoke<void>(id >= REMOTE_TERM ? "ssh_term_write" : "term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>(id >= REMOTE_TERM ? "ssh_term_resize" : "term_resize", { id, cols, rows }),
  termKill: (id: number) => invoke<void>(id >= REMOTE_TERM ? "ssh_term_kill" : "term_kill", { id }),

  sshConnect: (params: SshParams) => invoke<{ connId: string; home: string; fingerprint: string }>("ssh_connect", { params }),
  sshDisconnect: (connId: string) => invoke<void>("ssh_disconnect", { connId }),
  sshList: () => invoke<{ connId: string; label: string; home: string }[]>("ssh_list"),
  sshConfigHosts: () => invoke<{ alias: string; hostName: string; user: string; port: number; identityFile: string }[]>("ssh_config_hosts"),

  gitStatus: (root: string) => invoke<GitStatus>("git_status", { root }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitCommit: (root: string, message: string) => invoke<string>("git_commit", { root, message }),
  gitDiscard: (root: string, path: string) => invoke<void>("git_discard", { root, path }),
  gitShowHead: (root: string, path: string) => invoke<string>("git_show_head", { root, path }),
  gitInit: (root: string) => invoke<void>("git_init", { root }),
  gitDiffStaged: (root: string) => invoke<string>("git_diff_staged", { root }),
  gitBranches: (root: string) => invoke<string[]>("git_branches", { root }),
  gitCheckout: (root: string, branch: string, create: boolean) => invoke<void>("git_checkout", { root, branch, create }),
  gitSync: (root: string, action: "pull" | "push" | "fetch", token?: string) =>
    invoke<string>("git_sync", { root, action, token: token || null }),
  gitClone: (url: string, parent: string, name: string, token?: string) =>
    invoke<string>("git_clone", { url, parent, name, token: token || null }),
  gitRemote: (root: string) => invoke<string>("git_remote", { root }),
  gitPublish: (root: string, url: string, token?: string) => invoke<string>("git_publish", { root, url, token: token || null }),
  gitCurrentBranch: (root: string) => invoke<string>("git_current_branch", { root }),
  gitBlame: (root: string, path: string) => invoke<{ hash: string; author: string; time: number; summary: string }[]>("git_blame", { root, path }),
  gitStashList: (root: string) => invoke<{ index: number; message: string }[]>("git_stash_list", { root }),
  gitStash: (root: string, action: "push" | "pop" | "apply" | "drop", index?: number, message?: string) =>
    invoke<string>("git_stash", { root, action, index: index ?? null, message: message ?? null }),
  gitIdentity: (root: string) => invoke<{ name: string; email: string }>("git_identity", { root }),
  gitSetIdentity: (root: string, name: string, email: string, global: boolean) => invoke<void>("git_set_identity", { root, name, email, global }),

  openvsxSearch: (query: string, category?: string) => invoke<any>("openvsx_search", { query, category: category || null }),
  openvsxMeta: (namespace: string, name: string) => invoke<any>("openvsx_meta", { namespace, name }),
  openvsxText: (url: string) => invoke<string>("openvsx_text", { url }),
  readDataUrl: (path: string) => invoke<string>("read_data_url", { path }),
  extInstall: (namespace: string, name: string) => invoke<ExtInfo>("ext_install", { namespace, name }),
  extList: () => invoke<ExtInfo[]>("ext_list"),
  extUninstall: (id: string) => invoke<void>("ext_uninstall", { id }),
  vscodeDetect: () => invoke<{ name: string; hasSettings: boolean; extensionCount: number }[]>("vscode_detect"),
  vscodeImport: (editor: string) => invoke<{ settings: string | null; imported: string[] }>("vscode_import", { editor }),

  historySave: (path: string, content: string, label?: string) => invoke<void>("history_save", { path, content, label: label ?? null }),
  historyList: (path: string) => invoke<{ ts: number; size: number; label: string }[]>("history_list", { path }),
  historyRead: (path: string, ts: number) => invoke<string>("history_read", { path, ts }),

  loadSettings: () => invoke<any>("load_settings"),
  saveSettings: (settings: any) => invoke<void>("save_settings", { settings }),
  watchFolder: (path: string) => invoke<void>("watch_folder", { path }),

  agentSend: (req: {
    sessionId: string; workspace: string; message: string; config: ProviderConfig;
    approvalMode: string; context?: string | null; customInstructions?: string;
  }) => invoke<void>("agent_send", { req }),
  agentCancel: (sessionId: string) => invoke<void>("agent_cancel", { sessionId }),
  agentApprove: (approvalId: string, approved: boolean) => invoke<void>("agent_approve", { approvalId, approved }),
  agentReset: (sessionId: string) => invoke<void>("agent_reset", { sessionId }),
  procSpawn: (command: string, cwd: string | null, mode: "lsp" | "raw", env?: Record<string, string>) =>
    invoke<number>("proc_spawn", { command, cwd, mode, env: env ?? null }),
  procWrite: (id: number, data: string, framed: boolean) => invoke<void>("proc_write", { id, data, framed }),
  procKill: (id: number) => invoke<void>("proc_kill", { id }),
  which: (names: string[]) => invoke<string[]>("which", { names }),
  nvidiaModels: (apiKey?: string) => invoke<string[]>("nvidia_models", { apiKey: apiKey || null }),
  aiOneshot: (config: ProviderConfig, system: string, prompt: string, maxTokens?: number) =>
    invoke<string>("ai_oneshot", { config, system, prompt, maxTokens: maxTokens ?? null }),
};

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
