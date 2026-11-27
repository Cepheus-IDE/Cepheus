// Pure SKILL.md helpers (no app imports, so a plain Node script can test them).
// The frontmatter reader mirrors src-tauri/src/agent/customize.rs `parse_frontmatter`, which is what
// the agent backend actually uses; the writer only emits what that parser reads back unchanged.

export type FmValue = string | string[] | null;
export type Frontmatter = Record<string, FmValue>;

function unquote(s: string): string {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) return s.slice(1, -1);
  return s;
}

/** Splits a `---` frontmatter block from the body (`key: value`, `key: [a, b]`, block lists). */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string; hasFrontmatter: boolean } {
  const t = text.replace(/^﻿/, "");
  const data: Frontmatter = {};
  const rest = t.startsWith("---\r\n") ? t.slice(5) : t.startsWith("---\n") ? t.slice(4) : null;
  if (rest === null) return { data, body: t, hasFrontmatter: false };
  // Find the closing `---` line.
  let offset = 0;
  let bodyStart = -1;
  for (const line of rest.split(/(?<=\n)/)) {
    if (line.trimEnd() === "---") {
      bodyStart = offset + line.length;
      break;
    }
    offset += line.length;
  }
  if (bodyStart < 0) return { data, body: t, hasFrontmatter: false };
  const head = rest.slice(0, offset);
  let lastKey: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!line.trim() || trimmed.startsWith("#")) continue;
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
    else if (v.startsWith("[") && v.endsWith("]")) data[k] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    else data[k] = unquote(v);
  }
  return { data, body: rest.slice(bodyStart), hasFrontmatter: true };
}

/** A frontmatter value as a single trimmed string ("" when missing). */
export function fmString(data: Frontmatter, key: string): string {
  const v = data[key];
  if (Array.isArray(v)) return v.join(",");
  return (v ?? "").trim();
}

function fmScalar(v: string): string {
  const s = v.replace(/\s*[\r\n]+\s*/g, " ").trim();
  // Quote values the backend parser would otherwise misread (leading quote/bracket) or trim.
  return !s || /^["'[]/.test(s) ? `"${s}"` : s;
}

/** Serializes frontmatter + body. Keys keep insertion order; null/empty values are dropped. */
export function serializeSkill(data: Frontmatter, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      const items = v.map((x) => x.replace(/[,\r\n\]]/g, " ").trim()).filter(Boolean);
      if (items.length) lines.push(`${k}: [${items.join(", ")}]`);
    } else if (v.trim()) {
      lines.push(`${k}: ${fmScalar(v)}`);
    }
  }
  lines.push("---");
  const b = body.replace(/^\s*\n/, "");
  return lines.join("\n") + "\n" + (b.endsWith("\n") ? b : b + "\n");
}

/** Updates (or inserts) frontmatter keys in an existing SKILL.md, keeping the body as is. */
export function setFrontmatter(text: string, patch: Frontmatter): string {
  const { data, body } = parseFrontmatter(text);
  return serializeSkill({ ...data, ...patch }, body);
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;

/** "Write Unit Tests!" -> "write-unit-tests". */
export function toKebab(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME)
    .replace(/-+$/, "");
}

/** Null when valid, else a message. `taken` = names already used in the target scope. */
export function validateName(name: string, taken: string[] = []): string | null {
  if (!name) return "Name is required.";
  if (name.length > MAX_NAME) return `Name must be at most ${MAX_NAME} characters.`;
  if (!NAME_RE.test(name)) return "Use lowercase letters, digits and single hyphens (kebab-case), e.g. write-unit-tests.";
  if (taken.some((t) => t.toLowerCase() === name)) return `A skill named "${name}" already exists in this scope.`;
  return null;
}

export function validateDescription(d: string): string | null {
  const t = d.trim();
  if (!t) return "Description is required: the agent uses it to decide when to load the skill.";
  if (t.length > 1024) return "Description must be at most 1024 characters.";
  return null;
}

