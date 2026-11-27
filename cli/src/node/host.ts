/** Node implementation of the core's ToolHost: real files and processes. */
import { promises as fs, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import type { DirEntry, RunOptions, RunResult, SearchMatch, SearchOptions, ToolHost } from "../core/types.js";
import { genericSearch } from "../core/tools.js";
import { globToRegex } from "../core/customize.js";
import { normalize, relative } from "../core/paths.js";

export const toPosix = (p: string) => normalize(p.replace(/\\/g, "/"));

/** Native path for fs calls (Node accepts `/` on Windows too, but keep messages native). */
const native = (p: string) => (process.platform === "win32" ? p.replace(/\//g, "\\") : p);

export function cepheusHome(): string {
  return process.env.CEPHEUS_HOME?.trim() || path.join(os.homedir(), ".cepheus");
}

const ALWAYS_SKIP = new Set([".git", "node_modules", ".hg", ".svn", ".DS_Store"]);
const MAX_CAPTURE = 4 * 1024 * 1024;

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
  negate: boolean;
  /** Matched against the path relative to the .gitignore folder (anchored) or the basename. */
  anchored: boolean;
}

function parseGitignore(text: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    if (!line) continue;
    try {
      out.push({ re: new RegExp(globToRegex(line)), dirOnly, negate, anchored });
    } catch {
      /* ignore bad pattern */
    }
  }
  return out;
}

export class NodeToolHost implements ToolHost {
  readonly root: string;
  readonly caseInsensitive: boolean;
  readonly osLabel: string;
  readonly userSkillsDir?: string;

  constructor(root: string, opts: { userSkillsDir?: string | null } = {}) {
    this.root = toPosix(path.resolve(root));
    this.caseInsensitive = process.platform === "win32" || process.platform === "darwin";
    this.osLabel =
      process.platform === "win32"
        ? "Windows (commands run in PowerShell)"
        : process.platform === "darwin"
          ? "macOS (commands run in sh)"
          : `${process.platform} (commands run in sh)`;
    const skills = opts.userSkillsDir === undefined ? path.join(cepheusHome(), "skills") : opts.userSkillsDir;
    if (skills) this.userSkillsDir = toPosix(skills);
  }

  private rel(p: string) {
    return relative(this.root, p, this.caseInsensitive);
  }

  async readFile(p: string): Promise<string> {
    try {
      const buf = await fs.readFile(native(p));
      if (buf.length > 20 * 1024 * 1024) throw new Error(`File is too large to read (${Math.round(buf.length / 1048576)} MB): ${this.rel(p)}`);
      if (buf.subarray(0, 8000).includes(0)) throw new Error(`File looks binary and can't be read as text: ${this.rel(p)}`);
      return buf.toString("utf8").replace(/^﻿/, "");
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new Error(`File not found: ${this.rel(p)}`);
      if (e?.code === "EISDIR") throw new Error(`${this.rel(p)} is a directory; use list_dir.`);
      throw e;
    }
  }

  async writeFile(p: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(native(p)), { recursive: true });
    await fs.writeFile(native(p), content, "utf8");
  }

  async exists(p: string): Promise<boolean> {
    return existsSync(native(p));
  }

  async removeFile(p: string): Promise<void> {
    await fs.rm(native(p), { force: true });
  }

  async listDir(p: string): Promise<DirEntry[]> {
    try {
      const entries = await fs.readdir(native(p), { withFileTypes: true });
      const out: DirEntry[] = [];
      for (const e of entries) {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) {
          try {
            isDir = (await fs.stat(path.join(native(p), e.name))).isDirectory();
          } catch {
            /* dangling link */
          }
        }
        out.push({ name: e.name, isDir });
      }
      return out;
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new Error(`Directory not found: ${this.rel(p)}`);
      if (e?.code === "ENOTDIR") throw new Error(`${this.rel(p)} is a file, not a directory; use read_file.`);
      throw e;
    }
  }

  async findFiles(limit = 200_000): Promise<string[]> {
    const viaGit = this.gitFiles(limit);
    if (viaGit) return viaGit;
    return this.walk(limit);
  }

  /** Uses `git ls-files` when the workspace is in a git repository (exact .gitignore semantics). */
  private gitFiles(limit: number): string[] | null {
    try {
      const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: native(this.root),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      });
      if (r.status !== 0 || typeof r.stdout !== "string") return null;
      const files = r.stdout.split("\0").filter(Boolean);
      const out: string[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        if (seen.has(f)) continue;
        seen.add(f);
        if (!existsSync(path.join(native(this.root), f))) continue; // deleted but still in the index
        out.push(f);
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      return null;
    }
  }

  private async walk(limit: number): Promise<string[]> {
    const out: string[] = [];
    const stack: { dir: string; rel: string; rules: { base: string; rules: IgnoreRule[] }[] }[] = [{ dir: this.root, rel: "", rules: [] }];
    const ignored = (rules: { base: string; rules: IgnoreRule[] }[], rel: string, name: string, isDir: boolean) => {
      let res = false;
      for (const { base, rules: rs } of rules) {
        if (base && !rel.startsWith(base + "/")) continue;
        const sub = base ? rel.slice(base.length + 1) : rel;
        for (const r of rs) {
          if (r.dirOnly && !isDir) continue;
          if (r.anchored ? r.re.test(sub) : r.re.test(name)) res = !r.negate;
        }
      }
      return res;
    };
    while (stack.length && out.length < limit) {
      const { dir, rel, rules } = stack.pop()!;
      let local = rules;
      try {
        const gi = await fs.readFile(path.join(native(dir), ".gitignore"), "utf8");
        local = [...rules, { base: rel, rules: parseGitignore(gi) }];
      } catch {
        /* none */
      }
      let entries;
      try {
        entries = await fs.readdir(native(dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (ALWAYS_SKIP.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const isDir = e.isDirectory();
        if (ignored(local, r, e.name, isDir)) continue;
        if (isDir) stack.push({ dir: `${dir}/${e.name}`, rel: r, rules: local });
        else if (e.isFile() || e.isSymbolicLink()) {
          out.push(r);
          if (out.length >= limit) break;
        }
      }
    }
    return out.sort();
  }

  async search(opts: SearchOptions): Promise<SearchMatch[]> {
    return genericSearch(this, opts);
  }

  runCommand(command: string, opts: RunOptions = {}): Promise<RunResult> {
    return runShell(command, { ...opts, cwd: opts.cwd ?? this.root });
  }
}

/** Kills a process and its children. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    /* already gone */
  }
}

/** Runs a command line in PowerShell (Windows) or sh, with timeout, stdin input and cancel. */
export function runShell(command: string, opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const win = process.platform === "win32";
    const file = win ? "powershell.exe" : "sh";
    const args = win
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          // UTF-8 output instead of the OEM code page; keep the real exit code of a failing last
          // command (powershell -Command would report 1), like `sh -c`.
          `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8\n${command}\n` +
            `if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`,
        ]
      : ["-c", command];
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd ? native(opts.cwd) : undefined,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: !win,
      });
    } catch (e: any) {
      reject(new Error(`Failed to start command: ${e?.message ?? e}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d;
    });
    child.stderr!.on("data", (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(opts.input ?? "");
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : null;
    const onAbort = () => killTree(child.pid);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (r: RunResult | Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    child.on("error", (e) => finish(new Error(`Failed to start command: ${e.message}`)));
    child.on("close", (code, sig) => {
      if (opts.signal?.aborted) {
        const e = new Error("Cancelled by the user.");
        e.name = "AbortError";
        finish(e);
        return;
      }
      finish({ code: code ?? (sig ? 1 : -1), stdout, stderr, timedOut });
    });
  });
}
