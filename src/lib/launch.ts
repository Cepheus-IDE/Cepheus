//! Launch configurations: `.vscode/launch.json` and `.cepheus/launch.json` (JSONC, a subset of
//! VS Code's format) plus `${…}` variable substitution and the "Add Configuration…" starter file.

import { api, errMsg } from "./api";
import { get as getApp, toast } from "../store";
import { parseJsonc, parseEnvFile } from "./testParsers";
import { basename, dirname, join, relative } from "./paths";

export interface LaunchConfig {
  type: string;
  request: "launch" | "attach";
  name: string;
  program?: string;
  module?: string;
  args?: string[] | string;
  cwd?: string;
  env?: Record<string, string>;
  envFile?: string;
  runtimeExecutable?: string;
  runtimeArgs?: string[];
  port?: number;
  address?: string;
  stopOnEntry?: boolean;
  console?: string;
  /** Python interpreter for debugpy. */
  python?: string;
  /** Generic DAP: the adapter command line (speaks DAP over stdio). Cepheus extension. */
  adapterCommand?: string;
  /** Internal: a full command line that already contains `--inspect-brk` (Debug Test). */
  command?: string;
  /** Which file the configuration came from. */
  source?: string;
  [k: string]: any;
}

export const NODE_TYPES = ["node", "pwa-node", "node2", "node-terminal"];
export const PYTHON_TYPES = ["python", "debugpy"];
const JS_RE = /\.(m?[jt]s|c[jt]s|[jt]sx)$/i;

export function launchFiles(ws: string) {
  return [join(join(ws, ".vscode"), "launch.json"), join(join(ws, ".cepheus"), "launch.json")];
}

/** All configurations from both files (missing files are fine; broken JSON is reported). */
export async function loadLaunchConfigs(ws: string | null): Promise<LaunchConfig[]> {
  if (!ws || ws.startsWith("ssh://")) return [];
  const out: LaunchConfig[] = [];
  for (const f of launchFiles(ws)) {
    let text: string;
    try { text = await api.readFile(f); } catch { continue; }
    try {
      const j = parseJsonc(text);
      for (const c of j?.configurations ?? []) if (c && c.name && c.type) out.push({ request: "launch", ...c, source: f });
    } catch (e) {
      toast(`${relative(ws, f)}: ${errMsg(e)}`, "error");
    }
  }
  return out;
}

/** The configuration F5 uses when none is selected: debug the active file. */
export function currentFileConfig(file: string | undefined): LaunchConfig | null {
  if (!file) return null;
  if (JS_RE.test(file)) return { type: "node", request: "launch", name: `Node: ${basename(file)}`, program: file };
  if (/\.py$/i.test(file)) return { type: "python", request: "launch", name: `Python: ${basename(file)}`, program: file, console: "internalConsole" };
  return null;
}

/** Replaces ${workspaceFolder}, ${file}, ${fileDirname}… in every string of the config. */
export function resolveConfig(cfg: LaunchConfig, file: string | undefined): LaunchConfig {
  const ws = getApp().workspace ?? "";
  const f = file ?? "";
  const ext = f.match(/\.[^./\\]+$/)?.[0] ?? "";
  const vars: Record<string, string> = {
    workspaceFolder: ws,
    workspaceRoot: ws,
    workspaceFolderBasename: basename(ws),
    file: f,
    fileDirname: f ? dirname(f) : ws,
    fileBasename: basename(f),
    fileBasenameNoExtension: basename(f).slice(0, basename(f).length - ext.length),
    fileExtname: ext,
    relativeFile: relative(ws, f),
    relativeFileDirname: relative(ws, f ? dirname(f) : ws),
    cwd: ws,
    pathSeparator: navigator.userAgent.includes("Windows") ? "\\" : "/",
  };
  const sub = (v: any): any => {
    if (typeof v === "string")
      return v.replace(/\$\{([^}]+)\}/g, (m, k: string) => (k in vars ? vars[k] : k.startsWith("env:") || k.startsWith("config:") ? "" : m));
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return sub(cfg);
}

/** env + envFile (file values first, `env` wins like VS Code). */
export async function configEnv(cfg: LaunchConfig): Promise<Record<string, string>> {
  let env: Record<string, string> = {};
  if (cfg.envFile) {
    try { env = parseEnvFile(await api.readFile(cfg.envFile)); }
    catch (e) { toast(`envFile ${cfg.envFile}: ${errMsg(e)}`, "error"); }
  }
  for (const [k, v] of Object.entries(cfg.env ?? {})) if (v != null) env[k] = String(v);
  return env;
}

export const argList = (a: string[] | string | undefined): string[] => (Array.isArray(a) ? a.map(String) : a ? a.split(/\s+/).filter(Boolean) : []);

/** Gear button: open the existing launch.json, or create a starter one. */
export async function addConfiguration() {
  const ws = getApp().workspace;
  if (!ws || ws.startsWith("ssh://")) return toast("Open a local folder first.", "error");
  const { openFile } = await import("./workspace");
  for (const f of launchFiles(ws)) if (await api.exists(f).catch(() => false)) return openFile(f);
  let main = "${workspaceFolder}/index.js";
  try {
    const pkg = JSON.parse(await api.readFile(join(ws, "package.json")));
    if (typeof pkg.main === "string") main = "${workspaceFolder}/" + pkg.main.replace(/^\.\//, "");
  } catch { /* no package.json */ }
  const text = `{
  // Debug configurations for Cepheus (VS Code launch.json format).
  // Variables: \${workspaceFolder}, \${file}, \${fileDirname}, \${fileBasename}, \${relativeFile}.
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Launch current file",
      "program": "\${file}",
      "cwd": "\${workspaceFolder}"
    },
    {
      "type": "node",
      "request": "launch",
      "name": "Launch program",
      "program": "${main}",
      "args": [],
      "env": { "NODE_ENV": "development" },
      "stopOnEntry": false
    },
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to Node (9229)",
      "port": 9229
    },
    {
      "type": "python",
      "request": "launch",
      "name": "Python: current file",
      "program": "\${file}",
      "console": "internalConsole"
    }
  ]
}
`;
  const f = launchFiles(ws)[0];
  try {
    await api.createDir(join(ws, ".vscode")).catch(() => {});
    await api.writeFile(f, text);
    await openFile(f);
    const { refreshConfigs } = await import("./debugger");
    refreshConfigs();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}
