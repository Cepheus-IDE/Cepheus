//! Toolbox entry point: background watchers (terminal output, editor copies, TODO count) and the
//! actions shared by the sidebar view, notices, command palette and menus.

import { listen } from "@tauri-apps/api/event";
import { get, set, toast, useStore } from "../../store";
import { errMsg } from "../api";
import { newSession, sendMessage } from "../agent";
import { gitx } from "../gitApi";
import { lastFailureOutput, watchTerminals } from "./termWatch";
import { scanDiff } from "./secretScan";
import { watchClipboard } from "./clipboard";
import { scanTodos } from "./todos";
import { freePort } from "./ports";
import { ToolboxTab, useToolbox } from "./state";

export function showToolbox(tab?: ToolboxTab) {
  if (tab) useToolbox.setState({ tab });
  set({ sidebar: "toolbox", view: "editor" });
}

/** Starts an agent task that explains a failure from terminal output. */
export async function explainWithAgent(output: string) {
  const text = output.trim().split("\n").slice(-80).join("\n");
  if (!text) return toast("No terminal output to explain.", "error");
  const s = newSession();
  set({ agentOpen: true });
  await sendMessage(
    s.id,
    "A command in my terminal failed. Explain the cause in plain words and suggest the fix " +
      "(read the relevant project files if needed; don't change anything until I agree).\n\nLast terminal output:\n```\n" + text + "\n```",
    null,
  );
}

export function explainLastFailure() {
  const out = lastFailureOutput();
  if (!out.trim()) return toast("No terminal output yet.", "error");
  return explainWithAgent(out);
}

/** Command palette: scan the staged diff now and show the result in the Git panel. */
export async function scanStagedForSecrets() {
  const ws = get().workspace;
  if (!ws) return toast("Open a folder first.", "error");
  try {
    const { findings, envFiles } = scanDiff(await gitx.run(ws, ["diff", "--cached", "--no-color", "--no-ext-diff", "-U0"]));
    if (!findings.length && !envFiles.length) return toast("No likely secrets in the staged changes.");
    useToolbox.setState({ guard: { findings, envFiles, proceed: () => {} } });
    set({ sidebar: "git", view: "editor" });
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function freePortWithToast(port: number) {
  try {
    const stopped = await freePort(port);
    toast(`Freed port ${port}: stopped ${stopped.join(", ")}`);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

let todoTimer = 0;
function recountTodos(delay: number) {
  clearTimeout(todoTimer);
  todoTimer = window.setTimeout(() => {
    const ws = get().workspace;
    if (!ws) return useToolbox.setState({ todoCount: 0 });
    scanTodos(ws).catch(() => {});
  }, delay);
}

/** Called once from ToolboxOverlay (mounted in App). */
export function initToolbox(): () => void {
  const stops: (() => void)[] = [watchClipboard()];
  let alive = true;
  watchTerminals().then((u) => (alive ? stops.push(u) : u()));
  listen<string[]>("fs-changed", (e) => {
    // Only source edits can change the TODO count; ignore build output churn.
    if (e.payload.some((p) => !/[\\/](node_modules|target|dist|\.git)[\\/]/.test(p))) recountTodos(5000);
  }).then((u) => (alive ? stops.push(u) : u()));
  let ws = get().workspace;
  recountTodos(3000);
  stops.push(useStore.subscribe((s) => {
    if (s.workspace !== ws) { ws = s.workspace; recountTodos(3000); }
  }));
  return () => { alive = false; stops.forEach((f) => f()); clearTimeout(todoTimer); };
}
