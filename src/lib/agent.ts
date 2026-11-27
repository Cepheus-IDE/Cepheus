import { listen } from "@tauri-apps/api/event";
import { api, errMsg } from "./api";
import { get, set, toast, updateSession, AgentSession, ChatItem } from "../store";
import { providerConfig } from "./settings";
import { sessionConfig } from "./models";
import { cancelHarness, runHarness } from "./harness";
import { activeTab, onFsChanged } from "./workspace";
import { relative } from "./paths";
import { monaco } from "./monaco";
import { applyPlatformEvent, deleteSessionFile, initAgentPersistence, platformReq, steer } from "./agentPlatform";

let counter = 0;

export function newSession(select = true): AgentSession {
  const s = get().settings;
  const sess: AgentSession = {
    id: `s${Date.now().toString(36)}${++counter}`,
    title: "New task",
    status: "idle",
    items: [],
    plan: [],
    changes: {},
    tokens: { input: 0, output: 0 },
    createdAt: Date.now(),
    provider: s.provider,
    model: s.models[s.provider],
  };
  set((st) => ({ sessions: [sess, ...st.sessions], activeSessionId: select ? sess.id : st.activeSessionId }));
  return sess;
}

export function ensureSession(): AgentSession {
  const st = get();
  const existing = st.sessions.find((s) => s.id === st.activeSessionId);
  return existing ?? newSession();
}

export function deleteSession(id: string) {
  api.agentReset(id);
  deleteSessionFile(id); // persisted session + backend history
  set((st) => {
    const sessions = st.sessions.filter((s) => s.id !== id);
    return { sessions, activeSessionId: st.activeSessionId === id ? sessions[0]?.id ?? null : st.activeSessionId };
  });
}

/** Builds editor context (active file + selection) to attach to the message. */
export function editorContext(editor: monaco.editor.ICodeEditor | null): string | null {
  const tab = activeTab();
  const ws = get().workspace;
  if (!tab || tab.kind !== "file") return null;
  let ctx = `Active file: ${relative(ws, tab.path)}`;
  const sel = editor?.getSelection();
  const model = editor?.getModel();
  if (sel && model && !sel.isEmpty()) {
    const text = model.getValueInRange(sel);
    ctx += `\nSelected lines ${sel.startLineNumber}-${sel.endLineNumber}:\n\`\`\`\n${text.slice(0, 20000)}\n\`\`\``;
  } else if (editor?.getPosition()) {
    ctx += `\nCursor at line ${editor.getPosition()!.lineNumber}`;
  }
  return ctx;
}

export async function sendMessage(sessionId: string, text: string, context: string | null) {
  const st = get();
  if (!st.workspace) {
    toast("Open a folder first so the agent has a workspace.", "error");
    return;
  }
  const sess = st.sessions.find((s) => s.id === sessionId);
  if (!sess) return;
  // Steering: a message sent while the agent works is queued into the running loop.
  if ((sess.status === "running" || sess.status === "waiting") && (await steer(sessionId, text))) return;
  const settings = st.settings;
  // Language Models (models.ts): per-session model pick, Auto selection, custom providers.
  const cfg = sessionConfig(sessionId, settings, text);
  updateSession(sessionId, (s) => ({
    ...s,
    title: s.items.length === 0 ? text.slice(0, 60) : s.title,
    items: [...s.items, { kind: "user", text }],
    status: "running",
    provider: cfg.provider,
    model: cfg.model,
  }));
  try {
    // Agent harnesses (harness.ts): Claude Code / Codex CLI sessions bypass the built-in loop.
    if (await runHarness(sessionId, st.workspace, text, context)) return;
    await api.agentSend({
      sessionId,
      workspace: st.workspace,
      message: text,
      config: cfg,
      approvalMode: settings.approvalMode,
      context,
      customInstructions: settings.customInstructions,
      ...platformReq(sessionId), // Plan mode, custom agent, self-check, open files, MCP servers
    });
  } catch (e) {
    updateSession(sessionId, (s) => ({ ...s, status: "error", items: [...s.items, { kind: "error", text: errMsg(e) }] }));
  }
}

