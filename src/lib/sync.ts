// Settings Sync: profiles (settings, keybindings, enabled extensions, layout), user snippets and
// the installed extensions list, stored in a private GitHub Gist with the saved GitHub token.
// API keys and tokens are never synced (stripped here and again in the backend).
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { errMsg } from "./api";
import { get, toast } from "../store";
import { applyData, Profile, replaceProfiles, snapshotProfiles, useProfiles } from "./profiles";

interface SyncConfig {
  enabled: boolean;
  gistId: string;
  lastSync: number;
  lastLocalHash: string;
  lastRemoteAt: string;
  /** Leave out machine-specific values (shell, language server paths, recent folders, SSH hosts). */
  excludeMachine: boolean;
}
interface Remote { gistId: string; updatedAt: string; content: string | null }
interface Payload {
  format: "cepheus-sync";
  version: 1;
  updatedAt: number;
  profiles: Profile[];
  snippets: Record<string, Record<string, string>>;
  extensions: { id: string; version: string }[];
  machine?: { recent: string[]; sshHosts: unknown[] };
}

const KEY = "cepheus.sync";
const MACHINE_SETTINGS = ["shell", "languageServers"];

function readConfig(): SyncConfig {
  const def: SyncConfig = { enabled: false, gistId: "", lastSync: 0, lastLocalHash: "", lastRemoteAt: "", excludeMachine: true };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return def;
  }
}

export const useSync = create<SyncConfig & { busy: boolean; error: string; conflict: Payload | null }>(() => ({
  ...readConfig(),
  busy: false,
  error: "",
  conflict: null,
}));

function saveConfig(patch: Partial<SyncConfig>) {
  useSync.setState(patch);
  const { enabled, gistId, lastSync, lastLocalHash, lastRemoteAt, excludeMachine } = useSync.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ enabled, gistId, lastSync, lastLocalHash, lastRemoteAt, excludeMachine }));
  } catch { /* storage unavailable */ }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length;
}

const SECRET = /^(keys|githubToken|apiKey|token|password|passphrase|secret|privateKey)$/i;
function stripSecrets<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripSecrets) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, stripSecrets(x)])) as T;
  return v;
}

async function buildPayload(): Promise<Payload> {
  const { excludeMachine } = useSync.getState();
  const profiles = snapshotProfiles().map((p) => {
    if (!p.data || !excludeMachine) return p;
    const settings: any = { ...p.data.settings };
    for (const k of MACHINE_SETTINGS) delete settings[k];
    return { ...p, data: { ...p.data, settings } };
  });
  const snippets: Payload["snippets"] = {};
  for (const p of profiles) {
    const files = await invoke<Record<string, string>>("profile_snippets_read", { id: p.id }).catch(() => ({}));
    if (Object.keys(files).length) snippets[p.id] = files;
  }
  const s = get().settings;
  return stripSecrets({
    format: "cepheus-sync",
    version: 1,
    updatedAt: Date.now(),
    profiles,
    snippets,
    extensions: get().extensions.map((e) => ({ id: e.id, version: e.version })).sort((a, b) => a.id.localeCompare(b.id)),
    machine: excludeMachine ? undefined : { recent: s.recent, sshHosts: s.sshHosts },
  } as Payload);
}

const contentHash = (p: Payload) => hash(JSON.stringify({ ...p, updatedAt: 0 }));

async function push(token: string, payload: Payload) {
  const r = await invoke<Remote>("sync_push", { token, gistId: useSync.getState().gistId || null, content: JSON.stringify(payload) });
  saveConfig({ gistId: r.gistId, lastRemoteAt: r.updatedAt, lastLocalHash: contentHash(payload), lastSync: Date.now() });
}

