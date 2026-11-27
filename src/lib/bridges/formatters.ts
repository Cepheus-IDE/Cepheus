//! Extension bridges: formatters (Prettier, Black, Ruff, rustfmt, gofmt, clang-format, shfmt,
//! PHP CS Fixer, Taplo, dart format) as Monaco formatting providers, the per-language default
//! formatter, format on save, and "Format Document With…".

import { monaco } from "../monaco";
import { api } from "../api";
import { editorRef } from "../ai";
import { shellQuote } from "../procBus";
import { get, toast } from "../../store";
import { acceptFormatted, cargoEdition, FormatterId, formatterArgs, minimalEdit, withEol } from "./core";
import { FORMATTERS } from "./registry";
import { activeFormatterIds } from "./state";
import { localWorkspace, resolveTool, runTool } from "./tools";

const TAG = "__cepheusBridgeFormatter";
let providers: monaco.IDisposable[] = [];
let registeredKey = "";
let forced: string | null = null;
const warned = new Set<string>();

const modelPath = (m: monaco.editor.ITextModel) => m.uri.fsPath;

/** Bridge formatters on for a language (in bridge order). */
export const formattersFor = (lang: string): FormatterId[] => activeFormatterIds().filter((id) => FORMATTERS[id].languages.includes(lang));

/** The formatter Format Document uses: the explicit default, else the first bridge formatter, else the editor's. */
export function preferredFormatter(lang: string): FormatterId | "editor" {
  const pick = get().settings.defaultFormatter?.[lang];
  const list = formattersFor(lang);
  if (pick === "editor") return "editor";
  if (pick && list.includes(pick as FormatterId)) return pick as FormatterId;
  return list[0] ?? "editor";
}

