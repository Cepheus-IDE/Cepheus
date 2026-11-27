//! Extension bridges, built-in equivalents of small editor extensions:
//! Error Lens (inline errors), Path IntelliSense, Auto Rename Tag and EditorConfig.

import { monaco } from "../monaco";
import { api } from "../api";
import { get } from "../../store";
import { EditorConfigFile, editorConfigIndent, findTagPair, parseEditorConfig, pathPrefix, resolveEditorConfig, EditorConfigProps } from "./core";

// ---------------------------------------------------------------------------------------------
// Inline errors (usernamehw.errorlens)
// ---------------------------------------------------------------------------------------------

const collections = new WeakMap<monaco.editor.ICodeEditor, monaco.editor.IEditorDecorationsCollection>();
const SEV_CLASS: Record<number, string> = { [monaco.MarkerSeverity.Error]: "error", [monaco.MarkerSeverity.Warning]: "warning", [monaco.MarkerSeverity.Info]: "info" };

function renderInline(ed: monaco.editor.ICodeEditor, on: boolean) {
  let coll = collections.get(ed);
  const model = ed.getModel();
  if (!on || !model) { coll?.clear(); return; }
  const best = new Map<number, monaco.editor.IMarker>();
  for (const m of monaco.editor.getModelMarkers({ resource: model.uri })) {
    if (m.severity < monaco.MarkerSeverity.Info) continue;
    const cur = best.get(m.startLineNumber);
    if (!cur || m.severity > cur.severity) best.set(m.startLineNumber, m);
  }
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  for (const [line, m] of best) {
    if (line > model.getLineCount()) continue;
    const col = model.getLineMaxColumn(line);
    const cls = SEV_CLASS[m.severity] ?? "info";
    const msg = m.message.split(/\r?\n/)[0].slice(0, 200);
    decos.push({
      range: new monaco.Range(line, col, line, col),
      options: {
        isWholeLine: false,
        after: { content: `    ${msg}${m.source ? `  · ${m.source}` : ""}`, inlineClassName: `bridge-inline-msg ${cls}` },
        showIfCollapsed: true,
      },
    });
    decos.push({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: `bridge-inline-line ${cls}` } });
  }
  if (!coll) { coll = ed.createDecorationsCollection(); collections.set(ed, coll); }
  coll.set(decos);
}

export function initInlineErrors(): (() => void) & { refresh: () => void } {
  let t = 0;
  const all = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      const on = !!get().settings.inlineErrors;
      for (const ed of monaco.editor.getEditors()) renderInline(ed, on);
    }, 120);
  };
  const subs: monaco.IDisposable[] = [monaco.editor.onDidChangeMarkers(all)];
  const hook = (ed: monaco.editor.ICodeEditor) => subs.push(ed.onDidChangeModel(all), ed.onDidChangeModelContent(all));
  monaco.editor.getEditors().forEach(hook);
  subs.push(monaco.editor.onDidCreateEditor((ed) => { hook(ed); all(); }));
  all();
  return Object.assign(() => { subs.forEach((s) => s.dispose()); for (const ed of monaco.editor.getEditors()) collections.get(ed)?.clear(); }, { refresh: all });
}

// ---------------------------------------------------------------------------------------------
// Path completion (christian-kohler.path-intellisense)
// ---------------------------------------------------------------------------------------------

const PATH_LANGS = ["javascript", "typescript", "css", "scss", "less", "html", "markdown", "mdx", "vue", "svelte", "astro", "php", "handlebars"];
const CODE_EXT = /\.(d\.ts|tsx?|jsx?|mjs|cjs)$/;

