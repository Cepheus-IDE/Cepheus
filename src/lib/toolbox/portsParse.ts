//! Pure parsers for "who listens on which TCP port" (netstat/tasklist on Windows, lsof or ss elsewhere)
//! and for "address already in use" errors in terminal output. No imports: unit-tested from Node.

export interface ListeningPort {
  port: number;
  pid: number | null;
  process: string;
  /** Local addresses the port is bound on (0.0.0.0, ::, 127.0.0.1 …) */
  addresses: string[];
}

function addPort(map: Map<string, ListeningPort>, port: number, pid: number | null, process: string, addr: string) {
  if (!port || port > 65535) return;
  const key = `${port}/${pid ?? "?"}`;
  const cur = map.get(key);
  if (cur) {
    if (!cur.addresses.includes(addr)) cur.addresses.push(addr);
    if (!cur.process && process) cur.process = process;
  } else map.set(key, { port, pid, process, addresses: [addr] });
}

/** Splits "addr:port" / "[v6]:port" / "*:port" / "addr%iface:port". */
export function splitHostPort(s: string): { addr: string; port: number } | null {
  const m = s.match(/^(.*):(\d+)$/);
  if (!m) return null;
  return { addr: m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, "") || "*", port: Number(m[2]) };
}

/** `tasklist /fo csv /nh` → pid → image name. */
export function parseTasklist(out: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]*)","(\d+)"/);
    if (m) names.set(Number(m[2]), m[1]);
  }
  return names;
}

/**
 * `netstat -ano` (Windows). The State column is localized ("LISTENING", "ABHÖREN" …), so a TCP row
 * counts as listening when its foreign address is the wildcard `0.0.0.0:0` / `[::]:0`.
 */
export function parseNetstat(out: string, names: Map<number, string> = new Map()): ListeningPort[] {
  const map = new Map<string, ListeningPort>();
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5 || !/^TCP/i.test(p[0])) continue;
    if (!/^(0\.0\.0\.0|\[::\]|\*):(0|\*)$/.test(p[2])) continue;
    const local = splitHostPort(p[1]);
    const pid = Number(p[p.length - 1]);
    if (!local || !Number.isFinite(pid)) continue;
    addPort(map, local.port, pid, names.get(pid) ?? (pid === 4 ? "System" : ""), local.addr);
  }
  return sortPorts([...map.values()]);
}

/** `lsof -nP +c 0 -iTCP -sTCP:LISTEN` (macOS / Linux). lsof escapes spaces in names as \x20. */
export function parseLsof(out: string): ListeningPort[] {
  const map = new Map<string, ListeningPort>();
  for (const line of out.split(/\r?\n/)) {
    if (!/\(LISTEN\)\s*$/.test(line)) continue;
    const p = line.trim().split(/\s+/);
    const pid = Number(p[1]);
    const name = p[p.length - 2]; // NAME column, right before "(LISTEN)"
    const hp = splitHostPort(name);
    if (!hp || !Number.isFinite(pid)) continue;
    const proc = p[0].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    addPort(map, hp.port, pid, proc, hp.addr);
  }
  return sortPorts([...map.values()]);
}

/** `ss -ltnp` (Linux). The process column is only filled for the user's own processes (or as root). */
export function parseSs(out: string): ListeningPort[] {
  const map = new Map<string, ListeningPort>();
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] !== "LISTEN" || p.length < 5) continue;
    const hp = splitHostPort(p[3]);
    if (!hp) continue;
    const users = line.match(/users:\(\("([^"]*)",pid=(\d+)/);
    addPort(map, hp.port, users ? Number(users[2]) : null, users?.[1] ?? "", hp.addr);
  }
  return sortPorts([...map.values()]);
}

/** `netstat -ltnp` (Linux net-tools): "tcp 0 0 0.0.0.0:3000 0.0.0.0:* LISTEN 1234/node". */
export function parseNetTools(out: string): ListeningPort[] {
  const map = new Map<string, ListeningPort>();
  for (const line of out.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (!/^tcp6?$/.test(p[0]) || p[5] !== "LISTEN") continue;
    const hp = splitHostPort(p[3]);
    if (!hp) continue;
    const owner = (p[6] ?? "").match(/^(\d+)\/(.*)$/);
    addPort(map, hp.port, owner ? Number(owner[1]) : null, owner?.[2] ?? "", hp.addr);
  }
  return sortPorts([...map.values()]);
}

/** Picks the parser from the output shape (the Unix command tries lsof, then ss, then netstat). */
export function parseUnixPorts(out: string): ListeningPort[] {
  if (/\(LISTEN\)/.test(out)) return parseLsof(out);
  if (/^tcp6?\s/m.test(out)) return parseNetTools(out);
  return parseSs(out);
}

function sortPorts(list: ListeningPort[]): ListeningPort[] {
  return list.sort((a, b) => a.port - b.port || (a.pid ?? 0) - (b.pid ?? 0));
}

/** Loopback or wildcard binds are reachable at http://localhost:PORT. */
export function isLocalReachable(p: ListeningPort): boolean {
  return p.addresses.some((a) => /^(\*|0\.0\.0\.0|::|127\.|::1$|::ffff:127\.|localhost)/.test(a));
}

const ADDR_IN_USE: RegExp[] = [
  /EADDRINUSE[^\n]*?:(\d{2,5})\b/, // Node: "listen EADDRINUSE: address already in use :::3000"
  /:(\d{2,5}): bind: address already in use/i, // Go
  /address already in use[^\n]*?(?:port|:)\s*(\d{2,5})\b/i, // generic "... in use 0.0.0.0:8000"
  /\bport (\d{2,5}) is (?:already )?in use(?!,? trying| trying)/i, // CRA, Rails, Django-ish messages
  /\bport (\d{2,5}) (?:is )?already (?:in use|allocated|bound)/i, // docker "port is already allocated"
  /Only one usage of each socket address[^\n]*?:(\d{2,5})\b/i, // Windows WSAEADDRINUSE with address
  /Bind for [\d.:*]+:(\d{2,5}) failed: port is already allocated/i,
];

/** The port named by an "address already in use" error in `text`, or null (dev servers that move on are ignored). */
export function detectPortInUse(text: string): number | null {
  for (const re of ADDR_IN_USE) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 65535) return n;
    }
  }
  return null;
}
