//! Debugger UI inside the main Monaco editor: breakpoint gutter (click, right-click menu,
//! condition/hit count/logpoint widget), the current-line marker, inline variable values while
//! paused, hover evaluation, and the floating debug toolbar.

import { monaco } from "./monaco";
import {
  Breakpoint, Frame, Variable, evaluateSilently, fileBreakpoints, getBreakpoint, norm, replaceFileBreakpoints,
  toggleBreakpoint, updateBreakpoint, useDebug,
} from "./debugger";
import { inlineValues } from "./debugLogic";
import { mountDebugOverlays, showBreakpointMenu } from "../components/DebugOverlays";

const same = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase();

function bpClass(b: Breakpoint, active: boolean) {
  const kind = b.logMessage ? "dbg-bp-log" : b.condition || b.hitCondition ? "dbg-bp-cond" : "";
  return `dbg-bp ${kind} ${!b.enabled || !active ? "dbg-bp-off" : ""}`;
}
function bpHover(b: Breakpoint) {
  const parts = [b.logMessage ? `Logpoint: ${b.logMessage}` : "Breakpoint"];
  if (b.condition) parts.push(`Condition: ${b.condition}`);
  if (b.hitCondition) parts.push(`Hit count: ${b.hitCondition}`);
  if (!b.enabled) parts.push("(disabled)");
  return parts.join("  \n");
}

// ----------------------------------------------------------------------------------------------
// Inline values
// ----------------------------------------------------------------------------------------------

// ----------------------------------------------------------------------------------------------
// Breakpoint condition widget
// ----------------------------------------------------------------------------------------------

let widget: { ed: monaco.editor.ICodeEditor; w: monaco.editor.IContentWidget } | null = null;

function closeWidget() {
  if (!widget) return;
  widget.ed.removeContentWidget(widget.w);
  widget.ed.focus();
  widget = null;
}

/** Inline editor for a breakpoint's condition / hit count / log message (like VS Code's). */
export function openBreakpointWidget(ed: monaco.editor.ICodeEditor, line: number, kind: "condition" | "hit" | "log") {
  closeWidget();
  const model = ed.getModel();
  if (!model || model.uri.scheme !== "file") return;
  const path = model.uri.fsPath;
  const bp = getBreakpoint(path, line);
  const node = document.createElement("div");
  node.className = "dbg-bp-widget";
  node.style.width = `${Math.max(320, ed.getLayoutInfo().contentWidth - 80)}px`;
  const sel = document.createElement("select");
  for (const [v, l] of [["condition", "Expression"], ["hit", "Hit Count"], ["log", "Log Message"]]) {
    const o = document.createElement("option");
    o.value = v; o.textContent = l;
    sel.appendChild(o);
  }
  sel.value = kind;
  const input = document.createElement("input");
  input.spellcheck = false;
  const placeholder: Record<string, string> = {
    condition: "Break when expression evaluates to true. 'Enter' to accept, 'Esc' to cancel.",
    hit: "Break when hit count condition is met (5, >= 5, % 3). 'Enter' to accept.",
    log: "Message to log when the breakpoint is hit. Expressions within {} are interpolated. 'Enter' to accept.",
  };
  // Remember edits per field while switching the dropdown.
  const draft: Record<string, string> = { condition: bp?.condition ?? "", hit: bp?.hitCondition ?? "", log: bp?.logMessage ?? "" };
  const show = () => { input.value = draft[sel.value]; input.placeholder = placeholder[sel.value]; };
  show();
  sel.onchange = () => { show(); input.focus(); };
  input.oninput = () => { draft[sel.value] = input.value; };
  const accept = () => {
    const patch: Partial<Breakpoint> = { condition: draft.condition.trim(), hitCondition: draft.hit.trim(), logMessage: draft.log.trim() };
    if (!bp) patch.enabled = true;
    updateBreakpoint(path, line, patch);
    closeWidget();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); accept(); }
    if (e.key === "Escape") { e.preventDefault(); closeWidget(); }
  };
  node.addEventListener("focusout", (e) => { if (!node.contains(e.relatedTarget as Node)) setTimeout(() => { if (!node.contains(document.activeElement)) closeWidget(); }, 0); });
  node.append(sel, input);
  const w: monaco.editor.IContentWidget = {
    getId: () => "cepheus.breakpointWidget",
    getDomNode: () => node,
    getPosition: () => ({ position: { lineNumber: line, column: 1 }, preference: [monaco.editor.ContentWidgetPositionPreference.BELOW] }),
  };
  ed.addContentWidget(w);
  widget = { ed, w };
  ed.revealLineInCenterIfOutsideViewport(line);
  setTimeout(() => input.focus(), 0);
}

// ----------------------------------------------------------------------------------------------
// Attach
// ----------------------------------------------------------------------------------------------

