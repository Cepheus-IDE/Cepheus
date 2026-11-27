import { get, set } from "../store";
import { pickFolder, saveFile, saveAll, closeTab, closeFolder, refreshGit } from "./workspace";
import { newSession } from "./agent";
import { editorRef } from "./ai";

export interface Command {
  id: string;
  label: string;
  keys?: string;
  run: () => void | Promise<void>;
}

/** Runs a Monaco action on the main editor (trigger works even when getAction() hides it). */
function editorAction(id: string) {
  const ed = editorRef.current;
  if (!ed) return;
  ed.focus();
  ed.trigger("command", id, null);
}

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
async function zoom(dir: -1 | 0 | 1) {
  const { saveSettings } = await import("./workspace");
  const s = get().settings;
  const i = ZOOM_STEPS.findIndex((z) => z >= s.uiZoom - 0.001);
  const next = dir === 0 ? 1 : ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? 5 : i) + dir))];
  await saveSettings({ ...s, uiZoom: next });
}

export const commands: Command[] = [
  { id: "file.openFolder", label: "File: Open Folder…", keys: "Ctrl+O", run: pickFolder },
  { id: "file.closeFolder", label: "File: Close Folder", run: closeFolder },
  { id: "file.save", label: "File: Save", keys: "Ctrl+S", run: () => saveFile() },
  { id: "file.saveAll", label: "File: Save All", keys: "Ctrl+Alt+S", run: saveAll },
  { id: "file.closeTab", label: "View: Close Editor", keys: "Ctrl+W", run: () => { const a = get().activeId; if (a) closeTab(a); } },
  { id: "go.file", label: "Go to File…", keys: "Ctrl+P", run: () => set({ palette: { mode: "files" } }) },
  { id: "go.line", label: "Go to Line…", keys: "Ctrl+G", run: () => set({ palette: { mode: "line" } }) },
  { id: "view.explorer", label: "View: Show Explorer", keys: "Ctrl+Shift+E", run: () => set({ sidebar: "explorer", view: "editor" }) },
  { id: "view.search", label: "View: Search in Files", keys: "Ctrl+Shift+F", run: () => set({ sidebar: "search", view: "editor" }) },
  { id: "view.git", label: "View: Source Control", keys: "Ctrl+Shift+G", run: () => { set({ sidebar: "git", view: "editor" }); refreshGit(); } },
  { id: "view.extensions", label: "View: Extensions", keys: "Ctrl+Shift+X", run: () => set({ sidebar: "extensions", view: "editor" }) },
  { id: "view.github", label: "GitHub: Open Panel", run: () => set({ sidebar: "github", view: "editor" }) },
  { id: "view.timeMachine", label: "Time Machine: Show File History", keys: "Ctrl+Alt+H", run: () => set((s) => ({ timeMachine: !s.timeMachine })) },
  { id: "view.toggleSidebar", label: "View: Toggle Sidebar", keys: "Ctrl+B", run: () => set((s) => ({ sidebar: s.sidebar ? null : "explorer" })) },
  { id: "view.toggleTerminal", label: "View: Toggle Terminal", keys: "Ctrl+`", run: () => set((s) => ({ panelOpen: !s.panelOpen })) },
  { id: "view.toggleAgent", label: "View: Toggle Agent Panel", keys: "Ctrl+L", run: () => set((s) => ({ agentOpen: !s.agentOpen })) },
  { id: "view.manager", label: "View: Agent Manager", keys: "Ctrl+Shift+M", run: () => set((s) => ({ view: s.view === "manager" ? "editor" : "manager" })) },
  { id: "agent.new", label: "Agent: New Task", keys: "Ctrl+Shift+N", run: () => { newSession(); set({ agentOpen: true }); } },
  { id: "agent.inlineEdit", label: "AI: Inline Edit Selection", keys: "Ctrl+K", run: () => set({ inlineEditOpen: true }) },
  {
    id: "ai.toggleCompletion",
    label: "AI: Toggle Inline Completion",
    run: async () => {
      const { saveSettings } = await import("./workspace");
      const s = get().settings;
      await saveSettings({ ...s, inlineCompletion: !s.inlineCompletion });
    },
  },
  { id: "settings.open", label: "Preferences: Open Settings", keys: "Ctrl+,", run: () => set({ settingsOpen: true }) },
  { id: "editor.format", label: "Format Document", keys: "Shift+Alt+F", run: () => editorAction("editor.action.formatDocument") },
  { id: "editor.find", label: "Find in File", keys: "Ctrl+F", run: () => { editorRef.current?.focus(); editorRef.current?.getAction("actions.find")?.run(); } },
  { id: "editor.replace", label: "Replace in File", keys: "Ctrl+H", run: () => { editorRef.current?.focus(); editorRef.current?.getAction("editor.action.startFindReplaceAction")?.run(); } },
  { id: "editor.symbol", label: "Go to Symbol in File", keys: "Ctrl+Shift+O", run: () => { editorRef.current?.focus(); editorRef.current?.getAction("editor.action.quickOutline")?.run(); } },
  { id: "editor.wrap", label: "View: Toggle Word Wrap", keys: "Alt+Z", run: async () => { const { saveSettings } = await import("./workspace"); const s = get().settings; await saveSettings({ ...s, wordWrap: !s.wordWrap }); } },
  { id: "git.refresh", label: "Git: Refresh", run: refreshGit },
  { id: "git.checkoutTo", label: "Git: Checkout to…", run: async () => (await import("../components/BranchPicker")).openBranchPicker() },
  { id: "git.sync", label: "Git: Sync (Pull then Push)", run: async () => (await import("./gitApi")).syncNow() },
  { id: "git.fetchPrune", label: "Git: Fetch (Prune)", run: async () => { await (await import("./gitApi")).gitOp("Fetched", ["fetch", "--all", "--prune"], { network: true }); } },
  { id: "git.undoCommit", label: "Git: Undo Last Commit", run: async () => { await (await import("./gitApi")).gitOp("Undid last commit (changes kept staged)", ["reset", "--soft", "HEAD~1"]); } },
  { id: "git.showCommits", label: "Git: Show Commits (Graph)", run: async () => { (await import("./gitApi")).useGitUi.setState({ tab: "commits" }); set({ sidebar: "git", view: "editor" }); } },
  { id: "git.timeline", label: "Git: Open Timeline for Active File", run: async () => { (await import("./gitApi")).useGitUi.setState({ tab: "timeline" }); set({ sidebar: "git", view: "editor" }); } },
  { id: "git.mergeEditor", label: "Git: Resolve Active File in Merge Editor", run: async () => { const t = get().tabs.find((x) => x.id === get().activeId); if (t?.kind === "file") (await import("./gitApi")).openMergeEditor(t.path); } },
  { id: "git.toggleQuickDiff", label: "Git: Toggle Gutter Change Markers", run: async () => { const { saveSettings } = await import("./workspace"); const s = get().settings; await saveSettings({ ...s, quickDiff: !s.quickDiff }); } },
  { id: "lsp.restart", label: "Language Servers: Restart", run: async () => { const { restartLanguageServers } = await import("./lsp"); await restartLanguageServers(); } },
  { id: "git.toggleBlame", label: "Git: Toggle Inline Blame", run: async () => { const { saveSettings } = await import("./workspace"); const s = get().settings; await saveSettings({ ...s, inlineBlame: !s.inlineBlame }); } },
  { id: "editor.references", label: "Go to References", keys: "Shift+F12", run: () => editorAction("editor.action.goToReferences") },
  { id: "view.debug", label: "View: Run and Debug", keys: "Ctrl+Shift+D", run: () => set({ sidebar: "debug", view: "editor" }) },
  { id: "debug.start", label: "Debug: Start / Continue", keys: "F5", run: async () => (await import("./debugger")).startOrContinue() },
  { id: "debug.stop", label: "Debug: Stop", keys: "Shift+F5", run: async () => (await import("./debugger")).stopDebugging() },
  { id: "debug.restart", label: "Debug: Restart", keys: "Ctrl+Shift+F5", run: async () => (await import("./debugger")).restartDebugging() },
  { id: "debug.pause", label: "Debug: Pause", keys: "F6", run: async () => { (await import("./debugger")).pause(); } },
  { id: "debug.stepOver", label: "Debug: Step Over", keys: "F10", run: async () => { (await import("./debugger")).stepOver(); } },
  { id: "debug.stepInto", label: "Debug: Step Into", keys: "F11", run: async () => { (await import("./debugger")).stepInto(); } },
  { id: "debug.stepOut", label: "Debug: Step Out", keys: "Shift+F11", run: async () => { (await import("./debugger")).stepOut(); } },
  { id: "debug.toggleBreakpoint", label: "Debug: Toggle Breakpoint", keys: "F9", run: async () => (await import("./debugger")).toggleBreakpointAtCursor(editorRef.current) },
  { id: "debug.addConditionalBreakpoint", label: "Debug: Add Conditional Breakpoint…", run: async () => (await import("./debugger")).editBreakpointAtCursor(editorRef.current, "condition") },
  { id: "debug.addLogpoint", label: "Debug: Add Logpoint…", run: async () => (await import("./debugger")).editBreakpointAtCursor(editorRef.current, "log") },
  { id: "debug.toggleBreakpointsActive", label: "Debug: Activate / Deactivate All Breakpoints", run: async () => (await import("./debugger")).toggleBreakpointsActive() },
  { id: "debug.addConfiguration", label: "Debug: Add Configuration… (launch.json)", run: async () => (await import("./launch")).addConfiguration() },
  { id: "debug.addToWatch", label: "Debug: Add to Watch (selection or word)", run: async () => { const ed = editorRef.current; const m = ed?.getModel(); const sel = ed?.getSelection(); if (!m || !sel) return; const t = sel.isEmpty() ? m.getWordAtPosition(sel.getPosition())?.word : m.getValueInRange(sel); if (t) (await import("./debugger")).addWatch(t); } },
  { id: "view.testing", label: "View: Testing", run: () => set({ sidebar: "testing", view: "editor" }) },
  { id: "test.runAll", label: "Test: Run All Tests", run: async () => (await import("./testing")).runTests() },
  { id: "test.runAllCoverage", label: "Test: Run All Tests with Coverage", run: async () => (await import("./testing")).runWithCoverage() },
  { id: "test.runAtCursor", label: "Test: Run Test at Cursor", run: async () => (await import("./testing")).runAtCursor(false) },
  { id: "test.debugAtCursor", label: "Test: Debug Test at Cursor", run: async () => (await import("./testing")).runAtCursor(true) },
  { id: "test.runFile", label: "Test: Run Tests in Current File", run: async () => (await import("./testing")).runCurrentFile() },
  { id: "test.toggleWatch", label: "Test: Toggle Continuous Run (on save)", run: async () => (await import("./testing")).toggleWatch() },
  { id: "test.toggleCoverage", label: "Test: Toggle Coverage Overlay", run: async () => (await import("./testing")).toggleCoverageOverlay() },
  { id: "view.zoomIn", label: "View: Zoom In", keys: "Ctrl+=", run: () => zoom(1) },
  { id: "view.zoomOut", label: "View: Zoom Out", keys: "Ctrl+-", run: () => zoom(-1) },
  { id: "view.zoomReset", label: "View: Reset Zoom", keys: "Ctrl+0", run: () => zoom(0) },
  { id: "view.problems", label: "View: Problems", run: () => set({ panelOpen: true, panelTab: "problems" }) },
  { id: "settings.keybindings", label: "Preferences: Keyboard Shortcuts", run: () => set({ keybindingsOpen: true }) },
  { id: "profiles.show", label: "Profiles: Show Profiles", run: async () => (await import("./services")).openProfilesModal("profiles") },
  { id: "profiles.import", label: "Profiles: Import Profile…", run: async () => { await (await import("./profiles")).importProfile(); } },
  { id: "profiles.export", label: "Profiles: Export Current Profile…", run: async () => { const p = await import("./profiles"); await p.exportProfile(p.activeProfile().id); } },
  { id: "sync.show", label: "Settings Sync: Show Settings Sync", run: async () => (await import("./services")).openProfilesModal("sync") },
  { id: "sync.now", label: "Settings Sync: Sync Now", run: async () => (await import("./sync")).syncNow() },
  { id: "update.check", label: "Help: Check for Updates…", run: async () => { (await import("./services")).openProfilesModal("updates"); await (await import("./updater")).checkForUpdates(true, (await import("./updater")).updateMode() === "automatic"); } },
  { id: "devcontainer.reopen", label: "Dev Containers: Reopen in Container", run: async () => (await import("./continuity")).reopenInContainer(false) },
  { id: "devcontainer.rebuild", label: "Dev Containers: Rebuild and Reopen in Container", run: async () => (await import("./continuity")).reopenInContainer(true) },
  { id: "devcontainer.local", label: "Dev Containers: Reopen Folder Locally", run: async () => (await import("./continuity")).leaveContainer() },
  { id: "settings.network", label: "Preferences: Network, Telemetry & Organization Policy", run: async () => (await import("./services")).openProfilesModal("organization") },
  { id: "chat.manageModels", label: "Chat: Manage Language Models…", run: () => import("./models").then((m) => m.openLanguageModels("models")) },
  { id: "chat.usage", label: "Chat: Show Model Usage", run: () => import("./models").then((m) => m.openLanguageModels("usage")) },
  { id: "editor.revealDefinition", label: "Go to Definition", keys: "F12", run: () => editorAction("editor.action.revealDefinition") },
  { id: "editor.rename", label: "Rename Symbol", keys: "F2", run: () => editorAction("editor.action.rename") },
  // Code editing, terminal, settings (src/lib/editorFeatures.ts, settingsLevels.ts, snippets.ts, keymaps.ts)
  { id: "editor.quickFix", label: "Quick Fix…", keys: "Ctrl+.", run: () => editorAction("editor.action.quickFix") },
  { id: "editor.refactor", label: "Refactor…", keys: "Ctrl+Shift+R", run: () => editorAction("editor.action.refactor") },
  { id: "editor.sourceAction", label: "Source Action…", run: () => editorAction("editor.action.sourceAction") },
  { id: "editor.organizeImports", label: "Organize Imports", keys: "Shift+Alt+O", run: async () => (await import("./editorFeatures")).organizeImports() },
  { id: "lsp.install", label: "Language Servers: Install Server for Current Language", run: async () => (await import("./lsp")).installLanguageServer(get().language) },
  { id: "snippets.configure", label: "Snippets: Configure User Snippets (current language)", run: async () => (await import("./snippets")).configureSnippets("user") },
  { id: "snippets.configureWorkspace", label: "Snippets: Configure Workspace Snippets (current language)", run: async () => (await import("./snippets")).configureSnippets("workspace") },
  { id: "settings.openJson", label: "Preferences: Open User Settings (JSON)", run: async () => (await import("./settingsLevels")).openUserSettingsJson() },
  { id: "settings.openWorkspaceJson", label: "Preferences: Open Workspace Settings (JSON)", run: async () => (await import("./settingsLevels")).openWorkspaceSettingsJson() },
  { id: "settings.exportShortcuts", label: "Preferences: Export Keyboard Shortcuts (printable)", run: async () => (await import("./keymaps")).exportShortcuts() },
  { id: "terminal.new", label: "Terminal: Create New Terminal", keys: "Ctrl+Shift+`", run: () => { set({ panelOpen: true, panelTab: "terminal" }); window.dispatchEvent(new Event("cepheus:new-terminal")); } },
  { id: "terminal.split", label: "Terminal: Split Terminal", keys: "Ctrl+\\", run: () => window.dispatchEvent(new Event("cepheus:terminal-split")) },
  { id: "terminal.rename", label: "Terminal: Rename…", run: () => window.dispatchEvent(new Event("cepheus:terminal-rename")) },
  // Integrated browser (src/lib/browser.ts)
  { id: "browser.open", label: "Browser: Open URL…", run: async () => { await (await import("./browser")).openBrowser("", "none"); } },
  { id: "browser.preview", label: "Browser: Open Preview of Current HTML File", run: async () => (await import("./browser")).previewActiveFile() },
];

