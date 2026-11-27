/** Tiny argv parser (no dependencies). */
import type { ApprovalMode } from "../core/types.js";

export interface Args {
  command: string | null;
  prompt: string;
  mode?: ApprovalMode;
  plan: boolean;
  model?: string;
  provider?: string;
  json: boolean;
  cwd?: string;
  help: boolean;
  version: boolean;
  verbose: boolean;
  noColor: boolean;
  port?: number;
  host?: string;
  open: boolean;
  agent?: string;
  errors: string[];
}

const COMMANDS = new Set(["login", "models", "doctor", "web", "config", "help"]);

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: null, prompt: "", plan: false, json: false, help: false, version: false, verbose: false, noColor: false, open: false, errors: [] };
  const rest: string[] = [];
  const take = (i: number, name: string): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith("--") && v.length > 2)) {
      a.errors.push(`${name} needs a value`);
      return undefined;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline: string | undefined;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const val = (name: string) => {
      if (inline !== undefined) return inline;
      const v = take(i, name);
      if (v !== undefined) i++;
      return v;
    };
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      case "-y":
      case "--yes":
        a.mode = "turbo";
        break;
      case "--mode": {
        const m = val("--mode");
        if (m === "ask" || m === "auto-edit" || m === "turbo") a.mode = m;
        else if (m !== undefined) a.errors.push(`--mode must be ask, auto-edit or turbo (got '${m}')`);
        break;
      }
      case "--plan":
        a.plan = true;
        break;
      case "-m":
      case "--model":
        a.model = val("--model");
        break;
      case "-p":
      case "--provider":
        a.provider = val("--provider")?.toLowerCase();
        break;
      case "--json":
        a.json = true;
        break;
      case "-C":
      case "--cwd":
        a.cwd = val("--cwd");
        break;
      case "--verbose":
        a.verbose = true;
        break;
      case "--no-color":
        a.noColor = true;
        break;
      case "--port": {
        const p = parseInt(val("--port") ?? "", 10);
        if (Number.isFinite(p) && p > 0 && p < 65536) a.port = p;
        else a.errors.push("--port must be a number between 1 and 65535");
        break;
      }
      case "--host":
        a.host = val("--host");
        break;
      case "--open":
        a.open = true;
        break;
      case "--agent":
        a.agent = val("--agent");
        break;
      case "--":
        rest.push(...argv.slice(i + 1));
        i = argv.length;
        break;
      default:
        if (arg.startsWith("-") && arg.length > 1 && !/^-\d/.test(arg)) a.errors.push(`Unknown option ${arg}`);
        else rest.push(argv[i]);
    }
  }
  // A sub-command is a single bare word; anything longer is a prompt ("cepheus login page is broken").
  if (rest.length === 1 && COMMANDS.has(rest[0])) a.command = rest[0];
  // `cepheus web <folder>` serves that folder.
  else if (rest.length === 2 && rest[0] === "web" && !a.cwd) { a.command = "web"; a.cwd = rest[1]; }
  else a.prompt = rest.join(" ").trim();
  if (a.command === "help") {
    a.help = true;
    a.command = null;
  }
  return a;
}
