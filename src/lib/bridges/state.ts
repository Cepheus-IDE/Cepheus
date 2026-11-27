//! Extension bridges: which bridges are on, and live status (lint counts, server state) for the UI.

import { create } from "zustand";
import { get } from "../../store";
import type { FormatterId, LinterId } from "./core";
import { BRIDGES, BridgeDef, bridgeKey } from "./registry";

/** Has a switch the user can flip (some built-in bridges only offer actions). */
export const hasToggle = (b: BridgeDef) => b.kind !== "builtin" || !!b.setting || !!b.formatters?.length;

export function bridgeEnabled(b: BridgeDef): boolean {
  const s = get().settings;
  if (b.harness) return s.agentHarness === b.harness;
  if (b.setting) return !!s[b.setting];
  if (!hasToggle(b)) return true;
  if (b.ids.some((id) => s.disabledExtensions.includes(id))) return false;
  return s.bridges?.[bridgeKey(b)] === true;
}

export const enabledBridges = () => BRIDGES.filter((b) => (b.formatters?.length || b.linters?.length || b.server) && bridgeEnabled(b));
export const activeFormatterIds = (): FormatterId[] => [...new Set(enabledBridges().flatMap((b) => b.formatters ?? []))];
export const activeLinterIds = (): LinterId[] => [...new Set(enabledBridges().flatMap((b) => b.linters ?? []))];

export interface ServerState { state: "downloading" | "ready" | "waiting" | "error"; message?: string }

export const useBridgeRuntime = create<{
  /** `${linter}|${lower-cased path}` → number of problems. */
  lint: Record<string, number>;
  /** Linter → last error (missing config etc.). */
  lintError: Record<string, string>;
  /** Bridge key → bundled language server state. */
  servers: Record<string, ServerState>;
}>(() => ({ lint: {}, lintError: {}, servers: {} }));

export const lintKey = (tool: string, path: string) => `${tool}|${path.replace(/\\/g, "/").toLowerCase()}`;
