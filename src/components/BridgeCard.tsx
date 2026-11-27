import { useState } from "react";
import {
  BADGE_LABEL, bridgeFor, BridgeBadgeKind, checkTools, hasToggle, installTool, liveSummary, openSuggestBridge, runAction,
  setBridgeEnabled, toolIds, TOOLS, useBridge, useBridgeRuntime, useTools,
} from "../lib/bridges";
import { runInTerminal } from "../lib/terminalBus";
import { errMsg } from "../lib/api";
import { toast, useStore } from "../store";

const BADGE_TITLE: Record<BridgeBadgeKind, string> = {
  ready: "A Cepheus bridge provides this extension's main feature (its own code never runs).",
  setup: "A Cepheus bridge provides this extension's main feature once a tool is installed.",
  builtin: "Cepheus has this feature built in.",
  alternative: "This extension needs its vendor's service; Cepheus offers its own alternative.",
};

/** Badge for an extension that has a bridge (null if none, so callers can fall back). */
export function BridgeBadge({ extId }: { extId: string }) {
  const st = useBridge(extId);
  if (!st) return null;
  if (!st.badge) return <span className="ext-compat bridge checking">…</span>;
  const title = st.badge === "setup" ? `${BADGE_TITLE.setup} Needs: ${st.missing.map((m) => m.def.name).join(", ")} — open the extension for a one-click install.` : BADGE_TITLE[st.badge];
  return <span className={`ext-compat bridge ${st.badge}`} title={title}>{BADGE_LABEL[st.badge]}</span>;
}

/** Shown when an extension only has code and no bridge: why, and a way to ask for one. */
export function NoBridgeNote({ extId, displayName }: { extId: string; displayName: string }) {
  if (bridgeFor(extId)) return null;
  return (
    <div className="bridge-none">
      <span className="ext-compat code">Needs extension code</span>
      <span>
        This extension's features are JavaScript that runs in VS Code's extension host, which Cepheus doesn't have — so installing it adds nothing that runs.
        {" "}<button className="link" onClick={() => openSuggestBridge(extId, displayName)}>Suggest a bridge ↗</button>
      </span>
    </div>
  );
}

const SIGN_IN: Record<string, string> = { "claude-code": "claude", codex: "codex login" };

/** Top of the extension page: what works through the bridge, a switch, setup and live status. */
export default function BridgeCard({ extId, installed }: { extId: string; installed: boolean }) {
  const st = useBridge(extId);
  useBridgeRuntime((s) => s); // live counts / server state
  useStore((s) => s.lsp);
  useStore((s) => s.activeId);
  const toolStatus = useTools((s) => s.status);
  const [busy, setBusy] = useState("");
  if (!st) return null;
  const b = st.bridge;
  const act = async (label: string, fn: () => unknown) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); }
  };
  const ready = st.missing.length === 0;
  const harnessName = b.harness === "codex" ? "Codex" : "Claude Code";
  const live = st.enabled && hasToggle(b) ? liveSummary(b) : [];

  return (
    <section className={`bridge-card ${st.badge ?? "checking"}`} aria-label="Cepheus bridge">
      <div className="bridge-head">
        <i className={`codicon codicon-${b.kind === "builtin" ? "check-all" : b.kind === "harness" ? "hubot" : "plug"}`} />
        <div className="bridge-title">
          <div><b>{b.title}</b> {st.badge && <span className={`ext-compat bridge ${st.badge}`}>{BADGE_LABEL[st.badge]}</span>}</div>
          <div className="muted small">Cepheus bridge · the extension's own code is never run</div>
        </div>
        {hasToggle(b) && !b.harness && (
          <label className="bridge-switch" title={st.enabled ? "Turn the bridge off" : "Turn the bridge on"}>
            <input type="checkbox" checked={st.enabled} disabled={!!busy} onChange={(e) => act("toggle", () => setBridgeEnabled(b, e.target.checked))} />
            <span>{st.enabled ? "On" : "Off"}</span>
          </label>
        )}
      </div>

      <p className="bridge-desc">{b.description}</p>

      {live.length > 0 && (
        <ul className="bridge-live">
          {live.map((l, i) => <li key={i}><i className="codicon codicon-pulse" /> {l}</li>)}
        </ul>
      )}

      {st.missing.length > 0 && (
        <div className="bridge-setup">
          <div className="bridge-setup-title">Setup needed</div>
          {st.missing.map((m) => (
            <div key={m.id} className="bridge-req">
              <div>
                <b>{m.def.name}</b> <span className="muted small">{toolStatus[m.id]?.detail ?? ""}</span>
                {m.def.note && <div className="muted small">{m.def.note}</div>}
                {m.install && <code className="bridge-cmd">{m.install}</code>}
              </div>
              {m.install ? (
                <button className="btn small primary" disabled={!!busy} onClick={() => installTool(m.id)} title="Runs the command in a terminal, then checks again">Install</button>
              ) : <span className="muted small">install manually</span>}
            </div>
          ))}
          <button className="link" disabled={!!busy} onClick={() => act("recheck", () => checkTools(toolIds(b), true))}>{busy === "recheck" ? "Checking…" : "Check again"}</button>
        </div>
      )}

      {b.harness && (
        <div className="bridge-actions">
          {st.enabled ? (
            <>
              <span className="bridge-ok"><i className="codicon codicon-check" /> {harnessName} is the default agent</span>
              <button className="btn small" disabled={!!busy} onClick={() => act("toggle", () => setBridgeEnabled(b, false))}>Use the Cepheus agent instead</button>
            </>
          ) : (
            <button className="btn primary" disabled={!!busy || !ready} title={ready ? undefined : `Install the ${harnessName} CLI first`} onClick={() => act("toggle", () => setBridgeEnabled(b, true))}>
              Use {harnessName} as the agent
            </button>
          )}
          {ready && (
            <button className="btn small" onClick={() => runInTerminal({ title: `${harnessName} sign in`, command: SIGN_IN[b.harness!] })} title="Opens a terminal to sign in (needed once)">
              Sign in…
            </button>
          )}
        </div>
      )}

      {b.actions && b.actions.length > 0 && (
        <div className="bridge-actions">
          {b.actions.map((a) => <button key={a.label} className={`btn small ${a.primary ? "primary" : ""}`} onClick={() => runAction(a)}>{a.label}</button>)}
        </div>
      )}

      {b.server && !st.enabled && <div className="muted small">Turning it on downloads the extension package ({b.server.size}) and unpacks its language server{installed ? "" : " — the extension itself doesn't have to be installed"}.</div>}

      <details className="bridge-how">
        <summary>How it works</summary>
        <p>{b.how}</p>
        {b.settings?.length ? <p className="muted small">Settings: {b.settings.join(", ")}</p> : null}
        {(b.requires ?? []).length > 0 && <p className="muted small">Needs: {(b.requires ?? []).map((r) => r.split("|").map((t) => TOOLS[t]?.name ?? t).join(" or ")).join(", ")}</p>}
      </details>
    </section>
  );
}
