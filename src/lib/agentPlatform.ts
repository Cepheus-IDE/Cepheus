// Agent platform: session persistence, steering, Plan mode, customizations (instructions,
// skills, custom agents, hooks), MCP servers and the per-session debug log.
// Backend: src-tauri/src/agent/{mod,customize,mcp,persist,checks}.rs
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { errMsg } from "./api";
import { get, set, toast, updateSession, useStore, AgentSession, AgentDebugEntry } from "../store";
import { relative } from "./paths";
import { sendMessage } from "./agent";

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

const MAX_DEBUG = 600;
const saved = new Map<string, AgentSession>();
let saveTimer = 0;
let restored = false;

/** What goes to disk: everything except transient run state. */
function serializable(s: AgentSession): AgentSession {
  const busy = s.status === "running" || s.status === "waiting";
  return {
    ...s,
    status: busy ? "stopped" : s.status,
    items: s.items.map((it) =>
      it.kind === "tool" && (it.status === "running" || it.status === "approval")
        ? { ...it, status: "error", approvalId: undefined, output: it.output ?? "Interrupted (app closed)." }
        : it.kind === "user" && it.queued ? { ...it, queued: false } : it
    ),
    debug: s.debug?.slice(-MAX_DEBUG),
  };
}

function flush() {
  for (const s of get().sessions) {
    if (saved.get(s.id) === s) continue;
    saved.set(s.id, s);
    if (s.items.length === 0) continue; // untouched "New task" sessions are not worth keeping
    invoke("agent_session_save", { id: s.id, data: serializable(s) }).catch(() => {});
  }
}

/** Loads saved sessions (once) and keeps them saved (debounced) as they change. */
export async function initAgentPersistence() {
  if (restored) return;
  restored = true;
  try {
    const list = await invoke<AgentSession[]>("agent_sessions_load");
    const loaded = list
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.items))
      .map((s) => ({ ...serializable(s), changes: s.changes ?? {}, plan: s.plan ?? [], tokens: s.tokens ?? { input: 0, output: 0 } }));
    if (loaded.length) {
      set((st) => {
        const ids = new Set(st.sessions.map((s) => s.id));
        // Drop the empty placeholder session created before the restore finished.
        const live = st.sessions.filter((s) => s.items.length > 0 || s.id === st.activeSessionId);
        const sessions = [...live, ...loaded.filter((s) => !ids.has(s.id))];
        const placeholder = st.sessions.find((s) => s.id === st.activeSessionId && s.items.length === 0);
        return {
          sessions: placeholder ? sessions.filter((s) => s !== placeholder) : sessions,
          activeSessionId: placeholder || !st.activeSessionId ? loaded[0].id : st.activeSessionId,
        };
      });
      for (const s of get().sessions) saved.set(s.id, s);
    }
  } catch (e) {
    console.warn("agent session restore failed", e);
  }
  let prev = get().sessions;
  useStore.subscribe((st) => {
    if (st.sessions === prev) return;
    prev = st.sessions;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 800);
  });
  window.addEventListener("beforeunload", flush);
}

