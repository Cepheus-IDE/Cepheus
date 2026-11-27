// Agent skills: list/enable/duplicate/delete installed skills, the bundled gallery, the skill
// creator, .cepheus-skill import/export and "run skill" prefills. No backend changes: skills are
// plain folders the agent backend (src-tauri/src/agent/customize.rs) already loads from
//   <workspace>/.cepheus/skills/<name>/SKILL.md   (Project scope)
//   <app data dir>/skills/<name>/SKILL.md         (User scope)
// Disabled skills move to a `.disabled` folder inside the same root: the backend only reads
// `<root>/<child>/SKILL.md`, and `.disabled` itself has no SKILL.md, so they are ignored.
import { create } from "zustand";
import { api, errMsg } from "./api";
import { get, set, toast, AgentSession } from "../store";
import { join, basename } from "./paths";
import { refreshCustomizations } from "./agentPlatform";
import { providerConfig } from "./settings";
import {
  checkSkillText, compareVersions, draftSkillFromItems, fmString, makeBundle, parseBundle, parseFrontmatter,
  safeRelPath, serializeSkill, setFrontmatter, transcriptOf, Frontmatter,
} from "./skillFormat";

export type SkillScope = "project" | "user";
export const SCOPE_LABEL: Record<SkillScope, string> = { project: "Project", user: "User" };

export interface InstalledSkill {
  name: string;
  description: string;
  version: string;
  scope: SkillScope;
  /** Absolute skill folder. */
  dir: string;
  folder: string;
  enabled: boolean;
  files: number;
}

export interface BundledSkill { name: string; description: string; version: string; category: string; text: string }

const DISABLED = ".disabled";

// ---------------------------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------------------------

let userRootCache: string | null = null;
/** `<app data dir>/skills` — the same folder the backend reads (`app_data_dir`, not the config dir). */
export async function userSkillsRoot(): Promise<string> {
  if (!userRootCache) {
    const { appDataDir } = await import("@tauri-apps/api/path");
    userRootCache = join(await appDataDir(), "skills");
  }
  return userRootCache;
}

export function projectSkillsRoot(ws: string | null = get().workspace): string | null {
  return ws ? join(join(ws, ".cepheus"), "skills") : null;
}

export async function scopeRoot(scope: SkillScope): Promise<string> {
  if (scope === "user") return userSkillsRoot();
  const r = projectSkillsRoot();
  if (!r) throw new Error("Open a folder to use Project skills.");
  return r;
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/** Text files of a folder as relative `/` paths → absolute paths (depth-limited, capped). */
async function walk(dir: string, prefix = "", depth = 0, out: [string, string][] = []): Promise<[string, string][]> {
  let entries;
  try { entries = await api.readDir(dir); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDir) {
      if (depth < 4 && e.name !== "node_modules" && !e.name.startsWith(".")) await walk(e.path, rel, depth + 1, out);
    } else if (out.length < 300) {
      out.push([rel, e.path]);
    }
  }
  return out;
}

async function scanRoot(root: string, scope: SkillScope, enabled: boolean): Promise<InstalledSkill[]> {
  let entries;
  try { entries = await api.readDir(root); } catch { return []; }
  const dirs = entries.filter((e) => e.isDir && !e.name.startsWith("."));
  const found = await Promise.all(dirs.map(async (e): Promise<InstalledSkill | null> => {
    let text: string;
    try { text = await api.readFile(join(e.path, "SKILL.md")); } catch { return null; }
    const { data, body } = parseFrontmatter(text);
    const files = (await walk(e.path)).length;
    return {
      name: fmString(data, "name") || e.name,
      description: fmString(data, "description") || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"))?.trim() || "",
      version: fmString(data, "version"),
      scope, dir: e.path, folder: e.name, enabled, files,
    };
  }));
  return found.filter((s): s is InstalledSkill => !!s);
}

