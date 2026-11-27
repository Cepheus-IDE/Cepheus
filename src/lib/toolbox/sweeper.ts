//! Project sweeper: finds heavy, regenerable folders (node_modules, target, .next …) under a folder,
//! measures them, and moves the chosen ones to the Recycle Bin / Trash via `api.remove`.

import { api, DirEntry } from "../api";
import { runCommand, tempDir } from "../procBus";
import { dirname, join, samePath } from "../paths";
import { isWindows } from "./state";

export interface HeavyDir { path: string; name: string; project: string; size: number | null; projectModified: number | null }

/** Folder name → sibling file that proves it is generated (null = always regenerable). */
const TARGETS: Record<string, string[] | null> = {
  node_modules: null,
  target: ["Cargo.toml"],
  ".next": null,
  ".nuxt": null,
  ".turbo": null,
  ".svelte-kit": null,
  ".parcel-cache": null,
  dist: ["package.json", "pyproject.toml", "setup.py", "Cargo.toml", "vite.config.ts", "vite.config.js"],
  build: ["package.json", "build.gradle", "build.gradle.kts", "CMakeLists.txt", "pyproject.toml", "setup.py", "pubspec.yaml"],
  ".gradle": null,
  __pycache__: null,
  ".venv": ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "poetry.lock", "uv.lock"],
  ".pytest_cache": null,
  ".mypy_cache": null,
  Pods: ["Podfile"],
  DerivedData: null,
};
const NO_DESCEND = new Set([".git", ".hg", ".svn", "$RECYCLE.BIN", "System Volume Information", "AppData", "Library"]);
const MAX_DIRS = 15000;
const MAX_DEPTH = 7;

export function defaultSweepRoot(ws: string | null): string | null {
  if (!ws || ws.startsWith("ssh://")) return null;
  const parent = dirname(ws.replace(/[\\/]+$/, ""));
  return parent && parent !== ws ? parent : ws;
}

/** Walks `root` breadth-first and returns candidate folders (sizes are measured separately). */
export async function findHeavyDirs(root: string, onProgress?: (visited: number) => void, cancelled?: () => boolean): Promise<HeavyDir[]> {
  const found: HeavyDir[] = [];
  let queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < MAX_DIRS && !cancelled?.()) {
    const batch = queue.splice(0, 24);
    const listed = await Promise.all(batch.map(async (d) => ({ d, entries: await api.readDir(d.path).catch(() => [] as DirEntry[]) })));
    for (const { d, entries } of listed) {
      visited++;
      const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.name));
      for (const e of entries) {
        if (!e.isDir) continue;
        if (Object.prototype.hasOwnProperty.call(TARGETS, e.name)) {
          const proof = TARGETS[e.name];
          if (!proof || proof.some((f) => files.has(f))) {
            found.push({ path: e.path, name: e.name, project: d.path, size: null, projectModified: null });
            continue; // never descend into a match
          }
        }
        if (NO_DESCEND.has(e.name) || d.depth + 1 > MAX_DEPTH) continue;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        queue.push({ path: e.path, depth: d.depth + 1 });
      }
    }
    onProgress?.(visited);
  }
  return found;
}

/**
 * Measures sizes (bytes) and the newest top-level change in each project (ms since epoch).
 * Windows: PowerShell Get-ChildItem | Measure-Object; others: du -sk. Streams results via `onItem`.
 */
