/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0), mirroring
 * src-tauri/src/agent/mcp.rs. Servers come from `<workspace>/.cepheus/mcp.json`
 * (`{"servers": {name: {command, args, env}}}` or `{"mcpServers": ...}`); tools are exposed as
 * `mcp__<server>__<tool>`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { McpProvider, ToolDef } from "../core/types.js";
import { killTree } from "./host.js";

const PROTOCOL_VERSION = "2025-06-18";
const INIT_TIMEOUT = 30_000;
const CALL_TIMEOUT = 300_000;

export interface McpServerStatus {
  name: string;
  status: "running" | "error" | "skipped";
  error?: string;
  tools: string[];
}

function sanitize(s: string) {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function exposedName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

function cleanSchema(s: any): any {
  const o = s && typeof s === "object" && !Array.isArray(s) ? { ...s } : { type: "object" };
  delete o.$schema;
  o.type ??= "object";
  if (o.type === "object") o.properties ??= {};
  return o;
}

function winQuote(s: string) {
  return s && !/[\s"&|<>^()]/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

export class StdioMcpClient {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  stderrTail = "";
  alive = true;

  constructor(config: { command: string; args?: string[]; env?: Record<string, string> }, cwd?: string) {
    const args = (config.args ?? []).map(String);
    const env = { ...process.env, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, String(v)])) };
    if (process.platform === "win32") {
      // `.cmd` shims (npx, uvx, ...) need cmd.exe; it also finds plain executables on PATH.
      const line = [config.command, ...args].map(winQuote).join(" ");
      this.child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: true });
    } else {
      this.child = spawn(config.command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    }
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.onData(d));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    this.child.stdin!.on("error", () => {});
    const fail = (why: string) => {
      this.alive = false;
      for (const p of this.pending.values()) p.reject(new Error(why + (this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : "")));
      this.pending.clear();
    };
    this.child.on("error", (e) => fail(`MCP server failed to start: ${e.message}`));
    this.child.on("exit", (code) => fail(`MCP server exited (code ${code})`));
  }

  private onData(d: string) {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      this.handle(m);
    }
  }

  private handle(m: any) {
    if (typeof m?.method === "string") {
      // Server → client requests get a minimal reply so servers don't stall.
      if (m.id !== undefined) {
        const result = m.method === "roots/list" ? { roots: [] } : {};
        if (m.method === "ping" || m.method === "roots/list") this.write({ jsonrpc: "2.0", id: m.id, result });
        else this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not supported" } });
      }
      return;
    }
    const p = this.pending.get(m?.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(new Error(`MCP error ${m.error.code ?? ""}: ${m.error.message ?? JSON.stringify(m.error)}`));
    else p.resolve(m.result ?? {});
  }

  private write(msg: any) {
    this.child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params: any, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (!this.alive) return Promise.reject(new Error("MCP server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(t);
        this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } });
        reject(new Error("Cancelled by the user."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize() {
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cepheus-cli", version: "0.1.0" } },
      INIT_TIMEOUT,
    );
    this.write({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async listTools(): Promise<{ name: string; description: string; inputSchema: any }[]> {
    const out: { name: string; description: string; inputSchema: any }[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await this.request("tools/list", cursor ? { cursor } : {}, INIT_TIMEOUT);
      for (const t of r?.tools ?? []) {
        if (typeof t?.name !== "string") continue;
        out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } });
      }
      cursor = typeof r?.nextCursor === "string" ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: any, signal?: AbortSignal): Promise<{ output: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args && typeof args === "object" ? args : {} }, CALL_TIMEOUT, signal);
    const parts: string[] = [];
    for (const c of r?.content ?? []) {
      if (c?.type === "text") parts.push(c.text ?? "");
      else if (c?.type === "resource") parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
      else if (c?.type === "resource_link") parts.push(`[resource ${c.uri ?? ""}]`);
      else if (c?.type) parts.push(`[${c.type} content: ${c.mimeType ?? "binary"}]`);
    }
    if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
    return { output: parts.length ? parts.join("\n") : "(no output)", isError: r?.isError === true };
  }

  close() {
    this.alive = false;
    killTree(this.child.pid);
  }
}

export function serversOf(v: any): [string, any][] {
  const obj = v?.servers ?? v?.mcpServers ?? v;
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).filter(([, c]: [string, any]) => c && typeof c === "object" && !c.disabled) as [string, any][];
}

/** Starts the workspace's MCP servers lazily and exposes their tools to the agent. */
export class McpManager implements McpProvider {
  private servers = new Map<string, { client?: StdioMcpClient; tools: { name: string; description: string; inputSchema: any }[]; status: McpServerStatus }>();
  private started: Promise<void> | null = null;

  constructor(
    private root: string,
    private onWarning: (msg: string) => void = () => {},
  ) {}

  private start(): Promise<void> {
    this.started ??= (async () => {
      const file = path.join(this.root, ".cepheus", "mcp.json");
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        return;
      }
      let cfg: any;
      try {
        cfg = JSON.parse(text);
      } catch (e: any) {
        this.onWarning(`.cepheus/mcp.json: ${e.message}`);
        return;
      }
      await Promise.all(
        serversOf(cfg).map(async ([name, c]) => {
          const status: McpServerStatus = { name, status: "error", tools: [] };
          if (typeof c.command !== "string" || !c.command.trim()) {
            status.status = "skipped";
            status.error = c.url ? "HTTP MCP servers are not supported by the CLI yet (use the desktop app)." : "Server config needs `command`.";
            this.servers.set(name, { tools: [], status });
            this.onWarning(`MCP server '${name}': ${status.error}`);
            return;
          }
          const client = new StdioMcpClient(c, this.root);
          try {
            await client.initialize();
            const tools = await client.listTools();
            status.status = "running";
            status.tools = tools.map((t) => t.name);
            this.servers.set(name, { client, tools, status });
          } catch (e: any) {
            client.close();
            status.error = String(e?.message ?? e);
            this.servers.set(name, { tools: [], status });
            this.onWarning(`MCP server '${name}' failed: ${status.error}`);
          }
        }),
      );
    })();
    return this.started;
  }

  async status(): Promise<McpServerStatus[]> {
    await this.start();
    return [...this.servers.values()].map((s) => s.status);
  }

  async toolDefs(): Promise<ToolDef[]> {
    await this.start();
    const out: ToolDef[] = [];
    for (const [server, e] of this.servers) {
      if (e.status.status !== "running" || !e.client?.alive) continue;
      for (const t of e.tools)
        out.push({ name: exposedName(server, t.name), description: `[MCP server '${server}'] ${t.description}`, schema: cleanSchema(t.inputSchema) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async call(name: string, args: any, signal?: AbortSignal) {
    await this.start();
    for (const [server, e] of this.servers) {
      const t = e.tools.find((t) => exposedName(server, t.name) === name);
      if (t && e.client) return e.client.callTool(t.name, args, signal);
    }
    return { output: `MCP tool '${name}' is not available (server stopped?)`, isError: true };
  }

  close() {
    for (const e of this.servers.values()) e.client?.close();
    this.servers.clear();
    this.started = null;
  }
}