export function initPathCompletion(): () => void {
  const subs = PATH_LANGS.map((lang) => monaco.languages.registerCompletionItemProvider(lang, {
    triggerCharacters: ["/", ".", '"', "'"],
    async provideCompletionItems(model, position) {
      if (!get().settings.pathCompletion || model.uri.scheme !== "file") return { suggestions: [] };
      const line = model.getLineContent(position.lineNumber);
      const before = line.slice(0, position.column - 1);
      const pre = pathPrefix(before);
      if (!pre) return { suggestions: [] };
      const fileDir = model.uri.fsPath.replace(/[\\/][^\\/]*$/, "");
      const dir = `${fileDir}/${pre.dir}`.replace(/\\/g, "/");
      const entries = await api.readDir(dir).catch(() => []);
      const isImport = (lang === "javascript" || lang === "typescript") && /\b(import|from|require\s*\(|import\s*\()/.test(before);
      const range = new monaco.Range(position.lineNumber, position.column - pre.partial.length, position.lineNumber, position.column);
      return {
        suggestions: entries
          .filter((e) => (pre.partial.startsWith(".") || !e.name.startsWith(".")) && (e.name !== "node_modules" || pre.partial.startsWith("node")))
          .map((e) => {
            const insert = e.isDir ? e.name + "/" : isImport ? e.name.replace(CODE_EXT, "") : e.name;
            return {
              label: e.isDir ? e.name + "/" : e.name,
              kind: e.isDir ? monaco.languages.CompletionItemKind.Folder : monaco.languages.CompletionItemKind.File,
              detail: "path",
              insertText: insert,
              sortText: (e.isDir ? "0" : "1") + e.name.toLowerCase(),
              range,
              command: e.isDir ? { id: "editor.action.triggerSuggest", title: "" } : undefined,
            };
          }),
      };
    },
  }));
  return () => subs.forEach((s) => s.dispose());
}

// ---------------------------------------------------------------------------------------------
// Auto rename tag (formulahendry.auto-rename-tag)
// ---------------------------------------------------------------------------------------------

const TAG_LANGS = ["html", "xml", "javascript", "typescript", "vue", "svelte", "astro", "php", "handlebars", "razor", "xsl"];

export function initAutoRenameTag(): (() => void) & { refresh: () => void } {
  const subs: monaco.IDisposable[] = TAG_LANGS.map((lang) => monaco.languages.registerLinkedEditingRangeProvider(lang, {
    provideLinkedEditingRanges(model, position) {
      if (!get().settings.autoRenameTag) return null;
      if (model.getValueLength() > 500_000) return null;
      const text = model.getValue();
      const pair = findTagPair(text, model.getOffsetAt(position));
      if (!pair) return null;
      const r = (a: number, b: number) => monaco.Range.fromPositions(model.getPositionAt(a), model.getPositionAt(b));
      return { ranges: [r(...pair[0]), r(...pair[1])], wordPattern: /[A-Za-z][\w.:-]*/ };
    },
  }));
  const apply = (ed: monaco.editor.ICodeEditor) => ed.updateOptions({ linkedEditing: !!get().settings.autoRenameTag });
  monaco.editor.getEditors().forEach(apply);
  subs.push(monaco.editor.onDidCreateEditor((ed) => setTimeout(() => apply(ed), 0)));
  return Object.assign(() => subs.forEach((s) => s.dispose()), { refresh: () => monaco.editor.getEditors().forEach(apply) });
}

// ---------------------------------------------------------------------------------------------
// EditorConfig (editorconfig.editorconfig)
// ---------------------------------------------------------------------------------------------

const ecCache = new Map<string, Promise<EditorConfigFile | null>>();
const readEc = (dir: string) => {
  let p = ecCache.get(dir.toLowerCase());
  if (!p) {
    p = api.readFile(`${dir}/.editorconfig`).then(parseEditorConfig).catch(() => null);
    ecCache.set(dir.toLowerCase(), p);
  }
  return p;
};

/** Properties for a file from .editorconfig files in its folder and above. */
export async function editorConfigFor(path: string): Promise<EditorConfigProps | null> {
  if (!get().settings.editorConfig || path.startsWith("ssh://")) return null;
  const files: [string, EditorConfigFile][] = [];
  let dir = path.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  for (let i = 0; i < 32 && dir; i++) {
    const ec = await readEc(dir);
    if (ec) { files.unshift([dir, ec]); if (ec.root) break; }
    const up = dir.replace(/\/[^/]*$/, "");
    if (up === dir || !up) break;
    dir = up;
  }
  if (!files.length) return null;
  const p = resolveEditorConfig(path, files);
  return Object.keys(p).length ? p : null;
}

/** Applies indentation from .editorconfig to a model (on open and after settings changes). */
export async function applyEditorConfig(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== "file" || model.isDisposed()) return;
  const p = await editorConfigFor(model.uri.fsPath);
  if (!p || model.isDisposed()) return;
  const ind = editorConfigIndent(p);
  if (ind.tabSize !== undefined || ind.insertSpaces !== undefined) model.updateOptions(ind);
}

/** Save-time rules from .editorconfig (line endings applied here; whitespace rules returned). */
export async function editorConfigOnSave(model: monaco.editor.ITextModel): Promise<{ trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean } | null> {
  if (model.uri.scheme !== "file") return null;
  const p = await editorConfigFor(model.uri.fsPath);
  if (!p) return null;
  if (p.end_of_line === "lf" || p.end_of_line === "crlf") {
    const want = p.end_of_line === "crlf" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
    if (model.getEOL() !== (p.end_of_line === "crlf" ? "\r\n" : "\n")) model.pushEOL(want);
  }
  const o: { trimTrailingWhitespace?: boolean; insertFinalNewline?: boolean } = {};
  if (p.trim_trailing_whitespace !== undefined) o.trimTrailingWhitespace = p.trim_trailing_whitespace;
  if (p.insert_final_newline !== undefined) o.insertFinalNewline = p.insert_final_newline;
  return o;
}

/** A saved .editorconfig invalidates the cache and re-applies to open files. */
export function onEditorConfigSaved(path: string) {
  if (!/[\\/]\.editorconfig$/i.test(path)) return;
  ecCache.clear();
  monaco.editor.getModels().forEach((m) => { applyEditorConfig(m); });
}