export async function measure(dirs: HeavyDir[], onItem: (path: string, size: number | null, modified: number | null) => void, register?: (kill: () => void) => void): Promise<void> {
  if (!dirs.length) return;
  const tmp = await tempDir();
  const stamp = Date.now().toString(36);
  const heavy = Object.keys(TARGETS);
  if (isWindows()) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      `$heavy = @(${heavy.map(q).join(",")})`,
      // Two flat arrays: a single nested @(@(a, b)) would be flattened by PowerShell.
      `$paths = @(${dirs.map((d) => q(d.path)).join(",\n")})`,
      `$projs = @(${dirs.map((d) => q(d.project)).join(",\n")})`,
      "for ($i = 0; $i -lt $paths.Count; $i++) {",
      "  $s = (Get-ChildItem -LiteralPath $paths[$i] -Recurse -Force -File | Measure-Object -Sum Length).Sum",
      "  if ($null -eq $s) { $s = 0 }",
      "  $m = Get-ChildItem -LiteralPath $projs[$i] -Force | Where-Object { $heavy -notcontains $_.Name } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1",
      "  $ms = if ($m) { [long](($m.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds) } else { 0 }",
      "  [Console]::Out.WriteLine(\"$s`t$ms`t\" + $paths[$i])",
      "}",
    ].join("\r\n");
    const file = join(tmp, `cepheus-sweep-${stamp}.ps1`);
    // UTF-8 BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly.
    await api.writeFile(file, "﻿" + script);
    await stream(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${file}"`, onItem, register);
    api.remove(file).catch(() => {});
    return;
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const skip = heavy.map((h) => `-e ${q(h)}`).join(" ");
  const script = [
    // GNU first: on Linux `stat -f` means --file-system and would print filesystem info.
    "mt() { stat -c %Y \"$1\" 2>/dev/null || stat -f %m \"$1\" 2>/dev/null || echo 0; }",
    ...dirs.map((d) => {
      const p = q(d.path), proj = q(d.project);
      return `s=$(du -sk ${p} 2>/dev/null | cut -f1); n=$(ls -At ${proj} 2>/dev/null | grep -v -x ${skip} | head -n 1); if [ -n "$n" ]; then m=$(mt ${proj}/"$n"); else m=$(mt ${proj}); fi; printf '%s\\t%s\\t%s\\n' "$((\${s:-0} * 1024))" "$((\${m:-0} * 1000))" ${p}`;
    }),
  ].join("\n");
  const file = join(tmp, `cepheus-sweep-${stamp}.sh`);
  await api.writeFile(file, script);
  await stream(`sh '${file.replace(/'/g, `'\\''`)}'`, onItem, register);
  api.remove(file).catch(() => {});
}

async function stream(cmd: string, onItem: (path: string, size: number | null, modified: number | null) => void, register: ((kill: () => void) => void) | undefined) {
  let buf = "";
  const h = runCommand(cmd, null, {
    onOutput: (d, s) => {
      if (s !== "stdout") return;
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) {
        const m = l.match(/^(\d+)\t(\d+)\t(.+)$/);
        if (m) onItem(m[3], Number(m[1]), Number(m[2]) || null);
      }
    },
  });
  register?.(h.kill);
  await h.done;
}

/** Throws unless `path` is strictly inside `root` and is neither the workspace nor one of its ancestors. */
export function assertSafeToDelete(path: string, root: string, ws: string | null) {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = norm(path), r = norm(root);
  if (!p.startsWith(r + "/") || p === r) throw new Error(`${path} is outside the scanned folder`);
  if (ws) {
    const w = norm(ws);
    if (p === w || w.startsWith(p + "/")) throw new Error(`${path} contains the open workspace`);
  }
  if (path.startsWith("ssh://")) throw new Error("Remote folders can't be moved to the trash");
}

/** Moves the folders to the Recycle Bin / Trash. Returns the paths that failed with their errors. */
export async function sweep(paths: string[], root: string, ws: string | null): Promise<{ path: string; error: string }[]> {
  const failed: { path: string; error: string }[] = [];
  for (const p of paths) {
    try {
      assertSafeToDelete(p, root, ws);
      if (ws && samePath(p, ws)) throw new Error("Refusing to delete the workspace");
      await api.remove(p);
    } catch (e) {
      failed.push({ path: p, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return failed;
}

export function formatBytes(n: number | null): string {
  if (n === null) return "…";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}
