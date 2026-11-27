//! Editor-wide features wired once at startup (from initLsp): TS/JS refactorings and organize
//! imports, the Organize Imports / Refactor commands for every language, TS semantic checking
//! and screen-reader settings, and accessible names for icon-only buttons.

import { monaco, setTsSemanticValidation } from "./monaco";
import { editorRef } from "./ai";
import { get, toast, useStore } from "../store";
import { errMsg } from "./api";

const TS_LANGS = ["typescript", "javascript"];
const APPLY_TS_REFACTOR = "cepheus.ts.applyRefactor";
const APPLY_TS_ORGANIZE = "cepheus.ts.organizeImports";

async function tsWorker(model: monaco.editor.ITextModel): Promise<any> {
  const ts = monaco.languages.typescript;
  const get = model.getLanguageId() === "javascript" ? await ts.getJavaScriptWorker() : await ts.getTypeScriptWorker();
  return get(model.uri);
}

const formatOf = (model: monaco.editor.ITextModel) => {
  const o = model.getOptions();
  return { tabSize: o.tabSize, indentSize: o.indentSize, convertTabsToSpaces: o.insertSpaces };
};

/** Applies TypeScript `FileTextChanges[]` to the matching models (one undo step per file). */
function applyTsChanges(changes: any[]): boolean {
  let any = false;
  for (const fc of changes ?? []) {
    const model = monaco.editor.getModel(monaco.Uri.parse(fc.fileName));
    if (!model || !fc.textChanges?.length) continue;
    const ops = fc.textChanges.map((tc: any) => {
      const s = model.getPositionAt(tc.span.start);
      const e = model.getPositionAt(tc.span.start + tc.span.length);
      return { range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), text: tc.newText };
    });
    model.pushStackElement();
    model.pushEditOperations([], ops, () => null);
    model.pushStackElement();
    any = true;
  }
  return any;
}

async function tsOrganizeImports(model: monaco.editor.ITextModel): Promise<boolean> {
  const w = await tsWorker(model);
  return applyTsChanges(await w.organizeImportsEdits(model.uri.toString(), formatOf(model)));
}

function registerTsActions(): monaco.IDisposable[] {
  const subs: monaco.IDisposable[] = [];
  subs.push(monaco.editor.registerCommand(APPLY_TS_REFACTOR, async (_a, uri: string, start: number, end: number, refactor: string, action: string) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;
    try {
      const w = await tsWorker(model);
      const res = await w.getRefactorEdits(uri, start, end, refactor, action, formatOf(model));
      if (!res || !applyTsChanges(res.edits)) return toast("This refactoring produced no changes.");
      // Extract function/constant: put the cursor on the new name and start a rename, like VS Code.
      const ed = editorRef.current;
      if (res.renameLocation !== undefined && ed?.getModel() === model) {
        // renameLocation is an offset into the edited text, which is the model's text now.
        const pos = model.getPositionAt(res.renameLocation);
        ed.setPosition(pos);
        ed.revealPositionInCenterIfOutsideViewport(pos);
        setTimeout(() => ed.trigger("refactor", "editor.action.rename", null), 50);
      }
    } catch (e) {
      toast(errMsg(e), "error");
    }
  }));
  subs.push(monaco.editor.registerCommand(APPLY_TS_ORGANIZE, async (_a, uri: string) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (model) await tsOrganizeImports(model).catch((e) => toast(errMsg(e), "error"));
  }));

  for (const lang of TS_LANGS) {
    subs.push(monaco.languages.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, context) {
        const only = context.only ?? "";
        const actions: monaco.languages.CodeAction[] = [];
        const wantsSource = only === "source" || only.startsWith("source.organizeImports");
        const wantsRefactor = only ? only === "refactor" || only.startsWith("refactor") : context.trigger === monaco.languages.CodeActionTriggerType.Invoke || !range.isEmpty();
        if (wantsSource) {
          actions.push({ title: "Organize Imports", kind: "source.organizeImports", command: { id: APPLY_TS_ORGANIZE, title: "Organize Imports", arguments: [model.uri.toString()] } });
        }
        if (wantsRefactor) {
          const start = model.getOffsetAt(range.getStartPosition());
          const end = model.getOffsetAt(range.getEndPosition());
          const w = await tsWorker(model).catch(() => null);
          const infos: any[] = (await w?.getRefactors(model.uri.toString(), start, end, context.trigger === 1 ? "invoked" : "implicit")) ?? [];
          for (const info of infos) {
            for (const a of info.actions ?? []) {
              if (a.notApplicableReason) continue;
              const kind = a.kind ?? "refactor";
              if (only && only !== "refactor" && !kind.startsWith(only)) continue;
              actions.push({
                title: a.description,
                kind,
                command: { id: APPLY_TS_REFACTOR, title: a.description, arguments: [model.uri.toString(), start, end, info.name, a.name] },
              });
            }
          }
        }
        return { actions, dispose() {} };
      },
    }, { providedCodeActionKinds: ["refactor", "refactor.extract", "refactor.rewrite", "refactor.move", "source.organizeImports"] }));
  }
  return subs;
}

