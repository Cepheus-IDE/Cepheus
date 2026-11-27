//! Snippet variables (VS Code names) resolved before insertion. Tab stops, placeholders,
//! choices and variable transforms are left to Monaco's snippet engine.

export interface SnippetContext {
  filePath: string; // forward slashes
  workspace: string | null;
  selection: string;
  lineText: string;
  word: string;
  lineNumber: number; // 1-based
  clipboard: string;
  language: string;
  now?: Date;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HASH = ["python", "shell", "yaml", "ruby", "dockerfile", "perl", "r", "powershell", "makefile", "toml", "ini", "coffeescript", "julia", "elixir"];
const DASH = ["lua", "sql", "haskell"];
const MARKUP = ["html", "xml", "markdown", "vue", "svelte"];

const pad = (n: number) => String(n).padStart(2, "0");
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

function comments(lang: string) {
  if (HASH.includes(lang)) return { line: "#", start: lang === "python" ? '"""' : "#", end: lang === "python" ? '"""' : "" };
  if (DASH.includes(lang)) return { line: "--", start: lang === "lua" ? "--[[" : "/*", end: lang === "lua" ? "]]" : "*/" };
  if (MARKUP.includes(lang)) return { line: lang === "markdown" ? "<!--" : "<!--", start: "<!--", end: "-->" };
  if (lang === "css") return { line: "/*", start: "/*", end: "*/" };
  return { line: "//", start: "/*", end: "*/" };
}

export function variableValue(name: string, c: SnippetContext): string | undefined {
  const now = c.now ?? new Date();
  const file = c.filePath.split("/").pop() ?? "";
  const dir = c.filePath.includes("/") ? c.filePath.slice(0, c.filePath.lastIndexOf("/")) : "";
  const ws = c.workspace?.replace(/\\/g, "/").replace(/\/$/, "") ?? null;
  const cm = comments(c.language);
  const tz = -now.getTimezoneOffset();
  switch (name) {
    case "TM_SELECTED_TEXT": return c.selection;
    case "TM_CURRENT_LINE": return c.lineText;
    case "TM_CURRENT_WORD": return c.word;
    case "TM_LINE_INDEX": return String(c.lineNumber - 1);
    case "TM_LINE_NUMBER": return String(c.lineNumber);
    case "TM_FILENAME": return file;
    case "TM_FILENAME_BASE": return file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
    case "TM_DIRECTORY": return dir;
    case "TM_FILEPATH": return c.filePath;
    case "RELATIVE_FILEPATH": return ws && c.filePath.toLowerCase().startsWith(ws.toLowerCase() + "/") ? c.filePath.slice(ws.length + 1) : c.filePath;
    case "CLIPBOARD": return c.clipboard;
    case "WORKSPACE_NAME": return ws ? ws.split("/").pop() ?? "" : "";
    case "WORKSPACE_FOLDER": return ws ?? "";
    case "CURSOR_INDEX": return "0";
    case "CURSOR_NUMBER": return "1";
    case "CURRENT_YEAR": return String(now.getFullYear());
    case "CURRENT_YEAR_SHORT": return String(now.getFullYear()).slice(-2);
    case "CURRENT_MONTH": return pad(now.getMonth() + 1);
    case "CURRENT_MONTH_NAME": return MONTHS[now.getMonth()];
    case "CURRENT_MONTH_NAME_SHORT": return MONTHS[now.getMonth()].slice(0, 3);
    case "CURRENT_DATE": return pad(now.getDate());
    case "CURRENT_DAY_NAME": return DAYS[now.getDay()];
    case "CURRENT_DAY_NAME_SHORT": return DAYS[now.getDay()].slice(0, 3);
    case "CURRENT_HOUR": return pad(now.getHours());
    case "CURRENT_MINUTE": return pad(now.getMinutes());
    case "CURRENT_SECOND": return pad(now.getSeconds());
    case "CURRENT_SECONDS_UNIX": return String(Math.floor(now.getTime() / 1000));
    case "CURRENT_TIMEZONE_OFFSET": return (tz >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(tz) / 60)) + ":" + pad(Math.abs(tz) % 60);
    case "RANDOM": return String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    case "RANDOM_HEX": return hex(6);
    case "UUID": return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
    case "LINE_COMMENT": return cm.line;
    case "BLOCK_COMMENT_START": return cm.start;
    case "BLOCK_COMMENT_END": return cm.end;
    default: return undefined;
  }
}

const escape = (v: string) => v.replace(/[\\$}]/g, "\\$&");

/**
 * Replaces `$NAME`, `${NAME}` and `${NAME:default}` for known variables (an empty value falls back
 * to the default). Escapes (`\$`), tab stops and unknown names are kept verbatim.
 */
export function resolveSnippetVariables(body: string, c: SnippetContext): string {
  return body.replace(/(\\.)|\$([A-Z_][A-Z0-9_]*)|\$\{([A-Z_][A-Z0-9_]*)(?::((?:[^{}\\]|\\.)*))?\}/g, (all, esc, bare, braced, def) => {
    if (esc) return esc;
    const v = variableValue(bare ?? braced, c);
    if (v === undefined) return all;
    if (!v && def !== undefined) return def;
    return escape(v);
  });
}

/** VS Code snippet body (string or lines) → one string. */
export const bodyText = (b: unknown): string => (Array.isArray(b) ? b.map(String).join("\n") : typeof b === "string" ? b : "");
