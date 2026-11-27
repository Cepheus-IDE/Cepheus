import { monaco } from "./monaco";
import { api } from "./api";
import { get } from "../store";
import { attachQuickDiff, clearQuickDiffCache } from "./quickDiff";
import { formatBlame } from "./editorOptions";

// ----------------------------------------------------------------------------------------------
// Inline blame: "Author, 3 days ago • summary" after the cursor's line, like GitLens.
// ----------------------------------------------------------------------------------------------

type Blame = Awaited<ReturnType<typeof api.gitBlame>>;
const blameCache = new Map<string, Promise<Blame | null>>();

/** Called whenever git state may have changed (commit, checkout, save, ...). */
export function clearBlameCache() {
  blameCache.clear();
  clearQuickDiffCache();
}

function blameFor(root: string, path: string) {
  const k = path.toLowerCase();
  if (!blameCache.has(k)) blameCache.set(k, api.gitBlame(root, path).catch(() => null));
  return blameCache.get(k)!;
}

export function timeAgo(sec: number): string {
  const d = Date.now() / 1000 - sec;
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [s, n] of units) {
    const v = Math.floor(d / s);
    if (v >= 1) return `${v} ${n}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function attachBlame(ed: monaco.editor.IStandaloneCodeEditor) {
  const deco = ed.createDecorationsCollection();
  let t = 0;
  let seq = 0;
  const update = () => {
    clearTimeout(t);
    deco.clear();
    t = window.setTimeout(async () => {
      const my = ++seq;
      const st = get();
      const model = ed.getModel();
      const pos = ed.getPosition();
      if (!model || !pos || !st.settings.inlineBlame || !st.workspace || !st.git?.isRepo) return;
      if (model.uri.scheme !== "file" || st.workspace.startsWith("ssh://")) return;
      const path = model.uri.fsPath.replace(/\\/g, "/");
      // Line numbers only match the committed file while the buffer has no unsaved edits.
      if (Object.entries(st.dirty).some(([p, d]) => d && p.toLowerCase() === path.toLowerCase())) return;
      const lines = await blameFor(st.workspace, path);
      if (my !== seq || !lines) return;
      const b = lines[pos.lineNumber - 1];
      if (!b) return;
      const text = /^0+$/.test(b.hash)
        ? "You, uncommitted changes"
        : formatBlame(st.settings.blameFormat, b, timeAgo(b.time)); // Settings › Git › Blame format
      const col = model.getLineMaxColumn(pos.lineNumber);
      deco.set([{
        range: new monaco.Range(pos.lineNumber, col, pos.lineNumber, col),
        options: {
          after: { content: `    ${text}`, inlineClassName: "inline-blame" },
          hoverMessage: /^0+$/.test(b.hash) ? undefined : { value: `**${b.summary}**\n\n${b.author} · ${new Date(b.time * 1000).toLocaleString()}\n\n\`${b.hash.slice(0, 10)}\`` },
        },
      }]);
    }, 250);
  };
  const subs = [ed.onDidChangeCursorPosition(update), ed.onDidChangeModel(update), ed.onDidChangeModelContent(() => deco.clear())];
  return () => { clearTimeout(t); subs.forEach((s) => s.dispose()); deco.clear(); };
}

// ----------------------------------------------------------------------------------------------
// Merge conflicts: highlight <<<<<<< / ======= / >>>>>>> blocks with Accept actions above them.
// ----------------------------------------------------------------------------------------------

interface Conflict { start: number; base?: number; mid: number; end: number }

export function findConflicts(model: monaco.editor.ITextModel): Conflict[] {
  const out: Conflict[] = [];
  let cur: Partial<Conflict> | null = null;
  const n = model.getLineCount();
  for (let i = 1; i <= n; i++) {
    const l = model.getLineContent(i);
    if (l.startsWith("<<<<<<<")) cur = { start: i };
    else if (cur && l.startsWith("|||||||") && cur.mid === undefined) cur.base = i;
    else if (cur && l.startsWith("=======") && cur.mid === undefined) cur.mid = i;
    else if (cur && cur.mid !== undefined && l.startsWith(">>>>>>>")) {
      out.push({ ...(cur as Conflict), end: i });
      cur = null;
    }
  }
  return out;
}

