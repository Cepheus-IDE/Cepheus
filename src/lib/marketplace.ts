//! Extension marketplace helpers: registry queries (sort / paging through the generic registry text
//! fetch), compatibility of an extension with Cepheus, curated collections, update checks and size.

import { create } from "zustand";
import { api } from "./api";
import { policy } from "./policy";
import { runCommand, shellQuote } from "./procBus";
import { get } from "../store";

export const registryBase = () =>
  (policy().extensionRegistryUrl || get().settings.extensionRegistryUrl || "https://open-vsx.org").trim().replace(/\/+$/, "");

// ---------------------------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------------------------

export type CompatLevel = "full" | "partial" | "pack" | "code" | "empty";
export interface Compat { works: string[]; needsCode: boolean; pack: string[]; level: CompatLevel; label: string }

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** What Cepheus can use from a package.json: declarative contributions only, never `main` code. */
export function compatibility(pkg: any): Compat {
  const c = pkg?.contributes ?? {};
  const works: string[] = [];
  if (arr(c.themes).length) works.push(arr(c.themes).some((t) => String(t?.uiTheme).startsWith("hc-")) ? "theme (high contrast)" : "theme");
  if (arr(c.iconThemes).length) works.push("icons");
  if (arr(c.snippets).length) works.push("snippets");
  if (arr(c.grammars).length) works.push("grammar");
  else if (arr(c.languages).some((l) => l?.configuration)) works.push("language");
  const isKeymap = arr(pkg?.categories).includes("Keymaps");
  if (arr(c.keybindings).length && isKeymap) works.push("keymap");
  const pack = [...arr(pkg?.extensionPack), ...arr(pkg?.extensionDependencies)].filter((x) => typeof x === "string" && x.includes("."));
  const needsCode = !!(pkg?.main || pkg?.browser);
  const level: CompatLevel = works.length ? (needsCode ? "partial" : "full") : pack.length ? "pack" : needsCode ? "code" : "empty";
  const label =
    level === "full" ? `Works in Cepheus: ${works.join(" / ")}`
    : level === "partial" ? `Works in Cepheus: ${works.join(" / ")} · its code features are not supported`
    : level === "pack" ? `Extension pack · ${pack.length} extension${pack.length > 1 ? "s" : ""}`
    : level === "code" ? "Needs extension code (not supported)"
    : "Nothing Cepheus can use";
  return { works, needsCode, pack, level, label };
}

// ---------------------------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------------------------

export interface Hit {
  namespace: string;
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  downloadCount?: number;
  averageRating?: number;
  reviewCount?: number;
  timestamp?: string;
  verified?: boolean;
  files?: { icon?: string };
}

export type SortKey = "relevance" | "downloadCount" | "rating" | "timestamp" | "name";

export async function searchRegistry(o: { query: string; category?: string; sort: SortKey; size?: number }): Promise<Hit[]> {
  const p = new URLSearchParams({ query: o.query, size: String(o.size ?? 50) });
  if (o.category) p.set("category", o.category);
  if (o.sort !== "name") { p.set("sortBy", o.sort); p.set("sortOrder", "desc"); }
  let res: any;
  try {
    res = JSON.parse(await api.openvsxText(`${registryBase()}/api/-/search?${p}`));
  } catch {
    res = await api.openvsxSearch(o.query, o.category); // older registries: plain search
  }
  if (res?.error) throw new Error(res.error);
  const hits: Hit[] = res?.extensions ?? [];
  if (o.sort === "name") hits.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
  return hits;
}

const manifestCache = new Map<string, Promise<any>>();
let running = 0;
const waiters: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 6) await new Promise<void>((r) => waiters.push(r));
  running++;
  try { return await fn(); } finally { running--; waiters.shift()?.(); }
}

/** The package.json of a registry extension (cached; a few requests at a time). */
export function registryManifest(ns: string, name: string, version: string): Promise<any> {
  const key = `${ns}.${name}@${version}`.toLowerCase();
  let p = manifestCache.get(key);
  if (!p) {
    p = limited(() => api.openvsxText(`${registryBase()}/api/${ns}/${name}/${version}/file/package.json`)).then((t) => {
      const j = JSON.parse(t);
      if (j?.error) throw new Error(j.error);
      return j;
    });
    p.catch(() => manifestCache.delete(key));
    manifestCache.set(key, p);
  }
  return p;
}