/** "Organize Imports" for the active editor: TS worker for TS/JS, LSP `source.organizeImports` otherwise. */
export async function organizeImports() {
  const ed = editorRef.current;
  const model = ed?.getModel();
  if (!ed || !model) return;
  const lang = model.getLanguageId();
  try {
    if (TS_LANGS.includes(lang)) {
      if (!(await tsOrganizeImports(model))) toast("Imports are already organized.");
      return;
    }
    const lsp = await import("./lsp");
    const actions = await lsp.lspCodeActions(model, model.getFullModelRange(), "source.organizeImports");
    if (!actions.length) return toast(lsp.hasLspClient(lang) ? "The language server offers no Organize Imports here." : "No language server is running for this file.");
    await lsp.applyCodeAction(lang, actions[0]);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Runs a Monaco action on the main editor (Quick Fix, Refactor…, Source Action…). */
export function editorAction(id: string) {
  const ed = editorRef.current;
  if (!ed) return;
  ed.focus();
  ed.trigger("command", id, null);
}

/** Icon-only buttons get their tooltip as accessible name (screen readers otherwise read nothing). */
function labelIconButtons() {
  const fix = (root: ParentNode) => {
    root.querySelectorAll?.("button[title]:not([aria-label]), [role=button][title]:not([aria-label])").forEach((b) => {
      if (!b.textContent?.trim()) b.setAttribute("aria-label", b.getAttribute("title")!);
    });
  };
  let queued = false;
  const mo = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fix(document.body); });
  });
  fix(document.body);
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  return () => mo.disconnect();
}

let started = false;
export function initEditorFeatures(): () => void {
  if (started) return () => {};
  started = true;
  const tsSubs = registerTsActions();
  const apply = () => {
    const s = get().settings;
    setTsSemanticValidation(s.tsSemanticValidation !== false);
    for (const ed of monaco.editor.getEditors()) ed.updateOptions({ accessibilitySupport: s.accessibilitySupport ?? "auto" });
  };
  apply();
  const sub = monaco.editor.onDidCreateEditor((ed) => ed.updateOptions({ accessibilitySupport: get().settings.accessibilitySupport ?? "auto" }));
  let prev = get().settings;
  const unsub = useStore.subscribe((st) => {
    if (st.settings === prev) return;
    const changed = st.settings.tsSemanticValidation !== prev.tsSemanticValidation || st.settings.accessibilitySupport !== prev.accessibilitySupport;
    prev = st.settings;
    if (changed) apply();
  });
  const stopLabels = labelIconButtons();
  const stops: (() => void)[] = [];
  let alive = true;
  // Cleanup can run before these load (React StrictMode); stop them right away then.
  const keep = (stop: () => void) => (alive ? stops.push(stop) : stop());
  import("./settingsLevels").then((m) => alive && keep(m.initSettingsLevels()));
  import("./snippets").then((m) => alive && keep(m.initSnippets()));
  return () => { alive = false; tsSubs.forEach((d) => d.dispose()); sub.dispose(); unsub(); stopLabels(); stops.forEach((f) => f()); started = false; };
}