export function stopSession(id: string) {
  api.agentCancel(id);
  cancelHarness(id); // no-op unless the session runs a CLI harness
}

export function respondApproval(sessionId: string, approvalId: string, approved: boolean) {
  api.agentApprove(approvalId, approved);
  updateSession(sessionId, (s) => ({
    ...s,
    items: s.items.map((it) =>
      it.kind === "tool" && it.approvalId === approvalId ? { ...it, status: approved ? "running" : "rejected" } : it
    ),
  }));
}

function patchTool(items: ChatItem[], callId: string, patch: Partial<Extract<ChatItem, { kind: "tool" }>>): ChatItem[] {
  return items.map((it) => (it.kind === "tool" && it.callId === callId ? { ...it, ...patch } : it));
}

export async function listenAgentEvents() {
  initAgentPersistence();
  return listen<any>("agent-event", ({ payload: ev }) => {
    const id: string = ev.sessionId;
    updateSession(id, (s) => {
      const platform = applyPlatformEvent(s, ev); // steered / context / debug events
      if (platform) return platform;
      switch (ev.type) {
        case "status":
          return { ...s, status: ev.status };
        case "text":
          return { ...s, items: [...s.items, { kind: "assistant", text: ev.text }] };
        case "thinking":
          return { ...s, items: [...s.items, { kind: "thinking", text: ev.text }] };
        case "warning":
          return { ...s, items: [...s.items, { kind: "warning", text: ev.message }] };
        case "error":
          return { ...s, items: [...s.items, { kind: "error", text: ev.message }] };
        case "toolCall":
          if (ev.name === "update_plan") return s;
          return { ...s, items: [...s.items, { kind: "tool", callId: ev.callId, name: ev.name, args: ev.args, status: "running" }] };
        case "approvalRequest":
          return { ...s, items: patchTool(s.items, ev.callId, { status: "approval", approvalId: ev.approvalId }) };
        case "toolResult":
          if (ev.name === "update_plan") return s;
          return {
            ...s,
            items: patchTool(s.items, ev.callId, {
              output: ev.output,
              isError: ev.isError,
              status: ev.isError ? (s.items.some((i) => i.kind === "tool" && i.callId === ev.callId && i.status === "rejected") ? "rejected" : "error") : "done",
            }),
          };
        case "plan":
          return { ...s, plan: Array.isArray(ev.items) ? ev.items : [] };
        case "fileChanged": {
          const prev = s.changes[ev.path];
          // Time Machine: keep both sides of every agent edit.
          if (ev.before != null) api.historySave(ev.path, ev.before, "before-agent").catch(() => {});
          api.historySave(ev.path, ev.after, "agent").catch(() => {});
          // Remote workspaces have no file watcher: refresh editors/tree directly.
          if (String(ev.path).startsWith("ssh://")) setTimeout(() => onFsChanged([ev.path]), 0);
          return {
            ...s,
            changes: { ...s.changes, [ev.path]: { before: prev ? prev.before : ev.before ?? null, after: ev.after } },
          };
        }
        case "usage":
          return { ...s, tokens: { input: s.tokens.input + ev.inputTokens, output: s.tokens.output + ev.outputTokens } };
      }
      return s;
    });
  });
}

/** Reverts every file the session changed back to its state before the agent touched it. */
export async function revertSessionChanges(sessionId: string) {
  const sess = get().sessions.find((s) => s.id === sessionId);
  if (!sess) return;
  for (const [path, ch] of Object.entries(sess.changes)) {
    try {
      if (ch.before === null) await api.remove(path);
      else await api.writeFile(path, ch.before);
    } catch (e) {
      toast(`Revert failed for ${path}: ${errMsg(e)}`, "error");
    }
  }
  updateSession(sessionId, (s) => ({ ...s, changes: {} }));
  toast("Agent changes reverted");
}

export function acceptSessionChanges(sessionId: string) {
  updateSession(sessionId, (s) => ({ ...s, changes: {} }));
}
