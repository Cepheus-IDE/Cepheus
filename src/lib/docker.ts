//! Docker view backend: finds the Docker (or Podman) CLI, runs it through the shared process bus,
//! and parses its JSON output (src/lib/dockerParse.ts). No Rust side: everything is CLI calls.

import { create } from "zustand";
import { api, errMsg } from "./api";
import { runCommand, shellQuote, spawnProc } from "./procBus";
import { runInTerminal } from "./terminalBus";
import { get, set, toast } from "../store";
import { basename, dirname, join } from "./paths";
import {
  Container, composeNameFromYaml, composeProjectName, DfRow, Image, isDaemonDown, Network, parseContainers, parseDf,
  parseDfVolumes, parseImages, parseNetworks, parseStats, parseVersion, parseVolumes, splitLines, Stats, stripAnsi,
  VersionInfo, Volume,
} from "./dockerParse";

export type DockerTab = "containers" | "compose" | "images" | "volumes" | "cleanup";

/** UI requests from commands/menus (open a tab, open a log panel). */
export const useDocker = create<{ tab: DockerTab; refreshTick: number }>(() => ({ tab: "containers", refreshTick: 0 }));

export function showDocker(tab?: DockerTab) {
  if (tab) useDocker.setState({ tab });
  set({ sidebar: "docker", view: "editor" });
}

export const platform = (): "windows" | "mac" | "linux" => {
  const ua = navigator.userAgent;
  return ua.includes("Windows") ? "windows" : ua.includes("Mac") ? "mac" : "linux";
};

// ------------------------------------------------------------------ CLI discovery

export interface Cli { exe: string; engine: "docker" | "podman" }

let cliP: Promise<Cli | null> | null = null;

/** `docker` if on PATH, else `podman`; on macOS/Linux also common install paths (GUI apps get a short PATH). */
export function findCli(force = false): Promise<Cli | null> {
  if (cliP && !force) return cliP;
  cliP = (async () => {
    const found = await api.which(["docker", "podman"]).catch(() => [] as string[]);
    if (found.includes("docker")) return { exe: "docker", engine: "docker" as const };
    if (found.includes("podman")) return { exe: "podman", engine: "podman" as const };
    if (platform() === "windows") {
      for (const p of ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", "C:\\Program Files\\RedHat\\Podman\\podman.exe"]) {
        if (await api.exists(p).catch(() => false)) return { exe: shellQuote(p), engine: /podman/i.test(p) ? "podman" as const : "docker" as const };
      }
      return null;
    }
    const candidates = [
      "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "/usr/bin/docker",
      "/opt/homebrew/bin/podman", "/usr/local/bin/podman", "/opt/podman/bin/podman", "/usr/bin/podman",
    ];
    for (const p of candidates) {
      if (await api.exists(p).catch(() => false)) return { exe: shellQuote(p), engine: p.endsWith("podman") ? "podman" as const : "docker" as const };
    }
    return null;
  })();
  return cliP;
}

/** Shell command line for `<cli> args…` (args are quoted for the platform shell). */
export function cmdLine(cli: Cli, args: string[]): string {
  return [cli.exe, ...args.map(shellQuote)].join(" ");
}

export class DockerError extends Error {}

/** Runs the CLI and returns stdout; throws with the CLI's stderr on failure. */
export async function dk(args: string[], opts: { cwd?: string | null; onOutput?: (data: string, stream: "stdout" | "stderr") => void } = {}): Promise<string> {
  const cli = await findCli();
  if (!cli) throw new DockerError("Docker was not found on PATH.");
  const r = await runCommand(cmdLine(cli, args), opts.cwd ?? null, { onOutput: opts.onOutput }).done;
  if (r.code !== 0) throw new DockerError(stripAnsi(r.stderr || r.stdout).trim() || `${cli.engine} ${args[0]} failed (exit code ${r.code})`);
  return r.stdout;
}

/** Runs an action and reports it with a toast; returns whether it succeeded. */
export async function dkAction(label: string, args: string[]): Promise<boolean> {
  try {
    await dk(args);
    if (label) toast(label);
    return true;
  } catch (e) {
    toast(errMsg(e), "error");
    return false;
  }
}

// ------------------------------------------------------------------ status

export type DockerStatus =
  | { kind: "missing" }
  | { kind: "down"; cli: Cli; info: VersionInfo | null; error: string }
  | { kind: "ok"; cli: Cli; info: VersionInfo };

