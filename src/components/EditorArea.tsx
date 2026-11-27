import { useEffect, useRef } from "react";
import { monaco, languageForPath } from "../lib/monaco";
import { editorRef } from "../lib/ai";
import { closeTab, getModelEntry, pickFolder, openFolder } from "../lib/workspace";
import { basename, fileIcon, relative } from "../lib/paths";
import { get, set, useStore } from "../store";
import { Logo } from "./TitleBar";
import TimeMachine from "./TimeMachine";
import ExtensionPage from "./ExtensionPage";
import FileIcon from "./FileIcon";
import { attachGitExtras } from "../lib/gitExtras";
import { attachDebugGutter } from "../lib/debugger";
import BrowserTab from "./BrowserTab";
import MergeEditor from "./MergeEditor";
import PullRequestView from "./PullRequestView";
import { buildDiffOptions, buildEditorOptions } from "../lib/editorOptions";
import { pinTab, usePreviewTab } from "../lib/tabPreview";

export default function EditorArea() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const dirty = useStore((s) => s.dirty);
  const ws = useStore((s) => s.workspace);
  const settings = useStore((s) => s.settings);
  const pendingReveal = useStore((s) => s.pendingReveal);
  const timeMachine = useStore((s) => s.timeMachine);
  const previewId = usePreviewTab((s) => s.id);
  const hostRef = useRef<HTMLDivElement>(null);
  const diffHostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const prevModelPath = useRef<string | null>(null);
  const active = tabs.find((t) => t.id === activeId);

  // Create the code editor once.
  useEffect(() => {
    const ed = monaco.editor.create(hostRef.current!, {
      model: null,
      automaticLayout: true,
      inlineSuggest: { enabled: true },
      padding: { top: 8 },
      ...buildEditorOptions(get().settings), // Settings › Editor / Motion (src/lib/editorOptions.ts)
    });
    editorRef.current = ed;
    const detachGit = attachGitExtras(ed);
    const detachDebug = attachDebugGutter(ed);
    const sub1 = ed.onDidChangeCursorSelection((e) => {
      const sel = e.selection;
      const model = ed.getModel();
      set({
        cursor: {
          line: sel.positionLineNumber,
          col: sel.positionColumn,
          selection: model && !sel.isEmpty() ? model.getValueInRange(sel).length : 0,
        },
      });
    });
    const sub2 = ed.onDidChangeModel(() => set({ language: ed.getModel()?.getLanguageId() ?? "" }));
    return () => {
      sub1.dispose();
      sub2.dispose();
      detachGit();
      detachDebug();
      ed.dispose();
      editorRef.current = null;
    };
  }, []);

  // Apply settings.
  useEffect(() => {
    editorRef.current?.updateOptions(buildEditorOptions(settings));
    diffRef.current?.updateOptions(buildDiffOptions(settings));
  }, [settings]);

  // Switch model when the active tab changes.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (prevModelPath.current) {
      const prev = getModelEntry(prevModelPath.current);
      if (prev) prev.viewState = ed.saveViewState();
    }
    if (active?.kind === "file") {
      const entry = getModelEntry(active.path);
      if (entry && ed.getModel() !== entry.model) {
        ed.setModel(entry.model);
        if (entry.viewState) ed.restoreViewState(entry.viewState);
      }
      prevModelPath.current = active.path;
      requestAnimationFrame(() => ed.focus());
    } else {
      prevModelPath.current = null;
      if (!active) ed.setModel(null);
    }
  }, [active?.id, active?.kind, active?.path]);

  // Reveal a line (from search results, go-to-line, etc.).
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !pendingReveal || active?.kind !== "file") return;
    if (active.path.toLowerCase() !== pendingReveal.path.toLowerCase()) return;
    const { line, col } = pendingReveal;
    requestAnimationFrame(() => {
      ed.revealLineInCenter(line);
      ed.setPosition({ lineNumber: line, column: col });
      ed.focus();
    });
    set({ pendingReveal: null });
  }, [pendingReveal, active?.id]);

  // Diff editor for diff tabs.
  useEffect(() => {
    if (active?.kind !== "diff") return;
    if (!diffRef.current) {
      diffRef.current = monaco.editor.createDiffEditor(diffHostRef.current!, {
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: true,
        originalEditable: false,
        ...buildDiffOptions(get().settings),
      });
    }
    const lang = languageForPath(active.path);
    const original = monaco.editor.createModel(active.original ?? "", lang);
    const modified = monaco.editor.createModel(active.modified ?? "", lang);
    diffRef.current.setModel({ original, modified });
    return () => {
      diffRef.current?.setModel(null);
      original.dispose();
      modified.dispose();
    };
  }, [active?.id, active?.original, active?.modified]);

  useEffect(() => () => diffRef.current?.dispose(), []);

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t) => {
            return (
              <div
                key={t.id}
                className={`tab ${t.id === activeId ? "active" : ""} ${dirty[t.path] && t.kind === "file" ? "dirty" : ""} ${t.id === previewId ? "preview" : ""}`}
                onDoubleClick={() => pinTab(t.id)}
                onClick={() => set({ activeId: t.id })}
                onMouseDown={(e) => e.button === 1 && closeTab(t.id)}
                title={t.path}
              >
                {t.kind === "browser" ? <i className="codicon codicon-globe" /> : t.kind === "diff" ? <i className="codicon codicon-diff" /> : t.kind === "extension" ? <i className="codicon codicon-extensions" /> : <FileIcon name={t.title} />}
                <span className="tab-title">{t.title}</span>
                <button className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>
                  <i className="codicon codicon-close" />
                  <span className="dot" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {active?.kind === "extension" && active.ext && <ExtensionPage key={active.id} namespace={active.ext.namespace} name={active.ext.name} />}
      {active?.kind === "pr" && active.pr && <PullRequestView key={active.id} {...active.pr} />}
      {active && active.kind !== "extension" && active.kind !== "browser" && active.kind !== "pr" && (
        <div className="breadcrumbs">
          {relative(ws, active.path).split("/").map((p, i, arr) => (
            <span key={i}>
              {p}
              {i < arr.length - 1 && <i className="codicon codicon-chevron-right" />}
            </span>
          ))}
          {active.kind === "file" && (
            <button className={`crumb-action ${timeMachine ? "on" : ""}`} title="Time Machine — every saved version of this file" onClick={() => set({ timeMachine: !timeMachine })}>
              <i className="codicon codicon-history" /> Time Machine
            </button>
          )}
        </div>
      )}
      {active?.kind === "file" && timeMachine && <TimeMachine path={active.path} />}
      {active?.kind === "merge" && <MergeEditor key={active.id} tabId={active.id} path={active.path} />}
      <div className="editor-host" ref={hostRef} style={{ display: active?.kind === "file" ? "block" : "none" }} />
      <div className="editor-host" ref={diffHostRef} style={{ display: active?.kind === "diff" ? "block" : "none" }} />
      {/* Browser tabs stay mounted so their native webviews keep page state across tab switches. */}
      {tabs.filter((t) => t.kind === "browser").map((t) => <BrowserTab key={t.id} tab={t} visible={t.id === activeId} />)}
      {!active && settings.startupPage !== "none" && <Welcome hasWorkspace={!!ws} />}
    </div>
  );
}

