/**
 * Agent tools (mirrors src-tauri/src/agent/tools.rs): same names, arguments, outputs and
 * workspace confinement. Side effects go through the {@link ToolHost}.
 */
import type { ApprovalMode, SearchMatch, SearchOptions, ToolDef, ToolHost } from "./types.js";
import { relative, resolveInWorkspace } from "./paths.js";

export const MAX_OUTPUT = 30_000;

export function definitions(): ToolDef[] {
  return [
    {
      name: "list_dir",
      description: "List files and folders in a directory of the workspace. Use '.' for the workspace root.",
      schema: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path, relative to the workspace root" } },
        required: ["path"],
      },
    },
    {
      name: "find_files",
      description: "Find files in the workspace whose relative path contains the given text (case-insensitive). Respects .gitignore.",
      schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Substring to match against relative file paths, e.g. 'src/components' or '.rs'" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the workspace. Output lines are prefixed with line numbers. For large files, pass start_line/end_line.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root" },
          start_line: { type: "integer", description: "1-based first line to read (optional)" },
          end_line: { type: "integer", description: "1-based last line to read, inclusive (optional)" },
        },
        required: ["path"],
      },
    },
    {
      name: "search",
      description: "Search file contents across the workspace (ripgrep-style). Returns matching lines as path:line: text.",
      schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regular expression to search for" },
          is_regex: { type: "boolean", description: "Treat query as a regular expression (default false)" },
          case_sensitive: { type: "boolean", description: "Match case (default false)" },
        },
        required: ["query"],
      },
    },
    {
      name: "write_file",
      description:
        "Create a new file or completely overwrite an existing file with the given content. Prefer edit_file for small changes to existing files.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root" },
          content: { type: "string", description: "Full new content of the file" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description:
        "Edit an existing file by replacing an exact snippet. old_str must appear exactly once in the file (include enough surrounding lines to make it unique). Whitespace and indentation must match exactly.",
      schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the workspace root" },
          old_str: { type: "string", description: "Exact existing text to replace" },
          new_str: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
    {
      name: "run_command",
      description:
        "Run a shell command in the workspace root and return its combined stdout/stderr and exit code. On Windows this runs in PowerShell; elsewhere in sh. Do not start long-running servers or interactive programs; they will be killed at the timeout.",
      schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to run" },
          timeout_secs: { type: "integer", description: "Timeout in seconds (default 120, max 600)" },
        },
        required: ["command"],
      },
    },
    {
      name: "update_plan",
      description:
        "Publish or update your task plan, shown to the user as a live checklist. Call it at the start of multi-step work and whenever a step changes status. Send the full list every time.",
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "The full ordered list of steps",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "Short description of the step" },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["items"],
      },
    },
  ];
}

export function loadSkillDef(): ToolDef {
  return {
    name: "load_skill",
    description:
      "Load a skill by name: returns its SKILL.md instructions and lists the other files in the skill folder (read workspace files with read_file). Load a skill before doing a task it covers.",
    schema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name, as listed in the system prompt" } },
      required: ["name"],
    },
  };
}

/**
 * Which tools require approval under each mode.
 * - "ask":       file writes and commands need approval
 * - "auto-edit": file writes are automatic, commands need approval
 * - "turbo":     everything runs automatically
 * MCP tools can do anything their server allows, so they are treated like commands.
 */
export function needsApproval(name: string, mode: ApprovalMode | string): boolean {
  const external = name.startsWith("mcp__");
  if (mode === "turbo") return false;
  if (mode === "auto-edit") return name === "run_command" || external;
  return name === "run_command" || name === "write_file" || name === "edit_file" || external;
}

/** Tools available in Plan mode: research only, nothing that changes the workspace. */
export function isReadOnly(name: string): boolean {
  return ["list_dir", "find_files", "read_file", "search", "update_plan", "load_skill"].includes(name);
}

export function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n... [output truncated]" : s;
}

function argStr(args: any, k: string): string {
  const v = args?.[k];
  if (typeof v !== "string") throw new Error(`Missing required string argument '${k}'`);
  return v;
}

function argInt(args: any, k: string): number | undefined {
  const v = args?.[k];
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  return undefined;
}