/** Problems with a SKILL.md text (used for bundled skills and imports). Empty = valid. */
export function checkSkillText(text: string): string[] {
  const errs: string[] = [];
  const { data, body, hasFrontmatter } = parseFrontmatter(text);
  if (!hasFrontmatter) return ["Missing --- frontmatter block."];
  const nameErr = validateName(fmString(data, "name"));
  if (nameErr) errs.push(`name: ${nameErr}`);
  const descErr = validateDescription(fmString(data, "description"));
  if (descErr) errs.push(`description: ${descErr}`);
  const v = fmString(data, "version");
  if (v && !/^\d+(\.\d+){0,2}$/.test(v)) errs.push(`version: "${v}" is not like 1.2.3`);
  if (!body.trim()) errs.push("Body (instructions) is empty.");
  return errs;
}

/** Numeric dotted-version compare: <0 when a < b. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = (a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = (b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// .cepheus-skill bundles: { format, version, name, files: { "SKILL.md": "...", "dir/x.sh": "..." } }
// ---------------------------------------------------------------------------------------------

export const BUNDLE_FORMAT = "cepheus-skill";
export const BUNDLE_MAX_FILES = 200;
export const BUNDLE_MAX_BYTES = 5_000_000;

export interface SkillBundle { format: string; version: number; name: string; exportedAt?: string; files: Record<string, string> }

/** A relative path that cannot escape the skill folder, normalized to `/`; null when unsafe. */
export function safeRelPath(p: string): string | null {
  const n = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n.startsWith("/") || /^[a-zA-Z]:/.test(n) || n.includes("\0")) return null;
  const parts = n.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) return null;
  return n;
}

export function makeBundle(name: string, files: Record<string, string>): SkillBundle {
  return { format: BUNDLE_FORMAT, version: 1, name, exportedAt: new Date().toISOString(), files };
}

/** Parses and validates a bundle; throws a readable Error. */
export function parseBundle(json: string): SkillBundle & { skillName: string } {
  let b: any;
  try {
    b = JSON.parse(json);
  } catch {
    throw new Error("Not a valid .cepheus-skill file (invalid JSON).");
  }
  if (!b || b.format !== BUNDLE_FORMAT || typeof b.files !== "object" || !b.files) throw new Error("Not a .cepheus-skill bundle.");
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const [k, v] of Object.entries(b.files)) {
    const rel = safeRelPath(k);
    if (!rel) throw new Error(`Unsafe path in bundle: ${k}`);
    if (typeof v !== "string") throw new Error(`File ${k} is not text.`);
    bytes += v.length;
    files[rel] = v;
  }
  const n = Object.keys(files).length;
  if (n > BUNDLE_MAX_FILES) throw new Error(`Bundle has too many files (${n}).`);
  if (bytes > BUNDLE_MAX_BYTES) throw new Error("Bundle is too large.");
  const skill = files["SKILL.md"];
  if (skill === undefined) throw new Error("Bundle has no SKILL.md.");
  const errs = checkSkillText(skill);
  if (errs.length) throw new Error(`Invalid SKILL.md: ${errs.join("; ")}`);
  const skillName = fmString(parseFrontmatter(skill).data, "name");
  return { ...b, files, skillName };
}

// ---------------------------------------------------------------------------------------------
// Draft a skill from an agent conversation
// ---------------------------------------------------------------------------------------------

