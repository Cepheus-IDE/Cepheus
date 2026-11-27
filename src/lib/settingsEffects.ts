// Settings that act app-wide rather than on one component: root CSS classes (reduce motion,
// transparency, density, layout toggles), auto save on focus change, Git auto fetch, agent
// defaults / limits / notifications, tab restore and the startup page.
import { useEffect } from "react";
import { get, set, toast, useStore, AgentSession } from "../store";
import type { Settings } from "./settings";
import { playSound, systemNotify } from "./sounds";
import { usePreviewTab } from "./tabPreview";

/** html classes derived from settings (styles.css "Settings editor" section). */
export function rootClasses(s: Settings): Record<string, boolean> {
  return {
    "reduce-motion": s.reduceMotion ?? false,
    "reduce-transparency": s.reducedTransparency ?? false,
    "density-compact": s.compactDensity ?? false,
    "hc-focus": s.highContrastFocus ?? false,
    "sidebar-right": s.sidebarPosition === "right",
    "no-activitybar": s.activityBarVisible === false,
    "no-statusbar": s.statusBarVisible === false,
    "no-command-center": s.commandCenter === false,
    "tabs-wrap": s.wrapTabs ?? false,
    "tab-close-left": s.tabCloseButton === "left",
    "tab-close-off": s.tabCloseButton === "off",
    "no-breadcrumbs": s.breadcrumbs === false,
  };
}

/** Called once from App. */
export function useSettingsEffects() {
  const settings = useStore((s) => s.settings);
  useEffect(() => {
    const html = document.documentElement;
    for (const [cls, on] of Object.entries(rootClasses(settings))) html.classList.toggle(cls, on);
    html.style.setProperty("--ui-scale", String(settings.uiFontScale ?? 1));
  }, [settings]);
  useEffect(initSettingsEffects, []);
}

function initSettingsEffects(): () => void {
  const stops = [autoSaveOnFocus(), autoFetch(), agentWatch(), tabsAndStartup()];
  return () => stops.forEach((f) => f());
}

// ---------------------------------------------------------------------------------------------
// Auto save: "when the editor loses focus" (tab switch) and "when the window loses focus"
// ---------------------------------------------------------------------------------------------

function autoSaveOnFocus() {
  const saveAll = () => import("./workspace").then((w) => w.saveAll());
  const onBlur = () => {
    const s = get().settings;
    if (s.autoSave && s.autoSaveMode !== "afterDelay") saveAll();
  };
  window.addEventListener("blur", onBlur);
  const unsub = useStore.subscribe((st, prev) => {
    if (st.activeId === prev.activeId || !st.settings.autoSave || st.settings.autoSaveMode !== "onFocusChange") return;
    const left = prev.tabs.find((t) => t.id === prev.activeId);
    if (left?.kind === "file" && st.dirty[left.path]) import("./workspace").then((w) => w.saveFile(left.path));
  });
  return () => { window.removeEventListener("blur", onBlur); unsub(); };
}

// ---------------------------------------------------------------------------------------------
// Git auto fetch
// ---------------------------------------------------------------------------------------------

function autoFetch() {
  let timer = 0;
  let key = "";
  const schedule = () => {
    const st = get();
    const s = st.settings;
    const next = s.gitAutofetch && st.workspace && !st.workspace.startsWith("ssh://") ? `${st.workspace}|${s.gitAutofetchInterval}` : "";
    if (next === key) return;
    key = next;
    clearInterval(timer);
    if (!next) return;
    const ms = Math.max(30, s.gitAutofetchInterval || 180) * 1000;
    timer = window.setInterval(async () => {
      const cur = get();
      if (!cur.workspace || !cur.git?.isRepo) return;
      try {
        const { gitx, bumpRefs } = await import("./gitApi");
        await gitx.run(cur.workspace, ["fetch", "--all", "--prune", "--quiet"], cur.settings.githubToken);
        (await import("./workspace")).refreshGit();
        bumpRefs();
      } catch { /* offline or no remote: try again next interval */ }
    }, ms);
  };
  schedule();
  const unsub = useStore.subscribe(schedule);
  return () => { clearInterval(timer); unsub(); };
}

// ---------------------------------------------------------------------------------------------
// Agent: new-task defaults, tool-call limit, notifications, auto-open Changes
// ---------------------------------------------------------------------------------------------

const toolCount = (s: AgentSession) => s.items.reduce((n, it) => n + (it.kind === "tool" ? 1 : 0), 0);
const waitingApproval = (s: AgentSession) => s.items.some((it) => it.kind === "tool" && it.status === "approval");