export async function registryMeta(ns: string, name: string, version?: string): Promise<any> {
  if (!version) return api.openvsxMeta(ns, name);
  return JSON.parse(await api.openvsxText(`${registryBase()}/api/${ns}/${name}/${version}`));
}

// ---------------------------------------------------------------------------------------------
// Categories and curated collections
// ---------------------------------------------------------------------------------------------

export interface Category { id: string; label: string; category?: string; query?: string; unsupported?: boolean }

export const CATEGORIES: Category[] = [
  { id: "featured", label: "Featured" },
  { id: "themes", label: "Themes", category: "Themes" },
  { id: "icons", label: "Icon Themes", category: "Themes", query: "icon theme" },
  { id: "snippets", label: "Snippets", category: "Snippets" },
  { id: "languages", label: "Languages", category: "Programming Languages" },
  { id: "keymaps", label: "Keymaps", category: "Keymaps" },
  { id: "packs", label: "Extension Packs", category: "Extension Packs" },
  { id: "formatters", label: "Formatters", category: "Formatters", unsupported: true },
  { id: "linters", label: "Linters", category: "Linters", unsupported: true },
  { id: "ai", label: "AI", category: "AI", unsupported: true },
  { id: "all", label: "All" },
];

export interface Collection { title: string; note?: string; ids?: string[]; search?: { query: string; category?: string } }

export const FEATURED: Collection[] = [
  { title: "Popular color themes", search: { query: "", category: "Themes" } },
  {
    title: "File icon themes",
    ids: ["PKief.material-icon-theme", "vscode-icons-team.vscode-icons", "miguelsolorio.symbols", "file-icons.file-icons", "Catppuccin.catppuccin-vsc-icons"],
  },
  {
    title: "Languages",
    note: "Syntax highlighting and editing rules from TextMate grammars",
    ids: [
      "ziglang.vscode-zig", "nimsaem.nimvscode", "elixir-lsp.elixir-ls", "justusadam.language-haskell", "hashicorp.terraform",
      "Prisma.prisma", "GraphQL.vscode-graphql-syntax", "svelte.svelte-vscode", "astro-build.astro-vscode", "juanblanco.solidity",
      "Dart-Code.dart-code", "fwcd.kotlin", "vscode.swift", "tamasfe.even-better-toml",
    ],
  },
  { title: "Keymaps", ids: ["ms-vscode.sublime-keybindings", "ms-vscode.atom-keybindings", "k--kato.intellij-idea-keybindings"] },
  { title: "Snippet packs", search: { query: "snippets", category: "Snippets" } },
];

const metaCache = new Map<string, Promise<Hit | null>>();
/** A collection member as a search hit (from the registry's metadata endpoint, cached). */
export function hitFor(id: string): Promise<Hit | null> {
  let p = metaCache.get(id);
  if (!p) {
    const [ns, ...rest] = id.split(".");
    p = limited(() => api.openvsxMeta(ns, rest.join("."))).then((m) => (m && !m.error ? (m as Hit) : null)).catch(() => null);
    metaCache.set(id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Progress (pack installs, bulk updates)
// ---------------------------------------------------------------------------------------------

export const useExtProgress = create<{ label: string; done: number; total: number } | { label: null }>(() => ({ label: null }));

export async function withProgress<T>(label: string, items: T[], fn: (item: T) => Promise<void>) {
  useExtProgress.setState({ label, done: 0, total: items.length }, true);
  try {
    for (let i = 0; i < items.length; i++) {
      await fn(items[i]);
      useExtProgress.setState({ label, done: i + 1, total: items.length }, true);
    }
  } finally {
    useExtProgress.setState({ label: null }, true);
  }
}

// ---------------------------------------------------------------------------------------------
// Size on disk
// ---------------------------------------------------------------------------------------------

export async function dirSize(dir: string): Promise<number | null> {
  const win = navigator.userAgent.includes("Windows");
  const cmd = win
    ? `powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${dir.replace(/'/g, "''")}' -Recurse -File | Measure-Object -Property Length -Sum).Sum"`
    : `du -sk ${shellQuote(dir)}`;
  const r = await runCommand(cmd, null).done;
  const n = parseInt(r.stdout.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return win ? n : n * 1024;
}

export function fmtBytes(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " kB";
  return n + " B";
}

export function fmtCount(n?: number): string {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(n);
}
