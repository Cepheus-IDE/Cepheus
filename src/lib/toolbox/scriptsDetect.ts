//! Pure detection of runnable project tasks from manifest files. No imports: unit-tested from Node.
//! The caller reads files; these functions turn their text into { name, command } tasks.

export type TaskKind = "npm" | "make" | "just" | "cargo" | "composer" | "python" | "compose";
export interface Task { kind: TaskKind; name: string; command: string; detail?: string }

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfile (or the "packageManager" field) decides which client runs the scripts. */
export function detectPackageManager(files: Set<string>, pkg: any): PackageManager {
  const field = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(field)) return field as PackageManager;
  if (files.has("bun.lockb") || files.has("bun.lock")) return "bun";
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  return "npm";
}

export function npmTasks(pkgText: string, files: Set<string>): Task[] {
  let pkg: any;
  try { pkg = JSON.parse(pkgText); } catch { return []; }
  const pm = detectPackageManager(files, pkg);
  const run = pm === "npm" ? "npm run" : pm === "bun" ? "bun run" : pm;
  return Object.entries(pkg?.scripts ?? {})
    .filter(([, v]) => typeof v === "string")
    .map(([name, v]) => ({ kind: "npm" as const, name, command: `${run} ${name}`, detail: String(v) }));
}

/** Makefile targets: explicit names (no patterns, no special .TARGETS, no variable assignments). */
export function makeTargets(text: string): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line) || line.startsWith("#")) continue;
    if (/^[A-Za-z0-9_.-]+\s*(?::{1,3}=|[?+!]?=)/.test(line)) continue; // variable assignment
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.\/ -]*?)\s*::?(?!=)(.*)$/);
    if (!m) continue;
    for (const t of m[1].split(/\s+/)) {
      if (!t || t.includes("%") || t.startsWith(".") || seen.has(t)) continue;
      seen.add(t);
      out.push({ kind: "make", name: t, command: `make ${t}` });
    }
  }
  return out;
}

/** justfile recipes (`name args: deps`), skipping settings, aliases, imports and variables. */
export function justRecipes(text: string): Task[] {
  const out: Task[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line) || /^(set|alias|export|import|mod)\b/.test(line) || line.startsWith("#") || line.startsWith("[")) continue;
    const m = line.match(/^@?([A-Za-z_][A-Za-z0-9_-]*)\b([^:]*):(?!=)/);
    if (!m) continue;
    const doc = lines[i - 1]?.match(/^#\s*(.+)/)?.[1];
    out.push({ kind: "just", name: m[1], command: `just ${m[1]}`, detail: doc ?? (m[2].trim() ? `args: ${m[2].trim()}` : undefined) });
  }
  return out;
}

export function cargoTasks(cargoToml: string): Task[] {
  const isWorkspaceOnly = /^\[workspace\]/m.test(cargoToml) && !/^\[package\]/m.test(cargoToml);
  const tasks: Task[] = [
    { kind: "cargo", name: "build", command: "cargo build" },
    { kind: "cargo", name: "test", command: "cargo test" },
  ];
  if (!isWorkspaceOnly) tasks.push({ kind: "cargo", name: "run", command: "cargo run" });
  tasks.push({ kind: "cargo", name: "clippy", command: "cargo clippy" });
  return tasks;
}

export function composerTasks(text: string): Task[] {
  let j: any;
  try { j = JSON.parse(text); } catch { return []; }
  return Object.keys(j?.scripts ?? {})
    .filter((k) => !/^(pre|post)-/.test(k))
    .map((name) => ({ kind: "composer" as const, name, command: `composer run-script ${name}` }));
}

/** Names under one TOML table header (`[project.scripts]` …) in pyproject.toml, without a TOML parser. */
function tomlTableKeys(text: string, header: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start < 0) return [];
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith("[")) break;
    const m = l.match(/^"?([A-Za-z0-9_.-]+)"?\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

export function pythonTasks(pyproject: string | null, files: Set<string>, isWindows: boolean): Task[] {
  const out: Task[] = [];
  const py = isWindows ? "python" : "python3";
  const poetry = !!pyproject && (/^\[tool\.poetry\]/m.test(pyproject) || files.has("poetry.lock"));
  const runner = files.has("uv.lock") ? "uv run " : poetry ? "poetry run " : "";
  if (pyproject) {
    const names = new Set([...tomlTableKeys(pyproject, "project.scripts"), ...tomlTableKeys(pyproject, "tool.poetry.scripts")]);
    for (const n of names) out.push({ kind: "python", name: n, command: `${runner}${n}`, detail: "entry point" });
    for (const n of tomlTableKeys(pyproject, "tool.poe.tasks")) out.push({ kind: "python", name: n, command: `${runner}poe ${n}`, detail: "poe task" });
  }
  if (files.has("manage.py")) {
    out.push({ kind: "python", name: "runserver", command: `${runner || py + " "}${runner ? "python " : ""}manage.py runserver`, detail: "Django" });
    out.push({ kind: "python", name: "migrate", command: `${runner || py + " "}${runner ? "python " : ""}manage.py migrate`, detail: "Django" });
  }
  return out;
}

/** Service names under the top-level `services:` key of a compose file. */
export function composeServices(text: string): Task[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out: Task[] = [{ kind: "compose", name: "up (all)", command: "docker compose up" }];
  let indent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) break;
    if (indent < 0) indent = ind;
    if (ind !== indent) continue;
    const m = l.trim().match(/^["']?([A-Za-z0-9_.-]+)["']?:/);
    if (m) out.push({ kind: "compose", name: m[1], command: `docker compose up ${m[1]}` });
  }
  return out;
}

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