export async function listInstalled(): Promise<InstalledSkill[]> {
  const roots: [string, SkillScope][] = [];
  const pr = projectSkillsRoot();
  if (pr) roots.push([pr, "project"]);
  try { roots.push([await userSkillsRoot(), "user"]); } catch { /* not in Tauri */ }
  const lists = await Promise.all(roots.flatMap(([r, scope]) => [scanRoot(r, scope, true), scanRoot(join(r, DISABLED), scope, false)]));
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}

export const useSkills = create<{ installed: InstalledSkill[]; loading: boolean; loaded: boolean }>(() => ({ installed: [], loading: false, loaded: false }));

export async function reloadSkills() {
  useSkills.setState({ loading: true });
  try {
    useSkills.setState({ installed: await listInstalled(), loaded: true });
  } catch (e) {
    toast(errMsg(e), "error");
  } finally {
    useSkills.setState({ loading: false });
  }
  refreshCustomizations(true); // composer pickers and context chips
}

// ---------------------------------------------------------------------------------------------
// Gallery (bundled Markdown, src/skills/*.md)
// ---------------------------------------------------------------------------------------------

const RAW = import.meta.glob("../skills/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const GALLERY: BundledSkill[] = Object.values(RAW)
  .map((text) => {
    const { data } = parseFrontmatter(text);
    return {
      name: fmString(data, "name"),
      description: fmString(data, "description"),
      version: fmString(data, "version") || "1.0.0",
      category: fmString(data, "category") || "Other",
      text,
    };
  })
  .filter((s) => s.name)
  .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

/** Installed copies of a gallery skill (any scope, enabled or not). */
export function installedCopies(name: string, installed = useSkills.getState().installed) {
  return installed.filter((s) => s.name === name);
}

export function needsUpdate(b: BundledSkill, s: InstalledSkill) {
  return compareVersions(s.version || "0", b.version) < 0;
}

/** Installs (or, when present, updates SKILL.md of) a gallery skill. Other files are kept. */
export async function installBundled(b: BundledSkill, scope: SkillScope) {
  try {
    const existing = installedCopies(b.name).find((s) => s.scope === scope);
    const dir = existing?.dir ?? join(await scopeRoot(scope), b.name);
    await api.writeFile(join(dir, "SKILL.md"), b.text);
    toast(`${existing ? "Updated" : "Installed"} skill "${b.name}" (${SCOPE_LABEL[scope]})`);
    await reloadSkills();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------------------------------------------------------------------------------------------
// Installed-skill actions
// ---------------------------------------------------------------------------------------------

export async function setEnabled(s: InstalledSkill, enabled: boolean) {
  try {
    const root = await scopeRoot(s.scope);
    const target = enabled ? join(root, s.folder) : join(join(root, DISABLED), s.folder);
    if (!enabled) await api.createDir(join(root, DISABLED));
    else if (await api.exists(target)) throw new Error(`An enabled skill folder "${s.folder}" already exists.`);
    await api.rename(s.dir, target);
    await reloadSkills();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function deleteSkill(s: InstalledSkill) {
  try {
    await api.remove(s.dir); // local: Recycle Bin / Trash
    toast(`Deleted skill "${s.name}"`);
    await reloadSkills();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

/** Reads every text file of a skill folder (binary files are skipped and counted). */
export async function readSkillFiles(dir: string): Promise<{ files: Record<string, string>; skipped: string[] }> {
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [rel, abs] of await walk(dir)) {
    try { files[rel] = await api.readFile(abs); } catch { skipped.push(rel); }
  }
  return { files, skipped };
}

async function writeSkillFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const safe = safeRelPath(rel);
    if (!safe) throw new Error(`Unsafe path: ${rel}`);
    await api.writeFile(safe.split("/").reduce((p, part) => join(p, part), dir), content);
  }
}

function freeName(base: string, taken: string[]) {
  for (let i = 1; ; i++) {
    const n = i === 1 ? `${base}-copy` : `${base}-copy-${i}`;
    if (!taken.includes(n)) return n.slice(0, 64);
  }
}

export async function duplicateSkill(s: InstalledSkill) {
  try {
    const root = await scopeRoot(s.scope);
    const taken = useSkills.getState().installed.filter((x) => x.scope === s.scope).flatMap((x) => [x.name, x.folder]);
    const name = freeName(s.name, taken);
    const { files, skipped } = await readSkillFiles(s.dir);
    files["SKILL.md"] = setFrontmatter(files["SKILL.md"] ?? "", { name });
    await writeSkillFiles(join(root, name), files);
    toast(`Created "${name}"${skipped.length ? ` (skipped ${skipped.length} binary file${skipped.length > 1 ? "s" : ""})` : ""}`);
    await reloadSkills();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function revealSkill(s: InstalledSkill) {
  if (s.dir.startsWith("ssh://")) return toast("Reveal is only available for local folders.", "error");
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(join(s.dir, "SKILL.md"));
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  /** Extra files (templates, scripts) relative to the skill folder. */
  extras: { path: string; content: string }[];
}

export function namesInScope(scope: SkillScope): string[] {
  return useSkills.getState().installed.filter((s) => s.scope === scope).flatMap((s) => [s.name, s.folder]);
}

export async function createSkill(d: SkillDraft, scope: SkillScope): Promise<string> {
  const dir = join(await scopeRoot(scope), d.name);
  if (await api.exists(dir)) throw new Error(`Folder ${d.name} already exists.`);
  const fm: Frontmatter = { name: d.name, description: d.description.trim(), version: "1.0.0" };
  const files: Record<string, string> = { "SKILL.md": serializeSkill(fm, d.body) };
  for (const x of d.extras) {
    const rel = safeRelPath(x.path.trim());
    if (!rel || rel === "SKILL.md") throw new Error(`Invalid extra file path: "${x.path}"`);
    files[rel] = x.content;
  }
  await writeSkillFiles(dir, files);
  await reloadSkills();
  return join(dir, "SKILL.md");
}

// ---------------------------------------------------------------------------------------------
// Import / export (.cepheus-skill JSON bundles)
// ---------------------------------------------------------------------------------------------

export async function exportSkill(s: InstalledSkill) {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: `${s.name}.cepheus-skill`, filters: [{ name: "Cepheus skill", extensions: ["cepheus-skill"] }] });
    if (!path) return;
    const { files, skipped } = await readSkillFiles(s.dir);
    await api.writeFile(path, JSON.stringify(makeBundle(s.name, files), null, 2));
    toast(`Exported "${s.name}" to ${basename(path)}${skipped.length ? ` (${skipped.length} binary file${skipped.length > 1 ? "s" : ""} not included)` : ""}`);
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

export async function importSkill(scope: SkillScope) {
  try {
    const { open, ask } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, filters: [{ name: "Cepheus skill", extensions: ["cepheus-skill", "json"] }] });
    if (!path || Array.isArray(path)) return;
    const bundle = parseBundle(await api.readFile(path));
    const name = bundle.skillName;
    const dir = join(await scopeRoot(scope), name);
    if (await api.exists(dir)) {
      const ok = await ask(`A ${SCOPE_LABEL[scope]} skill folder "${name}" already exists. Replace it? The old folder goes to the trash.`, { title: "Import skill", kind: "warning" });
      if (!ok) return;
      await api.remove(dir);
    }
    await writeSkillFiles(dir, bundle.files);
    toast(`Imported skill "${name}" (${SCOPE_LABEL[scope]})`);
    await reloadSkills();
  } catch (e) {
    toast(errMsg(e), "error");
  }
}

// ---------------------------------------------------------------------------------------------
// UI state shared by the sidebar view, the modals (mounted in App) and commands
// ---------------------------------------------------------------------------------------------

export interface EditorState { draft: SkillDraft; scope: SkillScope; fromSession?: string }

export const useSkillsUI = create<{
  tab: "installed" | "gallery";
  editor: EditorState | null;
  preview: BundledSkill | null;
  runPicker: boolean;
}>(() => ({ tab: "installed", editor: null, preview: null, runPicker: false }));

export function showSkills(tab: "installed" | "gallery" = "installed") {
  set({ sidebar: "skills", view: "editor" });
  useSkillsUI.setState({ tab });
}

const BLANK_BODY = `# Title

Explain what this skill does and when the agent should use it.

## Steps

1. First step (name the exact files, tools and commands).
2. Second step.

## Done when

- [ ] A verifiable completion criterion.
`;

export function newSkill(scope: SkillScope = get().workspace ? "project" : "user") {
  useSkillsUI.setState({ editor: { scope, draft: { name: "", description: "", body: BLANK_BODY, extras: [] } } });
}

export function activeSession(): AgentSession | undefined {
  const st = get();
  return st.sessions.find((s) => s.id === st.activeSessionId) ?? st.sessions[0];
}

/** Opens the creator prefilled from an agent session's steps. */
export function skillFromSession(session = activeSession()) {
  if (!session || !session.items.some((i) => i.kind === "user")) return toast("Open an agent task with at least one message first.", "error");
  const d = draftSkillFromItems(session.title, session.items as any);
  useSkillsUI.setState({
    editor: { scope: get().workspace ? "project" : "user", fromSession: session.id, draft: { ...d, extras: [] } },
  });
}

/** Asks the configured model to rewrite a session into a general SKILL.md body. */
export async function improveDraftWithAI(sessionId: string, d: SkillDraft): Promise<SkillDraft> {
  const session = get().sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error("The agent task is no longer available.");
  const system =
    "You turn a finished coding-agent conversation into a reusable skill for future agent runs. " +
    "Write general, step-by-step instructions (not a log of this one run): when to use it, numbered steps naming tools and exact commands, " +
    "pitfalls, and a '## Done when' checklist with '- [ ]' items. Output ONLY a SKILL.md file: a frontmatter block with " +
    "name (kebab-case) and description (one sentence saying when to use it), then the Markdown body.";
  const prompt = `Current draft:\n\n${serializeSkill({ name: d.name, description: d.description }, d.body)}\n\nTranscript:\n${transcriptOf(session.items as any)}`;
  let out = await api.aiOneshot(providerConfig(get().settings), system, prompt, 4000);
  out = out.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, "$1");
  const { data, body, hasFrontmatter } = parseFrontmatter(out);
  if (!hasFrontmatter || !body.trim()) return { ...d, body: out + "\n" };
  return { ...d, name: fmString(data, "name") || d.name, description: fmString(data, "description") || d.description, body };
}

// ---------------------------------------------------------------------------------------------
// Running skills from the chat
// ---------------------------------------------------------------------------------------------

export const skillPrefix = (name: string) => `Use the ${name} skill: `;

/** Inserts/replaces the "Use the X skill: " prefix of a prompt. */
export function withSkillPrefix(text: string, name: string) {
  return skillPrefix(name) + text.replace(/^Use the \S+ skill: /, "");
}

/** Prefills consumed once by the composer quick-pick of a freshly opened session. */
const prefills = new Map<string, string>();
export function takeSkillPrefill(sessionId: string) {
  const p = prefills.get(sessionId);
  prefills.delete(sessionId);
  return p;
}

export async function runSkill(name: string) {
  const { newSession } = await import("./agent");
  const s = newSession();
  prefills.set(s.id, skillPrefix(name));
  set({ agentOpen: true, view: "editor" });
}

/** Validates every bundled skill (used by the gallery for a dev-time warning). */
export function galleryProblems(): string[] {
  return GALLERY.flatMap((b) => checkSkillText(b.text).map((e) => `${b.name}: ${e}`));
}
