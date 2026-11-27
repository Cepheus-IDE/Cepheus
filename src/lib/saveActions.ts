// Save participants: format on save, trim trailing whitespace, final newline handling.
// Called by workspace.saveFile before the text is written.
import { monaco } from "./monaco";
import { editorRef } from "./ai";
import { get } from "../store";

type Opts = { trimTrailingWhitespace: boolean; insertFinalNewline: boolean; trimFinalNewlines: boolean };

/** Minimal edits (so breakpoints, markers and folding survive) for a list of lines. */
export function cleanupEdits(lines: string[], s: Opts): { line: number; from: number; to: number; text: string; endLine?: number }[] {
  const edits: { line: number; from: number; to: number; text: string; endLine?: number }[] = [];
  const n = lines.length;
  const eff = lines.map((l) => (s.trimTrailingWhitespace ? l.replace(/[ \t]+$/, "") : l));
  // Last line with content (1-based); lines after it are (effectively) empty.
  let last = n;
  while (last > 0 && eff[last - 1] === "") last--;
  const dropTail = s.trimFinalNewlines && last > 0 && last < n - 1;
  if (s.trimTrailingWhitespace) {
    for (let i = 0; i < n; i++) {
      if (dropTail && i + 1 > last) break; // removed below anyway
      if (eff[i].length !== lines[i].length) edits.push({ line: i + 1, from: eff[i].length + 1, to: lines[i].length + 1, text: "" });
    }
  }
  // Keep exactly one newline after the last content line: delete lines last+1 … n-1 (with their breaks).
  if (dropTail) edits.push({ line: last + 1, from: 1, endLine: n, to: 1, text: "" });
  else if (s.insertFinalNewline && lines[n - 1] !== "") edits.push({ line: n, from: lines[n - 1].length + 1, to: lines[n - 1].length + 1, text: "\n" });
  return edits;
}

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

export async function beforeSave(model: monaco.editor.ITextModel) {
  const bridges = await import("./bridges").catch(() => null);
  // .editorconfig (bridges/extras.ts) overrides the whitespace rules per file and sets line endings.
  const s = { ...get().settings, ...((await bridges?.saveOverrides(model).catch(() => null)) ?? {}) };
  const ed = editorRef.current;
  // A bridge formatter (Prettier, Black, …) is the language's formatter: it runs without an editor.
  const bridged = s.formatOnSave && !!bridges && (await bridges.formatOnSave(model).catch(() => false));
  // Formatting needs an editor showing the model; background saves (auto save of other tabs) skip it.
  if (s.formatOnSave && !bridged && ed && ed.getModel() === model) {
    const action = ed.getAction("editor.action.formatDocument");
    if (action?.isSupported()) await withTimeout(action.run(), 2500).catch(() => {});
  }
  if (!s.trimTrailingWhitespace && !s.insertFinalNewline && !s.trimFinalNewlines) return;
  const edits = cleanupEdits(model.getLinesContent(), s);
  if (!edits.length) return;
  const eol = model.getEOL();
  const sel = ed && ed.getModel() === model ? ed.getSelections() : null;
  model.pushEditOperations(
    sel ?? [],
    edits.map((e) => ({ range: new monaco.Range(e.line, e.from, e.endLine ?? e.line, e.to), text: e.text.replace("\n", eol) })),
    () => sel
  );
}
