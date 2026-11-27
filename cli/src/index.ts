#!/usr/bin/env node
/** Cepheus CLI entry point: `cepheus [prompt] [options]`, `cepheus login|models|doctor|web|config`. */
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "./cli/args.js";
import { c, setColor } from "./cli/ansi.js";
import { VERSION } from "./version.js";
import { configExists, loadConfig, resolveProvider, type Resolved } from "./node/config.js";
import { FREE_OPTIONS, FREE_TIER_NOTICE, runDoctor, runLogin, runModels, showConfig } from "./cli/commands.js";
import { Input } from "./cli/input.js";
import { Controller, runJson, runOnce, runRepl } from "./cli/session.js";
import { runWeb } from "./cli/web.js";

const HELP = () => `${c.bold("Cepheus")} ${c.gray("v" + VERSION)} — an open-source AI coding agent for your terminal

${c.bold("Usage")}
  cepheus                         interactive session in the current folder
                                  (no setup needed: uses the free Cepheus tier when no key is configured)
  cepheus "<task>"                run one task, then exit
  cepheus login                   choose a provider, model and key (saved to ~/.cepheus/config.json)
  cepheus models                  list the models of the current provider (live)
  cepheus doctor                  check Node.js, config, provider reachability, git and Ollama
  cepheus web [folder] [--port 4000] [--host 127.0.0.1] [--open]
                                  start the browser UI for this folder
  cepheus config                  show the configuration (keys masked)

${c.bold("Options")}
  -y, --yes                       turbo mode: run edits and commands without asking
      --mode ask|auto-edit|turbo  approval mode (default: ask)
      --plan                      plan mode: read-only research that ends with a plan
  -m, --model <id>                model id, or "auto" for fallback across suggested models
  -p, --provider <id>             cepheus (free), nvidia, anthropic, gemini, openai, openrouter, groq, ollama, lmstudio, llamacpp, vllm
      --json                      print newline-delimited JSON events (for scripts and tools)
  -C, --cwd <dir>                 workspace folder (default: current folder)
      --agent <name>              use a custom agent from .cepheus/agents/<name>.md
      --verbose                   show thinking, command output and debug events
      --no-color                  disable colors (NO_COLOR is honored too)
  -v, --version                   print the version
  -h, --help                      show this help

${c.bold("Examples")}
  cepheus "fix the failing test"
  cepheus --plan "add dark mode to the settings page"
  cepheus -y "run the linter and fix all warnings"
  cepheus -p ollama -m qwen2.5-coder "explain src/index.ts"
  cepheus --json --yes "update the changelog" > events.ndjson
  NVIDIA_API_KEY=nvapi-... cepheus

${c.bold("Environment")}
  NVIDIA_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY,
  OPENAI_BASE_URL, CEPHEUS_PROVIDER, CEPHEUS_MODEL, CEPHEUS_HOME (default ~/.cepheus), NO_COLOR,
  CEPHEUS_PROXY_URL (free-tier proxy, default https://api.cepheus.codes/v1)

Docs: https://github.com/Cepheus-IDE/Cepheus/tree/main/cli#readme`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const ch of process.stdin) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.noColor || args.json) setColor(false);
  if (args.errors.length) {
    process.stderr.write(args.errors.map((e) => `cepheus: ${e}`).join("\n") + "\nRun `cepheus --help` for usage.\n");
    return 2;
  }
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (args.help) {
    process.stdout.write(HELP() + "\n");
    return 0;
  }
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    process.stderr.write(`Cepheus needs Node.js 18 or newer (you have ${process.versions.node}).\n`);
    return 1;
  }

  const root = path.resolve(args.cwd ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stderr.write(`cepheus: folder not found: ${root}\n`);
    return 2;
  }
  const overrides = { provider: args.provider, model: args.model };

  switch (args.command) {
    case "login": {
      const input = new Input();
      try {
        const r = await runLogin(input, {});
        return r ? 0 : 1;
      } finally {
        input.close();
      }
    }
    case "config":
      showConfig();
      return 0;
    case "models":
      return runModels(overrides, args.json);
    case "doctor":
      return runDoctor(root, overrides);
    case "web":
      return runWeb({ root, port: args.port ?? 4000, host: args.host ?? "127.0.0.1", open: args.open });
  }

  // --- agent ------------------------------------------------------------------------------
  let cfgFile = loadConfig();
  let resolved: Resolved | null = resolveProvider(cfgFile, overrides);
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !args.json;
  if (!resolved || resolved.missingKey) {
    if (interactive) {
      const input = new Input();
      try {
        if (resolved?.missingKey) {
          process.stdout.write(c.yellow(`No API key found for ${resolved.preset.label} (set ${resolved.preset.envKey} or save one now).\n`));
        }
        const saved = await runLogin(input, { firstRun: !resolved });
        if (!saved) return 1;
      } finally {
        input.close();
      }
      cfgFile = loadConfig();
      resolved = resolveProvider(cfgFile, overrides);
    }
    if (!resolved || resolved.missingKey) {
      const msg = resolved
        ? `No API key for ${resolved.preset.label}. Set ${resolved.preset.envKey} or run \`cepheus login\`.`
        : "No model provider configured. Run `cepheus login`, or set NVIDIA_API_KEY (or another provider key).";
      if (args.json) process.stdout.write(JSON.stringify({ type: "error", sessionId: "", message: msg }) + "\n");
      else process.stderr.write(`${c.red(msg)}\n\n${FREE_OPTIONS}\n`);
      return 1;
    }
  }

  // Nothing configured: say once per run that the free tier is in use and how to raise the limits.
  if (resolved.preset.id === "cepheus" && !args.provider && !configExists() && !args.json) {
    process.stderr.write(FREE_TIER_NOTICE + "\n\n");
  }

  const ctl = new Controller({
    root,
    resolved,
    cfgFile,
    mode: args.mode ?? cfgFile.approvalMode ?? "ask",
    plan: args.plan,
    verbose: args.verbose,
    agent: args.agent,
  });

  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY && !args.json) prompt = (await readStdin()).trim();
  if (args.json) {
    if (!prompt) {
      process.stdout.write(JSON.stringify({ type: "error", sessionId: "", message: "--json needs a task, e.g. cepheus --json \"fix the test\"" }) + "\n");
      return 2;
    }
    return runJson(ctl, prompt);
  }
  if (prompt) {
    const input = process.stdin.isTTY ? new Input() : null;
    try {
      return await runOnce(ctl, input, prompt);
    } finally {
      input?.close();
    }
  }
  return runRepl(ctl, new Input());
}

main().then(
  (code) => {
    if (code >= 0) {
      process.exitCode = code;
      // Don't let stray handles (spinners, MCP servers) keep a finished run alive.
      setTimeout(() => process.exit(code), 50).unref();
    }
  },
  (e) => {
    process.stderr.write(`cepheus: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
