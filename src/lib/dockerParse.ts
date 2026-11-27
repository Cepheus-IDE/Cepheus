//! Pure parsers for Docker / Podman CLI output (no Tauri imports, so they can be tested in Node).
//! Docker prints `--format '{{json .}}'` as one JSON object per line; Podman may print a JSON
//! array or pretty-printed objects, and uses different field names (Id vs ID, Names as an array,
//! Labels as an object, Ports as objects). Everything here accepts both.

export type Json = Record<string, any>;

/** Extracts every top-level JSON object from CLI output: JSON lines, a JSON array, pretty-printed objects, mixed with warnings. */
export function parseJsonObjects(text: string): Json[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  try {
    const v = JSON.parse(t);
    if (Array.isArray(v)) return v.flat(2).filter((x) => x && typeof x === "object" && !Array.isArray(x));
    if (v && typeof v === "object") return [v];
  } catch { /* fall through to the scanner */ }
  // Scanner: a top-level object starts at a `{` that begins a line (or follows `[` / `,` of an
  // array); a `{` in column 0 while inside an unterminated object restarts (the earlier one was junk).
  const out: Json[] = [];
  let depth = 0, start = -1, inStr = false, esc = false, prev = "\n";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    const before = prev;
    if (!/\s/.test(c) || c === "\n") prev = c;
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === "{") {
      const lineStart = before === "\n" || before === "[" || before === ",";
      if (depth === 0) { if (!lineStart) continue; start = i; }
      else if (i === 0 || t[i - 1] === "\n") { start = i; depth = 0; }
      depth++;
    }
    else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { const o = JSON.parse(t.slice(start, i + 1)); if (o && typeof o === "object") out.push(o); } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return out;
}

/** Case-insensitive field lookup with aliases (`pick(o, "ID", "Id")`). */
export function pick(o: Json | null | undefined, ...keys: string[]): any {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase().replace(/_/g, ""), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase().replace(/_/g, ""));
    if (real !== undefined && o[real] !== undefined && o[real] !== null) return o[real];
  }
  return undefined;
}

const str = (v: any): string => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(" ") : String(v));

// ------------------------------------------------------------------ sizes

const UNITS: Record<string, number> = {
  b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
  kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
  k: 1e3, m: 1e6, g: 1e9, t: 1e12,
};

