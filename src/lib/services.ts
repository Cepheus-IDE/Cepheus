// Startup wiring for profiles, Settings Sync, organization policy, network, updates and continuity.
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { DEFAULT_SETTINGS, Settings } from "./settings";
import { get, toast, useStore } from "../store";
import { errMsg } from "./api";
import { policyInfo } from "./policy";
import { autoSwitchForFolder, loadProfiles } from "./profiles";
import { configureRegistry, installMissingExtensions, loadRecommendations, runPreinstall } from "./extensions";
import { startAutoSync } from "./sync";
import { startUpdater } from "./updater";
import { detectContainer, startDeepLinks } from "./continuity";

export type ProfilesTab = "profiles" | "sync" | "updates" | "container" | "organization";
export const useProfilesModal = create<{ open: boolean; tab: ProfilesTab }>(() => ({ open: false, tab: "profiles" }));
export const openProfilesModal = (tab: ProfilesTab = "profiles") => useProfilesModal.setState({ open: true, tab });

export const installMissing = installMissingExtensions;

/** Pushes proxy / certificate settings to the backend HTTP clients. */
export async function applyNetwork(s: Settings) {
  try {
    const errors = await invoke<string[]>("net_configure", {
      config: { http: s.proxy.http, https: s.proxy.https, noProxy: s.proxy.noProxy, trustedCertificates: s.trustedCertificates },
    });
    if (errors.length) toast(`Trusted certificates: ${errors.join("; ")}`, "error");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

function whenSettingsLoaded(): Promise<void> {
  // loadSettings replaces the default object; wait for that.
  if (get().settings !== DEFAULT_SETTINGS) return Promise.resolve();
  return new Promise((resolve) => {
    const un = useStore.subscribe((s) => {
      if (s.settings !== DEFAULT_SETTINGS) {
        un();
        resolve();
      }
    });
  });
}

let started = false;
export async function startServices() {
  if (started) return;
  started = true;
  startDeepLinks();
  await whenSettingsLoaded();
  const s = get().settings;
  const info = policyInfo();
  if (info.error) toast(`Organization policy (${info.path}) could not be applied: ${info.error}`, "error");
  await applyNetwork(s);
  await configureRegistry(s.extensionRegistryUrl);
  await loadProfiles();
  runPreinstall();
  startUpdater();
  // Re-apply network / registry when those settings change; schedule sync on any change.
  let prev = s;
  const listeners: (() => void)[] = [];
  useStore.subscribe((st) => {
    const cur = st.settings;
    if (cur === prev) return;
    if (cur.proxy !== prev.proxy || cur.trustedCertificates !== prev.trustedCertificates) applyNetwork(cur);
    if (cur.extensionRegistryUrl !== prev.extensionRegistryUrl) configureRegistry(cur.extensionRegistryUrl);
    prev = cur;
    listeners.forEach((f) => f());
  });
  startAutoSync((fn) => listeners.push(fn));
  const ws = get().workspace;
  if (ws) onFolderOpened(ws);
}

export async function onFolderOpened(dir: string) {
  await autoSwitchForFolder(dir).catch(() => {});
  loadRecommendations(dir);
  detectContainer(dir);
}