export async function getStatus(force = false): Promise<DockerStatus> {
  const cli = await findCli(force);
  if (!cli) return { kind: "missing" };
  const r = await runCommand(cmdLine(cli, ["version", "--format", "{{json .}}"]), null).done;
  const info = parseVersion(r.stdout);
  if (info) info.engine = cli.engine;
  if (r.code === 0 && info?.server) return { kind: "ok", cli, info };
  const err = stripAnsi(r.stderr || "").trim();
  if (r.code === -1 && /not recognized|not found|No such file/i.test(err)) return { kind: "missing" };
  return { kind: "down", cli, info, error: err || (isDaemonDown(r.stdout) ? r.stdout.trim() : `${cli.engine} version exited with code ${r.code}`) };
}

/** Docker Desktop (Windows/macOS) or `podman machine start`. Linux Engine needs systemctl (shown in the UI). */
export async function startEngine(cli: Cli | null): Promise<void> {
  if (cli?.engine === "podman") {
    runInTerminal({ title: "podman machine start", command: cmdLine(cli, ["machine", "start"]) });
    return;
  }
  const p = platform();
  const command = p === "windows"
    ? `powershell -NoProfile -NonInteractive -Command "Start-Process (Join-Path $Env:ProgramFiles 'Docker\\Docker\\Docker Desktop.exe')"`
    : p === "mac" ? "open -a Docker" : "systemctl --user start docker-desktop";
  const r = await runCommand(command, null).done;
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "Could not start Docker Desktop");
}

export const LINUX_START = "sudo systemctl start docker";
export const INSTALL_URL = "https://docs.docker.com/get-started/get-docker/";
export const PODMAN_URL = "https://podman.io/docs/installation";

// ------------------------------------------------------------------ lists

const F = ["--format", "{{json .}}"];

export const listContainers = async (): Promise<Container[]> => parseContainers(await dk(["ps", "-a", ...F]));
export const listImages = async (): Promise<Image[]> => parseImages(await dk(["images", ...F]));
export const listStats = async (): Promise<Stats[]> => parseStats(await dk(["stats", "--no-stream", ...F]));
export const listNetworks = async (): Promise<Network[]> => parseNetworks(await dk(["network", "ls", ...F]));
export const systemDf = async (): Promise<DfRow[]> => parseDf(await dk(["system", "df", ...F]));

/** Volumes, with sizes from `system df -v` when the CLI supports JSON for it. */
export async function listVolumes(withSizes: boolean): Promise<Volume[]> {
  const vols = parseVolumes(await dk(["volume", "ls", ...F]));
  if (!withSizes) return vols;
  try {
    const sizes = parseDfVolumes(await dk(["system", "df", "-v", ...F]));
    return vols.map((v) => (v.size === null && sizes[v.name] !== undefined ? { ...v, size: sizes[v.name] } : v));
  } catch {
    return vols;
  }
}

export async function inspect(kind: "container" | "image" | "volume" | "network", id: string): Promise<string> {
  const out = await dk([kind, "inspect", id]);
  try { return JSON.stringify(JSON.parse(out), null, 2); } catch { return out; }
}

// ------------------------------------------------------------------ streaming (logs, pull)

export interface Stream { kill: () => void }

/**
 * Runs a long command and delivers complete, ANSI-free lines (without buffering the whole output
 * like runCommand does, so `logs -f` can run for hours).
 */
export function streamCommand(command: string, cwd: string | null, onLines: (lines: string[], stream: "stdout" | "stderr") => void, onExit: (code: number | null) => void): Stream {
  const rest = { stdout: "", stderr: "" };
  let id: number | null = null;
  let killed = false;
  spawnProc(command, cwd, "raw", {
    out: (s, d) => {
      const r = splitLines(rest[s], d);
      rest[s] = r.rest;
      if (r.lines.length) onLines(r.lines.map(stripAnsi), s);
    },
    exit: (code) => {
      for (const s of ["stdout", "stderr"] as const) if (rest[s]) onLines([stripAnsi(rest[s])], s);
      onExit(code);
    },
  }).then((i) => { id = i; if (killed) api.procKill(i).catch(() => {}); }, (e) => { onLines([errMsg(e)], "stderr"); onExit(-1); });
  return { kill: () => { killed = true; if (id !== null) api.procKill(id).catch(() => {}); } };
}

