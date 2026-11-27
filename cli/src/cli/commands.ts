/** `cepheus login`, first-run wizard, `cepheus models`, `cepheus doctor`, `cepheus config`. */
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { PRESETS, listModels, presetById, NVIDIA_DEFAULT_MODEL, type ProviderPreset } from "../core/providers.js";
import { loadCustomizations } from "../core/customize.js";
import { NodeToolHost } from "../node/host.js";
import { configPath, envKey, loadConfig, mask, resolveProvider, saveConfig, type CepheusConfig } from "../node/config.js";
import { Input } from "./input.js";
import { c, sym } from "./ansi.js";

const out = (s = "") => process.stdout.write(s + "\n");

export const FREE_OPTIONS = `${c.bold("Ways to start for free")}
  ${c.cyan("1)")} ${c.bold("Cepheus Free tier")} (the default) — nothing to set up: NVIDIA Nemotron models through the
     Cepheus proxy, no key needed. Fair-use limits: 20 requests per minute, 400 per day.
  ${c.cyan("2)")} ${c.bold("Your own NVIDIA developer key")} — higher limits and the full catalog. Sign in at
     ${c.cyan("https://build.nvidia.com")}, open a model and click "Get API Key" (starts with nvapi-).
  ${c.cyan("3)")} ${c.bold("Local models")} — install Ollama (${c.cyan("https://ollama.com")}) and run
     ${c.gray("ollama pull qwen2.5-coder")}, or start LM Studio's local server. Runs on your machine,
     no key and no internet needed (needs a reasonably powerful computer).
  ${c.cyan("4)")} ${c.bold("Bring your own key")} — Anthropic, Google Gemini, OpenAI, OpenRouter, Groq or any
     OpenAI-compatible endpoint. Some providers have free tiers; check their pricing pages.`;

/** Shown when Cepheus runs on the free tier because nothing is configured yet. */
export const FREE_TIER_NOTICE = `${c.bold("Welcome to Cepheus!")} You're on the ${c.bold("Cepheus Free tier")} (NVIDIA Nemotron, no key needed).
${c.gray("Fair-use limits: 20 requests/min, 400/day. For higher limits set NVIDIA_API_KEY (free at https://build.nvidia.com)")}
${c.gray("or another provider's key, or run `cepheus login`.")}`;

function presetLine(p: ProviderPreset, cfg: CepheusConfig): string {
  const env = envKey(p.id);
  const none = p.local ? "local, no key" : "free, no key (fair-use limits)";
  const key = env ? c.green(`key from ${env.name}`) : cfg.keys?.[p.id] ? c.green("key saved") : p.needsKey ? c.gray("needs a key") : c.gray(none);
  return `${p.label.padEnd(18)} ${key}`;
}

