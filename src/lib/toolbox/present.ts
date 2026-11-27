//! Presentation / screen-share mode: blurs secret-looking values in every editor (all values in
//! .env files), blurs API key fields in the UI (CSS on body.tb-presenting), and enlarges the editor
//! font one step. Purely visual: file contents never change.

import { monaco } from "../monaco";
import { get, useStore } from "../../store";
import { findSecretsInLine } from "./secretScan";
import { useToolbox } from "./state";

const FONT_STEP = 2;
const MAX_LINES = 20000;
const ENV_NAME = /(^|[\\/])(\.env[^\\/]*|[^\\/]*\.env)$/i;
const ENV_VALUE = /^\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*(.*?)\s*$/;

interface Attached { coll: monaco.editor.IEditorDecorationsCollection; subs: monaco.IDisposable[]; timer: number }
const attached = new Map<monaco.editor.ICodeEditor, Attached>();
let globalSubs: (() => void)[] = [];

function maskRanges(model: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const isEnv = ENV_NAME.test(model.uri.path);
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  const n = Math.min(model.getLineCount(), MAX_LINES);
  const opts = { inlineClassName: "tb-masked", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges };
  for (let ln = 1; ln <= n; ln++) {
    const text = model.getLineContent(ln);
    if (!text || text.length > 4000) continue;
    if (isEnv) {
      const m = text.match(ENV_VALUE);
      if (m && m[1] && !text.trimStart().startsWith("#")) {
        const start = text.indexOf(m[1], text.indexOf("=") >= 0 ? text.indexOf("=") : text.indexOf(":"));
        out.push({ range: new monaco.Range(ln, start + 1, ln, start + m[1].length + 1), options: opts });
        continue;
      }
    }
    for (const h of findSecretsInLine(text, true)) out.push({ range: new monaco.Range(ln, h.start + 1, ln, h.end + 1), options: opts });
  }
  // Private key bodies: everything between BEGIN and END lines.
  const matches = model.findMatches("-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----", false, true, true, null, false, 20);
  for (const m of matches) out.push({ range: m.range, options: opts });
  return out;
}

function refresh(ed: monaco.editor.ICodeEditor) {
  const a = attached.get(ed);
  const model = ed.getModel();
  if (!a) return;
  a.coll.set(model ? maskRanges(model) : []);
}

function fontSize() {
  return (get().settings.fontSize || 14) + FONT_STEP;
}

function attach(ed: monaco.editor.ICodeEditor) {
  if (attached.has(ed)) return;
  const a: Attached = { coll: ed.createDecorationsCollection(), subs: [], timer: 0 };
  attached.set(ed, a);
  const later = () => { clearTimeout(a.timer); a.timer = window.setTimeout(() => refresh(ed), 150); };
  a.subs.push(ed.onDidChangeModel(() => refresh(ed)), ed.onDidChangeModelContent(later), ed.onDidDispose(() => detach(ed, true)));
  ed.updateOptions({ fontSize: fontSize() });
  refresh(ed);
}

function detach(ed: monaco.editor.ICodeEditor, disposed = false) {
  const a = attached.get(ed);
  if (!a) return;
  clearTimeout(a.timer);
  a.subs.forEach((s) => s.dispose());
  attached.delete(ed);
  if (!disposed) {
    a.coll.clear();
    ed.updateOptions({ fontSize: get().settings.fontSize });
  }
}

export function setPresenting(on: boolean) {
  if (useToolbox.getState().presenting === on) return;
  useToolbox.setState({ presenting: on });
  document.body.classList.toggle("tb-presenting", on);
  if (on) {
    monaco.editor.getEditors().forEach(attach);
    const created = monaco.editor.onDidCreateEditor((ed) => setTimeout(() => attach(ed), 0));
    // Settings changes re-apply the normal font size in EditorArea; keep ours on top.
    const unsub = useStore.subscribe((s, prev) => {
      if (s.settings !== prev.settings) setTimeout(() => attached.forEach((_, ed) => ed.updateOptions({ fontSize: fontSize() })), 0);
    });
    globalSubs = [() => created.dispose(), unsub];
  } else {
    globalSubs.forEach((f) => f());
    globalSubs = [];
    [...attached.keys()].forEach((ed) => detach(ed));
  }
}

export const togglePresenting = () => setPresenting(!useToolbox.getState().presenting);
