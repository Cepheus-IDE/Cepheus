import { monaco } from "./monaco";
import { get, set, Problem } from "../store";

/** Monaco reports "c:/x"; use the workspace's spelling so paths group with workspace diagnostics. */
function fixCase(p: string) {
  const root = get().workspace?.replace(/\\/g, "/");
  return root && p.toLowerCase().startsWith(root.toLowerCase()) ? root + p.slice(root.length) : p;
}

const SEV: Record<number, Problem["severity"]> = {
  [monaco.MarkerSeverity.Error]: "error",
  [monaco.MarkerSeverity.Warning]: "warning",
  [monaco.MarkerSeverity.Info]: "info",
  [monaco.MarkerSeverity.Hint]: "info",
};
const ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Diagnostics for files that have no Monaco model (language servers report the whole workspace).
 * owner ("lsp:python") → lower-cased path → problems.
 */
const external = new Map<string, Map<string, Problem[]>>();
let resync: () => void = () => {};

export function setExternalProblems(owner: string, path: string, list: Problem[] | null) {
  let byPath = external.get(owner);
  if (!byPath) external.set(owner, (byPath = new Map()));
  const k = path.toLowerCase();
  if (!list?.length) { if (!byPath.delete(k)) return; }
  else byPath.set(k, list);
  resync();
}

export function clearExternalProblems(owner: string) {
  if (external.delete(owner)) resync();
}

/** Mirrors every Monaco marker (built-in validators and language servers) into the store. */
export function trackProblems() {
  let t = 0;
  const sync = () => {
    clearTimeout(t);
    t = window.setTimeout(() => {
      const problems: Problem[] = monaco.editor
        .getModelMarkers({})
        .filter((m) => m.resource.scheme === "file" && m.severity >= monaco.MarkerSeverity.Info)
        .map((m) => ({
          path: fixCase(m.resource.fsPath.replace(/\\/g, "/")),
          line: m.startLineNumber,
          col: m.startColumn,
          endLine: m.endLineNumber,
          endCol: m.endColumn,
          severity: SEV[m.severity] ?? "info",
          message: m.message,
          source: m.source || m.owner,
        }));
      // Open files are covered by their markers; only add the not-open ones.
      const open = new Set(monaco.editor.getModels().filter((m) => m.uri.scheme === "file").map((m) => m.uri.fsPath.replace(/\\/g, "/").toLowerCase()));
      for (const byPath of external.values()) for (const [k, list] of byPath) if (!open.has(k)) problems.push(...list);
      problems.sort((a, b) => a.path.localeCompare(b.path) || ORDER[a.severity] - ORDER[b.severity] || a.line - b.line);
      set({ problems });
    }, 150);
  };
  resync = sync;
  const subs = [monaco.editor.onDidChangeMarkers(sync), monaco.editor.onDidCreateModel(sync), monaco.editor.onWillDisposeModel(sync)];
  sync();
  return () => { subs.forEach((s) => s.dispose()); resync = () => {}; };
}
