/**
 * Workspace customizations (mirrors src-tauri/src/agent/customize.rs): instruction files,
 * skills, custom agents and hooks. Everything is read through the {@link ToolHost}.
 */
import type { ToolHost } from "./types.js";
import { join } from "./paths.js";
import { truncate } from "./tools.js";

export const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];
const MAX_INSTRUCTION_BYTES = 40_000;

export interface Instruction {
  path: string;
  applyTo: string | null;
  body: string;
}

export interface Skill {
  name: string;
  description: string;
  source: "workspace" | "user";
  dir: string;
}

export interface AgentDef {
  name: string;
  description: string;
  tools: string[] | null;
  model: string | null;
  path: string;
  body: string;
}

export interface Hook {
  event: string;
  matcher: string | null;
  command: string;
  timeout: number | null;
}

export interface Customizations {
  instructions: Instruction[];
  skills: Skill[];
  agents: AgentDef[];
  hooks: Hook[];
}

export const emptyCustomizations = (): Customizations => ({ instructions: [], skills: [], agents: [], hooks: [] });

// ---------------------------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------------------------

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

export type FmValue = string | string[] | null;

/**
 * Splits a `---` YAML-ish frontmatter block from the body. Supports `key: value`,
 * `key: [a, b]` and block lists (`key:` followed by `  - a` lines).
 */
export function parseFrontmatter(text: string): { data: Record<string, FmValue>; body: string } {
  const t = text.replace(/^﻿/, "");
  const data: Record<string, FmValue> = {};
  let rest: string;
  if (t.startsWith("---\r\n")) rest = t.slice(5);
  else if (t.startsWith("---\n")) rest = t.slice(4);
  else return { data, body: t };
  let offset = 0;
  let bodyStart = -1;
  for (const line of rest.split(/(?<=\n)/)) {
    if (line.trimEnd() === "---") {
      bodyStart = offset + line.length;
      break;
    }
    offset += line.length;
  }
  if (bodyStart < 0) return { data: {}, body: t };
  const head = rest.slice(0, offset);
  const body = rest.slice(bodyStart);
  let lastKey: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ") && lastKey) {
      const cur = data[lastKey];
      const arr = Array.isArray(cur) ? cur : [];
      arr.push(unquote(trimmed.slice(2).trim()));
      data[lastKey] = arr;
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    lastKey = k;
    if (!v) data[k] = null;
    else if (v.startsWith("[") && v.endsWith("]"))
      data[k] = v
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    else data[k] = unquote(v);
  }
  return { data, body };
}

export function fmStr(m: Record<string, FmValue>, k: string): string | null {
  const v = m[k];
  if (typeof v === "string") return v.trim() ? v.trim() : null;
  if (Array.isArray(v)) return v.join(",");
  return null;
}

export function fmList(m: Record<string, FmValue>, k: string): string[] | null {
  const v = m[k];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Globs (applyTo)
// ---------------------------------------------------------------------------------------------

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function globToRegex(glob: string): string {
  let re = "^";
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
      continue;
    }
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      inBrace = true;
      re += "(?:";
    } else if (c === "}" && inBrace) {
      inBrace = false;
      re += ")";
    } else if (c === "," && inBrace) re += "|";
    else re += escapeRe(c);
  }
  return re + "$";
}

/** Splits on commas that are not inside `{...}`. */
export function splitGlobs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Matches a comma-separated glob list (`applyTo`) against a relative path. Patterns without a
 * `/` also match the file name, so `*.ts` works like `**\/*.ts`.
 */
export function globMatch(globs: string, path: string, caseInsensitive = false): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const name = p.slice(p.lastIndexOf("/") + 1);
  return splitGlobs(globs).some((g0) => {
    const g = g0.replace(/^\.\//, "");
    let re: RegExp;
    try {
      re = new RegExp(globToRegex(g), caseInsensitive ? "i" : "");
    } catch {
      return false;
    }
    return re.test(p) || (!g.includes("/") && re.test(name));
  });
}

// ---------------------------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------------------------

/** Accepts `[{...}]`, `{"hooks": [...]}` or `{"hooks": {"preToolUse": [{matcher, command}]}}`. */
export function parseHooks(text: string): Hook[] {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const root = v && typeof v === "object" && "hooks" in v ? v.hooks : v;
  const out: Hook[] = [];
  const push = (event: string | null, h: any) => {
    if (!h || typeof h !== "object") return;
    const command = typeof h.command === "string" && h.command.trim() ? h.command : null;
    const ev = event ?? (typeof h.event === "string" ? h.event : null);
    if (!command || !ev) return;
    out.push({
      event: ev,
      matcher: typeof h.matcher === "string" && h.matcher ? h.matcher : null,
      command,
      timeout: typeof h.timeout === "number" ? h.timeout : null,
    });
  };
  if (Array.isArray(root)) root.forEach((h) => push(null, h));
  else if (root && typeof root === "object") {
    for (const [event, list] of Object.entries(root)) if (Array.isArray(list)) list.forEach((h) => push(event, h));
  }
  return out;
}

