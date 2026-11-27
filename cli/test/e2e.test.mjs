// End-to-end: the real agent loop + NodeToolHost against a local fake OpenAI-compatible server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSession, runAgentTurn } from "../dist/core/agent.js";
import { NodeToolHost } from "../dist/node/host.js";
import { fakeOpenAI, tempDir } from "./_helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function workspace() {
  const t = tempDir();
  writeFileSync(path.join(t.dir, "a.txt"), "hello world\nsecond line\n");
  mkdirSync(path.join(t.dir, "src"));
  writeFileSync(path.join(t.dir, "src", "util.js"), "export const x = 1; // TODO\n");
  return t;
}

const SCRIPT = [
  { content: "I'll look at the file first.", tool_calls: [{ name: "read_file", args: { path: "a.txt" } }] },
  {
    tool_calls: [
      { name: "update_plan", args: { items: [{ text: "Edit a.txt", status: "in_progress" }, { text: "Verify", status: "pending" }] } },
      { name: "edit_file", args: { path: "a.txt", old_str: "hello world", new_str: "hello cepheus" } },
    ],
  },
  { tool_calls: [{ name: "run_command", args: { command: "node --version" } }, { name: "search", args: { query: "TODO" } }] },
  { tool_calls: [{ name: "read_file", args: { path: "../outside.txt" } }] },
  { content: "Done: changed **a.txt**." },
];