/** Interactive setup; returns the saved config (or null when cancelled). */
export async function runLogin(input: Input, opts: { firstRun?: boolean } = {}): Promise<CepheusConfig | null> {
  const cfg = loadConfig();
  if (opts.firstRun) {
    out();
    out(c.bold("Welcome to Cepheus") + c.gray(" — an AI coding agent for your terminal."));
    out("It works right away on the free Cepheus tier (fair-use limits); pick another provider or add your own key");
    out("for higher limits. You can change this any time with `cepheus login`.");
    out();
    out(FREE_OPTIONS);
    out();
  } else {
    showConfig(cfg);
  }
  const order = ["cepheus", "nvidia", "ollama", "lmstudio", "anthropic", "gemini", "openai", "openrouter", "groq", "llamacpp", "vllm"];
  const presets = order.map((id) => presetById(id)!).filter(Boolean);
  const current = Math.max(0, presets.findIndex((p) => p.id === cfg.provider));
  const idx = await input.choose(c.bold("Which provider do you want to use?"), presets.map((p) => presetLine(p, cfg)), current);
  if (idx == null) return null;
  const preset = presets[idx];
  const next: CepheusConfig = { ...cfg, provider: preset.id, keys: { ...(cfg.keys ?? {}) }, baseUrls: { ...(cfg.baseUrls ?? {}) } };

  if (preset.local || preset.id === "openai") {
    const def = cfg.baseUrls?.[preset.id] ?? preset.baseUrl ?? "";
    const url = (await input.ask(`Base URL ${c.gray(`[${def}]`)}: `))?.trim();
    if (url == null) return null;
    const chosen = url || def;
    if (chosen !== preset.baseUrl) next.baseUrls![preset.id] = chosen;
    else delete next.baseUrls![preset.id];
  }

  if (preset.needsKey || preset.id === "openai") {
    const env = envKey(preset.id);
    if (env) out(c.gray(`${env.name} is set in your environment; it takes precedence over a saved key.`));
    if (preset.keyUrl) out(`Get a key at ${c.cyan(preset.keyUrl)}`);
    const existing = next.keys![preset.id];
    const hint = existing ? ` ${c.gray(`[keep ${mask(existing)}]`)}` : env ? c.gray(" [use the environment variable]") : "";
    const key = await input.askSecret(`API key${hint}: `);
    if (key == null) return null;
    if (key.trim()) next.keys![preset.id] = key.trim();
    else if (!existing && !env && preset.needsKey) {
      out(c.yellow(`${sym.warn} No key entered. Set ${preset.envKey} or run \`cepheus login\` again.`));
    }
  }

  // Model: live list when reachable, else the suggestions.
  const resolved = resolveProvider({ ...next, model: undefined }, { provider: preset.id, model: preset.defaultModel === "auto" ? NVIDIA_DEFAULT_MODEL : preset.defaultModel });
  let models: string[] = [];
  if (resolved && !resolved.missingKey) {
    process.stdout.write(c.gray("Checking the connection and fetching models… "));
    try {
      models = (await listModels(resolved.config, { timeoutMs: 15_000 })).map((m) => m.id);
      out(c.green(`${sym.ok} ${models.length} models`));
    } catch (e: any) {
      out(c.yellow(`${sym.warn} ${String(e?.message ?? e).split("\n")[0]}`));
    }
  }
  const suggestions = preset.models.filter((m) => !models.length || models.includes(m));
  const choices: string[] = [];
  if (preset.id === "nvidia") choices.push("auto");
  choices.push(...suggestions);
  for (const m of models) if (!choices.includes(m) && choices.length < 25) choices.push(m);
  if (!choices.length && preset.defaultModel) choices.push(preset.defaultModel);
  const labels = choices.map((m) => (m === "auto" ? `auto ${c.gray("(recommended: tries the suggested models in order on rate limits / errors)")}` : m));
  labels.push(c.gray("type another model id"));
  const prevIdx = Math.max(0, choices.indexOf(cfg.provider === preset.id ? cfg.model ?? "" : ""));
  const mi = await input.choose(c.bold("Which model?"), labels, prevIdx);
  if (mi == null) return null;
  if (mi === choices.length) {
    const m = (await input.ask("Model id: "))?.trim();
    if (!m) return null;
    next.model = m;
  } else next.model = choices[mi];
  if (preset.local && models.length === 0) {
    out(c.gray(`Tip: make sure the server is running${preset.id === "ollama" ? ` and the model is pulled (ollama pull ${next.model})` : ""}.`));
  }
  saveConfig(next);
  out(c.green(`${sym.ok} Saved ${configPath()}`) + c.gray(" (readable only by you where the OS supports it)"));
  out(`Provider ${c.bold(preset.label)} ${sym.dot} model ${c.bold(next.model ?? "")}`);
  return next;
}

export function showConfig(cfg: CepheusConfig = loadConfig()) {
  out(c.bold("Configuration") + c.gray(`  ${configPath()}${existsSync(configPath()) ? "" : " (not created yet)"}`));
  out(`  provider  ${cfg.provider ?? c.gray("(not set)")}`);
  out(`  model     ${cfg.model ?? c.gray("(default)")}`);
  if (cfg.approvalMode) out(`  mode      ${cfg.approvalMode}`);
  for (const [k, v] of Object.entries(cfg.keys ?? {})) out(`  key       ${k.padEnd(11)} ${mask(v)}`);
  for (const [k, v] of Object.entries(cfg.baseUrls ?? {})) out(`  baseUrl   ${k.padEnd(11)} ${v}`);
  const envs = ["NVIDIA_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY"].filter((n) => process.env[n]?.trim());
  for (const n of envs) out(`  env       ${n.padEnd(11)} ${mask(process.env[n])}`);
  for (const n of ["OPENAI_BASE_URL", "CEPHEUS_PROVIDER", "CEPHEUS_MODEL", "CEPHEUS_PROXY_URL"]) if (process.env[n]?.trim()) out(`  env       ${n} = ${process.env[n]}`);
  out();
}

export async function runModels(overrides: { provider?: string; model?: string }, json = false): Promise<number> {
  const r = resolveProvider(loadConfig(), overrides);
  if (!r) {
    out("No provider configured. Run `cepheus login` (or set NVIDIA_API_KEY).");
    return 1;
  }
  if (r.missingKey) {
    out(c.red(`No API key for ${r.preset.label}. Set ${r.preset.envKey} or run \`cepheus login\`.`));
    return 1;
  }
  try {
    const models = await listModels(r.config);
    if (json) {
      out(JSON.stringify(models.map((m) => m.id)));
      return 0;
    }
    out(c.bold(`${r.preset.label} models`) + c.gray(` (${models.length}, live from the API)`));
    for (const m of models) out(`  ${m.id === r.config.model ? c.green("● ") : "  "}${m.id}${m.contextWindow ? c.gray(`  ${Math.round(m.contextWindow / 1000)}k ctx`) : ""}`);
    out(c.gray(`\nUse one with: cepheus --model <id>   (or /model inside the REPL)`));
    return 0;
  } catch (e: any) {
    out(c.red(String(e?.message ?? e)));
    return 1;
  }
}

