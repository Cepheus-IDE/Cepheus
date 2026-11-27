// Auto-updates (backend: src-tauri/src/updater.rs). Disabled until the build has an update endpoint
// and public key (tauri.conf.json plugins.updater, or the organization policy).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { errMsg } from "./api";
import { get, toast } from "../store";

export interface UpdateConfig { configured: boolean; endpoint: string; source: string; policyMode: string | null; currentVersion: string }
interface UpdateInfo { version: string; currentVersion: string; notes: string | null; date: string | null }

type Status = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "disabled";

export const useUpdater = create<{ config: UpdateConfig | null; status: Status; info: UpdateInfo | null; progress: { downloaded: number; total: number | null } | null; error: string; lastCheck: number }>(() => ({
  config: null,
  status: "idle",
  info: null,
  progress: null,
  error: "",
  lastCheck: 0,
}));

/** Effective mode: the organization policy wins over the user setting. */
export const updateMode = () => (useUpdater.getState().config?.policyMode as any) || get().settings.updateMode;

export async function checkForUpdates(interactive: boolean, autoDownload = false) {
  const st = useUpdater.getState();
  if (st.status === "checking" || st.status === "downloading") return;
  if (!st.config?.configured) {
    if (interactive) toast("Updates are not configured for this build yet (no update endpoint).", "error");
    useUpdater.setState({ status: "disabled" });
    return;
  }
  useUpdater.setState({ status: "checking", error: "" });
  try {
    const info = await invoke<UpdateInfo | null>("update_check");
    useUpdater.setState({ info, status: info ? "available" : "none", lastCheck: Date.now() });
    if (!info) {
      if (interactive) toast(`Cepheus IDE ${st.config.currentVersion} is up to date.`);
      return;
    }
    if (autoDownload) await downloadUpdate();
    else toast(`Update ${info.version} is available — Help › Check for Updates… to install.`);
  } catch (e) {
    useUpdater.setState({ status: "error", error: errMsg(e) });
    if (interactive) toast(errMsg(e), "error");
  }
}

export async function downloadUpdate() {
  useUpdater.setState({ status: "downloading", progress: { downloaded: 0, total: null } });
  try {
    await invoke("update_download");
    useUpdater.setState({ status: "ready" });
    toast(`Update ${useUpdater.getState().info?.version ?? ""} is ready — restart to apply it.`);
  } catch (e) {
    useUpdater.setState({ status: "error", error: errMsg(e) });
    toast(errMsg(e), "error");
  }
}

export async function restartToUpdate() {
  const { saveAll } = await import("./workspace");
  await saveAll();
  try {
    await invoke("update_install");
  } catch (e) {
    useUpdater.setState({ status: "error", error: errMsg(e) });
    toast(errMsg(e), "error");
  }
}

export async function startUpdater() {
  try {
    useUpdater.setState({ config: await invoke<UpdateConfig>("update_config") });
  } catch {
    return;
  }
  listen<{ downloaded: number; total: number | null }>("update-progress", (e) => useUpdater.setState({ progress: e.payload }));
  if (!useUpdater.getState().config?.configured) {
    useUpdater.setState({ status: "disabled" });
    return;
  }
  const mode = updateMode();
  if (mode === "automatic") {
    setTimeout(() => checkForUpdates(false, true), 15_000);
    window.setInterval(() => updateMode() === "automatic" && useUpdater.getState().status !== "ready" && checkForUpdates(false, true), 6 * 3600_000);
  } else if (mode === "startup") {
    setTimeout(() => checkForUpdates(false), 15_000);
  }
}
