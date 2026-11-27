// Cepheus free-model proxy: forwards OpenAI-compatible requests to NVIDIA NIM with the server's key,
// so apps, the CLI and the web never ship the key. Zero dependencies; Node 18+.
//
// Env: NVIDIA_API_KEY (required), PORT (default 8787), HOST (default 127.0.0.1),
//      ALLOWED_ORIGINS (comma list for browsers, default https://cepheus.codes,https://www.cepheus.codes),
//      RPM (requests per minute per client, default 20), RPD (requests per day per client, default 400),
//      MAX_TOKENS (cap per request, default 8192), MODELS (comma allowlist, default Nemotron models),
//      IMG_RPM / IMG_RPD (image generations per client per minute / day, default 6 / 60),
//      IMAGE_MODEL (default black-forest-labs/flux.2-klein-4b).
import http from "node:http";

const UPSTREAM = process.env.UPSTREAM || "https://integrate.api.nvidia.com/v1";
const KEY = process.env.NVIDIA_API_KEY || "";
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const RPM = Number(process.env.RPM || 20);
const RPD = Number(process.env.RPD || 400);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 8192);
const MAX_BODY = 4 * 1024 * 1024;
const IMG_RPM = Number(process.env.IMG_RPM || 6);
const IMG_RPD = Number(process.env.IMG_RPD || 60);
const IMAGE_MODEL = process.env.IMAGE_MODEL || "black-forest-labs/flux.2-klein-4b";
const GENAI = process.env.GENAI_UPSTREAM || "https://ai.api.nvidia.com/v1/genai";
// FLUX.2 klein accepts multiples of 16 between 512 and 1568.
const SIZES = { "1344x768": [1344, 768], "1024x1024": [1024, 1024], "768x1344": [768, 1344] };
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "https://cepheus.codes,https://www.cepheus.codes").split(",").map((s) => s.trim()).filter(Boolean));
const MODELS = new Set((process.env.MODELS || [
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-super-vl-120b-a12b",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean));

if (!KEY) {
  console.error("NVIDIA_API_KEY is not set");
  process.exit(1);
}

// ---------- per-client rate limits (in memory; counts only, never content) ----------
const minute = new Map(); // client -> { start, n }
const day = new Map();
const imgMinute = new Map();
const imgDay = new Map();
function take(map, client, windowMs, limit) {
  const now = Date.now();
  let e = map.get(client);
  if (!e || now - e.start >= windowMs) e = { start: now, n: 0 };
  e.n++;
  map.set(client, e);
  return { ok: e.n <= limit, resetIn: Math.ceil((e.start + windowMs - now) / 1000) };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of minute) if (now - e.start > 60_000) minute.delete(k);
  for (const [k, e] of day) if (now - e.start > 86_400_000) day.delete(k);
  for (const [k, e] of imgMinute) if (now - e.start > 60_000) imgMinute.delete(k);
  for (const [k, e] of imgDay) if (now - e.start > 86_400_000) imgDay.delete(k);
}, 60_000).unref();

function clientId(req) {
  // Behind Caddy on the same host: trust X-Forwarded-For only from loopback.
  const remote = req.socket.remoteAddress || "";
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") && fwd ? fwd : remote;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true; // CLI and desktop app send no Origin
  if (!ORIGINS.has(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Cepheus-Client");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}
const fail = (res, status, message, extra) => json(res, status, { error: { message, type: "cepheus_proxy" } }, extra);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// OpenAI-style image endpoint backed by FLUX.2 klein. Body: { prompt, size }.
async function images(req, res) {
  const client = clientId(req);
  const m = take(imgMinute, client, 60_000, IMG_RPM);
  if (!m.ok) return fail(res, 429, `Image limit: ${IMG_RPM} per minute. Try again in ${m.resetIn}s.`, { "Retry-After": String(m.resetIn) });
  const d = take(imgDay, client, 86_400_000, IMG_RPD);
  if (!d.ok) return fail(res, 429, `Daily image limit of ${IMG_RPD} reached. It resets within ${Math.ceil(d.resetIn / 3600)}h.`, { "Retry-After": String(d.resetIn) });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return fail(res, 400, "Invalid JSON"); }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 2000) : "";
  if (!prompt) return fail(res, 400, "prompt is required");
  const [width, height] = SIZES[body.size] || SIZES["1024x1024"];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 90_000);
  req.on("close", () => { if (!res.writableEnded) ac.abort(); });
  try {
    const up = await fetch(`${GENAI}/${IMAGE_MODEL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ prompt, width, height, steps: 4 }),
      signal: ac.signal,
    });
    const j = await up.json().catch(() => null);
    const a = j && Array.isArray(j.artifacts) ? j.artifacts[0] : null;
    if (!up.ok || !a) return fail(res, up.status === 429 ? 429 : 502, up.status === 429 ? "The image service is busy, try again shortly" : "Image generation failed, please retry");
    if (a.finishReason !== "SUCCESS" || !a.base64) return fail(res, 422, "The image was blocked by the safety filter. Try a different prompt.");
    return json(res, 200, { created: Math.floor(Date.now() / 1000), model: IMAGE_MODEL, data: [{ b64_json: a.base64, mime_type: "image/jpeg", width, height }] });
  } catch {
    if (!res.headersSent) return fail(res, 504, "Image generation timed out, please retry");
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    if (!cors(req, res)) return fail(res, 403, "Origin not allowed");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [...MODELS].map((id) => ({ id, object: "model", owned_by: "nvidia" })) });
    }

    if (req.method === "POST" && url.pathname === "/v1/images/generations") return images(req, res);
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return fail(res, 404, "Not found");

    const client = clientId(req);
    const m = take(minute, client, 60_000, RPM);
    if (!m.ok) return fail(res, 429, `Free tier limit: ${RPM} requests per minute. Try again in ${m.resetIn}s, or add your own NVIDIA key for higher limits.`, { "Retry-After": String(m.resetIn) });
    const d = take(day, client, 86_400_000, RPD);
    if (!d.ok) return fail(res, 429, `Free tier daily limit of ${RPD} requests reached. It resets within ${Math.ceil(d.resetIn / 3600)}h, or add your own NVIDIA key (free at build.nvidia.com).`, { "Retry-After": String(d.resetIn) });

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      return fail(res, e.message === "too_large" ? 413 : 400, e.message === "too_large" ? "Request too large" : "Invalid JSON");
    }
    if (!MODELS.has(body.model)) return fail(res, 400, `Model not available on the free tier. Use one of: ${[...MODELS].join(", ")}`);
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
    delete body.user;

    const ac = new AbortController();
    req.on("close", () => { if (!res.writableEnded) ac.abort(); });
    const up = await fetch(`${UPSTREAM}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const headers = { "Content-Type": up.headers.get("content-type") || "application/json", "Cache-Control": "no-store" };
    res.writeHead(up.status, headers);
    if (!up.body) return res.end();
    // Stream through (works for both JSON and text/event-stream responses).
    for await (const chunk of up.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (!res.headersSent) fail(res, 502, "Upstream error, please retry");
    else res.end();
  }
});

server.requestTimeout = 300_000;
server.listen(PORT, HOST, () => console.log(`cepheus proxy on http://${HOST}:${PORT} (models: ${[...MODELS].join(", ")})`));