/** Minimal shape of the store's ChatItem used here. */
export type DraftItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; args: any; status: string; isError?: boolean }
  | { kind: string; [k: string]: any };

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Turns a session's steps into an editable SKILL.md draft (heuristic, no model call). */
export function draftSkillFromItems(title: string, items: DraftItem[]): { name: string; description: string; body: string } {
  const users = items.filter((i): i is { kind: "user"; text: string } => i.kind === "user" && typeof (i as any).text === "string");
  const goal = oneLine(users[0]?.text ?? title);
  const name = toKebab(title && title !== "New task" ? title : goal.split(" ").slice(0, 6).join(" ")) || "new-skill";
  const description = clipText(`Use when asked to ${goal.charAt(0).toLowerCase()}${goal.slice(1)}`.replace(/[.\s]+$/, ""), 200) + ".";

  const steps: string[] = [];
  const commands: string[] = [];
  const touched: string[] = [];
  let reads: string[] = [];
  const flushReads = () => {
    if (reads.length) steps.push(`Inspect the relevant code: ${reads.map((r) => `\`${r}\``).join(", ")}.`);
    reads = [];
  };
  let userIdx = 0;
  for (const it of items) {
    if (it.kind === "user") {
      if (userIdx++ > 0) {
        flushReads();
        steps.push(`Follow-up requirement: ${clipText(oneLine((it as any).text), 200)}`);
      }
      continue;
    }
    if (it.kind !== "tool") continue;
    const t = it as { name: string; args: any; status: string; isError?: boolean };
    if (t.status === "rejected") continue;
    const a = t.args ?? {};
    switch (t.name) {
      case "read_file":
      case "list_dir":
        if (a.path && !reads.includes(a.path) && reads.length < 8) reads.push(String(a.path));
        break;
      case "search":
      case "find_files":
        flushReads();
        steps.push(`Search the codebase for \`${a.query ?? a.pattern ?? ""}\` to find the places involved.`);
        break;
      case "edit_file":
      case "write_file":
        flushReads();
        if (a.path && !touched.includes(a.path)) {
          touched.push(String(a.path));
          steps.push(`${t.name === "write_file" ? "Create or rewrite" : "Edit"} \`${a.path}\`.`);
        }
        break;
      case "run_command":
      case "run_check":
        flushReads();
        if (a.command && !t.isError && t.status !== "error" && !commands.includes(a.command)) {
          commands.push(String(a.command));
          steps.push(`Run \`${a.command}\` and check the output.`);
        }
        break;
    }
  }
  flushReads();
  // Collapse consecutive duplicate steps.
  const uniq = steps.filter((s, i) => s !== steps[i - 1]).slice(0, 30);
  const lastAnswer = [...items].reverse().find((i) => i.kind === "assistant") as { text: string } | undefined;

  const parts = [
    `# ${title && title !== "New task" ? title : clipText(goal, 60)}`,
    "",
    "Reusable procedure distilled from an agent task. Edit it into general instructions before saving.",
    "",
    "## When to use",
    "",
    clipText(goal, 600),
    "",
    "## Steps",
    "",
    ...(uniq.length ? uniq.map((s, i) => `${i + 1}. ${s}`) : ["1. Describe the first step."]),
  ];
  if (commands.length) parts.push("", "## Commands", "", "```sh", ...commands, "```");
  if (touched.length) parts.push("", "## Files typically involved", "", ...touched.map((p) => `- \`${p}\``));
  if (lastAnswer?.text) parts.push("", "## Notes from the original run", "", clipText(lastAnswer.text.trim(), 1200));
  parts.push(
    "",
    "## Done when",
    "",
    "- [ ] The goal above is met and verified.",
    ...(commands.length ? ["- [ ] The commands above succeed."] : []),
    "- [ ] Summary of changes reported to the user.",
  );
  return { name, description, body: parts.join("\n") + "\n" };
}

/** Compact transcript of a session for the "Improve with AI" prompt. */
export function transcriptOf(items: DraftItem[], max = 12000): string {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === "user") out.push(`USER: ${(it as any).text}`);
    else if (it.kind === "assistant") out.push(`ASSISTANT: ${clipText((it as any).text, 1500)}`);
    else if (it.kind === "tool") {
      const t = it as any;
      out.push(`TOOL ${t.name}(${clipText(JSON.stringify(t.args ?? {}), 300)}) -> ${t.status}${t.isError ? " (error)" : ""}`);
    }
  }
  const s = out.join("\n");
  return s.length > max ? s.slice(s.length - max) : s;
}
