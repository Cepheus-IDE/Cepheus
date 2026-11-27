//! User and workspace snippets in VS Code format (prefix / body / description / scope):
//!   <profile folder>/snippets/<language>.json      user snippets for one language (active profile)
//!   <profile folder>/snippets/<name>.code-snippets  user snippets for all languages (or `scope`)
//!   <folder>/.cepheus/snippets/*.json, <folder>/.vscode/*.code-snippets   workspace snippets
//! A `.json` file named after a language id applies to that language; any other file applies to
//! the languages in each snippet's `scope`, or to all of them.

import { monaco } from "./monaco";
import { api, errMsg } from "./api";
import { get, toast, useStore } from "../store";
import { parseJsonc } from "./settings";
import { bodyText, resolveSnippetVariables } from "./snippetVars";
import { registerJsonSchema } from "./jsonSchemas";
import { userConfigDir } from "./settingsLevels";
import { editorRef } from "./ai";

interface UserSnippet { name: string; prefix: string; body: string; description?: string; langs: string[] | null; source: "User" | "Workspace" }

let snippets: UserSnippet[] = [];

/** User snippets live in the active profile's folder (profiles.ts); app config folder as a fallback. */
async function userSnippetsDir(): Promise<string | null> {
  try {
    const { activeSnippetsDir } = await import("./profiles");
    return (await activeSnippetsDir()).replace(/\\/g, "/");
  } catch {
    const cfg = await userConfigDir().catch(() => null);
    return cfg ? cfg + "/snippets" : null;
  }
}
let loadSeq = 0;

function parseFile(text: string, fileName: string, source: UserSnippet["source"]): UserSnippet[] {
  const json = parseJsonc(text);
  if (!json || typeof json !== "object") return [];
  const base = fileName.replace(/\.(json|code-snippets)$/i, "");
  const known = monaco.languages.getLanguages().some((l) => l.id === base);
  const fileLang = fileName.toLowerCase().endsWith(".json") && known ? [base] : null;
  const out: UserSnippet[] = [];
  for (const [name, def] of Object.entries<any>(json)) {
    if (!def || typeof def !== "object" || def.body === undefined) continue;
    const scope = typeof def.scope === "string" && def.scope.trim() ? def.scope.split(",").map((s: string) => s.trim()).filter(Boolean) : null;
    const prefixes: string[] = Array.isArray(def.prefix) ? def.prefix.map(String) : [String(def.prefix ?? name)];
    for (const prefix of prefixes) {
      out.push({ name, prefix, body: bodyText(def.body), description: typeof def.description === "string" ? def.description : bodyText(def.description) || undefined, langs: fileLang ?? scope, source });
    }
  }
  return out;
}

async function loadDir(dir: string, source: UserSnippet["source"], ext: RegExp): Promise<UserSnippet[]> {
  const entries = await api.readDir(dir).catch(() => []);
  const out: UserSnippet[] = [];
  for (const e of entries) {
    if (e.isDir || !ext.test(e.name)) continue;
    try {
      out.push(...parseFile(await api.readFile(e.path), e.name, source));
    } catch (err) {
      toast(`Snippets ${e.name}: ${errMsg(err)}`, "error");
    }
  }
  return out;
}

export async function reloadSnippets() {
  const seq = ++loadSeq;
  const list: UserSnippet[] = [];
  const dir = await userSnippetsDir();
  if (dir) list.push(...(await loadDir(dir, "User", /\.(json|code-snippets)$/i)));
  const ws = get().workspace?.replace(/\\/g, "/").replace(/\/$/, "");
  if (ws) {
    list.push(...(await loadDir(ws + "/.cepheus/snippets", "Workspace", /\.(json|code-snippets)$/i)));
    list.push(...(await loadDir(ws + "/.vscode", "Workspace", /\.code-snippets$/i)));
  }
  if (seq === loadSeq) snippets = list;
}

/** Live reload when a snippet file is saved (from lsp.notifySaved). */
export function onFileSaved(path: string) {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/\/snippets\/[^/]+\.(json|code-snippets)$/.test(p) || /\/\.vscode\/[^/]+\.code-snippets$/.test(p)) {
    reloadSnippets().then(() => toast("Snippets reloaded."));
  }
}

