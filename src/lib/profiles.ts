// Profiles: named bundles of settings, keybindings, enabled extensions, user snippets and layout.
// The live profile is whatever is in settings.json + the store; switching snapshots it into
// profiles.json and applies the target. Secrets, SSH hosts, recent folders and machine-level
// network/update settings stay global (shared by all profiles).
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";
import { errMsg } from "./api";
import { DEFAULT_SETTINGS, mergeSettings, Settings } from "./settings";
import { get, set, toast, SidebarView } from "../store";
import { samePath } from "./paths";

export interface Layout {
  sideW?: number;
  agentW?: number;
  panelH?: number;
  sidebar?: SidebarView | null;
  agentOpen?: boolean;
  panelOpen?: boolean;
}
export interface ProfileData {
  settings: Partial<Settings>;
  /** Enabled extension ids (others installed are disabled in this profile). */
  extensions: string[];
  layout: Layout;
}
export interface Profile {
  id: string;
  name: string;
  /** Workspace folders that switch to this profile when opened. */
  folders: string[];
  createdAt: number;
  data: ProfileData | null;
}
interface ProfilesFile { active: string; profiles: Profile[] }

/** Settings shared by every profile (secrets and machine-level configuration). */
export const GLOBAL_KEYS: (keyof Settings)[] = [
  "keys", "githubToken", "sshHosts", "recent", "proxy", "trustedCertificates", "telemetryLevel", "updateMode", "extensionRegistryUrl",
];
const LAYOUT_SIZES = ["sideW", "agentW", "panelH"] as const;

export const DEFAULT_PROFILE = "default";

export const useProfiles = create<ProfilesFile & { loaded: boolean }>(() => ({
  active: DEFAULT_PROFILE,
  profiles: [{ id: DEFAULT_PROFILE, name: "Default", folders: [], createdAt: 0, data: null }],
  loaded: false,
}));

export const activeProfile = () => {
  const s = useProfiles.getState();
  return s.profiles.find((p) => p.id === s.active) ?? s.profiles[0];
};

export async function loadProfiles() {
  try {
    const raw = await invoke<ProfilesFile | null>("profiles_load");
    if (raw && Array.isArray(raw.profiles) && raw.profiles.length) {
      const profiles = raw.profiles.map((p) => ({ ...p, folders: Array.isArray(p.folders) ? p.folders : [] }));
      if (!profiles.some((p) => p.id === DEFAULT_PROFILE)) profiles.unshift({ id: DEFAULT_PROFILE, name: "Default", folders: [], createdAt: 0, data: null });
      useProfiles.setState({ profiles, active: profiles.some((p) => p.id === raw.active) ? raw.active : DEFAULT_PROFILE, loaded: true });
      return;
    }
  } catch (e) {
    console.warn("profiles load failed", e);
  }
  useProfiles.setState({ loaded: true });
}

async function persist() {
  const { active, profiles } = useProfiles.getState();
  await invoke("profiles_save", { data: { active, profiles } });
}

function readLayout(): Layout {
  const st = get();
  const l: Layout = { sidebar: st.sidebar, agentOpen: st.agentOpen, panelOpen: st.panelOpen };
  for (const k of LAYOUT_SIZES) {
    const n = Number(localStorage.getItem("cepheus." + k));
    if (Number.isFinite(n) && n > 0) l[k] = n;
  }
  return l;
}

function applyLayout(l: Layout) {
  for (const k of LAYOUT_SIZES) {
    if (l[k]) localStorage.setItem("cepheus." + k, String(l[k]));
    else localStorage.removeItem("cepheus." + k);
  }
  set({
    sidebar: l.sidebar === undefined ? "explorer" : l.sidebar,
    agentOpen: l.agentOpen ?? true,
    panelOpen: l.panelOpen ?? false,
  });
  // usePersistentSize re-reads its value on this event.
  window.dispatchEvent(new Event("cepheus:layout"));
}

