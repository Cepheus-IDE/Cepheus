import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOpenAIRequest,
  parseOpenAIResponse,
  buildAnthropicRequest,
  parseAnthropicResponse,
  buildGeminiRequest,
  parseGeminiResponse,
  OpenAIStreamAccumulator,
  parseSse,
  toolResults,
  pushUserText,
  callModel,
  listModels,
  friendly,
  ApiError,
  expandAuto,
  resetUnavailable,
  NVIDIA_BASE,
  isChatModel,
} from "../dist/core/providers.js";
import { definitions } from "../dist/core/tools.js";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const tools = definitions().slice(0, 2);
const history = [{ role: "user", content: "hi" }];

test("OpenAI-compatible request mapping", () => {
  const r = buildOpenAIRequest({ provider: "openai", model: "gpt-5", apiKey: "sk-x", effort: "medium" }, "SYS", tools, history, 9000);
  assert.equal(r.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(r.headers.authorization, "Bearer sk-x");
  assert.deepEqual(r.body.messages[0], { role: "system", content: "SYS" });
  assert.deepEqual(r.body.messages[1], history[0]);
  assert.equal(r.body.tools[0].type, "function");
  assert.equal(r.body.tools[0].function.name, "list_dir");
  assert.deepEqual(r.body.tools[0].function.parameters, tools[0].schema);
  assert.equal(r.body.reasoning_effort, "medium");
  assert.equal(r.body.max_tokens, undefined);
  const n = buildOpenAIRequest({ provider: "openai", model: "m", baseUrl: NVIDIA_BASE + "/" }, "S", [], history, 99999, true);
  assert.equal(n.url, NVIDIA_BASE + "/chat/completions");
  assert.equal(n.body.max_tokens, 16384);
  assert.equal(n.body.tools, undefined);
  assert.equal(n.body.stream, true);
  assert.equal(n.headers.authorization, undefined, "local/no-key servers get no auth header");
});

test("OpenAI-compatible response mapping (fixture)", () => {
  const { entry, turn } = parseOpenAIResponse(JSON.parse(fx("openai-response.json")));
  assert.deepEqual(turn.texts, ["Let me read the file."]);
  assert.deepEqual(turn.thinking, ["The user wants the file contents."]);
  assert.deepEqual(turn.calls, [{ id: "call_abc", name: "read_file", args: { path: "src/a.ts", start_line: 1 } }]);
  assert.equal(turn.inputTokens, 120);
  assert.equal(turn.outputTokens, 30);
  assert.equal(turn.cacheReadTokens, 64);
  assert.equal(entry.role, "assistant");
  assert.equal(entry.tool_calls[0].id, "call_abc");
  assert.deepEqual(toolResults({ provider: "nvidia" }, [{ call: turn.calls[0], output: "file", isError: false }]), [
    { role: "tool", tool_call_id: "call_abc", content: "file" },
  ]);
});

test("OpenAI-compatible SSE stream accumulation (fixture)", () => {
  const acc = new OpenAIStreamAccumulator();
  const deltas = [];
  const tail = parseSse(fx("openai-stream.txt").replace(/\r\n/g, "\n"), (d) => {
    if (d !== "[DONE]") acc.push(JSON.parse(d), (t) => deltas.push(t));
  });
  assert.equal(tail.trim(), "");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  const { entry, turn } = parseOpenAIResponse(acc.toResponse());
  assert.deepEqual(turn.texts, ["Hello"]);
  assert.deepEqual(turn.calls, [{ id: "call_1", name: "edit_file", args: { path: "a.txt", old_str: "x", new_str: "y" } }]);
  assert.equal(turn.inputTokens, 50);
  assert.equal(entry.tool_calls[0].function.arguments, '{"path":"a.txt","old_str":"x","new_str":"y"}');
});

test("tool calls without ids get generated ids", () => {
  const { entry, turn } = parseOpenAIResponse({ choices: [{ message: { content: "", tool_calls: [{ function: { name: "list_dir", arguments: { path: "." } } }] } }] });
  assert.ok(turn.calls[0].id.startsWith("call_"));
  assert.equal(entry.tool_calls[0].id, turn.calls[0].id);
  assert.deepEqual(turn.calls[0].args, { path: "." });
});

test("Anthropic request/response mapping (fixture)", () => {
  const r = buildAnthropicRequest({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "k", effort: "high" }, "SYS", tools, history, 16000);
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], "k");
  assert.ok(r.headers["anthropic-version"]);
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.max_tokens, 16000);
  assert.deepEqual(r.body.messages, history);
  assert.deepEqual(r.body.tools[0], { name: "list_dir", description: tools[0].description, input_schema: tools[0].schema });
  assert.deepEqual(r.body.output_config, { effort: "high" });
  const { entry, turn } = parseAnthropicResponse(JSON.parse(fx("anthropic-response.json")));
  assert.deepEqual(turn.texts, ["Looking at the project."]);
  assert.deepEqual(turn.thinking, ["I should list the directory."]);
  assert.deepEqual(turn.calls, [{ id: "toolu_01", name: "list_dir", args: { path: "." } }]);
  assert.equal(turn.inputTokens, 1010);
  assert.equal(turn.cacheReadTokens, 900);
  assert.equal(entry.content.length, 3, "thinking blocks are kept in history");
  const tr = toolResults({ provider: "anthropic" }, [{ call: turn.calls[0], output: "a\nb", isError: true }]);
  assert.deepEqual(tr, [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "a\nb", is_error: true }] }]);
  const h = [...tr];
  pushUserText({ provider: "anthropic" }, h, "steer");
  assert.equal(h.length, 1, "user text merges into the trailing user entry");
  assert.deepEqual(h[0].content[1], { type: "text", text: "steer" });
  const refusal = parseAnthropicResponse({ content: [{ type: "tool_use", id: "x", name: "y", input: {} }], stop_reason: "refusal" });
  assert.equal(refusal.turn.calls.length, 0);
  assert.match(refusal.turn.warning, /declined/);
});

