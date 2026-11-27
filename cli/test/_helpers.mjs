// Shared test helpers (no tests here). Imports the compiled package from ../dist.
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function tempDir(prefix = "cepheus-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** In-memory ToolHost for pure unit tests. */
export function memoryHost(files = {}, opts = {}) {
  const root = opts.root ?? "/ws";
  const store = new Map(Object.entries(files).map(([k, v]) => [`${root}/${k}`, v]));
  const commands = [];
  return {
    root,
    caseInsensitive: false,
    osLabel: "test",
    store,
    commands,
    async readFile(p) {
      if (!store.has(p)) throw new Error(`File not found: ${p}`);
      return store.get(p);
    },
    async writeFile(p, c) {
      store.set(p, c);
    },
    async exists(p) {
      return store.has(p) || [...store.keys()].some((k) => k.startsWith(p + "/"));
    },
    async listDir(p) {
      const names = new Map();
      for (const k of store.keys()) {
        if (!k.startsWith(p + "/")) continue;
        const rest = k.slice(p.length + 1);
        const [first, ...more] = rest.split("/");
        names.set(first, more.length > 0 || names.get(first) === true);
      }
      return [...names].map(([name, isDir]) => ({ name, isDir }));
    },
    async findFiles() {
      return [...store.keys()].map((k) => k.slice(root.length + 1));
    },
    async search({ query }) {
      const out = [];
      for (const [k, v] of store) v.split("\n").forEach((l, i) => l.includes(query) && out.push({ path: k.slice(root.length + 1), line: i + 1, text: l }));
      return out;
    },
    async runCommand(command, o = {}) {
      commands.push({ command, ...o });
      if (opts.runCommand) return opts.runCommand(command, o);
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
}

/**
 * Fake OpenAI-compatible server. `script` is a list of assistant replies, one per request:
 * `{ content?, tool_calls?: [{name, args}] }`. Streams SSE when the request asks for it.
 * Records every request body in `requests`.
 */
export async function fakeOpenAI(script, opts = {}) {
  const requests = [];
  let i = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-model" }, { id: "text-embedding-3" }] }));
        return;
      }
      const json = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (opts.status) {
        const st = typeof opts.status === "function" ? opts.status(json, requests.length) : opts.status;
        if (st) {
          res.writeHead(st, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `fake error ${st}` } }));
          return;
        }
      }
      const step = script[Math.min(i++, script.length - 1)];
      const calls = (step.tool_calls ?? []).map((c, k) => ({
        id: `call_${requests.length}_${k}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
      const usage = { prompt_tokens: 10 * requests.length, completion_tokens: 5 };
      if (json.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (step.content) {
          for (const piece of step.content.match(/.{1,4}/gs)) send({ choices: [{ index: 0, delta: { content: piece } }] });
        }
        calls.forEach((c, k) => {
          const a = c.function.arguments;
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: k, id: c.id, type: "function", function: { name: c.function.name, arguments: a.slice(0, 5) } }] } }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: k, function: { arguments: a.slice(5) } }] } }] });
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] });
        send({ choices: [], usage });
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop", message: { role: "assistant", content: step.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) } }],
          usage,
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}
