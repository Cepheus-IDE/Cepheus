import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { clearBlameCache } from "./gitExtras";
import { api, errMsg } from "./api";
import { monaco, languageForPath } from "./monaco";
import { basename, samePath } from "./paths";
import { get, set, toast, Tab } from "../store";
import { mergeSettings, Settings } from "./settings";
import { applyTheme } from "./themes";
import { applyPolicy, loadPolicy } from "./policy";
import { userLevel } from "./settingsLevels";

// ----------------------------------------------------------------------------------------------
// Text models (one per open file, shared between tabs and the agent's live updates)
// ----------------------------------------------------------------------------------------------

interface ModelEntry { path: string; model: monaco.editor.ITextModel; savedVersion: number; disposeListener: monaco.IDisposable; viewState?: monaco.editor.ICodeEditorViewState | null }
const models = new Map<string, ModelEntry>();
const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();

export function getModelEntry(path: string) {
  return models.get(key(path));
}

/** Loads a file into a model without opening a tab (used by language features that jump across files). */
export const preloadModel = (path: string) => ensureModel(path);

async function ensureModel(path: string): Promise<ModelEntry> {
  const existing = models.get(key(path));
  if (existing) return existing;
  const content = await api.readFile(path);
  const uri = monaco.Uri.file(path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, languageForPath(path), uri);
  model.updateOptions({ tabSize: get().settings.tabSize });
  const entry: ModelEntry = {
    path,
    model,
    savedVersion: model.getAlternativeVersionId(),
    disposeListener: model.onDidChangeContent(() => {
      const isDirty = model.getAlternativeVersionId() !== entry.savedVersion;
      if (!!get().dirty[path] !== isDirty) set((s) => ({ dirty: { ...s.dirty, [path]: isDirty } }));
      if (isDirty && get().settings.autoSave) scheduleAutoSave(path);
    }),
  };
  models.set(key(path), entry);
  return entry;
}

const autoSaveTimers = new Map<string, number>();
function scheduleAutoSave(path: string) {
  clearTimeout(autoSaveTimers.get(path));
  autoSaveTimers.set(path, window.setTimeout(() => saveFile(path), 1000));
}

function disposeModel(path: string) {
  const e = models.get(key(path));
  if (!e) return;
  e.disposeListener.dispose();
  e.model.dispose();
  models.delete(key(path));
}

// ----------------------------------------------------------------------------------------------
// Workspace
// ----------------------------------------------------------------------------------------------

function applyZoom(z: number) {
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(z)).catch(() => {});
}

export async function loadSettings() {
  try {
    const raw = await api.loadSettings();
    await loadPolicy();
    const s = applyPolicy(mergeSettings(raw)); // organization policy wins
    set({ settings: s });
    if (s.uiZoom !== 1) applyZoom(s.uiZoom);
    await applyTheme(s.theme, s.customThemes);
  } catch (e) {
    toast("Failed to load settings: " + errMsg(e), "error");
  }
}

export async function saveSettings(s: Settings) {
  s = applyPolicy(s); // locked (organization-managed) settings cannot be changed
  const prev = get().settings;
  set({ settings: s });
  if (prev.theme !== s.theme || prev.customThemes !== s.customThemes) applyTheme(s.theme, s.customThemes);
  if (prev.uiZoom !== s.uiZoom) {
    applyZoom(s.uiZoom);
    toast(`Zoom ${Math.round(s.uiZoom * 100)}%`);
  }
  for (const e of models.values()) e.model.updateOptions({ tabSize: s.tabSize });
  try {
    await api.saveSettings(userLevel(s)); // workspace (.cepheus/settings.json) overrides stay out of the user file
  } catch (e) {
    toast("Failed to save settings: " + errMsg(e), "error");
  }
}

export async function pickFolder() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof dir === "string") await openFolder(dir);
}

export async function openFolder(dir: string) {
  const remote = dir.match(/^ssh:\/\/([^/]+)/);
  if (remote && !get().ssh[remote[1]]) {
    // Try to reconnect a saved host silently (agent/keys); otherwise send the user to the Remote panel.
    const host = get().settings.sshHosts.find((h) => h.id === remote[1]);
    if (!host) return toast("That SSH host is no longer saved.", "error");
    try {
      const { connectHost } = await import("../components/RemotePanel");
      await connectHost(host);
    } catch {
      set({ sidebar: "remote", view: "editor" });
      return toast(`Connect to ${host.label || host.host} first (Remote panel).`);
    }
  }
  for (const p of [...models.keys()]) disposeModel(p);
  set({ workspace: dir, tabs: [], activeId: null, dirty: {}, git: null, treeVersion: get().treeVersion + 1 });
  document.title = `${basename(dir)} — Cepheus IDE`;
  const s = get().settings;
  const recent = [dir, ...s.recent.filter((r) => !samePath(r, dir))].slice(0, 10);
  saveSettings({ ...s, recent });
  try {
    await api.watchFolder(dir);
  } catch (e) {
    console.warn("watch failed", e);
  }
  refreshGit();
  // Profile associated with this folder, workspace extension recommendations, dev container prompt.
  import("./services").then((m) => m.onFolderOpened(dir));
}

