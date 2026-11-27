import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { get, set, useStore } from "../store";
import { basename } from "../lib/paths";
import { commands } from "../lib/commands";
import { editorRef } from "../lib/ai";

type Item = { label: string; keys?: string; run: () => void; disabled?: boolean } | "sep";

const appWindow = getCurrentWindow();

/** Run a registered command by id. */
const cmd = (id: string) => () => commands.find((c) => c.id === id)?.run();
/** Run a Monaco editor action on the active editor. */
const ed = (action: string) => () => {
  const e = editorRef.current;
  if (!e) return;
  e.focus();
  e.trigger("menu", action, null);
};

function menus(): { name: string; items: Item[] }[] {
  const s = get();
  return [
    {
      name: "File",
      items: [
        { label: "New Agent Task", keys: "Ctrl+Shift+N", run: cmd("agent.new") },
        "sep",
        { label: "Open Folder…", keys: "Ctrl+O", run: cmd("file.openFolder") },
        { label: "Close Folder", run: cmd("file.closeFolder"), disabled: !s.workspace },
        "sep",
        { label: "Save", keys: "Ctrl+S", run: cmd("file.save"), disabled: !s.activeId },
        { label: "Save All", keys: "Ctrl+Alt+S", run: cmd("file.saveAll") },
        "sep",
        { label: "Preferences: Settings", keys: "Ctrl+,", run: cmd("settings.open") },
        { label: "Preferences: Keyboard Shortcuts", run: cmd("settings.keybindings") },
        { label: "Preferences: Profiles…", run: cmd("profiles.show") },
        { label: "Preferences: Settings Sync…", run: cmd("sync.show") },
        "sep",
        { label: "Close Editor", keys: "Ctrl+W", run: cmd("file.closeTab"), disabled: !s.activeId },
        { label: "Exit", run: () => appWindow.close() },
      ],
    },
    {
      name: "Edit",
      items: [
        { label: "Undo", keys: "Ctrl+Z", run: ed("undo") },
        { label: "Redo", keys: "Ctrl+Y", run: ed("redo") },
        "sep",
        { label: "Cut", keys: "Ctrl+X", run: ed("editor.action.clipboardCutAction") },
        { label: "Copy", keys: "Ctrl+C", run: ed("editor.action.clipboardCopyAction") },
        { label: "Paste", keys: "Ctrl+V", run: ed("editor.action.clipboardPasteAction") },
        "sep",
        { label: "Find", keys: "Ctrl+F", run: cmd("editor.find") },
        { label: "Replace", keys: "Ctrl+H", run: cmd("editor.replace") },
        "sep",
        { label: "Find in Files", keys: "Ctrl+Shift+F", run: cmd("view.search") },
        "sep",
        { label: "Toggle Line Comment", keys: "Ctrl+/", run: ed("editor.action.commentLine") },
        { label: "Format Document", keys: "Shift+Alt+F", run: cmd("editor.format") },
        { label: "Inline AI Edit", keys: "Ctrl+K", run: cmd("agent.inlineEdit") },
      ],
    },
    {
      name: "Selection",
      items: [
        { label: "Select All", keys: "Ctrl+A", run: ed("editor.action.selectAll") },
        { label: "Expand Selection", keys: "Shift+Alt+Right", run: ed("editor.action.smartSelect.expand") },
        { label: "Shrink Selection", keys: "Shift+Alt+Left", run: ed("editor.action.smartSelect.shrink") },
        "sep",
        { label: "Copy Line Up", keys: "Shift+Alt+Up", run: ed("editor.action.copyLinesUpAction") },
        { label: "Copy Line Down", keys: "Shift+Alt+Down", run: ed("editor.action.copyLinesDownAction") },
        { label: "Move Line Up", keys: "Alt+Up", run: ed("editor.action.moveLinesUpAction") },
        { label: "Move Line Down", keys: "Alt+Down", run: ed("editor.action.moveLinesDownAction") },
        "sep",
        { label: "Add Cursor Above", keys: "Ctrl+Alt+Up", run: ed("editor.action.insertCursorAbove") },
        { label: "Add Cursor Below", keys: "Ctrl+Alt+Down", run: ed("editor.action.insertCursorBelow") },
        { label: "Add Next Occurrence", keys: "Ctrl+D", run: ed("editor.action.addSelectionToNextFindMatch") },
        { label: "Select All Occurrences", keys: "Ctrl+Shift+L", run: ed("editor.action.selectHighlights") },
      ],
    },
    {
      name: "View",
      items: [
        { label: "Command Palette…", keys: "Ctrl+Shift+P", run: () => set({ palette: { mode: "commands" } }) },
        "sep",
        { label: "Explorer", keys: "Ctrl+Shift+E", run: cmd("view.explorer") },
        { label: "Search", keys: "Ctrl+Shift+F", run: cmd("view.search") },
        { label: "Source Control", keys: "Ctrl+Shift+G", run: cmd("view.git") },
        { label: "Extensions", keys: "Ctrl+Shift+X", run: cmd("view.extensions") },
        { label: "GitHub", run: cmd("view.github") },
        "sep",
        { label: "Agent Manager", keys: "Ctrl+Shift+M", run: cmd("view.manager") },
        { label: "Time Machine", keys: "Ctrl+Alt+H", run: cmd("view.timeMachine") },
        { label: "Problems", run: cmd("view.problems") },
        "sep",
        { label: "Toggle Primary Side Bar", keys: "Ctrl+B", run: cmd("view.toggleSidebar") },
        { label: "Toggle Panel", keys: "Ctrl+`", run: cmd("view.toggleTerminal") },
        { label: "Toggle Agent Panel", keys: "Ctrl+L", run: cmd("view.toggleAgent") },
        "sep",
        { label: "Word Wrap", keys: "Alt+Z", run: cmd("editor.wrap") },
        "sep",
        { label: "Zoom In", keys: "Ctrl+=", run: cmd("view.zoomIn") },
        { label: "Zoom Out", keys: "Ctrl+-", run: cmd("view.zoomOut") },
        { label: "Reset Zoom", keys: "Ctrl+0", run: cmd("view.zoomReset") },
      ],
    },
    {
      name: "Go",
      items: [
        { label: "Go to File…", keys: "Ctrl+P", run: cmd("go.file") },
        { label: "Go to Symbol in Editor…", keys: "Ctrl+Shift+O", run: cmd("editor.symbol") },
        { label: "Go to Line…", keys: "Ctrl+G", run: cmd("go.line") },
        "sep",
        { label: "Go to Definition", keys: "F12", run: ed("editor.action.revealDefinition") },
        { label: "Go to References", keys: "Shift+F12", run: ed("editor.action.goToReferences") },
        "sep",
        { label: "Next Problem", keys: "F8", run: ed("editor.action.marker.nextInFiles") },
        { label: "Previous Problem", keys: "Shift+F8", run: ed("editor.action.marker.prevInFiles") },
      ],
    },
    {
      name: "Run",
      items: [
        { label: "Start Debugging", keys: "F5", run: cmd("debug.start") },
        { label: "Stop Debugging", keys: "Shift+F5", run: cmd("debug.stop") },
        { label: "Restart Debugging", keys: "Ctrl+Shift+F5", run: cmd("debug.restart") },
        "sep",
        { label: "Step Over", keys: "F10", run: cmd("debug.stepOver") },
        { label: "Step Into", keys: "F11", run: cmd("debug.stepInto") },
        { label: "Step Out", keys: "Shift+F11", run: cmd("debug.stepOut") },
        { label: "Continue", keys: "F5", run: cmd("debug.start") },
        "sep",
        { label: "Toggle Breakpoint", keys: "F9", run: cmd("debug.toggleBreakpoint") },
        { label: "New Conditional Breakpoint…", run: cmd("debug.addConditionalBreakpoint") },
        { label: "New Logpoint…", run: cmd("debug.addLogpoint") },
        { label: "Activate / Deactivate All Breakpoints", run: cmd("debug.toggleBreakpointsActive") },
        "sep",
        { label: "Add Configuration…", run: cmd("debug.addConfiguration") },
        { label: "Run and Debug View", keys: "Ctrl+Shift+D", run: cmd("view.debug") },
        "sep",
        { label: "Run All Tests", run: cmd("test.runAll") },
        { label: "Run All Tests with Coverage", run: cmd("test.runAllCoverage") },
        { label: "Testing View", run: cmd("view.testing") },
        "sep",
        { label: "Build for iOS / macOS (Cloud)…", run: cmd("apple.open") },
      ],
    },
    {
      name: "Terminal",
      items: [
        { label: "New Terminal", keys: "Ctrl+Shift+`", run: () => { set({ panelOpen: true }); window.dispatchEvent(new Event("cepheus:new-terminal")); } },
        { label: "Toggle Terminal", keys: "Ctrl+`", run: cmd("view.toggleTerminal") },
        "sep",
        { label: "Explain Last Error with Agent", run: cmd("toolbox.explainError") },
      ],
    },
    {
      name: "Tools",
      items: [
        { label: "Run Project Script…", run: cmd("toolbox.scripts") },
        { label: "Listening Ports…", run: cmd("toolbox.ports") },
        { label: ".env Manager", run: cmd("toolbox.env") },
        { label: "TODO / FIXME Tree", run: cmd("toolbox.todo") },
        "sep",
        { label: "Scan Staged Changes for Secrets", run: cmd("toolbox.scanSecrets") },
        { label: "Presentation Mode (mask secrets)", run: cmd("toolbox.present") },
        { label: "Clipboard History…", keys: "Ctrl+Shift+V", run: cmd("toolbox.clipboard") },
        "sep",
        { label: "Developer Utilities", run: cmd("toolbox.utils") },
        { label: "Free Disk Space…", run: cmd("toolbox.sweep") },
      ],
    },
    {
      name: "Help",
      items: [
        { label: "Show All Commands", keys: "Ctrl+Shift+P", run: () => set({ palette: { mode: "commands" } }) },
        "sep",
        { label: "Monaco Editor Docs", run: () => openUrl("https://microsoft.github.io/monaco-editor/") },
        { label: "Open VSX Registry", run: () => openUrl("https://open-vsx.org/") },
        "sep",
        { label: "Check for Updates…", run: cmd("update.check") },
      ],
    },
  ];
}

