import { useEffect, useRef, useState } from "react";
import { monaco, languageForPath } from "../lib/monaco";
import { api, errMsg } from "../lib/api";
import { merge3, splitLines, Region } from "../lib/diff";
import { gitx } from "../lib/gitApi";
import { closeTab, openFile, refreshGit } from "../lib/workspace";
import { basename } from "../lib/paths";
import { get, toast, useStore } from "../store";

/**
 * 3-way merge editor: Incoming (theirs, stage 3) and Current (ours, stage 2) on top, an editable
 * Result below that starts from the merge base (stage 1) with every one-sided change already applied.
 * Each conflict gets Accept Incoming / Current / Both / Ignore; "Complete Merge" writes and stages.
 */

type Pick = "unresolved" | "current" | "incoming" | "both" | "ignored" | "manual";
type Action = "incoming" | "current" | "both" | "ignored" | "reset";

interface Controller {
  lenses: (which: "ours" | "theirs" | "result") => monaco.languages.CodeLens[];
  act: (idx: number, a: Action) => void;
}
const controllers = new Map<string, { ctl: Controller; which: "ours" | "theirs" | "result" }>();
const lensChanged = new monaco.Emitter<unknown>();
let registered = false;
function registerProviders() {
  if (registered) return;
  registered = true;
  monaco.editor.registerCommand("cepheus.mergeEditor.act", (_acc, uri: string, idx: number, a: Action) => controllers.get(uri)?.ctl.act(idx, a));
  monaco.languages.registerCodeLensProvider("*", {
    onDidChange: lensChanged.event as monaco.IEvent<any>,
    provideCodeLenses(model) {
      const c = controllers.get(model.uri.toString());
      return { lenses: c ? c.ctl.lenses(c.which) : [], dispose() {} };
    },
  });
}

const PICK_LABEL: Record<Pick, string> = { unresolved: "", current: "Current accepted", incoming: "Incoming accepted", both: "Both accepted", ignored: "Ignored", manual: "Edited manually" };

