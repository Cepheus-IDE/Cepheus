/** ~/.cepheus/config.json + environment variables → a ProviderConfig. */
import { promises as fs, readFileSync, existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import * as path from "node:path";
import type { ApprovalMode, ProviderConfig } from "../core/types.js";
import { CEPHEUS_PROXY_BASE, expandAuto, presetById, PRESETS, type ProviderPreset } from "../core/providers.js";
import { cepheusHome } from "./host.js";

export interface CepheusConfig {
  provider?: string;
  model?: string;
  /** API keys by preset id (nvidia, anthropic, gemini, openai, openrouter, groq, ...). */
  keys?: Record<string, string>;
  /** Base URL override for OpenAI-compatible providers, by preset id. */
  baseUrls?: Record<string, string>;
  approvalMode?: ApprovalMode;
  effort?: string;
  /** Extra models tried (same provider) when the main one is rate limited or unavailable. */
  fallbackModels?: string[];
  customInstructions?: string;
}

export function configPath(): string {
  return path.join(cepheusHome(), "config.json");
}

export function loadConfig(): CepheusConfig {
  const p = configPath();
  if (!existsSync(p)) return {};
  try {
    const v = JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
    return v && typeof v === "object" ? v : {};
  } catch (e: any) {
    throw new Error(`Could not read ${p}: ${e.message}. Fix or delete the file, then run \`cepheus login\`.`);
  }
}

export function configExists(): boolean {
  return existsSync(configPath());
}

/** Writes the config readable by the current user only (0600 where the OS supports it). */
export function saveConfig(cfg: CepheusConfig) {
  const p = configPath();
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* Windows: ACLs of the user profile apply */
  }
}

export async function removeConfig() {
  await fs.rm(configPath(), { force: true });
}

export function mask(key: string | undefined | null): string {
  const k = (key ?? "").trim();
  if (!k) return "(none)";
  if (k.length <= 10) return "•".repeat(k.length);
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

const ENV_KEYS: Record<string, string[]> = {
  nvidia: ["NVIDIA_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  groq: ["GROQ_API_KEY"],
};

export function envKey(preset: string, env: NodeJS.ProcessEnv = process.env): { value: string; name: string } | null {
  for (const n of ENV_KEYS[preset] ?? []) {
    const v = env[n]?.trim();
    if (v) return { value: v, name: n };
  }
  return null;
}

/** Picks a provider from the config or environment; the keyless Cepheus free tier when neither has one. */
export function detectProvider(cfg: CepheusConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CEPHEUS_PROVIDER?.trim()) return env.CEPHEUS_PROVIDER.trim().toLowerCase();
  if (cfg.provider) return cfg.provider;
  if (envKey("nvidia", env)) return "nvidia";
  if (envKey("anthropic", env)) return "anthropic";
  if (envKey("gemini", env)) return "gemini";
  if (envKey("openai", env) || env.OPENAI_BASE_URL?.trim()) return "openai";
  if (envKey("openrouter", env)) return "openrouter";
  if (envKey("groq", env)) return "groq";
  return "cepheus";
}

export interface Resolved {
  config: ProviderConfig;
  preset: ProviderPreset;
  /** Where the key came from: env var name, "config", or null (none). */
  keySource: string | null;
  missingKey: boolean;
}

export function resolveProvider(
  cfg: CepheusConfig,
  overrides: { provider?: string; model?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Resolved | null {
  const id = (overrides.provider ?? detectProvider(cfg, env) ?? "").toLowerCase();
  if (!id) return null;
  const preset = presetById(id);
  if (!preset) throw new Error(`Unknown provider '${id}'. Choose one of: ${PRESETS.map((p) => p.id).join(", ")}.`);
  const fromEnv = envKey(preset.id, env);
  const fromCfg = cfg.keys?.[preset.id]?.trim();
  const apiKey = fromEnv?.value ?? fromCfg ?? "";
  let baseUrl = cfg.baseUrls?.[preset.id]?.trim() || preset.baseUrl;
  if (preset.id === "openai" && env.OPENAI_BASE_URL?.trim()) baseUrl = env.OPENAI_BASE_URL.trim();
  // Point the free tier at another proxy (e.g. a local run of proxy/server.mjs).
  if (preset.id === "cepheus") baseUrl = env.CEPHEUS_PROXY_URL?.trim().replace(/\/+$/, "") || cfg.baseUrls?.cepheus?.trim() || CEPHEUS_PROXY_BASE;
  const sameProvider = !overrides.provider || overrides.provider === cfg.provider;
  const model =
    overrides.model?.trim() ||
    env.CEPHEUS_MODEL?.trim() ||
    (sameProvider && (!env.CEPHEUS_PROVIDER || env.CEPHEUS_PROVIDER === cfg.provider) ? cfg.model?.trim() : "") ||
    preset.defaultModel;
  const base: ProviderConfig = {
    provider: preset.kind,
    source: preset.id,
    label: preset.label,
    apiKey,
    model,
    baseUrl,
    effort: cfg.effort,
  };
  const config = expandAuto(base, sameProvider ? cfg.fallbackModels ?? [] : []);
  // A custom OpenAI-compatible endpoint (OPENAI_BASE_URL) usually needs no key.
  const customOpenAI = preset.id === "openai" && baseUrl && !baseUrl.includes("api.openai.com");
  return {
    config,
    preset,
    keySource: fromEnv ? fromEnv.name : fromCfg ? "config" : null,
    missingKey: preset.needsKey && !apiKey && !customOpenAI,
  };
}
