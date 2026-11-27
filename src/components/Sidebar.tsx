import { useStore } from "../store";
import Explorer from "./Explorer";
import SearchPanel from "./SearchPanel";
import GitPanel from "./GitPanel";
import SessionList from "./SessionList";
import GitHubPanel from "./GitHubPanel";
import ExtensionsPanel from "./ExtensionsPanel";
import RemotePanel from "./RemotePanel";
import DebugPanel from "./DebugPanel";
import TestExplorer from "./TestExplorer";
import SkillsView from "./SkillsView";
import AppleBuildPanel from "./AppleBuildPanel";
import Toolbox from "./Toolbox";
import DockerView from "./DockerView";
import DatabaseView from "./db/DatabaseView";

export default function Sidebar() {
  const view = useStore((s) => s.sidebar);
  switch (view) {
    case "explorer":
      return <Explorer />;
    case "apple":
      return <AppleBuildPanel />;
    case "search":
      return <SearchPanel />;
    case "git":
      return <GitPanel />;
    case "github":
      return <GitHubPanel />;
    case "extensions":
      return <ExtensionsPanel />;
    case "debug":
      return <DebugPanel />;
    case "testing":
      return <TestExplorer />;
    case "remote":
      return <RemotePanel />;
    case "skills":
      return <SkillsView />;
    case "database":
      return <DatabaseView />;
    case "docker":
      return <DockerView />;
    case "toolbox":
      return <Toolbox />;
    case "agents":
      return (
        <div className="panel">
          <div className="panel-header"><span>AGENT TASKS</span></div>
          <SessionList onOpen={() => useStore.setState({ agentOpen: true })} />
        </div>
      );
    default:
      return null;
  }
}