function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // Recomputed on every render so enabled/disabled states are current when a menu opens.
  const list = menus();

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    const onBlur = () => setOpen(null);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  return (
    <div className="menubar" ref={ref}>
      {list.map((m, i) => (
        <div key={m.name} className="menubar-entry">
          <button
            className={`menubar-btn ${open === i ? "on" : ""}`}
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === i ? null : i); }}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.name}
          </button>
          {open === i && (
            <div className="menu-dropdown" role="menu">
              {m.items.map((it, j) =>
                it === "sep" ? (
                  <div key={j} className="menu-sep" />
                ) : (
                  <button
                    key={j}
                    role="menuitem"
                    className="menu-item"
                    disabled={it.disabled}
                    onClick={() => { setOpen(null); it.run(); }}
                  >
                    <span>{it.label}</span>
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    appWindow.isMaximized().then(setMaximized);
    const un = appWindow.onResized(() => appWindow.isMaximized().then(setMaximized));
    return () => { un.then((f) => f()); };
  }, []);
  return (
    <div className="win-controls">
      <button title="Minimize" onClick={() => appWindow.minimize()}><i className="codicon codicon-chrome-minimize" /></button>
      <button title={maximized ? "Restore Down" : "Maximize"} onClick={() => appWindow.toggleMaximize()}>
        <i className={`codicon codicon-${maximized ? "chrome-restore" : "chrome-maximize"}`} />
      </button>
      <button className="close" title="Close" onClick={() => appWindow.close()}><i className="codicon codicon-chrome-close" /></button>
    </div>
  );
}

export default function TitleBar() {
  const ws = useStore((s) => s.workspace);
  const view = useStore((s) => s.view);
  const sidebar = useStore((s) => s.sidebar);
  const agentOpen = useStore((s) => s.agentOpen);
  const panelOpen = useStore((s) => s.panelOpen);
  const running = useStore((s) => s.sessions.filter((x) => x.status === "running" || x.status === "waiting").length);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="tb-logo" data-tauri-drag-region><Logo size={16} /></div>
      <MenuBar />
      <div className="tb-drag" data-tauri-drag-region />
      <button className="command-center" onClick={() => set({ palette: { mode: "files" } })}>
        <i className="codicon codicon-search" />
        <span>{ws ? basename(ws) : "Cepheus IDE"}</span>
      </button>
      <div className="tb-drag" data-tauri-drag-region />
      <div className="tb-right">
        <button
          className={`icon-btn ${view === "manager" ? "on" : ""}`}
          title="Agent Manager (Ctrl+Shift+M)"
          onClick={() => set((s) => ({ view: s.view === "manager" ? "editor" : "manager" }))}
        >
          <i className="codicon codicon-hubot" />
          {running > 0 && <span className="tb-badge">{running}</span>}
        </button>
        <span className="tb-divider" />
        <button className={`icon-btn ${sidebar ? "on" : ""}`} title="Toggle Primary Side Bar (Ctrl+B)" onClick={() => set((s) => ({ sidebar: s.sidebar ? null : "explorer" }))}>
          <i className={`codicon codicon-${sidebar ? "layout-sidebar-left" : "layout-sidebar-left-off"}`} />
        </button>
        <button className={`icon-btn ${panelOpen ? "on" : ""}`} title="Toggle Panel (Ctrl+`)" onClick={() => set((s) => ({ panelOpen: !s.panelOpen }))}>
          <i className={`codicon codicon-${panelOpen ? "layout-panel" : "layout-panel-off"}`} />
        </button>
        <button className={`icon-btn ${agentOpen ? "on" : ""}`} title="Toggle Agent Panel (Ctrl+L)" onClick={() => set((s) => ({ agentOpen: !s.agentOpen }))}>
          <i className={`codicon codicon-${agentOpen ? "layout-sidebar-right" : "layout-sidebar-right-off"}`} />
        </button>
      </div>
      <WindowControls />
    </div>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  // Cepheus constellation: a "house" of five stars, drawn as a hairline.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 4 L27 12.5 L23.5 28 L8.5 28 L5 12.5 Z" fill="none" stroke="#57554f" strokeWidth="1" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {[[16, 4], [27, 12.5], [23.5, 28], [8.5, 28], [5, 12.5]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 0 ? 2.6 : 1.7} fill={i === 0 ? "#c8a464" : "#e7e4dc"} />
      ))}
    </svg>
  );
}