function Welcome({ hasWorkspace }: { hasWorkspace: boolean }) {
  const recent = useStore((s) => s.settings.recent);
  const keys: [string, string][] = [
    ["Command Palette", "Ctrl+Shift+P"],
    ["Go to File", "Ctrl+P"],
    ["Agent Panel", "Ctrl+L"],
    ["New Agent Task", "Ctrl+Shift+N"],
    ["Inline AI Edit", "Ctrl+K"],
    ["Agent Manager", "Ctrl+Shift+M"],
    ["Toggle Terminal", "Ctrl+`"],
    ["Search in Files", "Ctrl+Shift+F"],
  ];
  return (
    <div className="welcome">
      <Logo size={72} />
      <h1>Cepheus IDE</h1>
      <p className="muted">A lightweight agentic code editor</p>
      {!hasWorkspace && (
        <div className="welcome-actions">
          <button className="btn primary" onClick={pickFolder}><i className="codicon codicon-folder-opened" /> Open Folder</button>
          {recent.slice(0, 5).map((r) => (
            <button key={r} className="link" onClick={() => openFolder(r)} title={r}>
              <i className="codicon codicon-history" /> {basename(r)} <span className="muted small">{r}</span>
            </button>
          ))}
        </div>
      )}
      <div className="shortcuts">
        {keys.map(([l, k]) => (
          <div key={l}><span>{l}</span><kbd>{k}</kbd></div>
        ))}
      </div>
    </div>
  );
}
