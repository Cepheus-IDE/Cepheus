//! Toolbox UI state (sidebar tab, notices, presentation mode, clipboard picker, commit guard).

import { create } from "zustand";
import type { SecretFinding } from "./secretScan";

export type ToolboxTab = "tasks" | "ports" | "env" | "todo" | "disk" | "utils";

/** Small actionable prompts raised from terminal output (free a port, explain an error). */
export interface Notice { id: number; kind: "port" | "error"; text: string; port?: number; output?: string }

export interface CommitGuard { findings: SecretFinding[]; envFiles: string[]; proceed: () => void }

interface ToolboxState {
  tab: ToolboxTab;
  notices: Notice[];
  presenting: boolean;
  todoCount: number;
  clipPicker: boolean;
  guard: CommitGuard | null;
}

export const useToolbox = create<ToolboxState>(() => ({
  tab: "tasks",
  notices: [],
  presenting: false,
  todoCount: 0,
  clipPicker: false,
  guard: null,
}));

export const isWindows = () => navigator.userAgent.includes("Windows");

let noticeId = 0;
/** Adds a notice (deduplicated by text) that disappears on its own after a while. */
export function pushNotice(n: Omit<Notice, "id">, ttl = 20000) {
  const st = useToolbox.getState();
  if (st.notices.some((x) => x.text === n.text)) return;
  const id = ++noticeId;
  useToolbox.setState({ notices: [...st.notices.slice(-2), { ...n, id }] });
  setTimeout(() => dismissNotice(id), ttl);
}

export function dismissNotice(id: number) {
  useToolbox.setState((s) => ({ notices: s.notices.filter((x) => x.id !== id) }));
}

/** localStorage JSON with a fallback (per-user conveniences only: pins, last exit codes, clips). */
export function loadLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}
