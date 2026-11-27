// Cepheus site API: token contract address, X profile and top holders for cepheus.codes, plus a small admin.
// Zero dependencies; Node 18+. Runs behind nginx on 127.0.0.1:8791 (see README.md).
//
// Env: PORT (default 8791), HOST (default 127.0.0.1), STATE_DIR (default /var/lib/cepheus-site),
//      ALLOWED_ORIGINS (default https://cepheus.codes,https://www.cepheus.codes).
// CLI: `node server.mjs --set-password < file` sets the admin password from stdin (only the scrypt hash is stored).
//      `node server.mjs --reset-password` (as root) prompts twice without echo, or reads CEPHEUS_ADMIN_NEW_PASSWORD
//      when stdin is not a terminal. Restart the service afterwards so it loads the new hash.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "127.0.0.1";
const STATE_DIR = process.env.STATE_DIR || "/var/lib/cepheus-site";
const STATE_FILE = path.join(STATE_DIR, "state.json");
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "https://cepheus.codes,https://www.cepheus.codes").split(",").map((s) => s.trim()).filter(Boolean));
const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = "cepheus_admin";
const MAX_BODY = 16 * 1024;
const HOLDERS_TTL = 60_000;

// ---------- Robinhood Chain networks (verified 2026-11-27) ----------
// Sources: https://docs.robinhood.com/chain/add-network-to-wallet , https://docs.robinhood.com/chain/connecting ,
//          https://docs.blockscout.com/robinhood-api (mainnet explorer is Blockscout; its API needs a Blockscout key).
// Both RPCs answered eth_chainId with 0x1237 (4663) and 0xb626 (46630). The mainnet explorer's own /api is behind a
// Cloudflare challenge for servers, so mainnet holder data goes through the Blockscout PRO API with a key.
export const NETWORKS = {
  mainnet: {
    name: "Robinhood Chain",
    chainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: "https://robinhoodchain.blockscout.com",
    explorerApi: "https://robinhoodchain.blockscout.com/api/v2",
    proApi: "https://api.blockscout.com/4663/api/v2", // used when an explorer API key is set
  },
  testnet: {
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    rpc: "https://rpc.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
    explorer: "https://explorer.testnet.chain.robinhood.com",
    explorerApi: "https://explorer.testnet.chain.robinhood.com/api/v2", // Blockscout, open API
    proApi: null,
  },
};

