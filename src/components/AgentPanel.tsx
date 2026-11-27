import { useEffect } from "react";
import { set, useStore } from "../store";
import { newSession } from "../lib/agent";
import AgentChat from "./AgentChat";
import { UsageBadge } from "./ModelPicker";
import { DebugToggle } from "./AgentExtras";
import { popOut } from "../lib/agentPlatform";

export default function AgentPanel() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const active = sessions.find((s) => s.id === activeId);

  useEffect(() => {
    if (!active) {
      if (sessions.length) set({ activeSessionId: sessions[0].id });
      else newSession();
    }
  }, [active, sessions]);

  return (
    <div className="panel agent-panel">
      <div className="panel-header">
        <select className="session-select" value={activeId ?? ""} onChange={(e) => set({ activeSessionId: e.target.value })}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.status === "running" ? "● " : s.status === "waiting" ? "◐ " : ""}
              {s.title}
            </option>
          ))}
        </select>
        {active && <UsageBadge sessionId={active.id} />}
        <div className="actions">
          <button title="New Task (Ctrl+Shift+N)" onClick={() => newSession()}><i className="codicon codicon-add" /></button>
          {active && <DebugToggle session={active} />}
          <button title="Pop out: open this session in the Agent Manager" onClick={() => (active ? popOut(active.id) : set({ view: "manager" }))}><i className="codicon codicon-screen-full" /></button>
          <button title="Close" onClick={() => set({ agentOpen: false })}><i className="codicon codicon-close" /></button>
        </div>
      </div>
      {active && <AgentChat key={active.id} sessionId={active.id} compact />}
    </div>
  );
}
