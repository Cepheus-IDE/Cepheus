// Quick diff: added / modified / deleted markers vs HEAD in the line-decorations gutter. Clicking a
// marker peeks the original lines with "Revert this change" and "Stage this hunk".
import { monaco } from "./monaco";
import { errMsg } from "./api";
import { basename, relative, samePath } from "./paths";
import { diffLines, hunkPatch, splitLines, Hunk } from "./diff";
import { gitx } from "./gitApi";
import { get, toast } from "../store";

const baseCache = new Map<string, Promise<string | null>>();
const refreshers = new Set<() => void>();

/** Called whenever git state may have changed (commit, stage, checkout ...). */
export function clearQuickDiffCache() {
  baseCache.clear();
  refreshers.forEach((f) => f());
}

/** The workspace path of a file model (tab paths keep the casing git expects). */
function pathOfModel(model: monaco.editor.ITextModel): string | null {
  if (model.uri.scheme !== "file") return null;
  const u = model.uri.toString();
  return get().tabs.find((t) => t.kind === "file" && monaco.Uri.file(t.path).toString() === u)?.path ?? null;
}

function headFor(root: string, path: string): Promise<string | null> {
  const k = path.toLowerCase();
  if (!baseCache.has(k)) baseCache.set(k, gitx.show(root, "HEAD", path).catch(() => null));
  return baseCache.get(k)!;
}

function modelLines(model: monaco.editor.ITextModel) {
  const lines = model.getLinesContent();
  const finalEol = lines.length > 1 && lines[lines.length - 1] === "";
  if (finalEol) lines.pop();
  if (lines.length === 1 && lines[0] === "") lines.pop();
  return { lines, finalEol, crlf: model.getEOL() === "\r\n" };
}

