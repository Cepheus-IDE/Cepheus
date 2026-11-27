import { api, errMsg } from "./api";
import { monaco } from "./monaco";
import { get, toast } from "../store";
import { providerConfig } from "./settings";

export const editorRef: { current: monaco.editor.IStandaloneCodeEditor | null } = { current: null };

function stripFences(s: string): string {
  const m = s.match(/^\s*```[\w+-]*\s*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1] : s;
}

// ---------------------------------------------------------------------------------------------
// Inline AI completion (ghost text)
// ---------------------------------------------------------------------------------------------

let registered = false;
export function registerInlineCompletion() {
  if (registered) return;
  registered = true;
  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
    async provideInlineCompletions(
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      _ctx: unknown,
      token: monaco.CancellationToken
    ) {
      const s = get().settings;
      if (!s.inlineCompletion) return { items: [] };
      // Debounce: wait for the user to pause typing.
      await new Promise((r) => setTimeout(r, 600));
      if (token.isCancellationRequested) return { items: [] };
      const full = model.getFullModelRange();
      const prefix = model.getValueInRange(new monaco.Range(Math.max(1, position.lineNumber - 80), 1, position.lineNumber, position.column));
      const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, Math.min(full.endLineNumber, position.lineNumber + 40), full.endColumn));
      if (prefix.trim().length < 3) return { items: [] };
      try {
        const out = await api.aiOneshot(
          providerConfig(s, s.completionModel, "low"),
          "You are a code completion engine. Given code before and after the cursor, output ONLY the text to insert at the cursor: no explanations, no markdown fences, no repetition of existing code. Keep it short (at most a few lines). If nothing sensible fits, output nothing.",
          `Language: ${model.getLanguageId()}\n<before_cursor>\n${prefix}</before_cursor>\n<after_cursor>\n${suffix}\n</after_cursor>\nText to insert at the cursor:`,
          2000
        );
        if (token.isCancellationRequested) return { items: [] };
        const text = stripFences(out).replace(/\s+$/, "");
        if (!text) return { items: [] };
        return { items: [{ insertText: text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] };
      } catch {
        return { items: [] };
      }
    },
    freeInlineCompletions() {},
    disposeInlineCompletions() {},
  } as any);
}

// ---------------------------------------------------------------------------------------------
// Inline edit (Ctrl+K): rewrite the selection according to an instruction
// ---------------------------------------------------------------------------------------------

export async function runInlineEdit(instruction: string) {
  const ed = editorRef.current;
  const model = ed?.getModel();
  if (!ed || !model) return;
  let sel = ed.getSelection()!;
  if (sel.isEmpty()) {
    // No selection: operate on the current line.
    sel = new monaco.Selection(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber));
  }
  const selected = model.getValueInRange(sel);
  const before = model.getValueInRange(new monaco.Range(Math.max(1, sel.startLineNumber - 60), 1, sel.startLineNumber, sel.startColumn));
  const after = model.getValueInRange(new monaco.Range(sel.endLineNumber, sel.endColumn, Math.min(model.getLineCount(), sel.endLineNumber + 30), 10000));
  const s = get().settings;
  const out = await api.aiOneshot(
    providerConfig(s),
    "You edit code. Rewrite the given snippet according to the instruction. Output ONLY the replacement snippet, preserving indentation, with no explanations and no markdown fences.",
    `File: ${model.uri.fsPath} (language: ${model.getLanguageId()})\n<context_before>\n${before}\n</context_before>\n<snippet>\n${selected}\n</snippet>\n<context_after>\n${after}\n</context_after>\nInstruction: ${instruction}\nReplacement snippet:`,
    16000
  );
  const replacement = stripFences(out);
  ed.pushUndoStop();
  ed.executeEdits("cepheus-inline-edit", [{ range: sel, text: replacement, forceMoveMarkers: true }]);
  ed.pushUndoStop();
  toast("Inline edit applied — Ctrl+Z to undo");
}

// ---------------------------------------------------------------------------------------------
// Commit message generation
// ---------------------------------------------------------------------------------------------

export async function generateCommitMessage(): Promise<string> {
  const ws = get().workspace!;
  const diff = await api.gitDiffStaged(ws);
  if (!diff.trim()) throw new Error("No changes to describe.");
  const s = get().settings;
  const out = await api.aiOneshot(
    providerConfig(s, undefined, "low"),
    "You write git commit messages. Output only the commit message: a concise imperative subject line (max 72 chars), then optionally a blank line and a short bullet list of key changes. No markdown fences.",
    `Diff:\n${diff.slice(0, 60000)}`,
    4000
  );
  return stripFences(out).trim();
}

export async function explainError(e: unknown) {
  toast(errMsg(e), "error");
}
