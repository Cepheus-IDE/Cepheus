// Preview tabs (Settings › Workbench › Preview tabs): a file opened while preview mode is on
// reuses the single italic preview tab until it is edited or its tab is double-clicked.
import { create } from "zustand";
import { get, useStore } from "../store";

export const usePreviewTab = create<{ id: string | null; suspended: boolean }>(() => ({ id: null, suspended: false }));
export const previewTabId = () => usePreviewTab.getState().id;
export const pinTab = (id: string) => { if (usePreviewTab.getState().id === id) usePreviewTab.setState({ id: null }); };

/** Decides how openFile adds `id`: returns the preview tab to replace (if any) and marks the new one. */
export function previewPlan(id: string, alreadyOpen: boolean): string | null {
  const st = get();
  if (!st.settings.tabPreview || alreadyOpen || usePreviewTab.getState().suspended) return null;
  const prev = usePreviewTab.getState().id;
  usePreviewTab.setState({ id });
  const prevTab = prev ? st.tabs.find((t) => t.id === prev) : null;
  return prevTab && !st.dirty[prevTab.path] ? prev : null;
}

// Editing a preview file, closing it, or turning preview mode off makes it a normal tab.
useStore.subscribe((s) => {
  const id = usePreviewTab.getState().id;
  if (!id) return;
  const tab = s.tabs.find((t) => t.id === id);
  if (!tab || !s.settings.tabPreview || s.dirty[tab.path]) usePreviewTab.setState({ id: null });
});
