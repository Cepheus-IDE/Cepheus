import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
// Monaco's TS worker extended with refactorings / organize imports (see tsWorkerExt.ts).
import tsWorker from "./tsWorkerExt?worker";

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

monaco.editor.defineTheme("cepheus-dark", {
  base: "vs-dark",
  inherit: true,
  // Restrained syntax palette: ivory text, brass keywords, sage strings, stone comments.
  rules: [
    { token: "", foreground: "e7e4dc" },
    { token: "comment", foreground: "5f5d57", fontStyle: "italic" },
    { token: "keyword", foreground: "c8a464" },
    { token: "keyword.control", foreground: "c8a464" },
    { token: "storage", foreground: "c8a464" },
    { token: "string", foreground: "a3b195" },
    { token: "string.escape", foreground: "c8a464" },
    { token: "regexp", foreground: "a3b195" },
    { token: "number", foreground: "d9c49a" },
    { token: "constant", foreground: "d9c49a" },
    { token: "type", foreground: "f2efe8", fontStyle: "" },
    { token: "type.identifier", foreground: "f2efe8" },
    { token: "identifier", foreground: "d8d4ca" },
    { token: "function", foreground: "f2efe8" },
    { token: "variable", foreground: "d8d4ca" },
    { token: "delimiter", foreground: "8d8a82" },
    { token: "delimiter.bracket", foreground: "8d8a82" },
    { token: "operator", foreground: "8d8a82" },
    { token: "tag", foreground: "c8a464" },
    { token: "attribute.name", foreground: "d8d4ca" },
    { token: "attribute.value", foreground: "a3b195" },
    { token: "metatag", foreground: "8d8a82" },
    { token: "key", foreground: "d8d4ca" },
    { token: "string.key.json", foreground: "d8d4ca" },
    { token: "string.value.json", foreground: "a3b195" },
  ],
  colors: {
    "editor.background": "#0d0d0c",
    "editor.foreground": "#e7e4dc",
    "editorLineNumber.foreground": "#34332f",
    "editorLineNumber.activeForeground": "#8d8a82",
    "editor.lineHighlightBackground": "#141413",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#c8a46430",
    "editor.inactiveSelectionBackground": "#c8a4641a",
    "editor.selectionHighlightBackground": "#c8a4641a",
    "editor.wordHighlightBackground": "#ffffff0d",
    "editor.findMatchBackground": "#c8a46455",
    "editor.findMatchHighlightBackground": "#c8a46426",
    "editorCursor.foreground": "#c8a464",
    "editorWhitespace.foreground": "#2a2a27",
    "editorIndentGuide.background1": "#1c1c1a",
    "editorIndentGuide.activeBackground1": "#34332f",
    "editorBracketMatch.background": "#c8a4641a",
    "editorBracketMatch.border": "#c8a46466",
    "editorBracketHighlight.foreground1": "#8d8a82",
    "editorBracketHighlight.foreground2": "#a39f95",
    "editorBracketHighlight.foreground3": "#c8a464",
    "editorBracketHighlight.foreground4": "#8d8a82",
    "editorBracketHighlight.foreground5": "#a39f95",
    "editorBracketHighlight.foreground6": "#c8a464",
    "editorBracketPairGuide.activeBackground1": "#34332f",
    "editorGutter.background": "#0d0d0c",
    "editorWidget.background": "#121211",
    "editorWidget.border": "#232321",
    "editorHoverWidget.background": "#121211",
    "editorHoverWidget.border": "#232321",
    "editorSuggestWidget.background": "#121211",
    "editorSuggestWidget.border": "#232321",
    "editorSuggestWidget.foreground": "#b8b4aa",
    "editorSuggestWidget.highlightForeground": "#c8a464",
    "editorSuggestWidget.selectedBackground": "#1e1e1c",
    "editorGhostText.foreground": "#5f5d57",
    "editorStickyScroll.background": "#0d0d0c",
    "editorStickyScrollHover.background": "#141413",
    "input.background": "#0d0d0c",
    "input.border": "#232321",
    "focusBorder": "#57554f",
    "list.hoverBackground": "#1a1a19",
    "list.activeSelectionBackground": "#1e1e1c",
    "list.highlightForeground": "#c8a464",
    "minimap.background": "#0d0d0c",
    "minimapSlider.background": "#ffffff08",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#ffffff10",
    "scrollbarSlider.hoverBackground": "#ffffff1c",
    "scrollbarSlider.activeBackground": "#ffffff24",
    "editorOverviewRuler.border": "#00000000",
    "editorError.foreground": "#c46a5c",
    "editorWarning.foreground": "#c8a464",
    "diffEditor.insertedTextBackground": "#8fa3821f",
    "diffEditor.removedTextBackground": "#c46a5c1f",
    "diffEditor.insertedLineBackground": "#8fa38212",
    "diffEditor.removedLineBackground": "#c46a5c12",
  },
});

// Allow TS/JS files to import each other without red squiggles everywhere.
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
  allowJs: true,
  allowNonTsExtensions: true,
  esModuleInterop: true,
});
/**
 * Semantic checks without a project: the worker only sees open files, so errors about modules,
 * ambient types and globals it can't resolve would be noise. Everything else (typos, wrong
 * arguments, missing properties) is reported, with Monaco's TS quick fixes.
 */
export const TS_IGNORED_DIAGNOSTICS = [
  2307, 2792, 7016, 2732, // cannot find module / its declarations / JSON modules
  2503, // cannot find namespace (e.g. React.* without @types)
  2580, 2591, 2593, 2582, 2867, 2868, // node / test-runner globals need @types
  2686, 7026, 2875, // UMD React global, JSX intrinsic elements, jsx runtime module
  1375, 1378, 1259, 1192, 1479, 2354, // module-format / tslib specifics
];
export function setTsSemanticValidation(enabled: boolean) {
  for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    d.setDiagnosticsOptions({
      noSemanticValidation: !enabled,
      noSyntaxValidation: false,
      noSuggestionDiagnostics: !enabled,
      diagnosticCodesToIgnore: TS_IGNORED_DIAGNOSTICS,
    });
  }
}
setTsSemanticValidation(false);
// JS gets checked only for syntax and suggestions unless the file opts in with // @ts-check.
monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
  ...monaco.languages.typescript.typescriptDefaults.getCompilerOptions(),
  checkJs: false,
});

export { monaco };

export function languageForPath(path: string): string {
  const uri = monaco.Uri.file(path);
  const ext = "." + (path.split(".").pop() ?? "").toLowerCase();
  const langs = monaco.languages.getLanguages();
  // Exact file names and multi-dot extensions (".blade.php") from extension `contributes.languages`.
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const named = langs.find((l) => l.filenames?.some((f) => f.toLowerCase() === base))
    ?? langs.find((l) => l.extensions?.some((e) => e.split(".").length > 2 && base.endsWith(e.toLowerCase())));
  if (named) return named.id;
  const lang = langs.find((l) => l.extensions?.includes(ext));
  if (lang) return lang.id;
  const lower = path.toLowerCase();
  if (lower.endsWith("dockerfile")) return "dockerfile";
  void uri;
  return "plaintext";
}