async function applyRemote(remote: Payload) {
  const { excludeMachine } = useSync.getState();
  const local = get().settings as any;
  const keepMachine = (p: Profile): Profile => {
    if (!p.data || !excludeMachine) return p;
    const settings: any = { ...p.data.settings };
    for (const k of MACHINE_SETTINGS) settings[k] = local[k];
    return { ...p, data: { ...p.data, settings } };
  };
  const profiles = (remote.profiles ?? []).map(keepMachine);
  await replaceProfiles(profiles);
  for (const [id, files] of Object.entries(remote.snippets ?? {})) {
    await invoke("profile_snippets_write", { id, files }).catch(() => {});
  }
  const installed = new Set(get().extensions.map((e) => e.id));
  const missing = (remote.extensions ?? []).map((e) => e.id).filter((id) => !installed.has(id));
  if (missing.length) {
    const { installMissing } = await import("./services");
    await installMissing(missing);
  }
  const active = profiles.find((p) => p.id === useProfiles.getState().active);
  if (active?.data) await applyData(active.data);
  if (remote.machine && !excludeMachine) {
    const { saveSettings } = await import("./workspace");
    const s = get().settings;
    await saveSettings({ ...s, recent: remote.machine.recent ?? s.recent, sshHosts: (remote.machine.sshHosts as any) ?? s.sshHosts });
  }
}

/** Sync now. With `resolve`, settles a conflict by keeping the local or the remote copy. */
export async function syncNow(resolve?: "local" | "remote"): Promise<void> {
  const st = useSync.getState();
  if (st.busy) return;
  const token = get().settings.githubToken;
  useSync.setState({ busy: true, error: "" });
  try {
    if (resolve === "remote" && st.conflict) {
      await applyRemote(st.conflict);
      const after = await buildPayload();
      saveConfig({ lastLocalHash: contentHash(after), lastSync: Date.now() });
      useSync.setState({ conflict: null });
      toast("Settings Sync: remote settings applied");
      return;
    }
    const local = await buildPayload();
    if (resolve === "local") {
      await push(token, local);
      useSync.setState({ conflict: null });
      toast("Settings Sync: local settings uploaded");
      return;
    }
    const remote = await invoke<Remote | null>("sync_fetch", { token, gistId: st.gistId || null });
    let data: Payload | null = null;
    if (remote?.content) {
      try {
        const v = JSON.parse(remote.content);
        if (v?.format === "cepheus-sync") data = v;
      } catch { /* corrupt gist: overwrite with local */ }
    }
    if (!remote || !data) return await push(token, local);
    saveConfig({ gistId: remote.gistId });
    const localChanged = contentHash(local) !== st.lastLocalHash;
    const remoteChanged = remote.updatedAt !== st.lastRemoteAt;
    const same = contentHash(data) === contentHash(local);
    if (same) {
      saveConfig({ lastRemoteAt: remote.updatedAt, lastLocalHash: contentHash(local), lastSync: Date.now() });
    } else if (remoteChanged && (localChanged || !st.lastRemoteAt)) {
      // Both sides changed (or first sync on this machine with data on both sides): ask.
      useSync.setState({ conflict: data });
      toast("Settings Sync: local and remote settings differ — choose which to keep (Profiles & Sync).", "error");
    } else if (remoteChanged) {
      await applyRemote(data);
      const after = await buildPayload();
      saveConfig({ lastRemoteAt: remote.updatedAt, lastLocalHash: contentHash(after), lastSync: Date.now() });
    } else if (localChanged) {
      await push(token, local);
    } else {
      saveConfig({ lastSync: Date.now() });
    }
  } catch (e) {
    useSync.setState({ error: errMsg(e) });
    toast("Settings Sync: " + errMsg(e), "error");
  } finally {
    useSync.setState({ busy: false });
  }
}

export async function turnOnSync(excludeMachine: boolean) {
  if (!get().settings.githubToken) throw new Error("Sign in to GitHub first (GitHub panel). Settings Sync uses a private Gist.");
  saveConfig({ enabled: true, excludeMachine });
  await syncNow();
}

export function turnOffSync() {
  saveConfig({ enabled: false });
}

export const setExcludeMachine = (v: boolean) => saveConfig({ excludeMachine: v });

let timer = 0;
/** Auto sync: on start, every 15 minutes, and 20s after settings change. */
export function startAutoSync(subscribe: (fn: () => void) => void) {
  if (useSync.getState().enabled) syncNow();
  window.setInterval(() => useSync.getState().enabled && syncNow(), 15 * 60_000);
  subscribe(() => {
    if (!useSync.getState().enabled) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => syncNow(), 20_000);
  });
}
