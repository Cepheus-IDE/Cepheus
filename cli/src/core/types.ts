/**
 * Shared types for the environment-agnostic agent core.
 *
 * Nothing in `src/core/**` may import `node:*` modules: every side effect (files, processes,
 * MCP servers) goes through the injected {@link ToolHost} / {@link McpProvider}, so the same core
 * runs in Node (src/node) and in the browser (src/web).
 */

// ---------------------------------------------------------------------------------------------
// Events (same shape as the desktop app's `agent-event`, see src-tauri/src/agent/mod.rs)
// ---------------------------------------------------------------------------------------------

export type AgentStatus = "running" | "waiting" | "idle" | "stopped" | "error";

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "done" | string;
}

export type AgentEvent =
  | { type: "status"; sessionId: string; status: AgentStatus }
  | { type: "text"; sessionId: string; text: string }
  /** Streaming chunk of assistant text. A full `text` event for the same text always follows. */
  | { type: "textDelta"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "toolCall"; sessionId: string; callId: string; name: string; args: any }
  | { type: "toolResult"; sessionId: string; callId: string; name: string; output: string; isError: boolean }
  | { type: "approvalRequest"; sessionId: string; approvalId: string; callId: string; name: string; args: any }
  | { type: "plan"; sessionId: string; items: PlanItem[] }
  /** `path` is absolute (as in the app); `relPath` is workspace-relative with `/` separators. */
  | { type: "fileChanged"; sessionId: string; path: string; relPath: string; before: string | null; after: string }
  | { type: "warning"; sessionId: string; message: string }
  | { type: "error"; sessionId: string; message: string }
  | { type: "usage"; sessionId: string; inputTokens: number; outputTokens: number; model?: string; provider?: string }
  | { type: "steered"; sessionId: string; text: string }
  | {
      type: "context";
      sessionId: string;
      instructions: string[];
      skills: string[];
      agent: string | null;
      mcpTools: number;
      planMode: boolean;
    }
  | { type: "debug"; sessionId: string; entry: Record<string, any> };

export type AgentEventType = AgentEvent["type"];

// ---------------------------------------------------------------------------------------------
// Host (side effects)
// ---------------------------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  isDir: boolean;
}

export interface SearchMatch {
  /** Workspace-relative path with `/` separators. */
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  query: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface RunOptions {
  /** Absolute working directory (defaults to the workspace root). */
  cwd?: string;
  timeoutMs?: number;
  /** Written to the process' stdin (hooks receive the tool call as JSON). */
  input?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/**
 * All side effects of the agent. Paths are absolute and use `/` separators
 * (on Windows: `C:/Users/me/project/src/a.ts`). The core confines model-supplied paths to
 * `root` before calling the host, so hosts may trust the paths they receive.
 */
export interface ToolHost {
  /** Absolute workspace root with `/` separators and no trailing slash. */
  readonly root: string;
  /** Compare paths case-insensitively (Windows, macOS default volumes). */
  readonly caseInsensitive?: boolean;
  /** Shown in the system prompt, e.g. "Windows (commands run in PowerShell)". */
  readonly osLabel?: string;
  /** Absolute folder with user-level skills (`~/.cepheus/skills`), if any. */
  readonly userSkillsDir?: string;

  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<DirEntry[]>;
  /** Workspace-relative paths (`/` separators) of the files in the workspace, ignoring VCS/ignored folders. */
  findFiles(limit?: number): Promise<string[]>;
  search(opts: SearchOptions): Promise<SearchMatch[]>;
  /** Runs a shell command line (PowerShell on Windows, sh elsewhere). */
  runCommand(command: string, opts?: RunOptions): Promise<RunResult>;
  /** Optional: deletes a file (used to undo the creation of new files). */
  removeFile?(path: string): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Tools and providers
// ---------------------------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, any>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
}

export interface ToolOutcome {
  call: ToolCall;
  output: string;
  isError: boolean;
}

/** MCP tools, supplied by the host (stdio servers need processes). */
export interface McpProvider {
  toolDefs(): Promise<ToolDef[]>;
  call(name: string, args: any, signal?: AbortSignal): Promise<{ output: string; isError: boolean }>;
}

export type ProviderKind = "nvidia" | "anthropic" | "gemini" | "openai";

export interface ProviderConfig {
  /** Wire protocol: "nvidia" | "anthropic" | "gemini" | "openai" (OpenAI-compatible). */
  provider: ProviderKind;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Reasoning effort: low | medium | high | xhigh | max. */
  effort?: string;
  /** Display name for messages, e.g. "Ollama". */
  label?: string;
  /** Preset id this config came from ("ollama", "openrouter", ...), used for availability keys. */
  source?: string;
  /**
   * Auto fallback: further candidates tried in order on 429 / 5xx / timeouts / model-not-found.
   * Only candidates with the same message format as `provider` are used.
   */
  fallbacks?: ProviderConfig[];
  /** Stream text (OpenAI-compatible providers). Default true. */
  stream?: boolean;
}

export interface Turn {
  texts: string[];
  thinking: string[];
  calls: ToolCall[];
  warning?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  provider: string;
  model: string;
  /** Fallback notices ("X failed, switched to Y"). */
  notices: string[];
  /** True when text was already delivered through `onTextDelta`. */
  streamed?: boolean;
}

export type ApprovalMode = "ask" | "auto-edit" | "turbo";

export interface ApprovalRequest {
  approvalId: string;
  callId: string;
  name: string;
  args: any;
}