test("agent loop: read_file → edit_file → run_command → final answer (turbo, streaming)", async () => {
  const ws = workspace();
  const srv = await fakeOpenAI(SCRIPT);
  try {
    const host = new NodeToolHost(ws.dir, { userSkillsDir: null });
    const events = [];
    const session = createSession();
    await runAgentTurn(
      { host, session, config: { provider: "openai", model: "fake", baseUrl: srv.url }, message: "Change hello world", approvalMode: "turbo" },
      (ev) => events.push(ev),
    );
    const types = events.map((e) => e.type);
    assert.equal(events[0].type, "status");
    assert.equal(events[0].status, "running");
    assert.deepEqual(events.at(-1), { type: "status", sessionId: session.id, status: "idle" });
    assert.ok(!types.includes("error"), JSON.stringify(events.filter((e) => e.type === "error")));
    assert.ok(types.includes("context") && types.includes("debug") && types.includes("usage") && types.includes("textDelta"));

    // Files changed on disk.
    assert.equal(readFileSync(path.join(ws.dir, "a.txt"), "utf8"), "hello cepheus\nsecond line\n");
    const fc = events.find((e) => e.type === "fileChanged");
    assert.equal(fc.relPath, "a.txt");
    assert.equal(fc.before, "hello world\nsecond line\n");
    assert.equal(fc.after, "hello cepheus\nsecond line\n");

    // Tool results.
    const results = Object.fromEntries(events.filter((e) => e.type === "toolResult").map((e) => [e.name + (e.isError ? "!" : ""), e.output]));
    assert.match(results.read_file, /^    1\thello world/);
    assert.equal(results.edit_file, "Edited a.txt");
    assert.match(results.run_command, /^Exit code: 0\nv\d+\./);
    assert.match(results.search, /src\/util\.js:1: export const x = 1; \/\/ TODO/);
    assert.match(results["read_file!"], /outside the workspace/);
    assert.ok(!existsSync(path.join(path.dirname(ws.dir), "outside.txt")));
    const plan = events.find((e) => e.type === "plan");
    assert.equal(plan.items.length, 2);

    // Final text arrives as deltas and as one text event.
    const texts = events.filter((e) => e.type === "text").map((e) => e.text);
    assert.deepEqual(texts, ["I'll look at the file first.", "Done: changed **a.txt**."]);
    const usage = events.filter((e) => e.type === "usage").reduce((s, e) => s + e.inputTokens, 0);
    assert.equal(usage, session.usage.inputTokens);

    // The model saw the tool results in OpenAI format with matching ids.
    assert.equal(srv.requests.length, 5);
    assert.equal(srv.requests[0].body.stream, true);
    const second = srv.requests[1].body.messages;
    const toolMsg = second.find((m) => m.role === "tool");
    const asst = second.find((m) => m.role === "assistant" && m.tool_calls);
    assert.equal(toolMsg.tool_call_id, asst.tool_calls[0].id);
    assert.match(second[0].content, /You are Cepheus/);
    assert.ok(srv.requests[0].body.tools.some((t) => t.function.name === "edit_file"));

    // Session keeps history for the next turn.
    assert.ok(session.history.length >= 10);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("ask mode: approvals, rejection and plan mode", async () => {
  const ws = workspace();
  const srv = await fakeOpenAI([
    { tool_calls: [{ name: "edit_file", args: { path: "a.txt", old_str: "second", new_str: "2nd" } }] },
    { tool_calls: [{ name: "run_command", args: { command: "node --version" } }] },
    { content: "ok" },
  ]);
  try {
    const host = new NodeToolHost(ws.dir, { userSkillsDir: null });
    const asked = [];
    const events = [];
    await runAgentTurn(
      {
        host,
        config: { provider: "openai", model: "fake", baseUrl: srv.url, stream: false },
        message: "go",
        approvalMode: "ask",
        approve: async (req) => {
          asked.push(req.name);
          return req.name === "edit_file"; // allow the edit, reject the command
        },
      },
      (ev) => events.push(ev),
    );
    assert.deepEqual(asked, ["edit_file", "run_command"]);
    assert.equal(events.filter((e) => e.type === "approvalRequest").length, 2);
    assert.ok(events.some((e) => e.type === "status" && e.status === "waiting"));
    assert.equal(readFileSync(path.join(ws.dir, "a.txt"), "utf8"), "hello world\n2nd line\n");
    const rejected = events.find((e) => e.type === "toolResult" && e.name === "run_command");
    assert.equal(rejected.isError, true);
    assert.match(rejected.output, /rejected this action/);
    assert.equal(srv.requests[0].body.stream, undefined);
  } finally {
    await srv.close();
    ws.cleanup();
  }

  // Plan mode: write tools are not offered and refused if called anyway.
  const ws2 = workspace();
  const srv2 = await fakeOpenAI([{ tool_calls: [{ name: "write_file", args: { path: "x.txt", content: "no" } }] }, { content: "Plan: ..." }]);
  try {
    const events = [];
    await runAgentTurn(
      { host: new NodeToolHost(ws2.dir, { userSkillsDir: null }), config: { provider: "openai", model: "f", baseUrl: srv2.url }, message: "plan it", planMode: true, approvalMode: "turbo" },
      (ev) => events.push(ev),
    );
    const names = srv2.requests[0].body.tools.map((t) => t.function.name);
    assert.ok(!names.includes("write_file") && !names.includes("run_command") && names.includes("read_file"));
    assert.match(srv2.requests[0].body.messages[0].content, /PLAN MODE/);
    assert.match(events.find((e) => e.type === "toolResult").output, /not available in Plan mode/);
    assert.ok(!existsSync(path.join(ws2.dir, "x.txt")));
  } finally {
    await srv2.close();
    ws2.cleanup();
  }
});

test("hooks: a failing preToolUse hook blocks the call; postToolUse and stop run", async () => {
  const ws = workspace();
  mkdirSync(path.join(ws.dir, ".cepheus"));
  writeFileSync(
    path.join(ws.dir, ".cepheus", "guard.mjs"),
    `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);` +
      `if(String(p.args.command).includes("forbidden")){process.stderr.write("no forbidden commands");process.exit(2)}process.exit(0)});`,
  );
  writeFileSync(
    path.join(ws.dir, ".cepheus", "log.mjs"),
    `import fs from "node:fs";let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);` +
      `fs.appendFileSync(".cepheus/hook.log",process.env.CEPHEUS_HOOK_EVENT+":"+(p.tool||"")+"\\n")});`,
  );
  writeFileSync(
    path.join(ws.dir, ".cepheus", "hooks.json"),
    JSON.stringify({
      hooks: [
        { event: "preToolUse", matcher: "run_command", command: "node .cepheus/guard.mjs" },
        { event: "postToolUse", command: "node .cepheus/log.mjs" },
        { event: "stop", command: "node .cepheus/log.mjs" },
      ],
    }),
  );
  writeFileSync(path.join(ws.dir, "AGENTS.md"), "Project rule: be careful.");
  const srv = await fakeOpenAI([
    { tool_calls: [{ name: "run_command", args: { command: "echo forbidden" } }, { name: "run_command", args: { command: "node --version" } }] },
    { content: "done" },
  ]);
  try {
    const events = [];
    await runAgentTurn(
      { host: new NodeToolHost(ws.dir, { userSkillsDir: null }), config: { provider: "openai", model: "f", baseUrl: srv.url }, message: "x", approvalMode: "turbo" },
      (ev) => events.push(ev),
    );
    const results = events.filter((e) => e.type === "toolResult");
    assert.equal(results[0].isError, true);
    assert.match(results[0].output, /Blocked by preToolUse hook `node \.cepheus\/guard\.mjs` \(exit 2\): no forbidden commands/);
    assert.equal(results[1].isError, false);
    const log = readFileSync(path.join(ws.dir, ".cepheus", "hook.log"), "utf8");
    assert.equal(log, "postToolUse:run_command\nstop:\n");
    const ctx = events.find((e) => e.type === "context");
    assert.deepEqual(ctx.instructions, ["AGENTS.md"]);
    assert.match(srv.requests[0].body.messages[0].content, /# Instructions from AGENTS.md\nProject rule: be careful\./);
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("cancel: aborting mid-turn ends with status stopped and keeps history valid", async () => {
  const ws = workspace();
  const srv = await fakeOpenAI([{ tool_calls: [{ name: "run_command", args: { command: "node -e \"setTimeout(()=>{},20000)\"" } }] }, { content: "x" }]);
  try {
    const ctl = new AbortController();
    const events = [];
    const session = createSession();
    const p = runAgentTurn(
      { host: new NodeToolHost(ws.dir, { userSkillsDir: null }), session, config: { provider: "openai", model: "f", baseUrl: srv.url }, message: "x", approvalMode: "turbo" },
      (ev) => {
        events.push(ev);
        if (ev.type === "toolCall") setTimeout(() => ctl.abort(), 300);
      },
      ctl.signal,
    );
    await p;
    assert.equal(events.at(-1).status, "stopped");
    const last = session.history.at(-1);
    assert.equal(last.role, "tool");
    assert.equal(last.content, "Cancelled by the user.");
  } finally {
    await srv.close();
    ws.cleanup();
  }
});

test("MCP stdio server: tools exposed as mcp__server__tool, approval required unless turbo", async () => {
  const { McpManager } = await import("../dist/node/mcp.js");
  const ws = workspace();
  mkdirSync(path.join(ws.dir, ".cepheus"));
  writeFileSync(
    path.join(ws.dir, ".cepheus", "fake-mcp.mjs"),
    `import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list" && !m.params.cursor) send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { $schema: "x", type: "object", properties: { text: { type: "string" } } } }], nextCursor: "p2" } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "fail", description: "Always fails" }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: m.params.name === "echo" ? "echo: " + m.params.arguments.text : "boom" }], isError: m.params.name === "fail" } });
});`,
  );
  writeFileSync(path.join(ws.dir, ".cepheus", "mcp.json"), JSON.stringify({ servers: { fake: { command: "node", args: [".cepheus/fake-mcp.mjs"] } } }));
  const srv = await fakeOpenAI([
    { tool_calls: [{ name: "mcp__fake__echo", args: { text: "hi" } }, { name: "mcp__fake__fail", args: {} }] },
    { content: "done" },
    { tool_calls: [{ name: "mcp__fake__echo", args: { text: "again" } }] },
    { content: "done" },
  ]);
  const mcp = new McpManager(ws.dir);
  try {
    const host = new NodeToolHost(ws.dir, { userSkillsDir: null });
    const session = createSession();
    const events = [];
    await runAgentTurn({ host, session, mcp, config: { provider: "openai", model: "f", baseUrl: srv.url }, message: "x", approvalMode: "turbo" }, (e) => events.push(e));
    const names = srv.requests[0].body.tools.map((t) => t.function.name);
    assert.ok(names.includes("mcp__fake__echo") && names.includes("mcp__fake__fail"));
    assert.equal(srv.requests[0].body.tools.find((t) => t.function.name === "mcp__fake__echo").function.parameters.$schema, undefined);
    const res = events.filter((e) => e.type === "toolResult");
    assert.deepEqual(res.map((r) => [r.output, r.isError]), [["echo: hi", false], ["boom", true]]);
    assert.equal(events.find((e) => e.type === "context").mcpTools, 2);
    const asked = [];
    await runAgentTurn(
      { host, session, mcp, config: { provider: "openai", model: "f", baseUrl: srv.url }, message: "y", approvalMode: "auto-edit", approve: async (r) => (asked.push(r.name), false) },
      () => {},
    );
    assert.deepEqual(asked, ["mcp__fake__echo"]);
  } finally {
    mcp.close();
    await srv.close();
    ws.cleanup();
  }
});

function runCli(args, { cwd, env, onLine, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      out += d;
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine?.(line, child);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    if (input !== undefined) child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

function cliEnv(home, url) {
  const env = { ...process.env, CEPHEUS_HOME: home, CEPHEUS_PROVIDER: "openai", CEPHEUS_MODEL: "fake-model", OPENAI_BASE_URL: url, NO_COLOR: "1" };
  for (const k of ["CEPHEUS_PROXY_URL", "OPENAI_API_KEY", "NVIDIA_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "FORCE_COLOR"]) delete env[k];
  return env;
}

test("CLI --json: newline-delimited AgentEvent JSON", async () => {
  const ws = workspace();
  const home = tempDir();
  const srv = await fakeOpenAI(SCRIPT);
  try {
    const r = await runCli(["--json", "--yes", "Change hello world"], { cwd: ws.dir, env: cliEnv(home.dir, srv.url), input: "" });
    assert.equal(r.code, 0, r.err + r.out);
    const lines = r.out.trim().split("\n");
    const events = lines.map((l) => JSON.parse(l)); // every line is JSON
    const types = new Set(events.map((e) => e.type));
    for (const t of ["status", "context", "toolCall", "toolResult", "fileChanged", "plan", "text", "usage", "debug"]) assert.ok(types.has(t), `missing ${t}`);
    assert.equal(events.at(-1).type, "status");
    assert.equal(events.at(-1).status, "idle");
    assert.ok(events.every((e) => typeof e.sessionId === "string"));
    assert.equal(readFileSync(path.join(ws.dir, "a.txt"), "utf8"), "hello cepheus\nsecond line\n");
  } finally {
    await srv.close();
    ws.cleanup();
    home.cleanup();
  }
});

test("CLI --json: approvals over stdin", async () => {
  const ws = workspace();
  const home = tempDir();
  const srv = await fakeOpenAI([{ tool_calls: [{ name: "edit_file", args: { path: "a.txt", old_str: "hello", new_str: "HELLO" } }] }, { content: "ok" }]);
  try {
    let approvals = 0;
    const r = await runCli(["--json", "ok go"], {
      cwd: ws.dir,
      env: cliEnv(home.dir, srv.url),
      onLine: (line, child) => {
        const ev = JSON.parse(line);
        if (ev.type === "approvalRequest") {
          approvals++;
          child.stdin.write(JSON.stringify({ approvalId: ev.approvalId, approved: true }) + "\n");
        }
        if (ev.type === "status" && ev.status === "idle") child.stdin.end();
      },
    });
    assert.equal(r.code, 0, r.err);
    assert.equal(approvals, 1);
    assert.equal(readFileSync(path.join(ws.dir, "a.txt"), "utf8"), "HELLO world\nsecond line\n");
  } finally {
    await srv.close();
    ws.cleanup();
    home.cleanup();
  }
});

test("CLI one-shot human output", async () => {
  const ws = workspace();
  const home = tempDir();
  const srv = await fakeOpenAI(SCRIPT);
  try {
    const r = await runCli(["--yes", "Change hello world"], { cwd: ws.dir, env: cliEnv(home.dir, srv.url), input: "" });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /✓ read a\.txt/);
    assert.match(r.out, /✎ edit a\.txt \+1 −1/);
    assert.match(r.out, /- hello world/);
    assert.match(r.out, /\+ hello cepheus/);
    assert.match(r.out, /▶ run node --version → exit 0/);
    assert.match(r.out, /✗ read_file \.\.\/outside\.txt → Path '\.\.\/outside\.txt' is outside the workspace/);
    assert.match(r.out, /Done: changed \*\*a\.txt\*\*\./);
    assert.doesNotMatch(r.out, /\x1b\[/, "NO_COLOR disables ANSI codes");
  } finally {
    await srv.close();
    ws.cleanup();
    home.cleanup();
  }
});

test("CLI with no config and no keys uses the free Cepheus preset (no Authorization header)", async () => {
  const ws = workspace();
  const home = tempDir();
  const srv = await fakeOpenAI([{ content: "Hello from the free tier." }]);
  try {
    const env = cliEnv(home.dir, srv.url);
    for (const k of ["CEPHEUS_PROVIDER", "CEPHEUS_MODEL", "OPENAI_BASE_URL"]) delete env[k];
    env.CEPHEUS_PROXY_URL = srv.url + "/"; // trailing slash is trimmed
    const r = await runCli(["say hello"], { cwd: ws.dir, env, input: "" });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Hello from the free tier./);
    assert.match(r.err, /Cepheus Free tier/);
    assert.match(r.err, /NVIDIA_API_KEY/);
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].url, "/v1/chat/completions");
    assert.equal(srv.requests[0].headers.authorization, undefined);
    assert.equal(srv.requests[0].body.model, "nvidia/nemotron-3-ultra-550b-a55b");

    const m = await runCli(["models", "--json"], { cwd: ws.dir, env, input: "" });
    assert.equal(m.code, 0, m.err + m.out);
    assert.deepEqual(JSON.parse(m.out), ["fake-model"]);

    // A provider that needs a key still explains the options, the free tier first.
    const r3 = await runCli(["do something"], { cwd: ws.dir, env: { ...env, CEPHEUS_PROVIDER: "anthropic" }, input: "" });
    assert.equal(r3.code, 1);
    assert.match(r3.err, /No API key for Anthropic/);
    assert.match(r3.err, /Cepheus Free tier/);
    assert.match(r3.err, /build.nvidia.com/);
  } finally {
    await srv.close();
    ws.cleanup();
    home.cleanup();
  }
});

test("CLI --version, --help, bad options, web fallback", async () => {
  const v = await runCli(["--version"], { input: "" });
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/);
  const h = await runCli(["--help"], { input: "" });
  assert.match(h.out, /Examples/);
  assert.match(h.out, /cepheus "fix the failing test"/);
  const bad = await runCli(["--mode", "yolo"], { input: "" });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--mode must be ask, auto-edit or turbo/);
});