test("Gemini request/response mapping (fixture)", () => {
  const gh = [{ role: "user", parts: [{ text: "hi" }] }];
  const r = buildGeminiRequest({ provider: "gemini", model: "gemini-2.5-pro", apiKey: "g", effort: "low" }, "SYS", tools, gh, 8000);
  assert.equal(r.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(r.headers["x-goog-api-key"], "g");
  assert.deepEqual(r.body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(r.body.contents, gh);
  assert.equal(r.body.tools[0].functionDeclarations[1].name, "find_files");
  assert.deepEqual(r.body.generationConfig.thinkingConfig, { thinkingBudget: 1024, includeThoughts: true });
  const { entry, turn } = parseGeminiResponse(JSON.parse(fx("gemini-response.json")));
  assert.deepEqual(turn.texts, ["I'll search."]);
  assert.deepEqual(turn.thinking, ["Thinking about it"]);
  assert.deepEqual(turn.calls, [{ id: "gemini-2", name: "search", args: { query: "TODO" } }]);
  assert.equal(turn.outputTokens, 25);
  assert.equal(entry.role, "model");
  assert.equal(entry.parts[2].thoughtSignature, "abc", "thought signatures are echoed back");
  const tr = toolResults({ provider: "gemini" }, [{ call: turn.calls[0], output: "none", isError: false }]);
  assert.deepEqual(tr, [{ role: "user", parts: [{ functionResponse: { name: "search", response: { output: "none" } } }] }]);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers });
    const r = await handler(url, body, calls.length);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json", ...(r.headers ?? {}) },
    });
  };
  f.calls = calls;
  return f;
}

const okReply = (model) => ({ body: { choices: [{ message: { role: "assistant", content: `hi from ${model}` } }], usage: {} } });