async function probe(url: string, ms = 2500): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export async function runDoctor(root: string, overrides: { provider?: string; model?: string }): Promise<number> {
  let problems = 0;
  const ok = (label: string, detail = "") => out(`  ${c.green(sym.ok)} ${label}${detail ? c.gray("  " + detail) : ""}`);
  const bad = (label: string, detail = "") => {
    problems++;
    out(`  ${c.red(sym.fail)} ${label}${detail ? "  " + c.yellow(detail) : ""}`);
  };
  const info = (label: string, detail = "") => out(`  ${c.gray(sym.dot)} ${label}${detail ? c.gray("  " + detail) : ""}`);
  out(c.bold("Cepheus doctor"));

  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 18) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node}`, "Cepheus needs Node.js 18 or newer.");
  if (typeof fetch !== "function") bad("global fetch", "not available; upgrade Node.js");

  let cfg: CepheusConfig = {};
  try {
    cfg = loadConfig();
    const p = configPath();
    if (existsSync(p)) {
      let perm = "";
      if (process.platform !== "win32") {
        const mode = statSync(p).mode & 0o777;
        perm = `mode ${mode.toString(8)}`;
        if (mode & 0o077) {
          bad(`Config ${p}`, `${perm}: readable by others; run chmod 600 "${p}"`);
        } else ok(`Config ${p}`, perm);
      } else ok(`Config ${p}`);
    } else info("No config file", "run `cepheus login` (environment variables also work)");
  } catch (e: any) {
    bad("Config", e.message);
  }

  let resolved = null;
  try {
    resolved = resolveProvider(cfg, overrides);
  } catch (e: any) {
    bad("Provider", e.message);
  }
  if (!resolved) bad("Provider", "none configured: run `cepheus login` or set NVIDIA_API_KEY");
  else {
    const r = resolved;
    const key = r.keySource
      ? `key ${mask(r.config.apiKey)} from ${r.keySource}`
      : r.preset.needsKey
        ? "no key"
        : r.preset.id === "cepheus"
          ? "free tier, no key needed (20 requests/min, 400/day)"
          : "no key needed";
    if (r.missingKey) bad(`Provider ${r.preset.label}`, `${key}: set ${r.preset.envKey} or run \`cepheus login\``);
    else {
      ok(`Provider ${r.preset.label} · ${r.config.model}`, `${key}${r.config.fallbacks?.length ? ` · ${r.config.fallbacks.length} fallback models` : ""}`);
      process.stdout.write(c.gray("    checking reachability… "));
      const t0 = Date.now();
      try {
        const models = await listModels(r.config, { timeoutMs: 15_000 });
        out(c.green(`${sym.ok} reachable (${models.length} models, ${Date.now() - t0} ms)`));
        if (models.length && r.config.model && !models.some((m) => m.id === r.config.model))
          info(`Model '${r.config.model}' is not in the provider's list`, "it may still work; see `cepheus models`");
      } catch (e: any) {
        out("");
        bad("Provider not reachable", String(e?.message ?? e).split("\n")[0]);
      }
    }
  }

  const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (git.status === 0) ok(git.stdout.trim());
  else info("git not found", "optional: install from https://git-scm.com (faster file listing, .gitignore support)");

  try {
    const tags = await probe("http://localhost:11434/api/tags");
    const names = (tags?.models ?? []).map((m: any) => m.name);
    ok(`Ollama running`, names.length ? `${names.length} models: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}` : "no models pulled yet (ollama pull qwen2.5-coder)");
  } catch {
    info("Ollama not running", "optional: https://ollama.com for free local models");
  }
  try {
    const v = await probe("http://localhost:1234/v1/models", 1500);
    ok("LM Studio server running", `${(v?.data ?? []).length} models`);
  } catch {
    /* not installed: stay quiet */
  }

  const host = new NodeToolHost(root);
  out(c.bold(`\nWorkspace ${host.root}`));
  try {
    const cust = await loadCustomizations(host);
    info(`Instructions: ${cust.instructions.map((i) => i.path).join(", ") || "none"}`, cust.instructions.length ? "" : "create one with /init");
    info(`Skills: ${cust.skills.map((s) => s.name).join(", ") || "none"}`);
    info(`Hooks: ${cust.hooks.length}`);
    const mcp = path.join(root, ".cepheus", "mcp.json");
    if (existsSync(mcp)) {
      try {
        const v = JSON.parse(readFileSync(mcp, "utf8"));
        info(`MCP servers: ${Object.keys(v?.servers ?? v?.mcpServers ?? v ?? {}).join(", ")}`);
      } catch (e: any) {
        bad(".cepheus/mcp.json", e.message);
      }
    }
  } catch (e: any) {
    bad("Customizations", e.message);
  }
  out();
  out(problems ? c.yellow(`${problems} problem${problems > 1 ? "s" : ""} found.`) : c.green("Everything looks good."));
  return problems ? 1 : 0;
}

export { PRESETS };
