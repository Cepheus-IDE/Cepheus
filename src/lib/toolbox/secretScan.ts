//! Pure secret detection: provider token shapes, private key blocks and high-entropy values assigned
//! to *_KEY / *_SECRET / *_TOKEN / PASSWORD names. Shared by the commit guard (staged diff) and
//! presentation mode (masking in the editor). No imports: unit-tested from Node.

export interface SecretHit { kind: string; start: number; end: number }
export interface SecretFinding { file: string; line: number; kind: string; preview: string }

/** Known token shapes. Order matters: specific prefixes before the broad OpenAI `sk-` shape. */
const TOKEN_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "Private key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "AWS access key ID", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "Slack token", re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/g },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI API key", re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "NVIDIA API key", re: /\bnvapi-[A-Za-z0-9_-]{30,}/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "Stripe live key", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
];

/** NAME = value / NAME: value / "name": "value" where the name looks secret. */
const ASSIGN_RE =
  /(["']?)([A-Za-z0-9_.-]*(?:_KEY|_SECRET|_TOKEN|PASSWORD|PASSWD|_PWD|SECRET_KEY|ACCESS_KEY|API_KEY|APIKEY|PRIVATE_KEY|CLIENT_SECRET)|api[_-]?key|secret|token|password|passwd|auth[_-]?token|access[_-]?token|client[_-]?secret)\1\s*(?::=|=>|[:=])\s*(["'`]?)([^\s"'`,;]+)\3/gi;

const PLACEHOLDER = /^(?:x+|\*+|\.+|-+|0+|null|none|nil|undefined|true|false|changeme|change[_-]?me|example|sample|dummy|test|password|secret|token|todo|tbd|placeholder|redacted|your[_-].*|<.*>|\{.*\}|\$.*|%.*%)$/i;
const PLACEHOLDER_PART = /(your|example|placeholder|xxxx|changeme|replace|dummy|<|>|\{\{|\$\{)/i;
/** Values that are code, not literals: process.env.X, os.getenv(…), settings.apiKey, func(…) */
const CODE_VALUE = /^(?:process\.|import\.meta|os\.|env\.|self\.|this\.|config\.|settings\.|options\.|opts\.|props\.|req\.|ctx\.|[A-Za-z_$][\w$]*\(|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$|[A-Za-z_$][\w$]*$)/;

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A literal that is long, random-looking and not an obvious placeholder or code reference. */
export function looksLikeSecretValue(v: string, quoted: boolean): boolean {
  if (v.length < 12 || v.length > 400) return false;
  if (PLACEHOLDER.test(v) || PLACEHOLDER_PART.test(v)) return false;
  // Unquoted identifiers/expressions in code are references, not secrets (quoted ones are literals).
  if (!quoted && CODE_VALUE.test(v) && !/\d/.test(v.slice(0, 1)) && !/[0-9]/.test(v)) return false;
  if (/^(?:https?|file):\/\//i.test(v) && !/:[^/@]+@/.test(v)) return false; // plain URL (no credentials)
  if (/^\d+$/.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  if (classes < 2) return false;
  return shannonEntropy(v) >= 3.3;
}

/**
 * Secret-looking spans in one line. `loose` (presentation mode) masks any non-placeholder literal
 * assigned to a secret-ish name, not only high-entropy ones.
 */
export function findSecretsInLine(line: string, loose = false): SecretHit[] {
  const hits: SecretHit[] = [];
  const overlaps = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);
  for (const { kind, re } of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(line)); ) {
      if (!overlaps(m.index, m.index + m[0].length)) hits.push({ kind, start: m.index, end: m.index + m[0].length });
    }
  }
  ASSIGN_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = ASSIGN_RE.exec(line)); ) {
    const value = m[4];
    const quoted = !!m[3];
    const ok = loose ? value.length >= 4 && !PLACEHOLDER.test(value) && !(!quoted && CODE_VALUE.test(value)) : looksLikeSecretValue(value, quoted);
    if (!ok) continue;
    const start = m.index + m[0].length - value.length - m[3].length;
    const end = start + value.length;
    if (!overlaps(start, end)) hits.push({ kind: `Secret assigned to ${m[2]}`, start, end });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** `.env`, `.env.local`, `prod.env` … but not templates (.env.example / .sample / .template / .dist). */
export function isEnvFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (/\.(example|sample|template|dist|defaults?)$/i.test(name)) return false;
  return /^\.env(\..+)?$/i.test(name) || /\.env$/i.test(name);
}

export function maskValue(v: string): string {
  if (v.length <= 8) return "•".repeat(v.length);
  return `${v.slice(0, 4)}${"•".repeat(Math.min(12, v.length - 4))} (${v.length} chars)`;
}

/** Files that legitimately carry key-shaped strings (lockfile hashes, minified bundles). */
const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$|\.min\.(?:js|css)$|\.map$|\.svg$/i;

/**
 * Scans a unified diff (`git diff --cached -U0`) for secrets on added lines.
 * Returns findings plus staged .env files (added or modified, not deleted).
 */
export function scanDiff(diff: string): { findings: SecretFinding[]; envFiles: string[] } {
  const findings: SecretFinding[] = [];
  const envFiles: string[] = [];
  let file = "";
  let lineNo = 0;
  let skip = false;
  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) { file = ""; skip = false; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^"|"$/g, "");
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      skip = !file || SKIP_FILE.test(file);
      if (file && isEnvFile(file) && !envFiles.includes(file)) envFiles.push(file);
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { lineNo = Number(h[1]); continue; }
    if (!file) continue;
    if (line.startsWith("+")) {
      const text = line.slice(1);
      if (!skip && text.length < 5000) {
        for (const hit of findSecretsInLine(text)) {
          findings.push({ file, line: lineNo, kind: hit.kind, preview: maskValue(text.slice(hit.start, hit.end)) });
        }
      }
      lineNo++;
    } else if (line.startsWith(" ")) lineNo++;
  }
  return { findings, envFiles };
}
