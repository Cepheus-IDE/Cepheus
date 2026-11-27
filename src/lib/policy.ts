// Organization policy (read by the backend from the system-wide policy.json; see src-tauri/src/policy.rs).
// Locked settings override user/workspace values everywhere settings are loaded or saved.
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS, Settings } from "./settings";

export interface Policy {
  settings: Record<string, unknown>;
  allowedProviders?: string[] | null;
  allowedModels?: string[] | null;
  allowedAgentTools?: string[] | null;
  allowedMcpServers?: string[] | null;
  minimumApprovalMode?: "ask" | "auto-edit" | "turbo" | null;
  sharedInstructions?: string | null;
  extensionAllowlist?: string[] | null;
  preinstallExtensions: string[];
  extensionRegistryUrl?: string | null;
  telemetryLevel?: string | null;
  updateMode?: Settings["updateMode"] | null;
  updateEndpoint?: string | null;
  updatePubkey?: string | null;
  proxy?: { http: string; https: string; noProxy: string } | null;
  trustedCertificates: string[];
}
export interface LoadedPolicy { path: string; present: boolean; error: string | null; policy: Policy }

let loaded: LoadedPolicy = { path: "", present: false, error: null, policy: { settings: {}, preinstallExtensions: [], trustedCertificates: [] } };
let loading: Promise<LoadedPolicy> | null = null;

export function loadPolicy(): Promise<LoadedPolicy> {
  loading ??= invoke<LoadedPolicy>("policy_get")
    .then((p) => (loaded = p))
    .catch(() => loaded);
  return loading;
}

export const policyInfo = () => loaded;
export const policy = () => loaded.policy;
export const hasPolicy = () => loaded.present && !loaded.error;

/** Settings keys forced by the policy (including ones implied by dedicated policy fields). */
export function managedKeys(): string[] {
  const p = loaded.policy;
  const keys = Object.keys(p.settings ?? {}).filter((k) => k in DEFAULT_SETTINGS);
  if (p.extensionRegistryUrl) keys.push("extensionRegistryUrl");
  if (p.updateMode) keys.push("updateMode");
  if (p.proxy) keys.push("proxy");
  if (p.telemetryLevel) keys.push("telemetryLevel");
  if (p.minimumApprovalMode && p.minimumApprovalMode !== "turbo") keys.push("approvalMode");
  return [...new Set(keys)];
}

export const isManaged = (key: keyof Settings | string) => managedKeys().includes(key as string);

const STRICT: Record<string, number> = { turbo: 0, "auto-edit": 1, ask: 2 };

/** Applies locked values; called by loadSettings/saveSettings, so policy always wins. */
export function applyPolicy(s: Settings): Settings {
  const p = loaded.policy;
  if (!loaded.present || loaded.error) return s;
  const out: any = { ...s };
  for (const [k, v] of Object.entries(p.settings ?? {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = (DEFAULT_SETTINGS as any)[k];
    // Nested records (keys/models/baseUrls/proxy) merge; everything else is replaced.
    out[k] = def && typeof def === "object" && !Array.isArray(def) && v && typeof v === "object" ? { ...out[k], ...(v as object) } : v;
  }
  if (p.extensionRegistryUrl) out.extensionRegistryUrl = p.extensionRegistryUrl;
  if (p.updateMode) out.updateMode = p.updateMode;
  if (p.proxy) out.proxy = { http: p.proxy.http ?? "", https: p.proxy.https ?? "", noProxy: p.proxy.noProxy ?? "" };
  out.telemetryLevel = "off";
  const min = p.minimumApprovalMode;
  if (min && (STRICT[out.approvalMode] ?? 2) < (STRICT[min] ?? 2)) out.approvalMode = min;
  if (p.allowedProviders?.length && !p.allowedProviders.includes(out.provider)) out.provider = p.allowedProviders[0];
  return out as Settings;
}

/** Case-insensitive `*` / `?` glob. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  return re.test(text);
}

const allows = (list: string[] | null | undefined, v: string) => !list || list.some((g) => globMatch(g, v));
export const providerAllowed = (provider: string) => allows(loaded.policy.allowedProviders, provider);
export const modelAllowed = (model: string) => !model || allows(loaded.policy.allowedModels, model);
export const agentToolAllowed = (tool: string) => tool === "update_plan" || allows(loaded.policy.allowedAgentTools, tool);
/** For the MCP UI: whether a server may be started (the backend enforces the same rule). */
export const mcpServerAllowed = (name: string) => allows(loaded.policy.allowedMcpServers, name);

/** Mirrors policy::extension_allowed_by in the backend (which enforces it on install). */
export function extensionAllowed(id: string, version?: string): boolean {
  const list = loaded.policy.extensionAllowlist;
  if (!list) return true;
  const lid = id.toLowerCase();
  const publisher = lid.split(".")[0];
  return list.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (e === "*" || e === publisher || e === lid) return true;
    const [eid, ver] = e.split("@");
    return ver !== undefined && eid === lid && (ver === "*" || (!!version && ver === version.toLowerCase()));
  });
}