function agentWatch() {
  const seen = new Set<string>();
  const runStart = new Map<string, number>(); // session id → tool count when the run started
  const unsub = useStore.subscribe((st, prev) => {
    if (st.sessions === prev.sessions) return;
    const s = st.settings;
    const prevById = new Map(prev.sessions.map((x) => [x.id, x]));
    for (const sess of st.sessions) {
      // Defaults for brand-new tasks (only once, so turning them off afterwards sticks).
      if (!seen.has(sess.id)) {
        seen.add(sess.id);
        if (!prevById.has(sess.id) && sess.items.length === 0 && (s.agentPlanModeDefault || s.agentVerifyDefault) && sess.planMode === undefined && sess.verify === undefined) {
          queueMicrotask(() => set((x) => ({ sessions: x.sessions.map((y) => (y.id === sess.id ? { ...y, planMode: s.agentPlanModeDefault || undefined, verify: s.agentVerifyDefault || undefined } : y)) })));
        }
      }
      const before = prevById.get(sess.id);
      if (!before || before === sess) continue;
      const busy = sess.status === "running" || sess.status === "waiting";
      const wasBusy = before.status === "running" || before.status === "waiting";
      if (busy && !wasBusy) runStart.set(sess.id, toolCount(before));
      // Tool-call limit for this run.
      if (busy && s.agentMaxTurns > 0 && toolCount(sess) - (runStart.get(sess.id) ?? 0) >= s.agentMaxTurns && toolCount(before) - (runStart.get(sess.id) ?? 0) < s.agentMaxTurns) {
        import("./agent").then((a) => a.stopSession(sess.id));
        toast(`Agent stopped after ${s.agentMaxTurns} tool calls (Settings › Agent & AI). Send a message to continue.`);
      }
      const title = sess.title || "Agent task";
      if (waitingApproval(sess) && !waitingApproval(before) && s.agentNotifyApproval) {
        if (!document.hasFocus() || st.activeSessionId !== sess.id || !st.agentOpen) toast(`“${title}” needs your approval`);
        playSound("approval");
        systemNotify("Agent needs approval", title);
      }
      if (wasBusy && !busy) {
        runStart.delete(sess.id);
        if (sess.status === "idle") {
          if (s.agentNotifyDone) {
            if (!document.hasFocus() || st.activeSessionId !== sess.id || !st.agentOpen) toast(`“${title}” finished`);
            playSound("done");
            systemNotify("Agent finished", title);
          }
          if (s.agentAutoOpenChanges && Object.keys(sess.changes).length) set({ agentOpen: true, activeSessionId: sess.id });
        }
      }
    }
  });
  return unsub;
}

// ---------------------------------------------------------------------------------------------
// Restore open tabs per folder; startup page
// ---------------------------------------------------------------------------------------------

const tabsKey = (ws: string) => "cepheus.tabs:" + ws.replace(/\\/g, "/").toLowerCase();
interface SavedTabs { files: string[]; active: string | null }

function tabsAndStartup() {
  let restoring = false;
  let started = false;
  const unsub = useStore.subscribe((st, prev) => {
    // Startup page: the first settings load decides whether to reopen the last folder.
    if (prev.settings !== st.settings && !started) {
      started = true;
      if (st.settings.startupPage === "lastFolder" && !st.workspace && st.settings.recent[0]) {
        const last = st.settings.recent[0];
        import("./workspace").then((w) => w.openFolder(last));
      }
    }
    if (st.workspace !== prev.workspace) {
      if (st.workspace && st.settings.restoreTabs) restore(st.workspace);
      return;
    }
    if (!st.workspace || restoring || (st.tabs === prev.tabs && st.activeId === prev.activeId)) return;
    const files = st.tabs.filter((t) => t.kind === "file").map((t) => t.path);
    const active = st.tabs.find((t) => t.id === st.activeId && t.kind === "file")?.path ?? null;
    try { localStorage.setItem(tabsKey(st.workspace), JSON.stringify({ files, active } satisfies SavedTabs)); } catch { /* storage blocked */ }
  });

  async function restore(ws: string) {
    let saved: SavedTabs | null = null;
    try { saved = JSON.parse(localStorage.getItem(tabsKey(ws)) || "null"); } catch { /* ignore */ }
    if (!saved?.files?.length) return;
    restoring = true;
    usePreviewTab.setState({ suspended: true }); // restored tabs are normal tabs
    try {
      const { api } = await import("./api");
      const w = await import("./workspace");
      for (const p of saved.files.slice(0, 30)) {
        if (get().workspace !== ws) return;
        if (await api.exists(p).catch(() => false)) await w.openFile(p);
      }
      if (saved.active && get().workspace === ws) await w.openFile(saved.active);
    } finally {
      restoring = false;
      usePreviewTab.setState({ suspended: false });
    }
  }
  return unsub;
}