export function hooksFor(c: Customizations, event: string, tool: string): Hook[] {
  return c.hooks.filter((h) => {
    if (h.event.toLowerCase() !== event.toLowerCase()) return false;
    if (!h.matcher || h.matcher === "*") return true;
    try {
      return new RegExp(`^(?:${h.matcher})$`).test(tool);
    } catch {
      return false;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

async function readOpt(host: ToolHost, p: string): Promise<string | null> {
  try {
    if (!(await host.exists(p))) return null;
    return await host.readFile(p);
  } catch {
    return null;
  }
}

function clip(s: string): string {
  return s.length > MAX_INSTRUCTION_BYTES ? s.slice(0, MAX_INSTRUCTION_BYTES) + "\n... [truncated]" : s;
}

async function mdFiles(host: ToolHost, dir: string): Promise<[string, string][]> {
  try {
    if (!(await host.exists(dir))) return [];
    const entries = await host.listDir(dir);
    return entries
      .filter((e) => !e.isDir && e.name.toLowerCase().endsWith(".md"))
      .map((e) => [e.name, join(dir, e.name)] as [string, string])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  } catch {
    return [];
  }
}

async function loadSkillsFrom(host: ToolHost, root: string, source: "workspace" | "user", out: Skill[]) {
  let entries;
  try {
    if (!(await host.exists(root))) return;
    entries = await host.listDir(root);
  } catch {
    return;
  }
  for (const e of entries.filter((e) => e.isDir).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = join(root, e.name);
    const text = await readOpt(host, join(dir, "SKILL.md"));
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);
    const name = fmStr(data, "name") ?? e.name;
    if (out.some((s) => s.name === name)) continue; // workspace skills shadow user skills
    const description =
      fmStr(data, "description") ??
      (body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#")) ?? "").trim();
    out.push({ name, description, source, dir });
  }
}

export async function loadCustomizations(host: ToolHost): Promise<Customizations> {
  const c = emptyCustomizations();
  const ws = host.root;
  for (const f of ROOT_INSTRUCTION_FILES) {
    const text = await readOpt(host, join(ws, f));
    if (text != null) {
      const { data, body } = parseFrontmatter(text);
      c.instructions.push({ path: f, applyTo: fmStr(data, "applyTo"), body: clip(body) });
    }
  }
  const cep = join(ws, ".cepheus");
  for (const [name, path] of await mdFiles(host, join(cep, "instructions"))) {
    const text = await readOpt(host, path);
    if (text != null) {
      const { data, body } = parseFrontmatter(text);
      c.instructions.push({ path: `.cepheus/instructions/${name}`, applyTo: fmStr(data, "applyTo"), body: clip(body) });
    }
  }
  await loadSkillsFrom(host, join(cep, "skills"), "workspace", c.skills);
  if (host.userSkillsDir) await loadSkillsFrom(host, host.userSkillsDir, "user", c.skills);
  for (const [name, path] of await mdFiles(host, join(cep, "agents"))) {
    const text = await readOpt(host, path);
    if (text == null) continue;
    const { data, body } = parseFrontmatter(text);
    const stem = name.replace(/\.md$/i, "").replace(/\.agent$/i, "");
    const tools = fmList(data, "tools");
    c.agents.push({
      name: fmStr(data, "name") ?? stem,
      description: fmStr(data, "description") ?? "",
      tools: tools && tools.length ? tools : null,
      model: fmStr(data, "model"),
      path: `.cepheus/agents/${name}`,
      body: clip(body),
    });
  }
  const hooks = await readOpt(host, join(cep, "hooks.json"));
  if (hooks != null) c.hooks = parseHooks(hooks);
  return c;
}

/** Instructions that apply given the files currently involved (touched by the agent). */
export function applicableInstructions(c: Customizations, involved: string[], caseInsensitive = false): Instruction[] {
  return c.instructions.filter((i) => {
    const g = (i.applyTo ?? "").trim();
    if (!g || g === "**" || g === "**/*" || g === "*") return true;
    return involved.some((p) => globMatch(g, p, caseInsensitive));
  });
}

/** Whether an agent's `tools:` allowlist permits `name` (entries may end with `*`). */
export function toolAllowed(allow: string[] | null, name: string): boolean {
  if (!allow) return true;
  if (name === "update_plan") return true;
  return allow.some((t) => (t.endsWith("*") ? name.startsWith(t.slice(0, -1)) : t === name));
}

async function listSkillFiles(host: ToolHost, root: string): Promise<string[]> {
  const out: string[] = [];
  const queue: [string, string, number][] = [[root, "", 0]];
  while (queue.length) {
    const [dir, prefix, depth] = queue.pop()!;
    let entries;
    try {
      entries = await host.listDir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDir) {
        if (depth < 3 && e.name !== "node_modules" && !e.name.startsWith(".")) queue.push([join(dir, e.name), rel, depth + 1]);
      } else if (rel !== "SKILL.md" && out.length < 200) out.push(rel);
    }
  }
  return out.sort();
}

/** Implements the `load_skill` tool. */
export async function loadSkill(host: ToolHost, skills: Skill[], args: any): Promise<string> {
  const name = typeof args?.name === "string" ? args.name : null;
  if (!name) throw new Error("Missing required string argument 'name'");
  const skill = skills.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!skill) throw new Error(`Unknown skill '${name}'. Available: ${skills.map((s) => s.name).join(", ")}`);
  const text = await host.readFile(join(skill.dir, "SKILL.md"));
  const { body } = parseFrontmatter(text);
  const files = await listSkillFiles(host, skill.dir);
  let out = `# Skill: ${skill.name}\nFolder: ${skill.dir}\n\n${body.trim()}`;
  if (files.length) out += "\n\n## Files in this skill\n" + files.map((f) => `- ${f}\n`).join("");
  return truncate(out);
}