function resolve(model: monaco.editor.ITextModel, c: Conflict, pick: "current" | "incoming" | "both") {
  const lines = (a: number, b: number) => (b < a ? [] : model.getValueInRange(new monaco.Range(a, 1, b, model.getLineMaxColumn(b))).split(/\r?\n/));
  const current = lines(c.start + 1, (c.base ?? c.mid) - 1);
  const incoming = lines(c.mid + 1, c.end - 1);
  const keep = pick === "current" ? current : pick === "incoming" ? incoming : [...current, ...incoming];
  const eol = model.getEOL();
  const last = c.end === model.getLineCount();
  const range = last
    ? new monaco.Range(c.start, 1, c.end, model.getLineMaxColumn(c.end))
    : new monaco.Range(c.start, 1, c.end + 1, 1);
  const text = keep.length ? keep.join(eol) + (last ? "" : eol) : "";
  model.pushEditOperations([], [{ range, text }], () => null);
}

let commandsRegistered = false;
function registerConflictCommands() {
  if (commandsRegistered) return;
  commandsRegistered = true;
  for (const pick of ["current", "incoming", "both"] as const) {
    monaco.editor.registerCommand(`cepheus.merge.${pick}`, (_acc, uri: monaco.Uri, start: number) => {
      const model = monaco.editor.getModel(uri);
      const c = model && findConflicts(model).find((x) => x.start === start);
      if (model && c) resolve(model, c, pick);
    });
  }
  monaco.editor.registerCommand("cepheus.merge.editor", (_acc, uri: monaco.Uri) => {
    const path = get().tabs.find((t) => t.kind === "file" && monaco.Uri.file(t.path).toString() === uri.toString())?.path ?? uri.fsPath;
    import("./gitApi").then((g) => g.openMergeEditor(path));
  });
  monaco.languages.registerCodeLensProvider("*", {
    provideCodeLenses(model) {
      const all = findConflicts(model);
      const lenses = all.flatMap((c, i) => {
        const range = new monaco.Range(c.start, 1, c.start, 1);
        const args = [model.uri, c.start];
        return [
          // Only offered for real files that git knows are conflicted (not the merge editor's own models).
          ...(i === 0 && model.uri.scheme === "file" ? [{ range, command: { id: "cepheus.merge.editor", title: "Resolve in Merge Editor", arguments: [model.uri] } }] : []),
          { range, command: { id: "cepheus.merge.current", title: "Accept Current Change", arguments: args } },
          { range, command: { id: "cepheus.merge.incoming", title: "Accept Incoming Change", arguments: args } },
          { range, command: { id: "cepheus.merge.both", title: "Accept Both Changes", arguments: args } },
        ];
      });
      return { lenses, dispose() {} };
    },
  });
}

function attachConflictDecorations(ed: monaco.editor.IStandaloneCodeEditor) {
  registerConflictCommands();
  const deco = ed.createDecorationsCollection();
  const update = () => {
    const model = ed.getModel();
    if (!model) return deco.clear();
    const whole = (a: number, b: number, cls: string) =>
      b < a ? [] : [{ range: new monaco.Range(a, 1, b, 1), options: { isWholeLine: true, className: cls } }];
    deco.set(
      findConflicts(model).flatMap((c) => [
        ...whole(c.start, c.start, "merge-current-header"),
        ...whole(c.start + 1, (c.base ?? c.mid) - 1, "merge-current"),
        ...(c.base ? whole(c.base, c.mid - 1, "merge-base") : []),
        ...whole(c.mid + 1, c.end - 1, "merge-incoming"),
        ...whole(c.end, c.end, "merge-incoming-header"),
      ]),
    );
  };
  const subs = [ed.onDidChangeModel(update), ed.onDidChangeModelContent(update)];
  update();
  return () => { subs.forEach((s) => s.dispose()); deco.clear(); };
}

/** Wires blame + conflict UI into the main editor. */
export function attachGitExtras(ed: monaco.editor.IStandaloneCodeEditor) {
  const a = attachBlame(ed);
  const b = attachConflictDecorations(ed);
  const c = attachQuickDiff(ed);
  return () => { a(); b(); c(); };
}
