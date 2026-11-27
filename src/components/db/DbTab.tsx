// Editor-area host for database tabs. Tab components unmount when another tab is active, so
// their state (SQL text, results, pending edits, designer drafts) lives in a per-tab cache.
import { useCallback, useEffect, useState } from "react";
import { useStore, type Tab } from "../../store";
import SqlEditorTab from "./SqlEditorTab";
import TableDataTab from "./TableDataTab";
import TableDesignerTab from "./TableDesignerTab";
import ErDiagramTab from "./ErDiagramTab";
import { connById, initDb } from "../../lib/db/store";

export type DbTabKind = "dbquery" | "dbtable" | "dbdesign" | "dber";
export const isDbTab = (k: Tab["kind"]): k is DbTabKind => k === "dbquery" || k === "dbtable" || k === "dbdesign" || k === "dber";
export const DB_TAB_ICON: Record<DbTabKind, string> = { dbquery: "database", dbtable: "table", dbdesign: "symbol-structure", dber: "type-hierarchy" };

const cache = new Map<string, Record<string, unknown>>();
const disposers = new Map<string, () => void>();

/** useState backed by a per-tab cache that survives unmounting. */
export function useTabState<T>(tabId: string, key: string, init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    const bag = cache.get(tabId);
    if (bag && key in bag) return bag[key] as T;
    return typeof init === "function" ? (init as () => T)() : init;
  });
  const set = useCallback(
    (nv: T | ((p: T) => T)) => {
      setV((prev) => {
        const next = typeof nv === "function" ? (nv as (p: T) => T)(prev) : nv;
        const bag = cache.get(tabId) ?? {};
        bag[key] = next;
        cache.set(tabId, bag);
        return next;
      });
    },
    [tabId, key],
  );
  useEffect(() => {
    const bag = cache.get(tabId) ?? {};
    if (!(key in bag)) {
      bag[key] = v;
      cache.set(tabId, bag);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [v, set];
}

/** Registers cleanup for a tab (e.g. disposing its Monaco model) when the tab is closed. */
export function onTabClosed(tabId: string, fn: () => void) {
  disposers.set(tabId, fn);
}

initDb();
useStore.subscribe((s, p) => {
  if (s.tabs === p.tabs) return;
  const open = new Set(s.tabs.map((t) => t.id));
  for (const id of [...cache.keys(), ...disposers.keys()]) {
    if (open.has(id)) continue;
    cache.delete(id);
    const d = disposers.get(id);
    disposers.delete(id);
    d?.();
  }
});

export default function DbTab({ tab }: { tab: Tab }) {
  const ref = tab.db!;
  const conn = connById(ref.conn);
  if (!conn) {
    return (
      <div className="db-tab"><div className="empty-state"><p>The connection for this tab was removed.</p></div></div>
    );
  }
  switch (tab.kind) {
    case "dbquery":
      return <SqlEditorTab tab={tab} />;
    case "dbtable":
      return <TableDataTab tab={tab} />;
    case "dbdesign":
      return <TableDesignerTab tab={tab} />;
    case "dber":
      return <ErDiagramTab tab={tab} />;
    default:
      return null;
  }
}