// ---------- State (atomic writes, owner-only) ----------
const DEFAULT_STATE = { ca: null, x: null, network: "mainnet", explorerKey: null, auth: null };
function loadState() {
  try { return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch (e) { if (e.code === "ENOENT") return { ...DEFAULT_STATE }; throw e; }
}
function saveState(s) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  // Keep the owner of an existing state file (root running the CLI must not take it over from the service user).
  let owner = null;
  try { const st = fs.statSync(STATE_FILE); owner = { uid: st.uid, gid: st.gid }; } catch {}
  if (!owner && process.getuid && process.getuid() === 0) { try { const st = fs.statSync(STATE_DIR); owner = { uid: st.uid, gid: st.gid }; } catch {} }
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(s, null, 2));
    if (owner && process.getuid && process.getuid() === 0) fs.fchownSync(fd, owner.uid, owner.gid);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- Passwords: scrypt with a random salt, constant-time compare ----------
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return { alg: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), hash: hash.toString("base64") };
}
function verifyPassword(pw, auth) {
  // Always run scrypt so timing does not reveal whether a password is configured.
  const a = auth || { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: "AAAAAAAAAAAAAAAAAAAAAA==", hash: Buffer.alloc(64).toString("base64") };
  const expected = Buffer.from(a.hash, "base64");
  const got = crypto.scryptSync(String(pw), Buffer.from(a.salt, "base64"), expected.length, { N: a.N, r: a.r, p: a.p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, expected) && !!auth;
}

// ---------- CLI: set the admin password from stdin ----------
if (process.argv.includes("--set-password")) {
  const pw = fs.readFileSync(0, "utf8").trim();
  if (pw.length < 12) { console.error("Password must be at least 12 characters"); process.exit(1); }
  const s = loadState();
  s.auth = hashPassword(pw);
  saveState(s);
  console.log("Admin password hash stored.");
  process.exit(0);
}

// ---------- CLI: reset the admin password on the server (when every recovery code is lost) ----------
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    input.setRawMode(true); input.resume(); input.setEncoding("utf8"); // no echo before the prompt shows
    process.stdout.write(question);
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") { done(); return resolve(value); }
        if (ch === "\u0003") { done(); return reject(new Error("Cancelled")); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    const done = () => { input.removeListener("data", onData); input.setRawMode(false); input.pause(); process.stdout.write("\n"); };
    input.on("data", onData);
  });
}
if (process.argv.includes("--reset-password")) {
  let pw;
  try {
    if (process.stdin.isTTY) {
      pw = await promptHidden("New admin password: ");
      const again = await promptHidden("Repeat new password: ");
      if (pw !== again) { console.error("The passwords do not match. Nothing was changed."); process.exit(1); }
    } else {
      pw = process.env.CEPHEUS_ADMIN_NEW_PASSWORD || "";
      if (!pw) { console.error("No terminal: set CEPHEUS_ADMIN_NEW_PASSWORD. Nothing was changed."); process.exit(1); }
    }
  } catch (e) { console.error(e.message + ". Nothing was changed."); process.exit(1); }
  if (pw.length < 12 || pw.length > 256) { console.error("Password must be 12 to 256 characters. Nothing was changed."); process.exit(1); }
  const s = loadState();
  s.auth = hashPassword(pw);
  saveState(s);
  console.log("Admin password reset. Now run: systemctl restart cepheus-site-api");
  process.exit(0);
}

let state = loadState();

// ---------- Recovery codes: 8 one-time codes, only scrypt hashes are stored ----------
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const CODE_SLOTS = 8;
function newCode() {
  let c = "";
  for (let i = 0; i < 12; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8);
}
function normalizeCode(v) {
  const c = String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return c.length === 12 ? c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8) : null;
}
function hashCode(code) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString("base64"), hash: crypto.scryptSync(code, salt, 32, CODE_SCRYPT).toString("base64") };
}
// Checks the code against every stored hash (and dummies up to 8), without stopping early.
function findCode(code) {
  const list = Array.isArray(state.recovery) ? state.recovery : [];
  let match = -1;
  for (let i = 0; i < Math.max(CODE_SLOTS, list.length); i++) {
    const h = list[i] || { salt: "AAAAAAAAAAAAAAAAAAAAAA==", hash: Buffer.alloc(32).toString("base64") };
    const expected = Buffer.from(h.hash, "base64");
    const got = crypto.scryptSync(code || "", Buffer.from(h.salt, "base64"), expected.length, CODE_SCRYPT);
    const ok = crypto.timingSafeEqual(got, expected);
    if (ok && list[i] && match < 0) match = i;
  }
  return match;
}

// ---------- Keccak-256 for EIP-55 checksums ----------
const MASK = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
function keccakF(A) {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[x + y] ^= D; }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y]);
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    A[0] ^= RC[round];
  }
}
export function keccak256(bytes) {
  const rate = 136, A = new Array(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      A[i] ^= lane;
    }
    keccakF(A);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i] >> BigInt(8 * b)) & 0xffn);
  return out.toString("hex");
}
export function toChecksum(addr) {
  const lower = addr.slice(2).toLowerCase();
  const h = keccak256(Buffer.from(lower, "ascii"));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

// ---------- Validation ----------
export function normalizeCa(v) {
  if (v === null || v === undefined || String(v).trim() === "") return { ok: true, value: null };
  const s = String(v).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return { ok: false, error: "Contract address must be 0x followed by 40 hex characters." };
  const sum = toChecksum(s);
  const mixed = /[a-f]/.test(s.slice(2)) && /[A-F]/.test(s.slice(2));
  if (mixed && s !== sum) return { ok: false, error: "Contract address has an invalid checksum (check for a typo)." };
  if (/^0x0{40}$/.test(s)) return { ok: false, error: "The zero address is not a token contract." };
  return { ok: true, value: sum };
}
export function normalizeX(v) {
  if (v === null || v === undefined || String(v).trim() === "") return { ok: true, value: null };
  let s = String(v).trim();
  let handle = null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i);
  if (m) handle = m[1].replace(/^@/, "");
  else if (/^@?[A-Za-z0-9_]{1,15}$/.test(s)) handle = s.replace(/^@/, "");
  const reserved = /^(home|explore|search|i|settings|intent|share|login|signup|messages|notifications|compose|tos|privacy)$/i;
  if (!handle || reserved.test(handle)) return { ok: false, error: "X profile must be a handle like @cepheus or a link like https://x.com/cepheus." };
  return { ok: true, value: `https://x.com/${handle}` };
}

