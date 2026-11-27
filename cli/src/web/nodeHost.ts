/** ToolHost for the agent in `cepheus web`: Node file system + PowerShell/sh commands, confined to the workspace. */
import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listFiles, readText, searchFiles, writeText, cepheusHome } from "./fsops.js";
import { osLabel } from "./procs.js";

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

export function createNodeToolHost(workspace: string, confine: (p: unknown) => string) {
  const root = slash(path.resolve(workspace));
  const native = (p: string) => confine(p);
  const toRel = (p: string) => slash(path.relative(workspace, p)) || ".";
  return {
    root,
    caseInsensitive: process.platform === "win32" || process.platform === "darwin",
    osLabel: osLabel(),
    userSkillsDir: slash(path.join(cepheusHome(), "skills")),
    readFile: (p: string) => readText(native(p)),
    writeFile: (p: string, content: string) => writeText(native(p), content),
    exists: async (p: string) => fs.existsSync(native(p)),
    async listDir(p: string) {
      const ents = await fsp.readdir(native(p), { withFileTypes: true });
      return ents
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    },
    async findFiles(limit = 50_000) {
      return (await listFiles(workspace, limit)).map(toRel);
    },
    async search(o: { query: string; isRegex?: boolean; caseSensitive?: boolean; maxResults?: number }) {
      const hits = await searchFiles(workspace, { ...o, maxResults: o.maxResults ?? 200 });
      return hits.map((h) => ({ path: toRel(h.path), line: h.line, text: h.text }));
    },
    async removeFile(p: string) {
      await fsp.rm(native(p), { force: true });
    },
    runCommand(command: string, o: { cwd?: string; timeoutMs?: number; input?: string; env?: Record<string, string>; signal?: AbortSignal } = {}) {
      const cwd = o.cwd ? native(o.cwd) : workspace;
      const env = { ...process.env, ...(o.env ?? {}) };
      const child =
        process.platform === "win32"
          ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { cwd, env, windowsHide: true })
          : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true });
      return new Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>((resolve) => {
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let timedOut = false;
        const kill = () => {
          if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          else {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, o.timeoutMs ?? 120_000);
        o.signal?.addEventListener("abort", kill);
        child.stdout.on("data", (d: Buffer) => out.push(d));
        child.stderr.on("data", (d: Buffer) => err.push(d));
        child.on("error", (e) => err.push(Buffer.from(e.message)));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
        });
        child.stdin.on("error", () => {});
        child.stdin.end(o.input ?? "");
      });
    },
  };
}

export const homeDir = () => os.homedir();