export async function streamDocker(args: string[], onLines: (lines: string[], stream: "stdout" | "stderr") => void, onExit: (code: number | null) => void, cwd: string | null = null): Promise<Stream> {
  const cli = await findCli();
  if (!cli) { onLines(["Docker was not found on PATH."], "stderr"); onExit(-1); return { kill: () => {} }; }
  return streamCommand(cmdLine(cli, args), cwd, onLines, onExit);
}

// ------------------------------------------------------------------ terminals

const SHELL_PROBE = "command -v bash >/dev/null && exec bash || exec sh";

export async function openShell(c: { id: string; name: string }) {
  const cli = await findCli();
  if (!cli) return toast("Docker was not found on PATH.", "error");
  runInTerminal({ title: `shell: ${c.name}`, command: cmdLine(cli, ["exec", "-it", c.id, "sh", "-c", SHELL_PROBE]) });
}

export async function runInDockerTerminal(title: string, args: string[], onExit?: (code: number) => void, cliOverride?: string[]) {
  const cli = await findCli();
  if (!cli) return toast("Docker was not found on PATH.", "error");
  const command = cliOverride ? [...cliOverride.map((x, i) => (i === 0 ? x : shellQuote(x))), ...args.map(shellQuote)].join(" ") : cmdLine(cli, args);
  runInTerminal({ title, command, onExit: (code) => { bumpRefresh(); onExit?.(code); } });
}

/** Asks the view to refresh (after terminal commands finish, commands from the palette…). */
export function bumpRefresh() {
  useDocker.setState((s) => ({ refreshTick: s.refreshTick + 1 }));
}

// ------------------------------------------------------------------ compose

let composeP: Promise<string[] | null> | null = null;

/** `docker compose` (plugin) or the standalone `docker-compose` / `podman-compose`; argv prefix, first item unquoted. */
export function composeBase(force = false): Promise<string[] | null> {
  if (composeP && !force) return composeP;
  composeP = (async () => {
    const cli = await findCli();
    if (!cli) return null;
    const r = await runCommand(cmdLine(cli, ["compose", "version"]), null).done;
    if (r.code === 0) return [cli.exe, "compose"];
    const alt = cli.engine === "podman" ? "podman-compose" : "docker-compose";
    const found = await api.which([alt]).catch(() => [] as string[]);
    return found.length ? [alt] : null;
  })();
  return composeP;
}

export const composeLine = (base: string[], args: string[]) => [...base.map((x, i) => (i === 0 ? x : shellQuote(x))), ...args.map(shellQuote)].join(" ");

export interface ComposeFile { path: string; dir: string; rel: string; project: string; services: string[] }

export const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const SKIP = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", ".venv", "__pycache__", "coverage", "Pods", ".git"]);