function registerProvider() {
  return monaco.languages.registerCompletionItemProvider("*", {
    async provideCompletionItems(model, position) {
      const lang = model.getLanguageId();
      const list = snippets.filter((s) => !s.langs || s.langs.includes(lang));
      if (!list.length) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const ed = editorRef.current;
      const sel = ed?.getModel() === model ? ed.getSelection() : null;
      const needsClipboard = list.some((s) => s.body.includes("CLIPBOARD"));
      const ctx = {
        filePath: model.uri.scheme === "file" ? model.uri.fsPath.replace(/\\/g, "/") : model.uri.path,
        workspace: get().workspace,
        selection: sel && !sel.isEmpty() ? model.getValueInRange(sel) : "",
        lineText: model.getLineContent(position.lineNumber),
        word: model.getWordAtPosition(position)?.word ?? "",
        lineNumber: position.lineNumber,
        clipboard: needsClipboard ? await navigator.clipboard.readText().catch(() => "") : "",
        language: lang,
      };
      return {
        suggestions: list.map((s) => ({
          label: { label: s.prefix, description: s.name },
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: `${s.description ?? s.name} (${s.source} Snippet)`,
          documentation: { value: "```" + lang + "\n" + s.body.replace(/\$\{\d+:([^}]*)\}/g, "$1").replace(/\$\d+/g, "") + "\n```" },
          insertText: resolveSnippetVariables(s.body, ctx),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          filterText: s.prefix,
          sortText: s.prefix,
          range,
        })),
      };
    },
  });
}

const TEMPLATE = (lang: string) => `{
  // ${lang} snippets. Each entry has a "prefix" (what you type), a "body" (string or array of
  // lines) and an optional "description". In a body: $1, $2 … tab stops, $0 the final cursor,
  // \${1:label} placeholders, \${1|one,two|} choices, and variables such as $TM_FILENAME,
  // $TM_SELECTED_TEXT, $CLIPBOARD, $CURRENT_YEAR, $CURRENT_DATE, $UUID, $WORKSPACE_NAME.
  //
  // "Print to console": {
  //   "prefix": "log",
  //   "body": ["console.log('$1');", "$0"],
  //   "description": "Log output to console"
  // }
}
`;

/** "Snippets: Configure User/Workspace Snippets" for the active editor's language. */
export async function configureSnippets(level: "user" | "workspace") {
  const lang = editorRef.current?.getModel()?.getLanguageId() || get().language || "global";
  // "global.json" isn't a language id, so it applies to every language (or each snippet's scope).
  const name = lang === "plaintext" ? "global.json" : `${lang}.json`;
  try {
    let dir: string;
    if (level === "user") {
      const d = await userSnippetsDir();
      if (!d) throw new Error("No user snippets folder");
      dir = d;
    }
    else {
      const ws = get().workspace;
      if (!ws) return toast("Open a folder first.");
      dir = ws.replace(/\\/g, "/").replace(/\/$/, "") + "/.cepheus/snippets";
    }
    const path = `${dir}/${name}`;
    if (!(await api.exists(path))) {
      await api.createDir(dir).catch(() => {});
      await api.writeFile(path, TEMPLATE(lang === "plaintext" ? "Global" : lang));
    }
    const { openFile } = await import("./workspace");
    await openFile(path, 2, 1);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

const SNIPPET_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "object",
    required: ["body"],
    properties: {
      prefix: { description: "Trigger word(s) shown in IntelliSense.", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      body: { description: "Snippet text: a string or an array of lines. $1 tab stops, ${1:placeholder}, $0 final cursor, $VARIABLES.", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      description: { type: "string", description: "Shown in IntelliSense." },
      scope: { type: "string", description: "Comma-separated language ids (only for files not named after a language)." },
    },
  },
};

export function initSnippets(): () => void {
  const provider = registerProvider();
  reloadSnippets();
  userConfigDir().then((dir) => {
    const dirName = dir.split("/").pop();
    registerJsonSchema("cepheus://schemas/snippets", [`**/${dirName}/profiles/*/snippets/*.json`,`**/${dirName}/snippets/*.json`, `**/${dirName}/snippets/*.code-snippets`, "**/.cepheus/snippets/*.json", "**/.vscode/*.code-snippets"], SNIPPET_SCHEMA);
  }).catch(() => {});
  let ws = get().workspace;
  const unsub = useStore.subscribe((s) => {
    if (s.workspace !== ws) { ws = s.workspace; reloadSnippets(); }
  });
  const onProfile = () => reloadSnippets();
  window.addEventListener("cepheus:profile-changed", onProfile);
  return () => { provider.dispose(); unsub(); window.removeEventListener("cepheus:profile-changed", onProfile); };
}