// ---------- HTTP helpers ----------
function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(JSON.stringify(body));
}
const fail = (res, status, error, extra) => json(res, status, { error }, extra);

function clientIp(req) {
  // nginx on the same host sets X-Forwarded-For; trust it only from loopback.
  const remote = req.socket.remoteAddress || "";
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  return (remote === "127.0.0.1" || remote === "::ffff:127.0.0.1" || remote === "::1") && fwd ? fwd : remote;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- Sessions (in memory; keyed by a hash of the token) ----------
const sessions = new Map(); // sha256(token) -> expiry
const tokenKey = (t) => crypto.createHash("sha256").update(t).digest("hex");
function newSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(tokenKey(token), Date.now() + SESSION_MS);
  return token;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/site; Max-Age=${maxAge}`;
}
function authed(req) {
  const t = cookies(req)[COOKIE];
  if (!t || !/^[A-Za-z0-9_-]{43}$/.test(t)) return null;
  const k = tokenKey(t), exp = sessions.get(k);
  if (!exp) return null;
  if (exp < Date.now()) { sessions.delete(k); return null; }
  return k;
}

// ---------- Login rate limit: 5 attempts per minute per IP ----------
const attempts = new Map();
function allowAttempt(ip) {
  const now = Date.now();
  let e = attempts.get(ip);
  if (!e || now - e.start >= 60_000) e = { start: now, n: 0 };
  e.n++;
  attempts.set(ip, e);
  return { ok: e.n <= 5, retry: Math.ceil((e.start + 60_000 - now) / 1000) };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of attempts) if (now - e.start > 60_000) attempts.delete(k);
  for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
}, 60_000).unref();

// ---------- Holders from the Blockscout API, cached 60 s ----------
const holderCache = new Map(); // key -> { at, body }
function formatUnits(raw, decimals, maxFrac = 4) {
  const neg = raw < 0n; if (neg) raw = -raw;
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  let frac = decimals > 0 ? (raw % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "") : "";
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!frac && whole === 0n && raw > 0n) return "<0." + "0".repeat(maxFrac - 1) + "1";
  return (neg ? "-" : "") + w + (frac ? "." + frac : "");
}
function percentOf(value, total) {
  if (total <= 0n) return null;
  const units = (value * 10n ** 12n) / total; // 1e-10 percent units, so tiny shares stay above zero
  return Number(units) / 1e10;
}
async function explorerGet(net, p) {
  const useKey = net.proApi && state.explorerKey;
  const base = useKey ? net.proApi : net.explorerApi;
  const url = new URL(base + p);
  if (useKey) url.searchParams.set("apikey", state.explorerKey);
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "cepheus-site-api" }, signal: AbortSignal.timeout(12_000) });
  const type = r.headers.get("content-type") || "";
  if (!r.ok || !type.includes("json")) {
    const reason = r.status === 402 || r.status === 401 ? "explorer API key missing or invalid" : !type.includes("json") ? "explorer blocked the request" : `explorer returned ${r.status}`;
    throw Object.assign(new Error(reason), { status: r.status });
  }
  return r.json();
}
async function loadHolders(limit) {
  const net = NETWORKS[state.network] || NETWORKS.mainnet;
  const ca = state.ca;
  const token = await explorerGet(net, `/tokens/${ca}`);
  const decimals = Number(token.decimals ?? 18);
  const total = BigInt(token.total_supply || "0");
  const items = [];
  let params = null;
  for (let page = 0; page < 4 && items.length < limit; page++) {
    const q = params ? "?" + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString() : "";
    const r = await explorerGet(net, `/tokens/${ca}/holders${q}`);
    items.push(...(r.items || []));
    if (!r.next_page_params) break;
    params = r.next_page_params;
  }
  return {
    status: "ok",
    token: { symbol: token.symbol || null, name: token.name || null, decimals, holders: token.holders_count != null ? Number(token.holders_count) : null },
    holders: items.slice(0, limit).map((h, i) => {
      const v = BigInt(h.value || "0");
      const addr = h.address && h.address.hash;
      return { rank: i + 1, address: addr, isContract: !!(h.address && h.address.is_contract), balance: formatUnits(v, decimals), percent: percentOf(v, total), url: `${net.explorer}/address/${addr}` };
    }),
  };
}
async function holders(limit) {
  if (!state.ca) return { code: 200, body: { status: "no_token", token: null, holders: [] } };
  const key = `${state.network}:${state.ca}:${limit}`;
  const hit = holderCache.get(key);
  if (hit && Date.now() - hit.at < HOLDERS_TTL) return { code: 200, body: hit.body };
  if (hit && hit.pending) return hit.pending;
  const pending = loadHolders(limit).then((body) => {
    holderCache.set(key, { at: Date.now(), body });
    return { code: 200, body };
  }, (e) => {
    console.error("holders:", e.message);
    if (hit && hit.body) { holderCache.set(key, { at: Date.now() - HOLDERS_TTL + 15_000, body: hit.body }); return { code: 200, body: hit.body }; }
    holderCache.delete(key);
    return { code: 502, body: { status: "unavailable", token: null, holders: [], error: "Holder data is temporarily unavailable." } };
  });
  holderCache.set(key, { ...(hit || {}), pending });
  return pending;
}

function publicView() { return { ca: state.ca || null, x: state.x || null }; }
function adminView() {
  return {
    ca: state.ca, x: state.x, network: state.network, explorerKeySet: !!state.explorerKey,
    recoveryLeft: Array.isArray(state.recovery) ? state.recovery.length : 0,
    networks: Object.entries(NETWORKS).map(([id, n]) => ({ id, name: n.name, chainId: n.chainId, explorer: n.explorer, keyed: !!n.proApi })),
  };
}

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    const p = url.pathname.replace(/\/+$/, "");
    const m = req.method;

    if (m === "GET" && p === "/api/site/healthz") return json(res, 200, { ok: true });
    if (m === "GET" && p === "/api/site/public") return json(res, 200, publicView());
    if (m === "GET" && p === "/api/site/holders") {
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
      const r = await holders(limit);
      return json(res, r.code, r.body, r.code === 200 ? { "Cache-Control": "public, max-age=30" } : {});
    }

    // Everything below changes state or is admin-only.
    if (!["GET", "HEAD"].includes(m)) {
      if (!ORIGINS.has(String(req.headers.origin || ""))) return fail(res, 403, "Origin not allowed");
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return fail(res, 415, "Use application/json");
    }

    if (m === "POST" && p === "/api/site/login") {
      const ip = clientIp(req);
      const rl = allowAttempt(ip);
      if (!rl.ok) return fail(res, 429, `Too many attempts. Try again in ${rl.retry}s.`, { "Retry-After": String(rl.retry) });
      const body = await readJson(req);
      const pw = typeof body.password === "string" ? body.password.slice(0, 256) : "";
      if (!verifyPassword(pw, state.auth)) return fail(res, 401, "Wrong password");
      const token = newSession();
      return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(token, SESSION_MS / 1000) });
    }
    if (m === "POST" && p === "/api/site/logout") {
      const k = authed(req);
      if (k) sessions.delete(k);
      return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    }

    if (m === "POST" && p === "/api/site/reset-password") {
      const rl = allowAttempt(clientIp(req));
      if (!rl.ok) return fail(res, 429, `Too many attempts. Try again in ${rl.retry}s.`, { "Retry-After": String(rl.retry) });
      const b = await readJson(req);
      const nxt = typeof b.next === "string" ? b.next : "";
      const code = normalizeCode(b.code);
      if (!code) return fail(res, 400, "Enter a recovery code in the form xxxx-xxxx-xxxx.");
      if (nxt.length < 12 || nxt.length > 256) return fail(res, 400, "New password must be 12 to 256 characters.");
      const i = findCode(code);
      if (i < 0) return fail(res, 401, "That recovery code is not valid or was already used.");
      const recovery = state.recovery.filter((_, j) => j !== i);
      const next = { ...state, auth: hashPassword(nxt), recovery };
      saveState(next);
      state = next;
      sessions.clear();
      const token = newSession();
      return json(res, 200, { ok: true, recoveryLeft: recovery.length }, { "Set-Cookie": sessionCookie(token, SESSION_MS / 1000) });
    }

    if (p.startsWith("/api/site/admin/")) {
      const k = authed(req);
      if (!k) return fail(res, 401, "Not signed in");

      if (m === "GET" && p === "/api/site/admin/settings") return json(res, 200, adminView());
      if (m === "PUT" && p === "/api/site/admin/settings") {
        const b = await readJson(req);
        const next = { ...state };
        if ("ca" in b) { const r = normalizeCa(b.ca); if (!r.ok) return fail(res, 400, r.error); next.ca = r.value; }
        if ("x" in b) { const r = normalizeX(b.x); if (!r.ok) return fail(res, 400, r.error); next.x = r.value; }
        if ("network" in b) { if (!NETWORKS[b.network]) return fail(res, 400, "Unknown network"); next.network = b.network; }
        if ("explorerKey" in b) {
          if (b.explorerKey === null || b.explorerKey === "") next.explorerKey = null;
          else if (typeof b.explorerKey === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(b.explorerKey.trim())) next.explorerKey = b.explorerKey.trim();
          else return fail(res, 400, "Explorer API key looks invalid");
        }
        saveState(next);
        state = next;
        holderCache.clear();
        return json(res, 200, adminView());
      }
      if (m === "POST" && p === "/api/site/admin/recovery") {
        const codes = Array.from({ length: CODE_SLOTS }, newCode);
        const next = { ...state, recovery: codes.map(hashCode) };
        saveState(next);
        state = next;
        return json(res, 200, { codes, recoveryLeft: codes.length });
      }
      if (m === "POST" && p === "/api/site/admin/password") {
        const b = await readJson(req);
        const cur = typeof b.current === "string" ? b.current : "";
        const nxt = typeof b.next === "string" ? b.next : "";
        const rl = allowAttempt(clientIp(req));
        if (!rl.ok) return fail(res, 429, `Too many attempts. Try again in ${rl.retry}s.`, { "Retry-After": String(rl.retry) });
        if (!verifyPassword(cur.slice(0, 256), state.auth)) return fail(res, 401, "Current password is wrong");
        if (nxt.length < 12 || nxt.length > 256) return fail(res, 400, "New password must be 12 to 256 characters");
        const next = { ...state, auth: hashPassword(nxt) };
        saveState(next);
        state = next;
        // Sign out every other session.
        for (const key of [...sessions.keys()]) if (key !== k) sessions.delete(key);
        return json(res, 200, { ok: true });
      }
    }
    return fail(res, 404, "Not found");
  } catch (e) {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : "Server error");
    if (!e.status) console.error(e);
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(PORT, HOST, () => console.log(`cepheus site api on http://${HOST}:${PORT} (network: ${state.network}, password ${state.auth ? "set" : "NOT set"})`));
