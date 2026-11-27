export function sep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function join(dir: string, name: string): string {
  const s = sep(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i <= 0 ? p : p.slice(0, i);
}

export function relative(root: string | null, p: string): string {
  if (!root) return p;
  const r = root.replace(/[\\/]+$/, "");
  if (p.toLowerCase().startsWith(r.toLowerCase())) {
    return p.slice(r.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  }
  return p;
}

export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

const ICONS: Record<string, [string, string]> = {
  ts: ["TS", "#3178c6"], tsx: ["TX", "#3178c6"], js: ["JS", "#e8d44d"], jsx: ["JX", "#e8d44d"],
  mjs: ["JS", "#e8d44d"], cjs: ["JS", "#e8d44d"], json: ["{}", "#cbcb41"], rs: ["RS", "#dea584"],
  py: ["PY", "#3572a5"], go: ["GO", "#00add8"], java: ["JV", "#b07219"], kt: ["KT", "#a97bff"],
  c: ["C", "#555cff"], h: ["H", "#555cff"], cpp: ["C+", "#f34b7d"], hpp: ["H+", "#f34b7d"], cs: ["C#", "#178600"],
  html: ["<>", "#e34c26"], css: ["#", "#563d7c"], scss: ["#", "#c6538c"], md: ["M↓", "#519aba"],
  toml: ["TM", "#9c4221"], yaml: ["YM", "#cb171e"], yml: ["YM", "#cb171e"], xml: ["<>", "#0060ac"],
  sh: ["$", "#89e051"], ps1: ["PS", "#012456"], bat: ["BT", "#c1f12e"], sql: ["SQ", "#e38c00"],
  php: ["PH", "#4f5d95"], rb: ["RB", "#701516"], swift: ["SW", "#f05138"], dart: ["DT", "#00b4ab"],
  vue: ["V", "#41b883"], svelte: ["SV", "#ff3e00"], lock: ["LK", "#888"], txt: ["TX", "#888"],
  svg: ["SV", "#ffb13b"], png: ["IM", "#a074c4"], jpg: ["IM", "#a074c4"], gif: ["IM", "#a074c4"],
};

export function fileIcon(name: string): { label: string; color: string } {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  // Monochrome by design: the label carries the meaning, CSS supplies the (single) color.
  const [label] = ICONS[ext] ?? ["·", ""];
  return { label, color: "" };
}
