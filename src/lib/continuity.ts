// Continuity: cepheus:// deep links and Dev Containers ("Reopen in Container").
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errMsg } from "./api";
import { get, set, toast } from "../store";

// ----------------------------------------------------------------------------------------------
// Deep links
// ----------------------------------------------------------------------------------------------

const prefills = new Map<string, string>();
/** AgentChat reads this once when a session opened from a link mounts. */
export function takePrefill(sessionId: string): string | undefined {
  const t = prefills.get(sessionId);
  prefills.delete(sessionId);
  return t;
}

/** cepheus://open?folder=…[&file=…&line=…] · cepheus://agent/new?prompt=… */
export async function handleDeepLink(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return toast(`Invalid link: ${raw}`, "error");
  }
  const route = (u.hostname + u.pathname).replace(/\/+$/, "").toLowerCase();
  const q = u.searchParams;
  try {
    if (route === "open") {
      const { openFolder, openFile } = await import("./workspace");
      const folder = q.get("folder");
      const file = q.get("file");
      if (folder) {
        if (!folder.startsWith("ssh://") && !(await api.exists(folder))) return toast(`Folder not found: ${folder}`, "error");
        await openFolder(folder);
      }
      if (file) await openFile(file, Number(q.get("line")) || undefined);
      if (!folder && !file) toast("Link is missing ?folder=", "error");
    } else if (route === "agent/new" || route === "agent") {
      const { newSession } = await import("./agent");
      const sess = newSession();
      const prompt = q.get("prompt") ?? "";
      // Prefill only: a link must never start an agent run on its own.
      if (prompt) prefills.set(sess.id, prompt);
      set({ agentOpen: true, view: "editor" });
      if (prompt) toast("Prompt from link added — review it and press Send.");
    } else {
      toast(`Unknown link: ${raw}`, "error");
    }
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

async function drainLinks() {
  const urls = await invoke<string[]>("deep_link_take").catch(() => [] as string[]);
  for (const u of urls) await handleDeepLink(u);
}

export function startDeepLinks() {
  listen("deep-link", () => drainLinks());
  drainLinks();
}

// ----------------------------------------------------------------------------------------------
// Dev Containers
// ----------------------------------------------------------------------------------------------

export interface ActiveContainer { container: string; name: string; workspace: string; workspaceFolder: string; user: string | null }
interface Detect { hasConfig: boolean; configPath: string | null; name: string | null; docker: boolean; active: ActiveContainer | null }

export const useContainer = create<{ detect: Detect | null; active: ActiveContainer | null; busy: boolean; log: string[]; shell: [string, string[]] | null }>(() => ({
  detect: null,
  active: null,
  busy: false,
  log: [],
  shell: null,
}));

listen<string>("devcontainer-log", (e) => useContainer.setState((s) => ({ log: [...s.log.slice(-400), e.payload] }))).catch(() => {});

/** Shell for new terminals: `docker exec -it …` while the workspace is open in a container. */
export function terminalShell(): { shell?: string; args?: string[] } | null {
  const s = useContainer.getState();
  if (!s.active || !s.shell || s.active.workspace !== get().workspace) return null;
  return { shell: s.shell[0], args: s.shell[1] };
}

export async function detectContainer(ws: string | null) {
  if (!ws || ws.startsWith("ssh://")) return useContainer.setState({ detect: null, active: null, shell: null });
  try {
    const d = await invoke<Detect>("devcontainer_detect", { workspace: ws });
    useContainer.setState({ detect: d, active: d.active, shell: d.active ? await invoke<[string, string[]] | null>("devcontainer_shell", { workspace: ws }) : null });
    if (d.hasConfig && !d.active) {
      toast(d.docker
        ? "This folder has a Dev Container configuration — use “Reopen in Container” in the status bar."
        : "This folder has a Dev Container configuration, but Docker was not found on PATH.");
    }
  } catch (e) {
    console.warn("devcontainer detect failed", e);
  }
}

export async function reopenInContainer(rebuild = false) {
  const ws = get().workspace;
  if (!ws) return toast("Open a folder first.", "error");
  if (useContainer.getState().busy) return;
  useContainer.setState({ busy: true, log: [] });
  const { openProfilesModal } = await import("./services");
  openProfilesModal("container");
  try {
    const active = await invoke<ActiveContainer>("devcontainer_up", { workspace: ws, rebuild });
    const shell = await invoke<[string, string[]] | null>("devcontainer_shell", { workspace: ws });
    useContainer.setState({ active, shell });
    toast(`Opened in dev container “${active.name}” — terminals and agent commands now run inside it.`);
    set({ panelOpen: true, panelTab: "terminal" });
    window.dispatchEvent(new Event("cepheus:new-terminal"));
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    useContainer.setState({ busy: false });
  }
}

export async function leaveContainer() {
  const ws = get().workspace;
  if (!ws) return;
  try {
    await invoke("devcontainer_stop", { workspace: ws });
    useContainer.setState({ active: null, shell: null });
    toast("Left the dev container; new terminals and agent commands run on this computer again.");
  } catch (e) {
    toast(errMsg(e), "error");
  }
}