/** Effective shortcut for a command: the user's override, else the default. */
export function keyFor(c: Command): string | undefined {
  const o = get().settings.keybindings[c.id];
  return o === undefined ? c.keys : o || undefined;
}

export function normalize(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let k = e.key;
  if (k === " ") k = "Space";
  if (e.code === "Backquote") k = "`";
  if (e.code === "Comma") k = ",";
  if (k === "+") k = "=";
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join("+");
}

export function handleGlobalKey(e: KeyboardEvent): boolean {
  // The shortcuts editor records raw keys; app shortcuts stay off while it is open.
  if (get().keybindingsOpen) return false;
  const combo = normalize(e);
  if (combo === "Ctrl+Shift+P" || combo === "F1") {
    set({ palette: { mode: "commands" } });
    return true;
  }
  // Let the editor handle its own Ctrl+F/H/G etc. when focused, except for our app-level keys.
  const cmd = commands.find((c) => keyFor(c) === combo);
  if (!cmd) return false;
  const editorOwned = ["Ctrl+F", "Ctrl+H", "Shift+Alt+F", "Ctrl+Shift+O", "F12", "F2", "Shift+F12", "Ctrl+."];
  if (editorOwned.includes(combo) && editorRef.current?.hasTextFocus()) return false;
  cmd.run();
  return true;
}