function servicesOf(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  let indent = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trim().startsWith("#")) continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) break;
    if (indent < 0) indent = ind;
    if (ind !== indent) continue;
    const m = l.trim().match(/^["']?([A-Za-z0-9_.-]+)["']?:/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Compose files in the workspace root and its first-level folders (one per folder, Compose's preference order). */
export async function findComposeFiles(ws: string): Promise<ComposeFile[]> {
  if (ws.startsWith("ssh://")) return [];
  const out: ComposeFile[] = [];
  const scan = async (dir: string, rel: string) => {
    const entries = await api.readDir(dir).catch(() => []);
    const names = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
    const file = COMPOSE_NAMES.find((n) => names.has(n));
    if (file) {
      const path = join(dir, file);
      const yaml = await api.readFile(path).catch(() => "");
      out.push({ path, dir, rel: rel ? `${rel}/${file}` : file, project: composeNameFromYaml(yaml) ?? composeProjectName(basename(dir)), services: servicesOf(yaml) });
    }
    return entries;
  };
  const root = await scan(ws, "");
  const subs = root.filter((e) => e.isDir && !e.name.startsWith(".") && !SKIP.has(e.name)).slice(0, 60);
  await Promise.all(subs.map((d) => scan(d.path, d.name)));
  return out.sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
}

export interface ComposeProject { name: string; file: ComposeFile | null; configFiles: string[]; workingDir: string | null; containers: Container[] }

/** Merges compose files with projects seen in container labels. */
export function composeProjects(files: ComposeFile[], containers: Container[]): ComposeProject[] {
  const map = new Map<string, ComposeProject>();
  for (const f of files) if (!map.has(f.project)) map.set(f.project, { name: f.project, file: f, configFiles: [f.path], workingDir: f.dir, containers: [] });
  for (const c of containers) {
    if (!c.project) continue;
    let p = map.get(c.project);
    if (!p) {
      const cfg = c.labels["com.docker.compose.project.config_files"] ?? c.labels["io.podman.compose.config_files"] ?? "";
      p = { name: c.project, file: null, configFiles: cfg ? cfg.split(",").filter(Boolean) : [], workingDir: c.labels["com.docker.compose.project.working_dir"] ?? null, containers: [] };
      map.set(c.project, p);
    }
    p.containers.push(c);
  }
  return [...map.values()].sort((a, b) => Number(!!b.file) - Number(!!a.file) || a.name.localeCompare(b.name));
}

/** `-f file… -p name` for a project (files when known, so `up`/`pull` work; the name otherwise). */
export function projectArgs(p: ComposeProject): string[] {
  const files = p.configFiles.flatMap((f) => ["-f", f]);
  return [...files, "-p", p.name];
}

export async function runCompose(p: ComposeProject, args: string[], title?: string, onExit?: (code: number) => void) {
  const base = await composeBase();
  if (!base) return toast("Docker Compose was not found (neither the `compose` plugin nor docker-compose).", "error");
  const cwd = p.workingDir ?? (p.configFiles[0] ? dirname(p.configFiles[0]) : null);
  const line = composeLine(base, [...projectArgs(p), ...args]);
  const ws = get().workspace;
  // The terminal opens in the workspace; cd when the project lives elsewhere.
  const cd = cwd && ws && cwd !== ws ? `cd ${platform() === "windows" ? "/d " : ""}${shellQuote(cwd)} && ` : "";
  runInTerminal({ title: title ?? `compose ${args[0]}: ${p.name}`, command: cd + line, onExit: (code) => { bumpRefresh(); onExit?.(code); } });
}

/** Short compose command run in the background (start/stop/restart one service), with a toast. */
export async function composeQuick(p: ComposeProject, args: string[], label: string): Promise<boolean> {
  const base = await composeBase();
  if (!base) { toast("Docker Compose was not found.", "error"); return false; }
  const r = await runCommand(composeLine(base, [...projectArgs(p), ...args]), p.workingDir, {}).done;
  if (r.code !== 0) { toast(stripAnsi(r.stderr || r.stdout).trim() || `compose ${args[0]} failed`, "error"); return false; }
  toast(label);
  bumpRefresh();
  return true;
}

export async function composeStream(p: ComposeProject, args: string[], onLines: (l: string[], s: "stdout" | "stderr") => void, onExit: (c: number | null) => void): Promise<Stream> {
  const base = await composeBase();
  if (!base) { onLines(["Docker Compose was not found."], "stderr"); onExit(-1); return { kill: () => {} }; }
  return streamCommand(composeLine(base, [...projectArgs(p), ...args]), p.workingDir, onLines, onExit);
}

// ------------------------------------------------------------------ Dockerfiles

export async function findDockerfiles(ws: string): Promise<string[]> {
  if (ws.startsWith("ssh://")) return [];
  const isDf = (n: string) => /^(Dockerfile|Containerfile)(\..+)?$/i.test(n) || /\.(dockerfile|containerfile)$/i.test(n);
  const out: string[] = [];
  const root = await api.readDir(ws).catch(() => []);
  out.push(...root.filter((e) => !e.isDir && isDf(e.name)).map((e) => e.path));
  const subs = root.filter((e) => e.isDir && !e.name.startsWith(".") && !SKIP.has(e.name)).slice(0, 60);
  for (const list of await Promise.all(subs.map((d) => api.readDir(d.path).catch(() => [])))) {
    out.push(...list.filter((e) => !e.isDir && isDf(e.name)).map((e) => e.path));
  }
  return out;
}

// ------------------------------------------------------------------ palette commands

async function pickProject(): Promise<ComposeProject | null> {
  const ws = get().workspace;
  if (!ws) { toast("Open a folder with a compose file first.", "error"); return null; }
  const files = await findComposeFiles(ws);
  if (!files.length) { toast("No compose.yaml / docker-compose.yml in this folder or its first-level folders.", "error"); return null; }
  if (files.length > 1) { showDocker("compose"); toast("Several compose files found: pick a project in the Docker view."); return null; }
  return composeProjects(files, [])[0];
}

export async function commandComposeUp() {
  const p = await pickProject();
  if (p) { showDocker("compose"); await runCompose(p, ["up", "-d"]); }
}

export async function commandComposeDown() {
  const p = await pickProject();
  if (p) { showDocker("compose"); await runCompose(p, ["down"]); }
}
