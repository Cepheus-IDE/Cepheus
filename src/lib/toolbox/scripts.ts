//! Project scripts runner: finds runnable tasks in the workspace root and its first-level folders
//! (monorepo packages) and runs them in a new terminal, remembering pins and last exit codes.

import { api, DirEntry } from "../api";
import { runInTerminal } from "../terminalBus";
import { get } from "../../store";
import {
  cargoTasks, COMPOSE_FILES, composerTasks, composeServices, justRecipes, makeTargets, npmTasks, pythonTasks, Task,
} from "./scriptsDetect";
import { isWindows, loadLocal, saveLocal } from "./state";

export interface TaskGroup { dir: string; rel: string; label: string; kind: Task["kind"]; tasks: Task[] }

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", ".venv", "__pycache__", "coverage", "Pods"]);
const KIND_LABEL: Record<Task["kind"], string> = {
  npm: "package.json", make: "Makefile", just: "justfile", cargo: "Cargo", composer: "composer.json", python: "Python", compose: "Docker Compose",
};

async function read(dir: string, name: string): Promise<string | null> {
  try { return await api.readFile(`${dir}${dir.includes("\\") ? "\\" : "/"}${name}`); } catch { return null; }
}

async function tasksIn(dir: string, rel: string, entries: DirEntry[], rootFiles: Set<string>): Promise<TaskGroup[]> {
  const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
  // Lockfiles usually live at the monorepo root.
  const lockFiles = new Set([...files, ...rootFiles]);
  const groups: TaskGroup[] = [];
  const add = (kind: Task["kind"], tasks: Task[]) => {
    if (tasks.length) groups.push({ dir, rel, kind, label: `${rel ? rel + " · " : ""}${KIND_LABEL[kind]}`, tasks });
  };
  const jobs: Promise<void>[] = [];
  const job = (name: string, fn: (text: string) => void) => {
    if (files.has(name)) jobs.push(read(dir, name).then((t) => { if (t !== null) fn(t); }));
  };
  job("package.json", (t) => add("npm", npmTasks(t, lockFiles)));
  const makefile = ["Makefile", "makefile", "GNUmakefile"].find((f) => files.has(f));
  if (makefile) job(makefile, (t) => add("make", makeTargets(t)));
  const justfile = ["justfile", "Justfile", ".justfile"].find((f) => files.has(f));
  if (justfile) job(justfile, (t) => add("just", justRecipes(t)));
  job("Cargo.toml", (t) => add("cargo", cargoTasks(t)));
  job("composer.json", (t) => add("composer", composerTasks(t)));
  if (files.has("pyproject.toml")) job("pyproject.toml", (t) => add("python", pythonTasks(t, files, isWindows())));
  else if (files.has("manage.py")) add("python", pythonTasks(null, files, isWindows()));
  const compose = COMPOSE_FILES.find((f) => files.has(f));
  if (compose) job(compose, (t) => add("compose", composeServices(t))); // all four names are compose defaults
  await Promise.all(jobs);
  const order = Object.keys(KIND_LABEL);
  return groups.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export async function detectTasks(ws: string): Promise<TaskGroup[]> {
  const root = await api.readDir(ws);
  const rootFiles = new Set(root.filter((e) => !e.isDir).map((e) => e.name));
  const out = await tasksIn(ws, "", root, rootFiles);
  const subdirs = root.filter((e) => e.isDir && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).slice(0, 40);
  // One level of nesting covers packages/*, apps/*, crates/* layouts.
  const nested = await Promise.all(subdirs.map(async (d) => {
    const entries = await api.readDir(d.path).catch(() => [] as DirEntry[]);
    const groups = await tasksIn(d.path, d.name, entries, rootFiles);
    if (groups.length || !["packages", "apps", "crates", "services", "libs"].includes(d.name)) return groups;
    const inner = entries.filter((e) => e.isDir && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)).slice(0, 40);
    return (await Promise.all(inner.map(async (x) => tasksIn(x.path, `${d.name}/${x.name}`, await api.readDir(x.path).catch(() => []), rootFiles)))).flat();
  }));
  return [...out, ...nested.flat()];
}

export const taskKey = (g: TaskGroup, t: Task) => `${g.rel}|${t.kind}|${t.name}`;

const PIN_KEY = "cepheus.toolbox.pins";
const EXIT_KEY = "cepheus.toolbox.exits";

export function loadPins(): string[] { return loadLocal<string[]>(PIN_KEY, []); }
export function savePins(p: string[]) { saveLocal(PIN_KEY, p); }
export function loadExits(): Record<string, { code: number; at: number }> { return loadLocal(EXIT_KEY, {}); }

function quoteDir(rel: string): string {
  const native = isWindows() ? rel.replace(/\//g, "\\") : rel;
  if (/^[\w.\\/-]+$/.test(native)) return native;
  return isWindows() ? `"${native}"` : `'${native.replace(/'/g, `'\\''`)}'`;
}

/** Runs a task in a new terminal tab; `onExit` gets the exit code. */
export function runTask(g: TaskGroup, t: Task, onExit?: (code: number) => void) {
  const ws = get().workspace;
  const cd = g.rel ? `cd ${isWindows() ? "/d " : ""}${quoteDir(g.rel)} && ` : "";
  // Terminals start in the workspace; a different root (unlikely) gets an absolute cd.
  const prefix = ws && !g.dir.startsWith(ws) ? `cd ${isWindows() ? "/d " : ""}${quoteDir(g.dir)} && ` : cd;
  runInTerminal({
    title: `${t.name}${g.rel ? ` (${g.rel})` : ""}`,
    command: prefix + t.command,
    onExit: (code) => {
      const exits = loadExits();
      exits[taskKey(g, t)] = { code, at: Date.now() };
      saveLocal(EXIT_KEY, exits);
      onExit?.(code);
    },
  });
}