test("Auto fallback on 429 and 404 within the same message format", async () => {
  resetUnavailable();
  const fetch = fakeFetch((url, body) => {
    if (body.model === "m1") return { status: 429, body: { error: { message: "slow down" } } };
    if (body.model === "m2") return { status: 404, body: { error: { message: "Function 'x': Not found for account 'y'" } } };
    return okReply(body.model);
  });
  const cfg = expandAuto({ provider: "nvidia", source: "nvidia", model: "auto", apiKey: "nvapi-test" });
  cfg.model = "m1";
  cfg.fallbacks = [
    { ...cfg, model: "m2", fallbacks: undefined },
    { provider: "anthropic", model: "claude-x" }, // other format: skipped
    { ...cfg, model: "m3", fallbacks: undefined },
  ];
  const { turn } = await callModel(cfg, "S", [], history, { fetch, retryDelayMs: 1 });
  assert.equal(turn.model, "m3");
  assert.deepEqual(turn.texts, ["hi from m3"]);
  assert.equal(turn.notices.length, 2);
  assert.match(turn.notices[0], /429 rate limited/);
  assert.match(turn.notices[1], /404 not available/);
  assert.deepEqual(fetch.calls.map((c) => c.body.model), ["m1", "m2", "m3"]);
  assert.equal(fetch.calls[0].url, NVIDIA_BASE + "/chat/completions");
  assert.equal(fetch.calls[0].headers.authorization, "Bearer nvapi-test");
  // m2 is now remembered as unavailable and skipped next time.
  const again = await callModel(cfg, "S", [], history, { fetch, retryDelayMs: 1 });
  assert.equal(again.turn.model, "m3");
  assert.deepEqual(fetch.calls.slice(3).map((c) => c.body.model), ["m1", "m3"]);
  resetUnavailable();
});

test("single model: transient error retried once, then friendly message", async () => {
  let n = 0;
  const fetch = fakeFetch(() => (++n === 1 ? { status: 503, body: "overloaded" } : okReply("solo")));
  const { turn } = await callModel({ provider: "openai", model: "solo" }, "S", [], history, { fetch, retryDelayMs: 1 });
  assert.equal(n, 2);
  assert.equal(turn.texts[0], "hi from solo");
  const f401 = fakeFetch(() => ({ status: 401, body: { error: { message: "invalid key" } } }));
  await assert.rejects(callModel({ provider: "nvidia", model: "x", apiKey: "bad" }, "S", [], history, { fetch: f401 }), (e) => {
    assert.match(e.message, /NVIDIA API key was rejected \(401\)/);
    assert.match(e.message, /build\.nvidia\.com/);
    assert.match(e.message, /Details: invalid key/);
    return true;
  });
});

test("friendly errors for 403/429/timeouts/local network", () => {
  const cfg = { provider: "openai", model: "m", baseUrl: "http://localhost:11434/v1" };
  assert.match(friendly(cfg, new ApiError("network", "ECONNREFUSED")), /local model server.*ollama serve/s);
  assert.match(friendly(cfg, new ApiError("timeout", "")), /timed out/);
  assert.match(friendly(cfg, new ApiError("http", "", 403)), /Access denied \(403\)/);
  assert.match(friendly({ provider: "nvidia", model: "m" }, new ApiError("http", "", 429)), /rate limited.*auto/s);
  assert.match(friendly(cfg, new ApiError("http", "", 404)), /isn't available/);
  assert.ok(new ApiError("http", "", 429).transient() && !new ApiError("http", "", 401).transient());
  assert.ok(new ApiError("http", "The model `foo` does not exist", 400).modelUnavailable());
});

test("network failure against a closed local port", async () => {
  await assert.rejects(
    callModel({ provider: "openai", model: "m", baseUrl: "http://127.0.0.1:9/v1" }, "S", [], history, { retryDelayMs: 1, timeoutMs: 5000 }),
    /Could not reach the local model server/,
  );
});

test("user abort is reported as AbortError", async () => {
  const ctl = new AbortController();
  const fetch = (url, init) =>
    new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const p = callModel({ provider: "openai", model: "m" }, "S", [], history, { fetch, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("model listing filters non-chat models", async () => {
  const fetch = fakeFetch(() => ({ body: { data: [{ id: "b-chat" }, { id: "nvidia/nv-embed-v1" }, { id: "a-chat" }, { id: "a-chat" }] } }));
  const models = await listModels({ provider: "nvidia", model: "", apiKey: "k" }, { fetch });
  assert.deepEqual(models.map((m) => m.id), ["a-chat", "b-chat"]);
  assert.equal(fetch.calls[0].url, NVIDIA_BASE + "/models");
  assert.ok(!isChatModel("llama-guard") && isChatModel("meta/llama-3.3-70b-instruct"));
});

test("expandAuto builds a candidate chain from the preset", () => {
  const c = expandAuto({ provider: "nvidia", source: "nvidia", model: "auto" });
  assert.equal(c.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.ok(c.fallbacks.length >= 2);
  const d = expandAuto({ provider: "openai", source: "ollama", model: "llama3" }, ["qwen"]);
  assert.deepEqual([d.model, ...d.fallbacks.map((f) => f.model)], ["llama3", "qwen"]);
});
