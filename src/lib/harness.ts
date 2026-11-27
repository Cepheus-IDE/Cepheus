import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { get } from "../store";

/** Agent harnesses: the built-in Cepheus loop, or the Claude Code / Codex CLIs run headless
 *  (backend: src-tauri/src/harness.rs). Their JSON events arrive as normal `agent-event`s. */

export type Harness = "cepheus" | "claude-code" | "codex";

export const HARNESSES: { id: Harness; name: string; exe?: string; install: string; models: string[] }[] = [
  { id: "cepheus", name: "Cepheus", install: "", models: [] },
  {
    id: "claude-code",
    name: "Claude Code",
    exe: "claude",
    install: "npm install -g @anthropic-ai/claude-code (or the native installer), then run `claude` once to sign in.",
    models: ["default", "opus", "sonnet", "haiku", "fable"],
  },
  {
    id: "codex",
    name: "Codex",
    exe: "codex",
    install: "npm install -g @openai/codex, then run `codex` once to sign in.",
    models: ["default", "gpt-5-codex", "gpt-5"],
  },
];

interface HarnessState {
  bySession: Record<string, Harness>;
  model: Record<string, string>;
  /** CLI session/thread id per `<session>|<harness>` for follow-ups. */
  resume: Record<string, string>;
  /** Which CLIs are on PATH (null = not checked yet). */
  installed: Record<string, boolean> | null;
}

export const useHarness = create<HarnessState>(() => ({ bySession: {}, model: {}, resume: {}, installed: null }));

export const harnessOf = (sessionId: string): Harness => useHarness.getState().bySession[sessionId] ?? "cepheus";

export function setHarness(sessionId: string, h: Harness) {
  useHarness.setState((st) => ({ bySession: { ...st.bySession, [sessionId]: h } }));
}
export function setHarnessModel(sessionId: string, m: string) {
  useHarness.setState((st) => ({ model: { ...st.model, [sessionId]: m } }));
}

export async function detectHarnesses(force = false): Promise<Record<string, boolean>> {
  const cur = useHarness.getState().installed;
  if (cur && !force) return cur;
  const exes = HARNESSES.filter((h) => h.exe).map((h) => h.exe!);
  const found = await api.which(exes).catch(() => [] as string[]);
  const installed = Object.fromEntries(exes.map((e) => [e, found.includes(e)]));
  useHarness.setState({ installed });
  return installed;
}

/** Sends the message through a CLI harness. Returns false for the built-in agent. */
export async function runHarness(sessionId: string, workspace: string, message: string, context: string | null): Promise<boolean> {
  const h = harnessOf(sessionId);
  if (h === "cepheus") return false;
  const st = useHarness.getState();
  await invoke("harness_send", {
    req: {
      sessionId,
      harness: h,
      workspace,
      message,
      context,
      resumeId: st.resume[`${sessionId}|${h}`] ?? null,
      approvalMode: get().settings.approvalMode,
      model: st.model[sessionId] ?? null,
    },
  });
  return true;
}

export function cancelHarness(sessionId: string) {
  if (harnessOf(sessionId) !== "cepheus") invoke("harness_cancel", { sessionId }).catch(() => {});
}

const g = globalThis as any;
(g.__cepheusHarnessUnlisten as (() => void) | undefined)?.();
listen<any>("harness-session", ({ payload }) => {
  useHarness.setState((st) => ({ resume: { ...st.resume, [`${payload.sessionId}|${payload.harness}`]: payload.resumeId } }));
}).then((u) => (g.__cepheusHarnessUnlisten = u)).catch(() => {});