/** "1.2GB" → 1.2e9, "512MiB" → 536870912, "0B" → 0, "N/A" / "" → null. Numbers pass through. */
export function parseSize(s: string | number | null | undefined): number | null {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  if (!s) return null;
  const m = String(s).trim().match(/^([\d.]+)\s*([a-z]*)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  const mul = unit === "" ? 1 : UNITS[unit];
  return mul === undefined ? null : Math.round(n * mul);
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let v = n, i = -1;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

/** "1.2kB / 648B" → [1200, 648]. */
export function parsePair(s: string | null | undefined): [number | null, number | null] {
  if (!s) return [null, null];
  const [a, b] = String(s).split("/").map((x) => x.trim());
  return [parseSize(a), parseSize(b)];
}

export function parsePercent(s: string | number | null | undefined): number | null {
  if (typeof s === "number") return s;
  if (!s) return null;
  const n = parseFloat(String(s).replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ labels, ports

/** "a=1,b=2,files=x.yml,y.yml" (values may contain commas) or an object → map. */
export function parseLabels(v: any): Record<string, string> {
  if (!v) return {};
  if (typeof v === "object" && !Array.isArray(v)) {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) out[k] = str(val);
    return out;
  }
  const out: Record<string, string> = {};
  for (const part of String(v).split(/,(?=[A-Za-z0-9_.\-/]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return out;
}

export interface PortMap { hostIp: string; hostPort: number | null; hostPortEnd: number | null; containerPort: number; containerPortEnd: number | null; proto: string }

function range(s: string): [number, number | null] {
  const [a, b] = s.split("-");
  return [parseInt(a, 10), b ? parseInt(b, 10) : null];
}

/**
 * Docker: "0.0.0.0:8080->80/tcp, :::8080->80/tcp, [::]:9000-9001->9000-9001/tcp, 443/tcp".
 * Podman: [{ host_ip, host_port, container_port, range, protocol }]. IPv4/IPv6 duplicates are merged.
 */
export function parsePorts(v: any): PortMap[] {
  const out: PortMap[] = [];
  if (Array.isArray(v)) {
    for (const p of v) {
      if (!p || typeof p !== "object") continue;
      const hp = Number(pick(p, "host_port", "HostPort", "PublicPort")) || null;
      const cp = Number(pick(p, "container_port", "ContainerPort", "PrivatePort")) || 0;
      const n = Number(pick(p, "range")) || 1;
      if (!cp) continue;
      out.push({
        hostIp: str(pick(p, "host_ip", "HostIp", "IP")), hostPort: hp, hostPortEnd: hp && n > 1 ? hp + n - 1 : null,
        containerPort: cp, containerPortEnd: n > 1 ? cp + n - 1 : null, proto: str(pick(p, "protocol", "Type", "Protocol")) || "tcp",
      });
    }
  } else if (typeof v === "string") {
    for (const raw of v.split(",")) {
      const s = raw.trim();
      if (!s) continue;
      const m = s.match(/^(?:(.*):(\d+(?:-\d+)?)->)?(\d+(?:-\d+)?)(?:\/(\w+))?$/);
      if (!m) continue;
      const [cp, cpe] = range(m[3]);
      const [hp, hpe] = m[2] ? range(m[2]) : [null, null];
      out.push({ hostIp: (m[1] ?? "").replace(/^\[|\]$/g, ""), hostPort: hp, hostPortEnd: hpe, containerPort: cp, containerPortEnd: cpe, proto: m[4] ?? "tcp" });
    }
  }
  const seen = new Set<string>();
  return out.filter((p) => {
    const k = `${p.hostPort}-${p.hostPortEnd}>${p.containerPort}-${p.containerPortEnd}/${p.proto}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function portLabel(p: PortMap): string {
  const c = `${p.containerPort}${p.containerPortEnd ? `-${p.containerPortEnd}` : ""}/${p.proto}`;
  return p.hostPort ? `${p.hostPort}${p.hostPortEnd ? `-${p.hostPortEnd}` : ""}→${c}` : c;
}

/** A published TCP port reachable from this machine (bound to all interfaces or loopback). */
export function isBrowsable(p: PortMap): boolean {
  return !!p.hostPort && p.proto === "tcp" && ["", "0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(p.hostIp);
}

// ------------------------------------------------------------------ entities

export type ContainerState = "running" | "paused" | "exited" | "created" | "restarting" | "removing" | "dead" | "unknown";

export interface Container {
  id: string; name: string; image: string; imageId: string; command: string; state: ContainerState; status: string;
  ports: PortMap[]; created: string; createdTs: number | null; labels: Record<string, string>;
  project: string | null; service: string | null;
}

function normState(s: string, status: string): ContainerState {
  const v = (s || status).toLowerCase();
  if (/paused/.test(v) || /\(paused\)/i.test(status)) return "paused";
  if (/^up|running/.test(v)) return "running";
  for (const k of ["exited", "created", "restarting", "removing", "dead"] as const) if (v.startsWith(k)) return k;
  if (v === "stopped" || v === "configured") return v === "stopped" ? "exited" : "created";
  return "unknown";
}

/** Unix seconds / ms / ISO / Docker's "2024-01-02 15:04:05 +0100 CET" → ms. */
export function parseTime(v: any): number | null {
  if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string" || !v) return null;
  const m = v.match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.\d+)?\s*([+-]\d\d:?\d\d|Z)?/);
  if (!m) return null;
  const tz = m[3] ? (m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d\d)(\d\d)$/, "$1:$2")) : "Z";
  const t = Date.parse(`${m[1]}T${m[2]}${tz}`);
  return Number.isFinite(t) ? t : null;
}

export function ago(ms: number | null, now = Date.now()): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const units: [number, string][] = [[31536000, "year"], [2592000, "month"], [604800, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [n, u] of units) if (s >= n) { const k = Math.floor(s / n); return `${k} ${u}${k > 1 ? "s" : ""} ago`; }
  return "just now";
}

export function parseContainers(text: string): Container[] {
  return parseJsonObjects(text).map((o) => {
    const names = pick(o, "Names", "Name");
    const name = (Array.isArray(names) ? names[0] : str(names).split(",")[0] ?? "").replace(/^\//, "");
    const labels = parseLabels(pick(o, "Labels"));
    const status = str(pick(o, "Status"));
    const createdRaw = pick(o, "Created");
    const createdAt = pick(o, "CreatedAt");
    const createdTs = parseTime(createdRaw) ?? parseTime(createdAt);
    const running = str(pick(o, "RunningFor"));
    return {
      id: str(pick(o, "ID", "Id")),
      name,
      image: str(pick(o, "Image")),
      imageId: str(pick(o, "ImageID", "ImageId")),
      command: str(pick(o, "Command")).replace(/^"|"$/g, ""),
      state: normState(str(pick(o, "State")), status),
      status,
      ports: parsePorts(pick(o, "Ports")),
      created: running || (createdTs ? ago(createdTs) : str(createdAt)),
      createdTs,
      labels,
      project: labels["com.docker.compose.project"] ?? labels["io.podman.compose.project"] ?? null,
      service: labels["com.docker.compose.service"] ?? labels["io.podman.compose.service"] ?? null,
    };
  }).filter((c) => c.id);
}

export interface Image { id: string; repository: string; tag: string; ref: string; size: number | null; sizeText: string; created: string; createdTs: number | null; dangling: boolean; containers: number | null }

export function parseImages(text: string): Image[] {
  const out: Image[] = [];
  for (const o of parseJsonObjects(text)) {
    const id = str(pick(o, "ID", "Id")).replace(/^sha256:/, "");
    let repo = str(pick(o, "Repository"));
    let tag = str(pick(o, "Tag"));
    const names = pick(o, "Names");
    if (!repo && Array.isArray(names) && names[0]) {
      const n = String(names[0]);
      const i = n.lastIndexOf(":");
      repo = i > n.lastIndexOf("/") ? n.slice(0, i) : n;
      tag = i > n.lastIndexOf("/") ? n.slice(i + 1) : "latest";
    }
    const dangling = (!repo || repo === "<none>") && (!tag || tag === "<none>");
    const sizeRaw = pick(o, "Size", "VirtualSize");
    const size = parseSize(sizeRaw);
    const createdTs = parseTime(pick(o, "Created")) ?? parseTime(pick(o, "CreatedAt"));
    const cont = pick(o, "Containers");
    out.push({
      id, repository: repo || "<none>", tag: tag || "<none>",
      ref: dangling ? id.slice(0, 12) : `${repo}:${tag || "latest"}`,
      size, sizeText: typeof sizeRaw === "string" ? sizeRaw : formatBytes(size),
      created: str(pick(o, "CreatedSince")) || (createdTs ? ago(createdTs) : str(pick(o, "CreatedAt"))),
      createdTs, dangling,
      containers: typeof cont === "number" ? cont : /^\d+$/.test(str(cont)) ? Number(cont) : null,
    });
  }
  return out.filter((i) => i.id);
}

/** Whether any container uses this image (by name, name:latest or ID prefix). */
export function imageInUse(img: Image, containers: Container[]): boolean {
  if (img.containers !== null && img.containers > 0) return true;
  const short = img.id.slice(0, 12);
  return containers.some((c) => {
    const ci = c.image.replace(/^sha256:/, "");
    const cid = c.imageId.replace(/^sha256:/, "");
    if (cid && (cid.startsWith(short) || img.id.startsWith(cid))) return true;
    if (ci === img.ref || (img.tag === "latest" && ci === img.repository)) return true;
    // Podman prefixes short names with docker.io/library/ or localhost/.
    const strip = (s: string) => s.replace(/^(docker\.io\/(library\/)?|localhost\/)/, "");
    return strip(ci) === strip(img.ref) || (img.tag === "latest" && strip(ci) === strip(img.repository)) || ci.startsWith(short);
  });
}

export interface Stats { id: string; name: string; cpu: number | null; memUsed: number | null; memLimit: number | null; memPerc: number | null; netRx: number | null; netTx: number | null; blockRead: number | null; blockWrite: number | null; pids: number | null }

export function parseStats(text: string): Stats[] {
  return parseJsonObjects(text).map((o) => {
    const [memUsed, memLimit] = parsePair(pick(o, "MemUsage", "mem_usage"));
    const [netRx, netTx] = parsePair(pick(o, "NetIO", "net_io"));
    const [blockRead, blockWrite] = parsePair(pick(o, "BlockIO", "block_io"));
    const pids = parseInt(str(pick(o, "PIDs", "PIDS", "pids")), 10);
    return {
      id: str(pick(o, "ID", "Id", "Container")),
      name: str(pick(o, "Name")).replace(/^\//, ""),
      cpu: parsePercent(pick(o, "CPUPerc", "cpu_percent", "CPU")),
      memUsed, memLimit,
      memPerc: parsePercent(pick(o, "MemPerc", "mem_percent")),
      netRx, netTx, blockRead, blockWrite,
      pids: Number.isFinite(pids) ? pids : null,
    };
  }).filter((s) => s.id || s.name);
}

export interface Volume { name: string; driver: string; mountpoint: string; size: number | null; links: number | null; labels: Record<string, string> }
export interface Network { id: string; name: string; driver: string; scope: string }

export function parseVolumes(text: string): Volume[] {
  return parseJsonObjects(text).map((o) => {
    const links = str(pick(o, "Links", "RefCount"));
    return {
      name: str(pick(o, "Name")), driver: str(pick(o, "Driver")), mountpoint: str(pick(o, "Mountpoint")),
      size: parseSize(pick(o, "Size")), links: /^\d+$/.test(links) ? Number(links) : null, labels: parseLabels(pick(o, "Labels")),
    };
  }).filter((v) => v.name);
}

export function parseNetworks(text: string): Network[] {
  return parseJsonObjects(text).map((o) => ({
    id: str(pick(o, "ID", "Id", "network_id")), name: str(pick(o, "Name")), driver: str(pick(o, "Driver")), scope: str(pick(o, "Scope")) || "local",
  })).filter((n) => n.name);
}

export interface DfRow { type: string; total: number | null; active: number | null; size: number | null; sizeText: string; reclaimable: number | null; reclaimableText: string }

/** `docker system df --format '{{json .}}'` rows (Images, Containers, Local Volumes, Build Cache). */
export function parseDf(text: string): DfRow[] {
  return parseJsonObjects(text).filter((o) => pick(o, "Type")).map((o) => {
    const sizeText = str(pick(o, "Size"));
    const recl = str(pick(o, "Reclaimable"));
    const total = parseInt(str(pick(o, "TotalCount", "Total")), 10);
    const active = parseInt(str(pick(o, "Active")), 10);
    return {
      type: str(pick(o, "Type")), total: Number.isFinite(total) ? total : null, active: Number.isFinite(active) ? active : null,
      size: parseSize(pick(o, "Size")), sizeText, reclaimable: parseSize(recl), reclaimableText: recl,
    };
  });
}

/** Volume sizes from `docker system df -v --format '{{json .}}'` ({ Volumes: [{ Name, Size }] }). */
export function parseDfVolumes(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of parseJsonObjects(text)) {
    const vols = pick(o, "Volumes");
    if (!Array.isArray(vols)) continue;
    for (const v of vols) {
      const n = str(pick(v, "Name"));
      const s = parseSize(pick(v, "Size"));
      if (n && s !== null) out[n] = s;
    }
  }
  return out;
}

export interface VersionInfo { client: string | null; server: string | null; serverOs: string; apiVersion: string; context: string; engine: "docker" | "podman" }

/** `docker version --format '{{json .}}'` (Server may be null when the daemon is down). */
export function parseVersion(text: string): VersionInfo | null {
  const o = parseJsonObjects(text)[0];
  if (!o) return null;
  const c = pick(o, "Client") ?? null;
  const s = pick(o, "Server") ?? null;
  const comps: any[] = Array.isArray(pick(s, "Components")) ? pick(s, "Components") : [];
  const podman = /podman/i.test(JSON.stringify(o).slice(0, 4000)) && !comps.some((x) => /^Engine$/i.test(str(pick(x, "Name"))));
  const serverVer = s ? str(pick(s, "Version")) || null : null;
  return {
    client: c ? str(pick(c, "Version")) || null : null,
    server: serverVer,
    serverOs: s ? [str(pick(s, "Os")), str(pick(s, "Arch"))].filter(Boolean).join("/") || str(pick(s, "OsArch")) : "",
    apiVersion: str(pick(s, "ApiVersion", "APIVersion")) || str(pick(c, "ApiVersion", "APIVersion")),
    context: str(pick(c, "Context")),
    engine: podman ? "podman" : "docker",
  };
}

/** Daemon-not-running messages from Docker / Podman on all platforms. */
export function isDaemonDown(stderr: string): boolean {
  return /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker_engine|dockerDesktopLinuxEngine|connection refused|cannot connect to podman|podman machine|no such file or directory.*docker\.sock|permission denied.*docker\.sock|The system cannot find the file specified/i.test(stderr);
}

// ------------------------------------------------------------------ misc

/** Compose's default project name for a directory: lowercased, only [a-z0-9_-]. */
export function composeProjectName(dirName: string): string {
  return dirName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** Top-level `name:` of a compose file, if any. */
export function composeNameFromYaml(yaml: string): string | null {
  const m = yaml.match(/^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*(#.*)?$/m);
  return m ? m[1].toLowerCase() : null;
}

/** Strips ANSI escape codes (colored log output). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

/** Splits streamed chunks into complete lines, keeping the unfinished tail. */
export function splitLines(buf: string, chunk: string): { lines: string[]; rest: string } {
  const all = (buf + chunk).replace(/\r\n/g, "\n");
  const parts = all.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.replace(/\r/g, "")), rest };
}

/** "8080:80, 3000:3000/udp" → ["8080:80", "3000:3000/udp"] (validated). */
export function parsePortSpecs(s: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const p of s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^((\d{1,3}\.){3}\d{1,3}:)?(\d{1,5}(-\d{1,5})?:)?\d{1,5}(-\d{1,5})?(\/(tcp|udp|sctp))?$/.test(p)) ok.push(p); else bad.push(p);
  }
  return { ok, bad };
}

/** "A=1\nB=two words" → ["A=1", "B=two words"] (lines without "=" or with a bad key are rejected). */
export function parseEnvSpecs(s: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [], bad: string[] = [];
  for (const line of s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"))) {
    if (/^[A-Za-z_][A-Za-z0-9_.]*=/.test(line)) ok.push(line); else bad.push(line);
  }
  return { ok, bad };
}
