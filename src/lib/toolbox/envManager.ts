//! .env manager: finds .env* files (root and first-level folders — they are usually gitignored, so
//! the file index can't be used), compares their keys with the template and with code usages.

import { api, DirEntry } from "../api";
import { join, relative } from "../paths";
import { compareEnv, ENV_USAGE_SEARCH, EnvEntry, EnvReport, extractEnvUsages, isEnvTemplate, parseEnv, appendKeys } from "./envScan";

export interface EnvFile { path: string; name: string; template: boolean; entries: EnvEntry[] }
export interface EnvGroup { dir: string; rel: string; files: EnvFile[]; report: EnvReport }

const ENV_NAME = /^\.env(\..+)?$|\.env$/i;
const SKIP = new Set(["node_modules", "target", "dist", "build", ".git", ".venv", "venv", "vendor"]);

async function envFilesIn(dir: string, entries: DirEntry[]): Promise<EnvFile[]> {
  const files = entries.filter((e) => !e.isDir && ENV_NAME.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(files.map(async (f) => {
    const text = await api.readFile(f.path).catch(() => "");
    return { path: f.path, name: f.name, template: isEnvTemplate(f.name), entries: parseEnv(text) };
  }));
}

/** Variable name → files (workspace-relative) that read it. */
export async function codeUsages(ws: string): Promise<Map<string, string[]>> {
  const matches = await api.search(ws, { query: ENV_USAGE_SEARCH, isRegex: true, caseSensitive: true, wholeWord: false, maxResults: 5000 });
  const usages = new Map<string, string[]>();
  for (const m of matches) {
    for (const key of extractEnvUsages(m.text)) {
      const where = `${relative(ws, m.path)}:${m.line}`;
      const list = usages.get(key) ?? [];
      if (list.length < 20) list.push(where);
      usages.set(key, list);
    }
  }
  return usages;
}

export async function scanEnv(ws: string): Promise<EnvGroup[]> {
  const root = await api.readDir(ws);
  const dirs: { dir: string; rel: string; entries: DirEntry[] }[] = [{ dir: ws, rel: "", entries: root }];
  const subs = root.filter((e) => e.isDir && !e.name.startsWith(".") && !SKIP.has(e.name)).slice(0, 40);
  for (const s of await Promise.all(subs.map(async (d) => ({ dir: d.path, rel: d.name, entries: await api.readDir(d.path).catch(() => [] as DirEntry[]) })))) {
    if (s.entries.some((e) => !e.isDir && ENV_NAME.test(e.name))) dirs.push(s);
  }
  const usages = await codeUsages(ws).catch(() => new Map<string, string[]>());
  const groups: EnvGroup[] = [];
  for (const d of dirs) {
    const files = await envFilesIn(d.dir, d.entries);
    // Code in a sub-package is compared with that package's .env; root .env sees the whole tree.
    const scoped = new Map([...usages].map(([k, w]) => [k, d.rel ? w.filter((x) => x.startsWith(d.rel + "/")) : w] as const).filter(([, w]) => w.length));
    const defined = new Set(files.filter((f) => !f.template).flatMap((f) => f.entries.map((e) => e.key)));
    const tpl = files.filter((f) => f.template);
    const template = tpl.length ? new Set(tpl.flatMap((f) => f.entries.map((e) => e.key))) : null;
    const report = compareEnv(defined, template, scoped);
    if (files.length || (!d.rel && scoped.size)) groups.push({ dir: d.dir, rel: d.rel, files, report });
  }
  return groups;
}

/** Appends keys (names only, no values) to the group's template, creating `.env.example` if needed. */
export async function addKeysToTemplate(g: EnvGroup, keys: string[]): Promise<string> {
  const tpl = g.files.find((f) => f.template);
  const path = tpl?.path ?? join(g.dir, ".env.example");
  const text = tpl ? await api.readFile(path) : "";
  const existing = new Set(parseEnv(text).map((e) => e.key));
  await api.writeFile(path, appendKeys(text, keys.filter((k) => !existing.has(k))));
  return path;
}

/** Appends keys with empty values to the group's main .env (created if missing). */
export async function addKeysToEnv(g: EnvGroup, keys: string[]): Promise<string> {
  const env = g.files.find((f) => f.name === ".env") ?? g.files.find((f) => !f.template);
  const path = env?.path ?? join(g.dir, ".env");
  const text = env ? await api.readFile(path) : "";
  const existing = new Set(parseEnv(text).map((e) => e.key));
  await api.writeFile(path, appendKeys(text, keys.filter((k) => !existing.has(k))));
  return path;
}
