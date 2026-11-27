// Settings → Monaco / xterm options. One place, so the editor, diff editor and terminals agree
// (and Reduce motion overrides every animation the same way).
import type * as Monaco from "monaco-editor";
import type { ITerminalOptions } from "@xterm/xterm";
import type { Settings } from "./settings";

export const DEFAULT_EDITOR_FONT = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";
export const DEFAULT_TERMINAL_FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, monospace";

const WRAP = { viewport: "on", column: "wordWrapColumn", bounded: "bounded" } as const;

/** Options for the code editor (IEditorOptions keys only; model options are separate). */
export function buildEditorOptions(s: Settings): Monaco.editor.IEditorOptions {
  const still = s.reduceMotion ?? false;
  return {
    fontFamily: s.fontFamily || DEFAULT_EDITOR_FONT,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    lineHeight: s.lineHeight,
    letterSpacing: s.letterSpacing,
    fontLigatures: s.fontLigatures,
    wordWrap: s.wordWrap ? WRAP[s.wordWrapMode] ?? "on" : "off",
    wordWrapColumn: s.wordWrapColumn,
    rulers: s.rulers.filter((n) => Number.isFinite(n) && n > 0),
    renderWhitespace: s.renderWhitespace,
    renderControlCharacters: s.renderControlCharacters,
    lineNumbers: s.lineNumbers,
    renderLineHighlight: s.renderLineHighlight,
    bracketPairColorization: { enabled: s.bracketPairColorization },
    guides: { bracketPairs: s.bracketPairGuides, indentation: s.indentationGuides },
    stickyScroll: { enabled: s.stickyScroll, maxLineCount: s.stickyScrollMaxLines },
    minimap: { enabled: s.minimap, side: s.minimapSide, size: s.minimapSize, renderCharacters: s.minimapRenderCharacters, showSlider: s.minimapShowSlider },
    folding: s.folding,
    foldingStrategy: s.foldingStrategy,
    glyphMargin: s.glyphMargin,
    codeLens: s.codeLens,
    inlayHints: { enabled: s.inlayHints },
    hover: { delay: s.hoverDelay },
    quickSuggestions: s.quickSuggestions ? { other: "on", comments: "off", strings: "off" } : false,
    quickSuggestionsDelay: s.quickSuggestionsDelay,
    acceptSuggestionOnEnter: s.acceptSuggestionOnEnter,
    suggest: { preview: s.suggestPreview, showSnippets: s.snippetSuggestions !== "none" },
    snippetSuggestions: s.snippetSuggestions,
    parameterHints: { enabled: s.parameterHints },
    autoClosingBrackets: s.autoClosingBrackets,
    autoClosingQuotes: s.autoClosingQuotes,
    autoSurround: s.autoSurround,
    formatOnPaste: s.formatOnPaste,
    formatOnType: s.formatOnType,
    multiCursorModifier: s.multiCursorModifier,
    dragAndDrop: s.dragAndDrop,
    links: s.links,
    occurrencesHighlight: s.occurrencesHighlight ? "singleFile" : "off",
    selectionHighlight: s.selectionHighlight,
    unicodeHighlight: { ambiguousCharacters: s.unicodeHighlightAmbiguous, invisibleCharacters: s.unicodeHighlightInvisible },
    scrollBeyondLastLine: s.scrollBeyondLastLine,
    cursorSurroundingLines: s.cursorSurroundingLines,
    cursorStyle: s.cursorStyle,
    cursorWidth: s.cursorWidth,
    // Reduce motion wins over the individual animation settings.
    cursorBlinking: still ? "solid" : s.cursorBlinking,
    cursorSmoothCaretAnimation: still ? "off" : s.cursorSmoothCaretAnimation,
    smoothScrolling: still ? false : s.smoothScrolling,
    mouseWheelScrollSensitivity: s.mouseWheelScrollSensitivity,
    fastScrollSensitivity: s.fastScrollSensitivity,
    accessibilitySupport: s.accessibilitySupport ?? "auto",
  };
}

/** The subset that makes sense for read-only diff editors. */
export function buildDiffOptions(s: Settings): Monaco.editor.IDiffEditorOptions {
  const o = buildEditorOptions(s);
  return {
    fontFamily: o.fontFamily, fontSize: o.fontSize, fontWeight: o.fontWeight, lineHeight: o.lineHeight, letterSpacing: o.letterSpacing,
    fontLigatures: o.fontLigatures, wordWrap: o.wordWrap, renderWhitespace: o.renderWhitespace, lineNumbers: o.lineNumbers,
    minimap: o.minimap, smoothScrolling: o.smoothScrolling, cursorBlinking: o.cursorBlinking, cursorSmoothCaretAnimation: o.cursorSmoothCaretAnimation,
    mouseWheelScrollSensitivity: o.mouseWheelScrollSensitivity, fastScrollSensitivity: o.fastScrollSensitivity, accessibilitySupport: o.accessibilitySupport,
  };
}

/** Indentation lives on the text model, not the editor. */
export function applyModelOptions(model: Monaco.editor.ITextModel, s: Settings) {
  model.updateOptions({ tabSize: s.tabSize, insertSpaces: s.insertSpaces ?? true });
  if (s.detectIndentation ?? true) model.detectIndentation(s.insertSpaces ?? true, s.tabSize);
}

/** xterm options for new and running terminals. */
export function buildTerminalOptions(s: Settings): ITerminalOptions {
  return {
    fontFamily: s.terminalFontFamily || DEFAULT_TERMINAL_FONT,
    fontSize: s.terminalFontSize || 13,
    lineHeight: s.terminalLineHeight || 1,
    cursorStyle: s.terminalCursorStyle,
    cursorBlink: (s.reduceMotion ?? false) ? false : s.terminalCursorBlink,
    scrollback: s.terminalScrollback,
    screenReaderMode: s.accessibilitySupport === "on",
  };
}

/** The `{author}, {ago} • {summary}` inline blame template. */
export function formatBlame(tpl: string, b: { author: string; summary: string; hash: string; time: number }, ago: string): string {
  const vals: Record<string, string> = { author: b.author, summary: b.summary, hash: b.hash.slice(0, 8), ago, date: new Date(b.time * 1000).toLocaleDateString() };
  return (tpl || "{author}, {ago} • {summary}").replace(/\{(\w+)\}/g, (m, k) => vals[k] ?? m);
}
