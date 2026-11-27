import { create } from "zustand";
import { DEFAULT_SETTINGS, Settings } from "./lib/settings";
import type { ExtInfo, GitStatus } from "./lib/api";

export interface Tab {
  id: string;
  kind: "file" | "diff" | "extension" | "merge" | "pr" | "browser" | "dbquery" | "dbtable" | "dbdesign" | "dber"; // browser: integrated browser tab, path = current URL; db*: database client (src/components/db)
  path: string;
  /** For extension tabs */
  ext?: { namespace: string; name: string };
  /** For pull request tabs */
  pr?: { owner: string; repo: string; number: number };
  title: string;
  original?: string;
  modified?: string;
  /** For database tabs (dbquery / dbtable / dbdesign / dber) */
  db?: import("./lib/db/types").DbTabRef;
  /** For diff tabs: label shown on the left side */
  originalLabel?: string;
}

export interface Problem { path: string; line: number; col: number; endLine: number; endCol: number; severity: "error" | "warning" | "info"; message: string; source: string }
export type PanelTab = "terminal" | "problems" | "debug" | "tests";

export type SidebarView = "explorer" | "search" | "git" | "debug" | "testing" | "github" | "remote" | "extensions" | "agents" | "skills" | "apple" | "toolbox" | "docker" | "database";

export type ChatItem =
  | { kind: "user"; text: string; /** steering message waiting for the next model turn */ queued?: boolean }
  | { kind: "context"; instructions: string[]; skills: string[]; agent?: string | null; mcpTools?: number; planMode?: boolean }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "error"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      args: any;
      output?: string;
      isError?: boolean;
      status: "running" | "done" | "error" | "approval" | "rejected";
      approvalId?: string;
    };

export interface PlanItem { text: string; status: "pending" | "in_progress" | "done" }
export interface FileChange { before: string | null; after: string }

export interface AgentSession {
  id: string;
  title: string;
  status: "idle" | "running" | "waiting" | "error" | "stopped";
  items: ChatItem[];
  plan: PlanItem[];
  changes: Record<string, FileChange>;
  tokens: { input: number; output: number };
  createdAt: number;
  provider: string;
  model: string;
  /** Agent platform (src/lib/agent.ts): Plan mode, custom agent, self-check, debug log. */
  planMode?: boolean;
  agent?: string;
  verify?: boolean;
  debug?: AgentDebugEntry[];
  showDebug?: boolean;
}

/** One agent debug-log entry (model turn, tool call, hook, check, steer, context). */
export interface AgentDebugEntry { kind: string; ts: number; [k: string]: any }

export interface Toast { id: number; text: string; kind: "info" | "error" }

interface State {
  workspace: string | null;
  settings: Settings;
  settingsOpen: boolean;
  tabs: Tab[];
  activeId: string | null;
  dirty: Record<string, boolean>;
  sidebar: SidebarView | null;
  agentOpen: boolean;
  panelOpen: boolean;
  view: "editor" | "manager";
  palette: null | { mode: "commands" | "files" | "line"; initial?: string };
  inlineEditOpen: boolean;
  cursor: { line: number; col: number; selection: number };
  language: string;
  git: GitStatus | null;
  treeVersion: number;
  sessions: AgentSession[];
  activeSessionId: string | null;
  toasts: Toast[];
  pendingReveal: { path: string; line: number; col: number } | null;
  extensions: ExtInfo[];
  themeVersion: number;
  iconThemeVersion: number;
  timeMachine: boolean;
  /** Live SSH connections by id */
  ssh: Record<string, { label: string; home: string }>;
  panelTab: PanelTab;
  problems: Problem[];
  keybindingsOpen: boolean;
  /** Language server status by Monaco language id */
  lsp: Record<string, { name: string; status: "starting" | "ready" | "error"; message?: string }>;
}

export const useStore = create<State>(() => ({
  workspace: null,
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  tabs: [],
  activeId: null,
  dirty: {},
  sidebar: "explorer",
  agentOpen: true,
  panelOpen: false,
  view: "editor",
  palette: null,
  inlineEditOpen: false,
  cursor: { line: 1, col: 1, selection: 0 },
  language: "",
  git: null,
  treeVersion: 0,
  sessions: [],
  activeSessionId: null,
  toasts: [],
  pendingReveal: null,
  extensions: [],
  themeVersion: 0,
  iconThemeVersion: 0,
  timeMachine: false,
  ssh: {},
  panelTab: "terminal",
  problems: [],
  keybindingsOpen: false,
  lsp: {},
}));

export const set = useStore.setState;
export const get = useStore.getState;

let toastId = 0;
export function toast(text: string, kind: "info" | "error" = "info") {
  // Settings › Notifications: do not disturb hides info toasts; duration in seconds (errors ×2).
  const cfg = get().settings;
  if (kind === "info" && cfg.doNotDisturb) return;
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  const secs = Math.max(1, cfg.toastDuration ?? 3.5);
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), (kind === "error" ? secs * 2 : secs) * 1000);
}

export function updateSession(id: string, fn: (s: AgentSession) => AgentSession) {
  set((st) => ({ sessions: st.sessions.map((s) => (s.id === id ? fn(s) : s)) }));
}
