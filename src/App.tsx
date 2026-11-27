import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { loadSettings, onFsChanged, refreshGit } from "./lib/workspace";
import { listenAgentEvents } from "./lib/agent";
import { handleGlobalKey } from "./lib/commands";
import { registerInlineCompletion } from "./lib/ai";
import { loadExtensions } from "./lib/extensions";
import { trackProblems } from "./lib/problems";
import { initLsp } from "./lib/lsp";
import TitleBar from "./components/TitleBar";
import ActivityBar from "./components/ActivityBar";
import Sidebar from "./components/Sidebar";
import EditorArea from "./components/EditorArea";
import TerminalPanel from "./components/TerminalPanel";
import AgentPanel from "./components/AgentPanel";
import AgentManager from "./components/AgentManager";
import StatusBar from "./components/StatusBar";
import CommandPalette from "./components/CommandPalette";
import BranchPicker from "./components/BranchPicker";
import SettingsModal from "./components/SettingsModal";
import InlineEdit from "./components/InlineEdit";
import Toasts from "./components/Toasts";
import ProfilesModal from "./components/ProfilesModal";
import { DevServerPrompt } from "./components/BrowserTab";
import ToolboxOverlay from "./components/ToolboxOverlay";
import { initBrowser } from "./lib/browser";
import KeybindingsModal from "./components/KeybindingsModal";
import LanguageModels from "./components/LanguageModels";
import { SkillsModals } from "./components/SkillsView";
import { Resizer, usePersistentSize } from "./components/Resizer";
import { useSettingsEffects } from "./lib/settingsEffects";

export default function App() {
  const sidebar = useStore((s) => s.sidebar);
  const agentOpen = useStore((s) => s.agentOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const view = useStore((s) => s.view);
  // Settings › Workbench: side bar on the right mirrors the layout, so resizer drags flip.
  const flip = useStore((s) => s.settings.sidebarPosition === "right") ? -1 : 1;
  useSettingsEffects(); // root classes (reduce motion, density…), auto save modes, agent notifications…
  const [sideW, setSideW] = usePersistentSize("sideW", 270);
  const [agentW, setAgentW] = usePersistentSize("agentW", 400);
  const [panelH, setPanelH] = usePersistentSize("panelH", 260);

  useEffect(() => {
    loadSettings().then(loadExtensions);
    registerInlineCompletion();
    const stopProblems = trackProblems();
    const unsubs: Promise<() => void>[] = [
      Promise.resolve(stopProblems),
      Promise.resolve(initLsp()),
      listenAgentEvents(),
      initBrowser(), // integrated browser: dev-server detection, live reload, agent open requests
      (() => {
        let pending: string[] = [];
        let t = 0;
        return listen<string[]>("fs-changed", (e) => {
          pending.push(...e.payload);
          clearTimeout(t);
          t = window.setTimeout(() => {
            const batch = [...new Set(pending)];
            pending = [];
            onFsChanged(batch);
          }, 250);
        });
      })(),
    ];
    const onKey = (e: KeyboardEvent) => {
      if (handleGlobalKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onFocus = () => refreshGit();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focus", onFocus);
    // Disable the webview's default context menu outside text inputs.
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .monaco-editor, .xterm")) e.preventDefault();
    };
    window.addEventListener("contextmenu", onCtx);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("contextmenu", onCtx);
      unsubs.forEach((p) => p.then((f) => f()));
    };
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="main">
        <ActivityBar />
        {view === "manager" && <AgentManager />}
        {/* The editor layout stays mounted in Manager view so editors and terminals keep their state. */}
        <div className="workbench" style={{ display: view === "manager" ? "none" : "flex" }}>
            {sidebar && (
              <>
                <div className="sidebar" style={{ width: sideW }}>
                  <Sidebar />
                </div>
                <Resizer dir="x" onDelta={(d) => setSideW((w) => Math.min(600, Math.max(170, w + d * flip)))} />
              </>
            )}
            <div className="center">
              <div className="editor-wrap">
                <EditorArea />
              </div>
              {panelOpen && <Resizer dir="y" onDelta={(d) => setPanelH((h) => Math.min(800, Math.max(100, h - d)))} />}
              {/* Always mounted so terminal sessions survive hiding the panel. */}
              <div className="bottom-panel" style={{ height: panelH, display: panelOpen ? "flex" : "none" }}>
                <TerminalPanel />
              </div>
            </div>
            {agentOpen && (
              <>
                <Resizer dir="x" onDelta={(d) => setAgentW((w) => Math.min(900, Math.max(300, w - d * flip)))} />
                <div className="agent-side" style={{ width: agentW }}>
                  <AgentPanel />
                </div>
              </>
            )}
        </div>
      </div>
      <StatusBar />
      <CommandPalette />
      <BranchPicker />
      <SettingsModal />
      <InlineEdit />
      <KeybindingsModal />
      <LanguageModels />
      <SkillsModals />
      <ProfilesModal />
      <Toasts />
      <DevServerPrompt />
      <ToolboxOverlay />
    </div>
  );
}
