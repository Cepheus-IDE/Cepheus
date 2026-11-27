//! Clipboard history for code: remembers the last 50 copies/cuts made inside editors (from the
//! DOM copy/cut events while an editor has focus; the system clipboard is never read). Kept in
//! memory only, so copied secrets don't end up on disk. Ctrl+Shift+V in an editor opens the picker.

import { create } from "zustand";
import { monaco } from "../monaco";
import { get } from "../../store";
import { relative } from "../paths";
import { useToolbox } from "./state";

export interface Clip { text: string; at: number; source: string; language: string }

const MAX = 50;
export const useClips = create<{ clips: Clip[] }>(() => ({ clips: [] }));

/** The editor that was focused when the picker opened (pasting returns focus to it). */
let target: monaco.editor.ICodeEditor | null = null;

function focusedEditor(): monaco.editor.ICodeEditor | null {
  return monaco.editor.getEditors().find((e) => e.hasTextFocus() || e.hasWidgetFocus()) ?? null;
}

function copiedText(ed: monaco.editor.ICodeEditor): string {
  const model = ed.getModel();
  const sels = ed.getSelections();
  if (!model || !sels?.length) return "";
  // Empty selection copies the whole line (Monaco's emptySelectionClipboard default).
  if (sels.every((s) => s.isEmpty())) {
    const lines = [...new Set(sels.map((s) => s.startLineNumber))].sort((a, b) => a - b);
    return lines.map((l) => model.getLineContent(l) + model.getEOL()).join("");
  }
  return sels.filter((s) => !s.isEmpty()).map((s) => model.getValueInRange(s)).join(model.getEOL());
}

export function remember(text: string, source: string, language: string) {
  if (!text.trim() || text.length > 200_000) return;
  useClips.setState((s) => ({ clips: [{ text, at: Date.now(), source, language }, ...s.clips.filter((c) => c.text !== text)].slice(0, MAX) }));
}

export function openClipPicker() {
  target = focusedEditor() ?? target ?? (monaco.editor.getEditors()[0] || null);
  useToolbox.setState({ clipPicker: true });
}

/** Inserts `text` at every cursor of the target editor (one undo step). */
export function pasteClip(text: string) {
  useToolbox.setState({ clipPicker: false });
  const ed = target ?? focusedEditor();
  if (!ed || !ed.getModel() || ed.getOption(monaco.editor.EditorOption.readOnly)) return;
  const sels = ed.getSelections() ?? [];
  ed.focus();
  ed.pushUndoStop();
  ed.executeEdits("clipboard-history", sels.map((range) => ({ range, text, forceMoveMarkers: true })));
  ed.pushUndoStop();
}

export function watchClipboard(): () => void {
  const onCopy = () => {
    const ed = focusedEditor();
    if (!ed) return;
    const text = copiedText(ed);
    const model = ed.getModel();
    remember(text, model ? relative(get().workspace, model.uri.fsPath || model.uri.path) : "", model?.getLanguageId() ?? "");
  };
  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCopy, true);
  // Ctrl/Cmd+Shift+V only while an editor has focus (terminals keep it for paste). onKeyDown works on
  // every editor, including the halves of diff editors; the context-menu entry needs addAction.
  const addKey = (ed: monaco.editor.ICodeEditor): monaco.IDisposable[] => {
    const open = () => { target = ed; useToolbox.setState({ clipPicker: true }); };
    const subs = [ed.onKeyDown((e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.keyCode === monaco.KeyCode.KeyV) {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    })];
    const standalone = ed as Partial<monaco.editor.IStandaloneCodeEditor>;
    if (typeof standalone.addAction === "function") {
      subs.push(standalone.addAction({ id: "cepheus.clipboardHistory", label: "Paste from Clipboard History…", contextMenuGroupId: "9_cutcopypaste", contextMenuOrder: 10, run: open }));
    }
    return subs;
  };
  const actions = monaco.editor.getEditors().flatMap(addKey);
  const sub = monaco.editor.onDidCreateEditor((ed) => setTimeout(() => actions.push(...addKey(ed)), 0));
  return () => {
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("cut", onCopy, true);
    sub.dispose();
    actions.forEach((a) => a.dispose());
  };
}