function countOccurrences(text: string, needle: string): number {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** The exact-match edit used by `edit_file` (CRLF tolerant). Throws the model-facing error. */
export function applyEdit(text: string, oldStr: string, newStr: string): string {
  if (oldStr === "") throw new Error("old_str must not be empty. Use write_file to create or overwrite a file.");
  const crlf = text.includes("\r\n");
  let o = oldStr;
  let n = newStr;
  if (crlf && !oldStr.includes("\r\n")) {
    o = oldStr.replace(/\n/g, "\r\n");
    n = newStr.replace(/\n/g, "\r\n");
  }
  const count = countOccurrences(text, o);
  if (count === 0) throw new Error("old_str was not found in the file. Re-read the file and copy the exact text.");
  if (count > 1) throw new Error(`old_str matches ${count} places; include more surrounding context to make it unique.`);
  const i = text.indexOf(o);
  // Manual splice: String.replace would interpret `$&` etc. in the replacement.
  return text.slice(0, i) + n + text.slice(i + o.length);
}

export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Result of a file-modifying tool: lets the UI show a diff / undo. */
export interface FileChange {
  path: string;
  relPath: string;
  before: string | null;
  after: string;
}

export interface ToolExecResult {
  output: string;
  change?: FileChange;
}

/** Runs a built-in tool. Errors are thrown as `Error` with a model-facing message. */
export async function executeTool(host: ToolHost, name: string, args: any, signal?: AbortSignal): Promise<ToolExecResult> {
  const ws = host.root;
  const ci = !!host.caseInsensitive;
  const resolve = (p: string) => resolveInWorkspace(ws, p, ci);
  const rel = (p: string) => relative(ws, p, ci);
  switch (name) {
    case "list_dir": {
      const dir = resolve(typeof args?.path === "string" ? args.path : ".");
      const entries = (await host.listDir(dir))
        .sort((a, b) => (a.isDir === b.isDir ? (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1) : a.isDir ? -1 : 1))
        .map((e) => (e.isDir ? `${e.name}/` : e.name));
      return { output: entries.length ? entries.join("\n") : "(empty directory)" };
    }
    case "find_files": {
      const pat = argStr(args, "pattern").toLowerCase().replace(/\\/g, "/");
      const files = await host.findFiles(200_000);
      const hits = files.filter((f) => f.toLowerCase().includes(pat)).slice(0, 300);
      return { output: hits.length ? hits.join("\n") : "No files matched." };
    }
    case "read_file": {
      const p = resolve(argStr(args, "path"));
      const text = await host.readFile(p);
      const lines = textLines(text);
      const total = lines.length;
      if (total === 0) return { output: "(empty file)" };
      const start = Math.max(1, argInt(args, "start_line") ?? 1);
      const end = Math.min(argInt(args, "end_line") ?? total, total, start + 1999);
      let out = "";
      for (let i = start - 1; i < end; i++) out += `${String(i + 1).padStart(5)}\t${lines[i]}\n`;
      if (end < total) out += `... [${total - end} more lines; total ${total}. Use start_line/end_line to read more]\n`;
      return { output: truncate(out) };
    }
    case "search": {
      const res = await host.search({
        query: argStr(args, "query"),
        isRegex: args?.is_regex === true,
        caseSensitive: args?.case_sensitive === true,
        maxResults: 200,
      });
      if (!res.length) return { output: "No matches." };
      return { output: truncate(res.map((m) => `${m.path}:${m.line}: ${m.text.trim()}`).join("\n")) };
    }
    case "write_file": {
      const p = resolve(argStr(args, "path"));
      const content = argStr(args, "content");
      let before: string | null = null;
      if (await host.exists(p)) {
        try {
          before = await host.readFile(p);
        } catch {
          before = null;
        }
      }
      await host.writeFile(p, content);
      const msg = `${before != null ? "Overwrote" : "Created"} ${rel(p)} (${textLines(content).length} lines)`;
      return { output: msg, change: { path: p, relPath: rel(p), before, after: content } };
    }
    case "edit_file": {
      const p = resolve(argStr(args, "path"));
      const oldStr = argStr(args, "old_str");
      const newStr = argStr(args, "new_str");
      const text = await host.readFile(p);
      const updated = applyEdit(text, oldStr, newStr);
      await host.writeFile(p, updated);
      return { output: `Edited ${rel(p)}`, change: { path: p, relPath: rel(p), before: text, after: updated } };
    }
    case "run_command": {
      const command = argStr(args, "command");
      const secs = Math.min(600, Math.max(1, argInt(args, "timeout_secs") ?? 120));
      const out = await host.runCommand(command, { cwd: ws, timeoutMs: secs * 1000, signal });
      let s = out.stdout;
      if (out.stderr.trim()) s += `\n[stderr]\n${out.stderr}`;
      if (out.timedOut) {
        throw new Error(truncate(`Command timed out after ${secs}s and was killed.\n${s}`));
      }
      return { output: truncate(`Exit code: ${out.code}\n${s.trim() ? s : "(no output)"}`) };
    }
    case "update_plan":
      return { output: "Plan updated." };
    default:
      throw new Error(`Unknown tool '${name}'`);
  }
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Generic content search built on `findFiles` + `readFile`, for hosts without a native search.
 * Skips binary-looking and very large files.
 */
export async function genericSearch(
  host: Pick<ToolHost, "root" | "findFiles" | "readFile">,
  opts: SearchOptions,
  joinPath: (root: string, rel: string) => string = (r, p) => `${r.replace(/\/$/, "")}/${p}`,
): Promise<SearchMatch[]> {
  const max = opts.maxResults ?? 200;
  let re: RegExp;
  try {
    re = new RegExp(opts.isRegex ? opts.query : escapeRegExp(opts.query), opts.caseSensitive ? "" : "i");
  } catch (e: any) {
    throw new Error(`Invalid regular expression: ${e?.message ?? e}`);
  }
  const out: SearchMatch[] = [];
  const files = await host.findFiles(50_000);
  for (const f of files) {
    if (out.length >= max) break;
    let text: string;
    try {
      text = await host.readFile(joinPath(host.root, f));
    } catch {
      continue;
    }
    if (text.length > 2_000_000 || text.includes("\u0000")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < max; i++) {
      if (re.test(lines[i])) out.push({ path: f, line: i + 1, text: lines[i].slice(0, 500) });
    }
  }
  return out;
}