export default function MergeEditor({ tabId, path }: { tabId: string; path: string }) {
  const ws = useStore((s) => s.workspace);
  const fontSize = useStore((s) => s.settings.fontSize);
  const theirsHost = useRef<HTMLDivElement>(null);
  const oursHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [cur, setCur] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const api3 = useRef<{ go: (i: number) => void; act: (i: number, a: Action) => void; complete: () => Promise<void> } | null>(null);

  useEffect(() => {
    if (!ws) return;
    let disposed = false;
    const cleanup: (() => void)[] = [];
    (async () => {
      const [base, ours, theirs] = await Promise.all([
        gitx.show(ws, ":1", path).catch(() => ""), // missing for add/add conflicts
        gitx.show(ws, ":2", path).catch(() => null),
        gitx.show(ws, ":3", path).catch(() => null),
      ]);
      if (disposed) return;
      if (ours === null || theirs === null) {
        setError(ours === null && theirs === null
          ? `${basename(path)} is not in a merge conflict (no index stages 2/3). Is the merge already resolved?`
          : `${basename(path)} was deleted on one side (${ours === null ? "current" : "incoming"}). Resolve it in the file or with git rm / git add.`);
        return;
      }
      registerProviders();
      const B = splitLines(base), O = splitLines(ours), T = splitLines(theirs);
      const regions = merge3(B.lines, O.lines, T.lines);
      const conflicts = regions.filter((r) => r.kind === "conflict");
      const lang = languageForPath(path);
      const eol = O.crlf ? "\r\n" : "\n";

      // Result: base text for conflicts, the changed side for everything else.
      const take = (r: Region) => (r.kind === "theirs" ? T.lines.slice(...r.theirs) : r.kind === "ours" || r.kind === "same" ? O.lines.slice(...r.ours) : B.lines.slice(...r.base));
      const resLines: string[] = [];
      const resRanges = new Map<Region, [number, number]>();
      for (const r of regions) {
        const l = take(r);
        resRanges.set(r, [resLines.length, resLines.length + l.length]);
        resLines.push(...l);
      }
      const nonce = Math.random().toString(36).slice(2);
      const uri = (w: string) => monaco.Uri.parse(`merge-${w}:/${nonce}/${basename(path)}`);
      const mk = (text: string, w: string) => {
        const m = monaco.editor.createModel(text, lang, uri(w));
        m.setEOL(O.crlf ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
        return m;
      };
      const tModel = mk(theirs, "theirs"), oModel = mk(ours, "ours");
      const rModel = mk(resLines.map((l) => l + eol).join(""), "result");
      const opts: monaco.editor.IStandaloneEditorConstructionOptions = {
        automaticLayout: true, fontSize: get().settings.fontSize, minimap: { enabled: false }, scrollBeyondLastLine: false, glyphMargin: false, renderLineHighlight: "none",
      };
      const tEd = monaco.editor.create(theirsHost.current!, { ...opts, model: tModel, readOnly: true });
      const oEd = monaco.editor.create(oursHost.current!, { ...opts, model: oModel, readOnly: true });
      const rEd = monaco.editor.create(resultHost.current!, { ...opts, model: rModel });
      cleanup.push(() => { [tEd, oEd, rEd].forEach((e) => e.dispose()); [tModel, oModel, rModel].forEach((m) => m.dispose()); });

      // Conflict ranges in the result are tracked with decorations so they survive free-form edits.
      const tracked = rModel.deltaDecorations([], conflicts.map((c) => {
        const [s, e] = resRanges.get(c)!;
        return { range: new monaco.Range(s + 1, 1, e + 1, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } };
      }));
      const state: Pick[] = conflicts.map(() => "unresolved");
      const baseText = conflicts.map((c) => B.lines.slice(...c.base).map((l) => l + eol).join(""));
      const rangeOf = (i: number) => rModel.getDecorationRange(tracked[i]) ?? new monaco.Range(1, 1, 1, 1);
      let applying = false;

      const lineDeco = (ed: monaco.editor.IStandaloneCodeEditor, items: { range: [number, number]; cls: string }[]) =>
        ed.createDecorationsCollection(items.map(({ range: [s, e], cls }) => (e > s
          ? { range: new monaco.Range(s + 1, 1, e, 1), options: { isWholeLine: true, className: cls, linesDecorationsClassName: cls + "-gutter" } }
          : { range: new monaco.Range(Math.max(1, s), 1, Math.max(1, s), 1), options: { isWholeLine: true, className: s === 0 ? "me-empty-top" : "me-empty" } })));
      const changed = regions.filter((r) => r.kind !== "stable");
      lineDeco(tEd, changed.filter((r) => r.kind !== "ours").map((r) => ({ range: r.theirs, cls: r.kind === "conflict" ? "me-conflict" : "me-auto" })));
      lineDeco(oEd, changed.filter((r) => r.kind !== "theirs").map((r) => ({ range: r.ours, cls: r.kind === "conflict" ? "me-conflict" : "me-auto" })));
      // Decorations move with edits, so the one-sided changes only need to be marked once.
      rEd.createDecorationsCollection(changed.filter((r) => r.kind !== "conflict").flatMap((r) => {
        const [s, e] = resRanges.get(r)!;
        return e > s ? [{ range: new monaco.Range(s + 1, 1, e, 1), options: { isWholeLine: true, className: "me-auto", linesDecorationsClassName: "me-auto-gutter" } }] : [];
      }));
      const rConf = rEd.createDecorationsCollection();
      const paint = () => {
        rConf.set(conflicts.map((_, i) => {
          const r = rangeOf(i);
          const cls = state[i] === "unresolved" ? "me-conflict" : "me-resolved";
          const end = r.endColumn === 1 && r.endLineNumber > r.startLineNumber ? r.endLineNumber - 1 : r.endLineNumber;
          const empty = r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn;
          return { range: new monaco.Range(r.startLineNumber, 1, end, 1), options: { isWholeLine: true, className: empty ? "me-empty" : cls, linesDecorationsClassName: cls + "-gutter" } };
        }));
      };



      const sync = () => { setPicks([...state]); lensChanged.fire(undefined); };
      const setRegion = (i: number, lines: string[], pick: Pick) => {
        const r = rangeOf(i);
        const text = lines.map((l) => l + eol).join("");
        applying = true;
        rModel.pushEditOperations([], [{ range: r, text }], () => null);
        applying = false;
        const s = r.startLineNumber;
        tracked[i] = rModel.deltaDecorations([tracked[i]], [{ range: new monaco.Range(s, 1, s + lines.length, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges } }])[0];
        state[i] = pick;
        paint();
        sync();
      };
      const act = (i: number, a: Action) => {
        const c = conflicts[i];
        if (!c) return;
        const o = O.lines.slice(...c.ours), t = T.lines.slice(...c.theirs);
        if (a === "current") setRegion(i, o, "current");
        else if (a === "incoming") setRegion(i, t, "incoming");
        else if (a === "both") setRegion(i, [...o, ...t], "both");
        else if (a === "reset") setRegion(i, B.lines.slice(...c.base), "unresolved");
        else { state[i] = "ignored"; paint(); sync(); }
        const next = state.findIndex((p, j) => j > i && p === "unresolved");
        if (a !== "reset" && next >= 0) go(next);
      };
      const go = (i: number) => {
        const c = conflicts[i];
        if (!c) return;
        setCur(i);
        const reveal = (ed: monaco.editor.IStandaloneCodeEditor, [s, e]: [number, number]) => ed.revealLinesInCenter(s + 1, Math.max(s + 1, e));
        reveal(tEd, c.theirs);
        reveal(oEd, c.ours);
        const r = rangeOf(i);
        rEd.revealLinesInCenter(r.startLineNumber, Math.max(r.startLineNumber, r.endLineNumber - 1));
        rEd.setPosition({ lineNumber: r.startLineNumber, column: 1 });
      };

      const lens = (line: number, title: string, i: number, a: Action, u: string) =>
        ({ range: new monaco.Range(Math.max(1, line), 1, Math.max(1, line), 1), command: { id: "cepheus.mergeEditor.act", title, arguments: [u, i, a] } });
      const ctl: Controller = {
        act,
        lenses: (which) => conflicts.flatMap((c, i) => {
          if (which === "theirs") {
            const u = tModel.uri.toString();
            return [lens(c.theirs[0] + 1, "Accept Incoming", i, "incoming", u), lens(c.theirs[0] + 1, "Accept Both", i, "both", u)];
          }
          if (which === "ours") {
            const u = oModel.uri.toString();
            return [lens(c.ours[0] + 1, "Accept Current", i, "current", u), lens(c.ours[0] + 1, "Accept Both", i, "both", u)];
          }
          const u = rModel.uri.toString();
          const line = rangeOf(i).startLineNumber;
          if (state[i] !== "unresolved") return [lens(line, `✓ ${PICK_LABEL[state[i]]}`, i, "reset", u), lens(line, "Reset to base", i, "reset", u)];
          return [
            lens(line, `Conflict ${i + 1}: Accept Incoming`, i, "incoming", u),
            lens(line, "Accept Current", i, "current", u),
            lens(line, "Accept Both", i, "both", u),
            lens(line, "Ignore", i, "ignored", u),
          ];
        }),
      };
      controllers.set(tModel.uri.toString(), { ctl, which: "theirs" });
      controllers.set(oModel.uri.toString(), { ctl, which: "ours" });
      controllers.set(rModel.uri.toString(), { ctl, which: "result" });
      cleanup.push(() => [tModel, oModel, rModel].forEach((m) => controllers.delete(m.uri.toString())));

      const sub = rModel.onDidChangeContent(() => {
        if (applying) return;
        // A hand edit inside an unresolved conflict counts as resolving it.
        conflicts.forEach((_, i) => { if (state[i] === "unresolved" && rModel.getValueInRange(rangeOf(i)) !== baseText[i]) state[i] = "manual"; });
        paint();
        sync();
      });
      cleanup.push(() => sub.dispose());
      paint();

      api3.current = {
        go,
        act,
        complete: async () => {
          let text = rModel.getValue(monaco.editor.EndOfLinePreference.TextDefined);
          if (!O.finalEol && text.endsWith(eol)) text = text.slice(0, -eol.length);
          await api.historySave(path, await api.readFile(path).catch(() => ""), "save").catch(() => {});
          await api.writeFile(path, text);
          await api.gitStage(get().workspace!, [path]);
          toast(`Merged ${basename(path)} and staged it`);
          refreshGit();
          closeTab(tabId);
        },
      };
      sync();
      setLoaded(true);
      if (conflicts.length) setTimeout(() => go(0), 50);
    })().catch((e) => !disposed && setError(errMsg(e)));
    return () => { disposed = true; api3.current = null; cleanup.forEach((f) => f()); };
  }, [ws, path, tabId]);

  const remaining = picks.filter((p) => p === "unresolved").length;
  const complete = async () => {
    if (remaining && !confirm) { setConfirm(true); setTimeout(() => setConfirm(false), 4000); return; }
    try { await api3.current?.complete(); } catch (e) { toast(errMsg(e), "error"); }
  };

  if (error) {
    return (
      <div className="merge-editor">
        <div className="empty-state">
          <p>{error}</p>
          <button className="btn" onClick={() => openFile(path)}>Open File</button>
        </div>
      </div>
    );
  }

  return (
    <div className="merge-editor" style={{ fontSize }}>
      <div className="me-toolbar">
        <b>{basename(path)}</b>
        <span className={`me-count ${remaining ? "" : "done"}`}>
          {loaded ? (picks.length === 0 ? "No conflicting changes — all changes merged automatically" : remaining ? `${remaining} of ${picks.length} conflicts remaining` : `All ${picks.length} conflicts resolved`) : "Loading…"}
        </span>
        {picks.length > 0 && (
          <>
            <button className="icon-btn" title="Previous conflict" onClick={() => api3.current?.go((cur - 1 + picks.length) % picks.length)}><i className="codicon codicon-arrow-up" /></button>
            <span className="muted small">{cur + 1}/{picks.length}{picks[cur] && picks[cur] !== "unresolved" ? ` · ${PICK_LABEL[picks[cur]]}` : ""}</span>
            <button className="icon-btn" title="Next conflict" onClick={() => api3.current?.go((cur + 1) % picks.length)}><i className="codicon codicon-arrow-down" /></button>
            <span className="me-sep" />
            <button className="btn small" onClick={() => api3.current?.act(cur, "incoming")}>Accept Incoming</button>
            <button className="btn small" onClick={() => api3.current?.act(cur, "current")}>Accept Current</button>
            <button className="btn small" onClick={() => api3.current?.act(cur, "both")}>Accept Both</button>
            <button className="btn small" onClick={() => api3.current?.act(cur, "ignored")}>Ignore</button>
          </>
        )}
        <span className="spacer" />
        <button className="btn small" title="Open the file with conflict markers instead" onClick={() => openFile(path)}>Open File</button>
        <button className="btn primary small" disabled={!loaded} onClick={complete}>
          {confirm ? `${remaining} unresolved — click again to complete` : "Complete Merge"}
        </button>
      </div>
      <div className="me-top">
        <div className="me-pane">
          <div className="me-pane-title incoming">Incoming <span className="muted">(theirs · stage 3)</span></div>
          <div className="me-host" ref={theirsHost} />
        </div>
        <div className="me-pane">
          <div className="me-pane-title current">Current <span className="muted">(ours · stage 2)</span></div>
          <div className="me-host" ref={oursHost} />
        </div>
      </div>
      <div className="me-pane me-result">
        <div className="me-pane-title">Result <span className="muted">(starts from the merge base · editable)</span></div>
        <div className="me-host" ref={resultHost} />
      </div>
    </div>
  );
}