async function rustEdition(file: string): Promise<string | undefined> {
  let dir = file.replace(/[\\/][^\\/]*$/, "");
  for (let i = 0; i < 12 && dir; i++) {
    const t = await api.readFile(`${dir}/Cargo.toml`).catch(() => null);
    if (t !== null) return cargoEdition(t);
    const up = dir.replace(/[\\/][^\\/]*$/, "");
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Runs a formatter on a model's text; returns the new text (model EOL) or throws with a reason. */
export async function formatText(id: FormatterId, model: monaco.editor.ITextModel): Promise<string> {
  const def = FORMATTERS[id];
  const file = modelPath(model);
  const tool = await resolveTool(def.tool, file);
  if (!tool) throw new Error(`${def.name} isn't installed${localWorkspace() ? "" : " (open a folder first)"} — see its extension page for a one-click install.`);
  const input = model.getValue();
  const edition = id === "rustfmt" ? await rustEdition(file) : undefined;
  const plan = (tmp: string) => formatterArgs(id, file, tmp, shellQuote, { edition });
  const mode = plan("x").mode;
  // rustfmt reading stdin looks for rustfmt.toml from the working folder upwards.
  const cwd = id === "rustfmt" ? file.replace(/[\\/][^\\/]*$/, "") : tool.cwd;
  const run = await runTool(tool.exe, (tmp) => plan(tmp).args, { cwd, file, input, mode, timeoutMs: 20000 }).done;
  const res = acceptFormatted(input, run.text, run.code);
  if (!res.ok) throw new Error(`${def.name} failed (${res.reason})${run.stderr.trim() ? ": " + run.stderr.trim().split(/\r?\n/).slice(0, 3).join(" ") : ""}`);
  return withEol(res.text, model.getEOL());
}

/** Formats a model with a bridge formatter as one undoable edit. */
export async function formatModel(id: FormatterId, model: monaco.editor.ITextModel): Promise<boolean> {
  const version = model.getVersionId();
  const text = await formatText(id, model);
  if (model.isDisposed() || model.getVersionId() !== version) return false; // edited meanwhile
  const e = minimalEdit(model.getValue(), text);
  if (!e) return true;
  const ed = editorRef.current && editorRef.current.getModel() === model ? editorRef.current : null;
  const range = monaco.Range.fromPositions(model.getPositionAt(e.start), model.getPositionAt(e.end));
  model.pushStackElement();
  model.pushEditOperations(ed?.getSelections() ?? [], [{ range, text: e.text }], () => null);
  model.pushStackElement();
  return true;
}

/**
 * Format on save: when the language's formatter is a bridge one, run it (also for background saves,
 * no editor needed). Returns true when a bridge handled it, so the editor's formatter is skipped.
 */
export async function formatOnSave(model: monaco.editor.ITextModel): Promise<boolean> {
  const pick = preferredFormatter(model.getLanguageId());
  if (pick === "editor") return false;
  // Tool not in this project (e.g. no Prettier in node_modules): say so once, use the editor's formatter.
  if (!(await resolveTool(FORMATTERS[pick].tool, modelPath(model)))) {
    if (!warned.has(pick + "|" + localWorkspace())) {
      warned.add(pick + "|" + localWorkspace());
      toast(`${FORMATTERS[pick].name} isn't installed for this project, so format on save uses the editor's formatter. Install it from the extension page.`);
    }
    return false;
  }
  try {
    await Promise.race([formatModel(pick, model), new Promise((_, rej) => setTimeout(() => rej(new Error(`${FORMATTERS[pick].name} took too long; saved without formatting`)), 15000))]);
  } catch (e) {
    toast(String((e as Error)?.message ?? e), "error");
  }
  return true;
}

/** (Re)registers Monaco providers for the bridge formatters that are on. */
export function syncFormatterProviders() {
  const ids = activeFormatterIds();
  const key = ids.join(",");
  if (key === registeredKey) return;
  registeredKey = key;
  providers.forEach((p) => p.dispose());
  providers = [];
  for (const id of ids) {
    const def = FORMATTERS[id];
    for (const lang of def.languages) {
      const provider: monaco.languages.DocumentFormattingEditProvider & Record<string, unknown> = {
        displayName: `${def.name} (bridge)`,
        [TAG]: id,
        async provideDocumentFormattingEdits(model) {
          try {
            const text = await formatText(id, model);
            return [{ range: model.getFullModelRange(), text }]; // Monaco reduces this to minimal edits
          } catch (e) {
            toast(String((e as Error)?.message ?? e), "error");
            return [];
          }
        },
      };
      providers.push(monaco.languages.registerDocumentFormattingEditProvider(lang, provider));
    }
  }
}

/** Monaco picks a formatter when several apply: honor "Format Document With…" and the default. */
export async function installFormatterSelector(): Promise<() => void> {
  try {
    const { FormattingConflicts } = await import("monaco-editor/esm/vs/editor/contrib/format/browser/format.js");
    const d = FormattingConflicts.setFormatterSelector(async (list: any[], model: monaco.editor.ITextModel) => {
      const want = forced ?? preferredFormatter(model.getLanguageId());
      const bridge = (p: any) => typeof p?.[TAG] === "string";
      if (want === "editor") return list.find((p) => !bridge(p)) ?? list[0];
      return list.find((p) => p?.[TAG] === want) ?? list.find((p) => !bridge(p)) ?? list[0];
    });
    return () => d.dispose();
  } catch (e) {
    console.warn("formatter selector unavailable", e);
    return () => {};
  }
}

/** Formats the active editor with a given formatter ("editor" = built-in / language server). */
export async function formatActiveWith(choice: FormatterId | "editor") {
  const ed = editorRef.current;
  const model = ed?.getModel();
  if (!ed || !model) return;
  if (choice !== "editor") {
    try { await formatModel(choice, model); } catch (e) { toast(String((e as Error)?.message ?? e), "error"); }
    return;
  }
  forced = "editor";
  try {
    ed.focus();
    await ed.getAction("editor.action.formatDocument")?.run();
  } finally {
    forced = null;
  }
}

export function disposeFormatters() {
  providers.forEach((p) => p.dispose());
  providers = [];
  registeredKey = "";
}
