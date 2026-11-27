import { useStore } from "../store";
import SessionList from "./SessionList";
import AgentChat, { PlanView } from "./AgentChat";
import { basename } from "../lib/paths";
import { pickFolder } from "../lib/workspace";
import { DebugToggle } from "./AgentExtras";
import { dock } from "../lib/agentPlatform";

/** Antigravity-style "mission control": many agent tasks side by side. */
export default function AgentManager() {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  const ws = useStore((s) => s.workspace);
  const active = sessions.find((s) => s.id === activeId);
  const running = sessions.filter((s) => s.status === "running").length;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const tokens = sessions.reduce((a, s) => a + s.tokens.input + s.tokens.output, 0);

  return (
    <div className="manager">
      <div className="manager-side">
        <div className="manager-head">
          <h2>Agent Manager</h2>
          <div className="muted small">{ws ? basename(ws) : "No folder open"}</div>
          <div className="stats">
            <div><b>{sessions.length}</b><span>tasks</span></div>
            <div><b className="c-run">{running}</b><span>running</span></div>
            <div><b className="c-wait">{waiting}</b><span>need you</span></div>
            <div><b>{tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens}</b><span>tokens</span></div>
          </div>
        </div>
        <SessionList />
      </div>
      <div className="manager-main">
        {!ws && (
          <div className="note warn" style={{ margin: 16 }}>
            <i className="codicon codicon-warning" /> Open a folder so agents have a workspace.{" "}
            <button className="link" onClick={pickFolder}>Open Folder</button>
          </div>
        )}
        {active ? (
          <div className="manager-conv">
            <div className="manager-chat">
              <div className="manager-title">
                <h3 className="ellipsis">{active.title}</h3>
                <span className={`status-pill st-${active.status}`}>{active.status}</span>
                <span className="muted small">{active.provider}/{active.model}</span>
                <div className="spacer" />
                <div className="actions manager-actions">
                  <DebugToggle session={active} />
                  <button title="Dock: continue this session in the side panel next to the editor" onClick={() => dock(active.id)}><i className="codicon codicon-layout-sidebar-right" /></button>
                </div>
              </div>
              <AgentChat key={active.id} sessionId={active.id} />
            </div>
            <div className="manager-artifacts">
              <h4>Artifacts</h4>
              {active.plan.length === 0 && Object.keys(active.changes).length === 0 && (
                <div className="muted small">The agent's plan and file changes will appear here.</div>
              )}
              <PlanView session={active} />
              <div className="muted small" style={{ marginTop: 12 }}>
                Tokens: {active.tokens.input.toLocaleString()} in · {active.tokens.output.toLocaleString()} out
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state">Create a task to get started.</div>
        )}
      </div>
    </div>
  );
}
