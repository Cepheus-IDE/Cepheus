// VS Code "file icon theme" support (e.g. Material Icon Theme, vscode-icons).
import { api } from "./api";
import { parseJsonc } from "./settings";
import { languageForPath } from "./monaco";
import { currentUi } from "./themes";
import { set } from "../store";

interface Maps {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileExtensions: Map<string, string>;
  fileNames: Map<string, string>;
  folderNames: Map<string, string>;
  folderNamesExpanded: Map<string, string>;
  languageIds: Map<string, string>;
}

interface Loaded {
  defs: Map<string, string>; // icon id → absolute image path
  base: Maps;
  light?: Maps;
  hidesExplorerArrows: boolean;
}

let active: Loaded | null = null;

function toMap(o: unknown): Map<string, string> {
  const m = new Map<string, string>();
  if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (typeof v === "string") m.set(k.toLowerCase(), v);
  return m;
}

function maps(j: any): Maps {
  return {
    file: j?.file, folder: j?.folder, folderExpanded: j?.folderExpanded,
    fileExtensions: toMap(j?.fileExtensions), fileNames: toMap(j?.fileNames),
    folderNames: toMap(j?.folderNames), folderNamesExpanded: toMap(j?.folderNamesExpanded),
    languageIds: toMap(j?.languageIds),
  };
}

function resolvePath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const parts = base.split(/[\\/]/);
  parts.pop(); // theme json file name
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join(sep);
}

export async function setIconTheme(themePath: string | null) {
  if (!themePath) {
    active = null;
  } else {
    try {
      const j = parseJsonc(await api.readFile(themePath));
      const defs = new Map<string, string>();
      for (const [id, d] of Object.entries<any>(j.iconDefinitions ?? {})) {
        if (typeof d?.iconPath === "string") defs.set(id, resolvePath(themePath, d.iconPath));
      }
      active = { defs, base: maps(j), light: j.light ? maps(j.light) : undefined, hidesExplorerArrows: !!j.hidesExplorerArrows };
    } catch (e) {
      console.warn("icon theme failed", e);
      active = null;
    }
  }
  imageCache.clear();
  set((s) => ({ iconThemeVersion: s.iconThemeVersion + 1 }));
}

export const iconThemeActive = () => !!active;
export const hidesArrows = () => !!active?.hidesExplorerArrows;

const LANG_CANDIDATES: Record<string, string[]> = { tsx: ["typescriptreact"], jsx: ["javascriptreact"] };

/** Absolute image path for a file/folder, or null to use the built-in monogram. */
export function iconFor(name: string, isDir: boolean, open = false): string | null {
  if (!active) return null;
  const lower = name.toLowerCase();
  const layers = currentUi.kind === "light" && active.light ? [active.light, active.base] : [active.base];
  const lookup = (fn: (m: Maps) => string | undefined) => {
    for (const m of layers) {
      const id = fn(m);
      if (id && active!.defs.has(id)) return active!.defs.get(id)!;
    }
    return null;
  };
  if (isDir) {
    return (
      lookup((m) => (open ? m.folderNamesExpanded.get(lower) : m.folderNames.get(lower))) ??
      lookup((m) => (open ? m.folderExpanded ?? m.folder : m.folder))
    );
  }
  const byName = lookup((m) => m.fileNames.get(lower));
  if (byName) return byName;
  // Longest extension first: "foo.test.ts" → "test.ts", then "ts".
  const segs = lower.split(".");
  for (let i = 1; i < segs.length; i++) {
    const ext = segs.slice(i).join(".");
    const hit = lookup((m) => m.fileExtensions.get(ext));
    if (hit) return hit;
  }
  const extOnly = segs.length > 1 ? segs[segs.length - 1] : "";
  for (const lang of [...(LANG_CANDIDATES[extOnly] ?? []), languageForPath(name)]) {
    const hit = lookup((m) => m.languageIds.get(lang));
    if (hit) return hit;
  }
  return lookup((m) => m.file);
}

const imageCache = new Map<string, string | Promise<string>>();

export function imageSync(path: string): string | null {
  const v = imageCache.get(path);
  return typeof v === "string" ? v : null;
}

export function loadImage(path: string): Promise<string> {
  const v = imageCache.get(path);
  if (typeof v === "string") return Promise.resolve(v);
  if (v) return v;
  const p = api.readDataUrl(path).then((url) => {
    imageCache.set(path, url);
    return url;
  });
  imageCache.set(path, p);
  return p;
}
