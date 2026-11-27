import { set, useStore, SidebarView } from "../store";
import { refreshGit } from "../lib/workspace";

const ITEMS: { id: SidebarView; icon: string; title: string }[] = [
  { id: "explorer", icon: "files", title: "Explorer (Ctrl+Shift+E)" },
  { id: "search", icon: "search", title: "Search (Ctrl+Shift+F)" },
  { id: "git", icon: "source-control", title: "Source Control (Ctrl+Shift+G)" },
  { id: "debug", icon: "debug-alt", title: "Run and Debug (Ctrl+Shift+D)" },
  { id: "testing", icon: "beaker", title: "Testing" },
  { id: "github", icon: "github", title: "GitHub" },
  { id: "remote", icon: "remote-explorer", title: "Remote · SSH" },
  { id: "agents", icon: "hubot", title: "Agent Tasks" },
  { id: "extensions", icon: "extensions", title: "Extensions (Ctrl+Shift+X)" },
];

export default function ActivityBar() {
  const sidebar = useStore((s) => s.sidebar);
  const view = useStore((s) => s.view);
  const changes = useStore((s) => s.git?.files.length ?? 0);
  const running = useStore((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);

  return (
    <div className="activitybar">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          title={it.title}
          className={view === "editor" && sidebar === it.id ? "active" : ""}
          onClick={() => {
            if (it.id === "git") refreshGit();
            set((s) => ({ view: "editor", sidebar: s.sidebar === it.id && s.view === "editor" ? null : it.id }));
          }}
        >
          <i className={`codicon codicon-${it.icon}`} />
          {it.id === "git" && changes > 0 && <span className="badge">{changes > 99 ? "99+" : changes}</span>}
          {it.id === "agents" && running > 0 && <span className="badge pulse">{running}</span>}
        </button>
      ))}
      <div className="spacer" />
      <button title="Settings" onClick={() => set({ settingsOpen: true })}>
        <i className="codicon codicon-settings-gear" />
      </button>
    </div>
  );
}