function profileSettings(s: Settings): Partial<Settings> {
  const out: any = { ...s };
  for (const k of GLOBAL_KEYS) delete out[k];
  return out;
}

/** Snapshot of the live state, as stored for the active profile. */
export function captureCurrent(): ProfileData {
  const st = get();
  const disabled = new Set(st.settings.disabledExtensions);
  return {
    settings: profileSettings(st.settings),
    extensions: st.extensions.map((e) => e.id).filter((id) => !disabled.has(id)),
    layout: readLayout(),
  };
}

function emptyData(): ProfileData {
  return { settings: profileSettings(structuredClone(DEFAULT_SETTINGS)), extensions: [], layout: {} };
}

const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Applies a profile's data to the live app (settings, enabled extensions, layout). */
export async function applyData(data: ProfileData) {
  const { saveSettings } = await import("./workspace");
  const cur = get().settings;
  const next: any = mergeSettings({ ...data.settings });
  for (const k of GLOBAL_KEYS) next[k] = cur[k];
  const enabled = new Set(data.extensions);
  next.disabledExtensions = get().extensions.map((e) => e.id).filter((id) => !enabled.has(id));
  await saveSettings(next as Settings);
  applyLayout(data.layout ?? {});
  const { loadExtensions } = await import("./extensions");
  await loadExtensions();
  window.dispatchEvent(new CustomEvent("cepheus:profile-changed", { detail: { id: useProfiles.getState().active } }));
}