let hoverRegistered = false;
function registerHover() {
  if (hoverRegistered) return;
  hoverRegistered = true;
  monaco.languages.registerHoverProvider("*", {
    async provideHover(model, pos) {
      if (useDebug.getState().status !== "paused" || model.uri.scheme !== "file") return null;
      const word = model.getWordAtPosition(pos);
      if (!word) return null;
      // Include a member chain to the left: `obj.prop.x`.
      const left = model.getLineContent(pos.lineNumber).slice(0, word.endColumn - 1);
      const expr = left.match(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/)?.[0];
      if (!expr || /^(const|let|var|function|return|if|else|for|while|def|class|import|from|new|this)$/.test(expr)) return null;
      const r = await evaluateSilently(expr);
      if (!r || r.error) return null;
      return {
        range: new monaco.Range(pos.lineNumber, word.startColumn - (expr.length - word.word.length), pos.lineNumber, word.endColumn),
        contents: [{ value: "```\n" + `${expr}: ${r.value}`.slice(0, 2000) + "\n```" }],
      };
    },
  });
}

export function attachDebugEditor(ed: monaco.editor.IStandaloneCodeEditor) {
  ed.updateOptions({ glyphMargin: true });
  registerHover();
  const deco = ed.createDecorationsCollection();
  const inline = ed.createDecorationsCollection();
  // Line of each breakpoint decoration, to follow edits above it.
  let bpDecoLines: number[] = [];

  const modelPath = () => { const m = ed.getModel(); return m && m.uri.scheme === "file" ? m.uri.fsPath : null; };

  const render = () => {
    const path = modelPath();
    if (!path) { deco.clear(); inline.clear(); bpDecoLines = []; return; }
    const s = useDebug.getState();
    const bps = fileBreakpoints(path);
    const frame = s.status === "paused" ? s.frames[s.frameIndex] : undefined;
    const here = frame && same(frame.path, path) ? frame.line : -1;
    const top = s.status === "paused" ? s.frames[0] : undefined;
    const topHere = top && same(top.path, path) ? top.line : -1;
    bpDecoLines = bps.map((b) => b.line);
    deco.set([
      ...bps.map((b) => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: { glyphMarginClassName: bpClass(b, s.breakpointsActive), glyphMarginHoverMessage: { value: bpHover(b) }, stickiness: 1 },
      })),
      ...(here > 0
        ? [{
            range: new monaco.Range(here, 1, here, 1),
            options: {
              isWholeLine: true,
              className: here === topHere && s.frameIndex === 0 ? "dbg-current-line" : "dbg-frame-line",
              glyphMarginClassName: bps.some((b) => b.line === here) ? "dbg-bp dbg-here" : "dbg-here",
            },
          }]
        : []),
    ]);
    // Inline values for the visible function of the selected frame.
    const model = ed.getModel()!;
    if (here > 0 && frame) {
      const local = frame.scopes.find((x) => x.type === "local" && x.startLine);
      const first = Math.max(1, Math.min(here, local?.startLine ?? here - 40), here - 200);
      const lines: string[] = [];
      for (let l = first; l <= Math.min(here, model.getLineCount()); l++) lines.push(model.getLineContent(l));
      const vals = inlineValues(lines, first, frame, s.vars, model.getLanguageId() === "python");
      inline.set([...vals].map(([l, text]) => {
        const col = model.getLineMaxColumn(l);
        return { range: new monaco.Range(l, col, l, col), options: { after: { content: `  ${text}`, inlineClassName: "dbg-inline-value" }, showIfCollapsed: true } };
      }));
    } else inline.clear();
  };

  /** After edits, breakpoints follow their (sticky) decorations. */
  const follow = () => {
    const path = modelPath();
    if (!path || !bpDecoLines.length) return;
    const ranges = deco.getRanges();
    const bps = fileBreakpoints(path);
    if (ranges.length < bps.length) return;
    const moved = bps.map((b, i) => ({ ...b, line: ranges[i]?.startLineNumber ?? b.line }));
    if (moved.some((b, i) => b.line !== bps[i].line)) replaceFileBreakpoints(path, moved);
  };

  let followTimer = 0;
  const subs = [
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.target.position || !e.event.leftButton) return;
      const path = modelPath();
      if (path) toggleBreakpoint(path, e.target.position.lineNumber);
    }),
    ed.onDidChangeModel(render),
    ed.onDidChangeModelContent(() => { clearTimeout(followTimer); followTimer = window.setTimeout(follow, 300); }),
  ];

  // Right-click in the gutter: our menu instead of the editor's.
  // getDomNode() is null until the editor has a model; the container always exists.
  const dom = ed.getContainerDomNode();
  const onCtx = (e: MouseEvent) => {
    const t = ed.getTargetAtClientPoint(e.clientX, e.clientY);
    if (!t || !t.position) return;
    const T = monaco.editor.MouseTargetType;
    if (t.type !== T.GUTTER_GLYPH_MARGIN && t.type !== T.GUTTER_LINE_NUMBERS && t.type !== T.GUTTER_LINE_DECORATIONS) return;
    const path = modelPath();
    if (!path) return;
    e.preventDefault();
    e.stopPropagation();
    const line = t.position.lineNumber;
    showBreakpointMenu(e.clientX, e.clientY, path, line, (kind) => openBreakpointWidget(ed, line, kind));
  };
  dom.addEventListener("contextmenu", onCtx, true);

  const unsub = useDebug.subscribe(render);
  render();
  const host = ed.getContainerDomNode().parentElement;
  const unmount = host ? mountDebugOverlays(host) : () => {};
  return () => {
    subs.forEach((s) => s.dispose());
    unsub();
    dom.removeEventListener("contextmenu", onCtx, true);
    deco.clear();
    inline.clear();
    unmount();
  };
}