export function closeFolder() {
  for (const p of [...models.keys()]) disposeModel(p);
  set({ workspace: null, tabs: [], activeId: null, dirty: {}, git: null });
  document.title = "Cepheus IDE";
}

// ----------------------------------------------------------------------------------------------
// Tabs
// ----------------------------------------------------------------------------------------------

export async function openFile(path: string, line?: number, col?: number) {
  try {
    await ensureModel(path);
  } catch (e) {
    toast(`Cannot open ${basename(path)}: ${errMsg(e)}`, "error");
    return;
  }
  const id = "file:" + key(path);
  set((s) => ({
    tabs: s.tabs.some((t) => t.id === id) ? s.tabs : [...s.tabs, { id, kind: "file", path, title: basename(path) }],
    activeId: id,
    view: "editor",
    pendingReveal: line ? { path, line, col: col ?? 1 } : s.pendingReveal,
  }));
}

/** Opens the extension details page in an editor tab (like VS Code). */
export function openExtension(namespace: string, name: string, displayName?: string) {
  const id = `ext:${namespace}.${name}`.toLowerCase();
  set((s) => ({
    tabs: s.tabs.some((t) => t.id === id)
      ? s.tabs
      : [...s.tabs, { id, kind: "extension", path: `${namespace}.${name}`, title: `Extension: ${displayName ?? name}`, ext: { namespace, name } }],
    activeId: id,
    view: "editor",
  }));
}

export function openDiff(path: string, original: string, modified: string, originalLabel = "Original") {
  const id = "diff:" + key(path) + ":" + originalLabel;
  const tab: Tab = { id, kind: "diff", path, title: `${basename(path)} (${originalLabel} ↔ Current)`, original, modified, originalLabel };
  set((s) => ({
    tabs: s.tabs.some((t) => t.id === id) ? s.tabs.map((t) => (t.id === id ? tab : t)) : [...s.tabs, tab],
    activeId: id,
    view: "editor",
  }));
}

export async function closeTab(id: string, force = false) {
  const s = get();
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.kind === "file" && s.dirty[tab.path] && !force) {
    // Native confirm() is unavailable in the webview; keep it simple: save first.
    await saveFile(tab.path);
  }
  const idx = s.tabs.findIndex((t) => t.id === id);
  const tabs = s.tabs.filter((t) => t.id !== id);
  let activeId = s.activeId;
  if (activeId === id) activeId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
  const dirty = { ...s.dirty };
  if (tab.kind === "file") {
    delete dirty[tab.path];
    if (!tabs.some((t) => t.kind === "file" && samePath(t.path, tab.path))) disposeModel(tab.path);
  }
  set({ tabs, activeId, dirty });
}

export function activeTab(): Tab | undefined {
  const s = get();
  return s.tabs.find((t) => t.id === s.activeId);
}

export async function saveFile(path?: string) {
  const p = path ?? activeTab()?.path;
  if (!p) return;
  const e = models.get(key(p));
  if (!e) return;
  try {
    const content = e.model.getValue();
    await api.writeFile(p, content);
    api.historySave(p, content, "save").catch(() => {});
    import("./lsp").then((l) => l.notifySaved(p));
    e.savedVersion = e.model.getAlternativeVersionId();
    set((s) => ({ dirty: { ...s.dirty, [p]: false } }));
    refreshGitSoon();
  } catch (err) {
    toast(`Save failed: ${errMsg(err)}`, "error");
  }
}

export async function saveAll() {
  const dirty = Object.entries(get().dirty).filter(([, d]) => d).map(([p]) => p);
  for (const p of dirty) await saveFile(p);
}

/** Called on file-system change events: reload clean models from disk (e.g. after agent edits). */
export async function onFsChanged(paths: string[]) {
  for (const p of paths) {
    const e = models.get(key(p));
    if (!e) continue;
    if (get().dirty[e.path] || e.model.getAlternativeVersionId() !== e.savedVersion) continue;
    try {
      const content = await api.readFile(p);
      if (content !== e.model.getValue()) {
        e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: content }], () => null);
        e.savedVersion = e.model.getAlternativeVersionId();
        // The content listener ran before savedVersion moved and marked the file dirty; clear it.
        set((s) => ({ dirty: { ...s.dirty, [e.path]: false } }));
      }
    } catch {
      /* deleted or binary */
    }
  }
  set((s) => ({ treeVersion: s.treeVersion + 1 }));
  refreshGitSoon();
}

// ----------------------------------------------------------------------------------------------
// Git
// ----------------------------------------------------------------------------------------------

let gitTimer = 0;
export function refreshGitSoon() {
  clearTimeout(gitTimer);
  gitTimer = window.setTimeout(refreshGit, 600);
}

export async function refreshGit() {
  const ws = get().workspace;
  if (!ws) return;
  clearBlameCache();
  try {
    set({ git: await api.gitStatus(ws) });
  } catch (e) {
    console.warn(e);
  }
}

export async function openGitDiff(path: string) {
  const ws = get().workspace;
  if (!ws) return;
  try {
    const original = await api.gitShowHead(ws, path);
    let modified = "";
    try {
      modified = await api.readFile(path);
    } catch {
      /* deleted */
    }
    openDiff(path, original, modified, "HEAD");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}
