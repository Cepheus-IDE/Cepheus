//! Pure .env parsing and environment-variable usage extraction for the .env manager. No imports.

export interface EnvEntry { key: string; value: string; line: number }

/** Parses KEY=value lines (`export` prefix, quotes, inline comments after unquoted values). */
export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.length > 1) {
      let end = v.indexOf(q, 1);
      // Multi-line quoted values ("-----BEGIN …").
      if (end < 0) {
        let j = i + 1;
        let acc = v.slice(1);
        while (j < lines.length && !lines[j].includes(q)) acc += "\n" + lines[j++];
        if (j < lines.length) acc += "\n" + lines[j].slice(0, lines[j].indexOf(q));
        out.push({ key: m[1], value: acc, line: i + 1 });
        i = j;
        continue;
      }
      v = v.slice(1, end);
    } else {
      v = v.replace(/\s+#.*$/, "");
    }
    out.push({ key: m[1], value: v, line: i + 1 });
  }
  return out;
}

/** Regexes that capture the variable name in group 1. */
export const ENV_USAGE_PATTERNS: RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /env::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /Deno\.env\.get\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, // Go
  /\bENV\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, // Ruby
  /\bgetenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g, // PHP / C
  /\$_ENV\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, // PHP
];

/** One regex (Rust `regex` syntax, no lookaround) to find candidate lines with the search backend. */
export const ENV_USAGE_SEARCH = String.raw`process\.env|import\.meta\.env|os\.environ|os\.getenv|env::var|Deno\.env\.get|os\.Getenv|os\.LookupEnv|ENV\[|getenv\(|\$_ENV\[`;

/** Variables provided by runtimes/build tools, never expected in a .env file. */
const BUILTIN = new Set([
  "NODE_ENV", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "APPDATA",
  "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "PWD", "SHELL", "CI", "LANG", "TERM", "HOSTNAME", "COMSPEC", "SYSTEMROOT",
  "PROGRAMFILES", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OUT_DIR", "VITEST", "JEST_WORKER_ID",
  "npm_package_version", "npm_lifecycle_event", "PORT_OFFSET", "DEBUG",
]);
const BUILTIN_PREFIX = /^(?:CARGO_|npm_|TAURI_ENV_|RUST_|GITHUB_|RUNNER_|VERCEL_|NETLIFY|__)/;

export function isBuiltinEnv(key: string): boolean {
  return BUILTIN.has(key) || BUILTIN_PREFIX.test(key);
}

/** Variable names referenced in one line of code. */
export function extractEnvUsages(line: string): string[] {
  const found = new Set<string>();
  for (const re of ENV_USAGE_PATTERNS) {
    re.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = re.exec(line)); ) if (!isBuiltinEnv(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** Template files whose keys document what .env should contain. */
export function isEnvTemplate(name: string): boolean {
  return /^\.env\.(example|sample|template|dist|defaults?)$/i.test(name);
}

export interface EnvReport {
  /** Used in code, defined in no .env file */
  missingInEnv: { key: string; where: string[] }[];
  /** Listed in the template, absent from .env */
  missingFromEnv: string[];
  /** Defined in .env, absent from the template */
  missingFromExample: string[];
}

/** Compares defined keys (.env*), template keys and code usages. */
export function compareEnv(defined: Set<string>, template: Set<string> | null, usages: Map<string, string[]>): EnvReport {
  const known = new Set([...defined, ...(template ?? [])]);
  const missingInEnv = [...usages.entries()]
    .filter(([k]) => !defined.has(k) && !known.has(k))
    .map(([key, where]) => ({ key, where }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    missingInEnv,
    missingFromEnv: template ? [...template].filter((k) => !defined.has(k)).sort() : [],
    missingFromExample: template ? [...defined].filter((k) => !template.has(k)).sort() : [...defined].sort(),
  };
}

/** Appends `KEY=` lines for `keys` to a template's text (keeps its trailing newline style). */
export function appendKeys(text: string, keys: string[]): string {
  if (!keys.length) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const base = text && !text.endsWith("\n") ? text + eol : text;
  return base + keys.map((k) => `${k}=`).join(eol) + eol;
}