export function deleteSessionFile(id: string) {
  saved.delete(id);
  invoke("agent_session_delete", { id }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Run request extras + steering
// ---------------------------------------------------------------------------------------------

/** Extra `agent_send` fields for the agent platform. */
export function platformReq(sessionId: string) {
  const st = get();
  const s = st.sessions.find((x) => x.id === sessionId);
  const ws = st.workspace;
  const openFiles = ws
    ? st.tabs.filter((t) => t.kind === "file" && !t.path.startsWith("untitled")).map((t) => relative(ws, t.path).replace(/\\/g, "/"))
    : [];
  return {
    mode: s?.planMode ? "plan" : null,
    agent: s?.agent || null,
    verify: !!s?.verify,
    openFiles,
    mcpServers: st.settings.mcpServers ?? {},
  };
}

/** Queues a message into a running session. Returns false when the session is not running. */
export async function steer(sessionId: string, text: string): Promise<boolean> {
  try {
    const queued = await invoke<boolean>("agent_steer", { sessionId, message: text });
    if (queued) updateSession(sessionId, (s) => ({ ...s, items: [...s.items, { kind: "user", text, queued: true }] }));
    return queued;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  }
}

/** Plan mode is done: continue the same conversation in normal mode. */
export function startImplementation(sessionId: string) {
  updateSession(sessionId, (s) => ({ ...s, planMode: false }));
  sendMessage(sessionId, "The plan is approved. Implement it now, step by step, keeping the plan checklist updated.", null);
}

export function setSessionOption(sessionId: string, patch: Partial<Pick<AgentSession, "planMode" | "agent" | "verify" | "showDebug">>) {
  updateSession(sessionId, (s) => ({ ...s, ...patch }));
}

/** Applies platform events to a session. Returns null for events it does not handle. */
export function applyPlatformEvent(s: AgentSession, ev: any): AgentSession | null {
  switch (ev.type) {
    case "steered": {
      // Mark the oldest queued copy as delivered.
      let done = false;
      const items = s.items.map((it) => {
        if (!done && it.kind === "user" && it.queued && it.text === ev.text) {
          done = true;
          return { ...it, queued: false };
        }
        return it;
      });
      return { ...s, items };
    }
    case "context":
      return {
        ...s,
        items: [...s.items, { kind: "context", instructions: ev.instructions ?? [], skills: ev.skills ?? [], agent: ev.agent, mcpTools: ev.mcpTools, planMode: ev.planMode }],
      };
    case "debug": {
      const debug = [...(s.debug ?? []), ev.entry as AgentDebugEntry];
      return { ...s, debug: debug.length > MAX_DEBUG ? debug.slice(-MAX_DEBUG) : debug };
    }
    case "status":
      // A run that ends drops steering messages it never consumed.
      if (ev.status !== "running" && ev.status !== "waiting" && s.items.some((i) => i.kind === "user" && i.queued)) {
        return {
          ...s,
          status: ev.status,
          items: [
            ...s.items.map((i) => (i.kind === "user" && i.queued ? { ...i, queued: false } : i)),
            { kind: "warning", text: "A message sent during the run was not delivered before it ended; send it again." },
          ],
        };
      }
      return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Customizations
// ---------------------------------------------------------------------------------------------

export interface CustomAgent { name: string; description: string; tools: string[] | null; model: string | null; path: string }
export interface Customizations {
  instructions: { path: string; applyTo: string | null }[];
  skills: { name: string; description: string; source: string; dir: string }[];
  agents: CustomAgent[];
  hooks: { event: string; matcher: string | null; command: string }[];
}

const EMPTY: Customizations = { instructions: [], skills: [], agents: [], hooks: [] };
export const useCustomizations = create<{ ws: string | null; data: Customizations }>(() => ({ ws: null, data: EMPTY }));

export async function refreshCustomizations(force = false) {
  const ws = get().workspace;
  if (!ws) return useCustomizations.setState({ ws: null, data: EMPTY });
  if (!force && useCustomizations.getState().ws === ws) return;
  useCustomizations.setState({ ws });
  try {
    const data = await invoke<Customizations>("agent_customizations", { workspace: ws });
    if (get().workspace === ws) useCustomizations.setState({ ws, data });
  } catch {
    /* no workspace customizations */
  }
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

export interface McpStatus {
  name: string;
  source: "user" | "workspace";
  status: "running" | "stopped" | "error" | "starting";
  error: string | null;
  tools: { name: string; description: string }[];
  config: any;
  transport: "stdio" | "http";
}

export const mcpApi = {
  status: (servers: any) => invoke<McpStatus[]>("mcp_status", { workspace: get().workspace ?? "", servers }),
  start: (servers: any, name: string) => invoke<void>("mcp_start", { workspace: get().workspace ?? "", servers, name }),
  stop: (name: string) => invoke<void>("mcp_stop", { name }),
};

// ---------------------------------------------------------------------------------------------
// Debug log summary
// ---------------------------------------------------------------------------------------------

export function debugSummary(entries: AgentDebugEntry[]) {
  const turns = entries.filter((e) => e.kind === "turn");
  const tools = entries.filter((e) => e.kind === "tool");
  const byTool: Record<string, { n: number; ms: number; errors: number }> = {};
  for (const t of tools) {
    const b = (byTool[t.name] ??= { n: 0, ms: 0, errors: 0 });
    b.n++;
    b.ms += t.durationMs ?? 0;
    if (t.error) b.errors++;
  }
  return {
    turns: turns.length,
    modelMs: turns.reduce((a, t) => a + (t.durationMs ?? 0), 0),
    toolMs: tools.reduce((a, t) => a + (t.durationMs ?? 0), 0),
    input: turns.reduce((a, t) => a + (t.inputTokens ?? 0), 0),
    output: turns.reduce((a, t) => a + (t.outputTokens ?? 0), 0),
    toolCalls: tools.length,
    toolErrors: tools.filter((t) => t.error).length,
    hooks: entries.filter((e) => e.kind === "hook").length,
    blocked: entries.filter((e) => e.kind === "hook" && e.blocked).length,
    checks: entries.filter((e) => e.kind === "check"),
    byTool,
  };
}

/** Pop out / dock: one click between the side panel and the Agent Manager, same session. */
export function popOut(sessionId: string) {
  set({ activeSessionId: sessionId, view: "manager" });
}
export function dock(sessionId: string) {
  set({ activeSessionId: sessionId, view: "editor", agentOpen: true });
}