export async function switchProfile(id: string) {
  const st = useProfiles.getState();
  if (id === st.active) return;
  const target = st.profiles.find((p) => p.id === id);
  if (!target) return;
  const current = captureCurrent();
  useProfiles.setState({
    active: id,
    profiles: st.profiles.map((p) => (p.id === st.active ? { ...p, data: current } : p)),
  });
  try {
    await applyData(target.data ?? emptyData());
    await persist();
    toast(`Profile: ${target.name}`);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function createProfile(name: string, from: "empty" | "current", switchTo = true) {
  const n = name.trim();
  if (!n) throw new Error("Enter a profile name.");
  if (useProfiles.getState().profiles.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new Error(`A profile named “${n}” already exists.`);
  const p: Profile = { id: newId(), name: n, folders: [], createdAt: Date.now(), data: from === "current" ? captureCurrent() : emptyData() };
  if (from === "current") {
    // Copy the current profile's user snippets too.
    const files = await invoke<Record<string, string>>("profile_snippets_read", { id: useProfiles.getState().active }).catch(() => ({}));
    await invoke("profile_snippets_write", { id: p.id, files });
  }
  useProfiles.setState((s) => ({ profiles: [...s.profiles, p] }));
  await persist();
  if (switchTo) await switchProfile(p.id);
  return p;
}

export async function renameProfile(id: string, name: string) {
  const n = name.trim();
  if (!n || id === DEFAULT_PROFILE) return;
  useProfiles.setState((s) => ({ profiles: s.profiles.map((p) => (p.id === id ? { ...p, name: n } : p)) }));
  await persist();
}

export async function deleteProfile(id: string) {
  if (id === DEFAULT_PROFILE) return;
  if (useProfiles.getState().active === id) await switchProfile(DEFAULT_PROFILE);
  useProfiles.setState((s) => ({ profiles: s.profiles.filter((p) => p.id !== id) }));
  await persist();
  invoke("profile_delete_data", { id }).catch(() => {});
}

/** Associates (or un-associates) the open folder with a profile. */
export async function setFolderProfile(folder: string, id: string | null) {
  useProfiles.setState((s) => ({
    profiles: s.profiles.map((p) => {
      const folders = p.folders.filter((f) => !samePath(f, folder));
      return { ...p, folders: p.id === id ? [...folders, folder] : folders };
    }),
  }));
  await persist();
}

export const folderProfile = (folder: string) => useProfiles.getState().profiles.find((p) => p.folders.some((f) => samePath(f, folder)));

/** Called on folder open: switch to the folder's associated profile, if any. */
export async function autoSwitchForFolder(folder: string) {
  const p = folderProfile(folder);
  if (p && p.id !== useProfiles.getState().active) await switchProfile(p.id);
}

/** User snippets folder of the active profile (for the snippets editor / loader). */
export const activeSnippetsDir = () => invoke<string>("profile_snippets_dir", { id: useProfiles.getState().active });

// ----------------------------------------------------------------------------------------------
// Export / import (.cepheus-profile)
// ----------------------------------------------------------------------------------------------

export async function exportProfile(id: string) {
  const st = useProfiles.getState();
  const p = st.profiles.find((x) => x.id === id);
  if (!p) return;
  const data = id === st.active ? captureCurrent() : p.data ?? emptyData();
  const path = await saveDialog({
    title: "Export Profile",
    defaultPath: `${p.name.replace(/[^\w.-]+/g, "-")}.cepheus-profile`,
    filters: [{ name: "Cepheus Profile", extensions: ["cepheus-profile"] }],
  });
  if (!path) return;
  await invoke("profile_export", { path, id, profile: { id: p.id, name: p.name, data } });
  toast(`Exported “${p.name}” (API keys and tokens are never included)`);
}

export async function importProfile() {
  const path = await openDialog({ title: "Import Profile", multiple: false, filters: [{ name: "Cepheus Profile", extensions: ["cepheus-profile", "json"] }] });
  if (typeof path !== "string") return;
  const id = newId();
  const raw = await invoke<{ name: string; data?: ProfileData }>("profile_import", { path, newId: id });
  let name = String(raw.name).trim();
  const names = new Set(useProfiles.getState().profiles.map((p) => p.name.toLowerCase()));
  for (let i = 2; names.has(name.toLowerCase()); i++) name = `${String(raw.name).trim()} (${i})`;
  const d = raw.data;
  const data: ProfileData = {
    settings: d?.settings && typeof d.settings === "object" ? profileSettings(mergeSettings(d.settings)) : emptyData().settings,
    extensions: Array.isArray(d?.extensions) ? d!.extensions.filter((x) => typeof x === "string") : [],
    layout: d?.layout && typeof d.layout === "object" ? d.layout : {},
  };
  const p: Profile = { id, name, folders: [], createdAt: Date.now(), data };
  useProfiles.setState((s) => ({ profiles: [...s.profiles, p] }));
  await persist();
  // Offer the profile's extensions: install the missing ones from the registry.
  const installed = new Set(get().extensions.map((e) => e.id));
  const missing = data.extensions.filter((x) => !installed.has(x));
  if (missing.length) {
    const { installMissing } = await import("./services");
    await installMissing(missing);
  }
  toast(`Imported profile “${name}”`);
  return p;
}

/** Replaces all profiles (Settings Sync, remote wins). The active profile is kept if it still exists. */
export async function replaceProfiles(remote: Profile[]) {
  const st = useProfiles.getState();
  const local = new Map(st.profiles.map((p) => [p.id, p]));
  const profiles = remote.map((r) => ({ ...r, folders: local.get(r.id)?.folders ?? [] }));
  if (!profiles.some((p) => p.id === DEFAULT_PROFILE)) profiles.unshift({ id: DEFAULT_PROFILE, name: "Default", folders: [], createdAt: 0, data: null });
  const active = profiles.some((p) => p.id === st.active) ? st.active : DEFAULT_PROFILE;
  useProfiles.setState({ profiles, active });
  await persist();
}

/** All profiles with the active one's data filled from the live state (for sync). */
export function snapshotProfiles(): Profile[] {
  const st = useProfiles.getState();
  return st.profiles.map((p) => ({ ...p, folders: [], data: p.id === st.active ? captureCurrent() : p.data }));
}
