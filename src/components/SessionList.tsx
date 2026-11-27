import { set, useStore } from "../store";
import { deleteSession, newSession } from "../lib/agent";

const STATUS_ICON: Record<string, string> = {
  idle: "circle-large-outline",
  running: "loading codicon-modifier-spin",
  waiting: "bell-dot",
  error: "error",
  stopped: "debug-stop",
};

function ago(ts: number) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionList({ onOpen }: { onOpen?: (id: string) => void }) {
  const sessions = useStore((s) => s.sessions);
  const activeId = useStore((s) => s.activeSessionId);
  return (
    <div className="session-list">
      <button className="btn primary new-task" onClick={() => { const s = newSession(); onOpen?.(s.id); }}>
        <i className="codicon codicon-add" /> New Task
      </button>
      {sessions.length === 0 && <div className="muted small pad">No tasks yet.</div>}
      {sessions.map((s) => {
        const done = s.plan.filter((p) => p.status === "done").length;
        return (
          <div
            key={s.id}
            className={`session-row ${s.id === activeId ? "active" : ""} st-${s.status}`}
            onClick={() => { set({ activeSessionId: s.id }); onOpen?.(s.id); }}
          >
            <i className={`codicon codicon-${STATUS_ICON[s.status] ?? "circle"}`} />
            <div className="session-info">
              <div className="ellipsis">{s.title}</div>
              <div className="muted small">
                {s.status === "waiting" ? "Needs approval · " : ""}
                {s.plan.length > 0 ? `${done}/${s.plan.length} steps · ` : ""}
                {Object.keys(s.changes).length > 0 ? `${Object.keys(s.changes).length} files · ` : ""}
                {ago(s.createdAt)}
              </div>
            </div>
            <button className="icon-btn small del" title="Delete task" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}>
              <i className="codicon codicon-trash" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