export function attachQuickDiff(ed: monaco.editor.IStandaloneCodeEditor) {
  const deco = ed.createDecorationsCollection();
  let state: { path: string; base: ReturnType<typeof splitLines>; hunks: Hunk[] } | null = null;
  let t = 0;
  let seq = 0;
  let peek: { close: () => void; hunk: Hunk } | null = null;
  const closePeek = () => { const p = peek; peek = null; p?.close(); };

  const update = () => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      const my = ++seq;
      const st = get();
      const model = ed.getModel();
      const path = model && pathOfModel(model);
      if (!model || !path || !st.workspace || !st.git?.isRepo || st.settings.quickDiff === false) { state = null; return deco.clear(); }
      const f = st.git.files.find((x) => samePath(x.path, path));
      // Untracked and conflicted files get no markers (everything would be "added").
      const head = f && (f.index === "?" || f.index === "U" || f.worktree === "U") ? null : await headFor(st.workspace, path);
      if (my !== seq || ed.getModel() !== model) return;
      if (head === null) { state = null; return deco.clear(); }
      const base = splitLines(head);
      const hunks = diffLines(base.lines, modelLines(model).lines);
      state = { path, base, hunks };
      const n = model.getLineCount();
      deco.set(hunks.map((h) => {
        const kind = h.aStart === h.aEnd ? "added" : h.bStart === h.bEnd ? "deleted" : "modified";
        const s = kind === "deleted" ? Math.min(Math.max(1, h.bStart), n) : h.bStart + 1;
        const e = kind === "deleted" ? s : Math.min(h.bEnd, n);
        const color = kind === "added" ? "#2ea04399" : kind === "deleted" ? "#f85149aa" : "#1b81e599";
        return {
          range: new monaco.Range(s, 1, e, 1),
          options: {
            linesDecorationsClassName: `qd-gutter qd-${kind}${kind === "deleted" && h.bStart === 0 ? " qd-top" : ""}`,
            overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Left },
            minimap: { color, position: monaco.editor.MinimapPosition.Gutter },
          },
        };
      }));
    }, 300);
  };

  const hunkAt = (line: number) =>
    state?.hunks.find((h) => (h.bStart === h.bEnd ? Math.max(1, h.bStart) === line : line > h.bStart && line <= h.bEnd));

  const revert = (h: Hunk) => {
    const model = ed.getModel();
    if (!model || !state) return;
    const eol = model.getEOL();
    const orig = state.base.lines.slice(h.aStart, h.aEnd);
    const n = model.getLineCount();
    let range: monaco.Range;
    let text = "";
    if (h.bStart === h.bEnd) {
      // Deleted lines: insert them back after line bStart.
      if (h.bStart < n) { range = new monaco.Range(h.bStart + 1, 1, h.bStart + 1, 1); text = orig.join(eol) + eol; }
      else { const c = model.getLineMaxColumn(n); range = new monaco.Range(n, c, n, c); text = eol + orig.join(eol); }
    } else if (orig.length) {
      range = new monaco.Range(h.bStart + 1, 1, h.bEnd, model.getLineMaxColumn(h.bEnd));
      text = orig.join(eol);
    } else if (h.bEnd < n) {
      range = new monaco.Range(h.bStart + 1, 1, h.bEnd + 1, 1);
    } else {
      range = h.bStart > 0 ? new monaco.Range(h.bStart, model.getLineMaxColumn(h.bStart), h.bEnd, model.getLineMaxColumn(h.bEnd)) : model.getFullModelRange();
    }
    model.pushEditOperations([], [{ range, text }], () => null);
  };

  const stage = async (h: Hunk) => {
    const st = get();
    const model = ed.getModel();
    if (!model || !state || !st.workspace) return;
    try {
      // Patch against the index (it may already differ from HEAD), limited to this hunk's lines.
      const index = splitLines(await gitx.show(st.workspace, ":0", state.path).catch(() => ""));
      const mod = modelLines(model);
      const lo = h.bStart, hi = h.bEnd;
      const hs = diffLines(index.lines, mod.lines).filter((x) => (x.bStart === x.bEnd ? x.bStart >= lo && x.bStart <= hi : x.bStart < Math.max(hi, lo + 1) && x.bEnd > lo));
      if (!hs.length) return toast("This change is already staged");
      const rel = relative(st.workspace, state.path);
      // Bottom-up, so the line numbers of the remaining hunks stay valid in the index.
      for (const x of [...hs].reverse()) await gitx.apply(st.workspace, hunkPatch(rel, index, mod, x), true);
      toast("Staged hunk");
      const { refreshGit } = await import("./workspace");
      refreshGit();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const showPeek = (h: Hunk) => {
    closePeek();
    const model = ed.getModel();
    if (!model || !state) return;
    const all = state.hunks;
    const idx = all.indexOf(h);
    const dom = document.createElement("div");
    dom.className = "qd-peek";
    const head = document.createElement("div");
    head.className = "qd-peek-head";
    const title = document.createElement("span");
    title.className = "qd-peek-title";
    title.textContent = `${basename(state.path)} — change ${idx + 1} of ${all.length} vs HEAD`;
    head.appendChild(title);
    const btn = (label: string, icon: string, fn: () => void, text = true) => {
      const b = document.createElement("button");
      b.title = label;
      b.innerHTML = `<i class="codicon codicon-${icon}"></i>`;
      if (text) b.append(" " + label);
      // Keep Monaco from treating the click as an editor mouse-down.
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      head.appendChild(b);
    };
    const go = (d: number) => {
      const nh = all[(idx + d + all.length) % all.length];
      if (nh) { ed.revealLineInCenter(Math.max(1, nh.bStart + 1)); showPeek(nh); }
    };
    btn("Revert this change", "discard", () => { closePeek(); revert(h); });
    btn("Stage this hunk", "add", () => { closePeek(); stage(h); });
    btn("Previous change", "arrow-up", () => go(-1), false);
    btn("Next change", "arrow-down", () => go(1), false);
    btn("Close", "close", closePeek, false);
    dom.appendChild(head);
    const body = document.createElement("pre");
    body.className = "qd-peek-body";
    const font = ed.getOption(monaco.editor.EditorOption.fontInfo);
    body.style.fontFamily = font.fontFamily;
    body.style.fontSize = font.fontSize + "px";
    body.style.lineHeight = font.lineHeight + "px";
    const line = (cls: string, sign: string, l: string) => {
      const d = document.createElement("div");
      d.className = cls;
      d.textContent = `${sign} ${l}`;
      body.appendChild(d);
    };
    state.base.lines.slice(h.aStart, h.aEnd).forEach((l) => line("qd-del-line", "-", l));
    if (h.aStart === h.aEnd) line("qd-info-line", " ", "(lines added)");
    dom.appendChild(body);
    const rows = Math.min(12, Math.max(1, h.aEnd - h.aStart));
    const height = 30 + rows * font.lineHeight + 8;
    let zoneId = "";
    const layout = () => {
      const li = ed.getLayoutInfo();
      dom.style.left = li.contentLeft + "px";
      dom.style.width = Math.max(200, li.contentWidth - li.verticalScrollbarWidth - 4) + "px";
    };
    const widget: monaco.editor.IOverlayWidget = { getId: () => "cepheus.quickdiff.peek", getDomNode: () => dom, getPosition: () => null };
    ed.addOverlayWidget(widget);
    layout();
    ed.changeViewZones((acc) => {
      zoneId = acc.addZone({
        afterLineNumber: h.bStart === h.bEnd ? h.bStart : h.bEnd,
        heightInPx: height,
        domNode: document.createElement("div"),
        onDomNodeTop: (top) => { dom.style.top = top + "px"; },
        onComputedHeight: (hh) => { dom.style.height = hh + "px"; },
      });
    });
    const sub = ed.onDidLayoutChange(layout);
    peek = {
      hunk: h,
      close: () => { sub.dispose(); ed.changeViewZones((acc) => acc.removeZone(zoneId)); ed.removeOverlayWidget(widget); },
    };
  };

  const subs = [
    ed.onDidChangeModel(() => { closePeek(); update(); }),
    ed.onDidChangeModelContent(() => { closePeek(); update(); }),
    ed.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS || !e.target.position) return;
      const h = hunkAt(e.target.position.lineNumber);
      if (!h) return;
      if (peek && peek.hunk.aStart === h.aStart && peek.hunk.bStart === h.bStart) closePeek();
      else showPeek(h);
    }),
    ed.onKeyDown((e) => { if (peek && e.keyCode === monaco.KeyCode.Escape) { closePeek(); e.preventDefault(); } }),
  ];
  refreshers.add(update);
  update();
  return () => { clearTimeout(t); closePeek(); refreshers.delete(update); subs.forEach((s) => s.dispose()); deco.clear(); };
}
