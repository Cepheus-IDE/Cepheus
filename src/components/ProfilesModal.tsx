import { useEffect, useState } from "react";
import { errMsg } from "../lib/api";
import { get, toast, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import { Settings } from "../lib/settings";
import { isManaged, managedKeys, policyInfo } from "../lib/policy";
import {
  createProfile, deleteProfile, DEFAULT_PROFILE, exportProfile, folderProfile, importProfile, renameProfile,
  setFolderProfile, switchProfile, useProfiles,
} from "../lib/profiles";
import { setExcludeMachine, syncNow, turnOffSync, turnOnSync, useSync } from "../lib/sync";
import { checkForUpdates, downloadUpdate, restartToUpdate, updateMode, useUpdater } from "../lib/updater";
import { leaveContainer, reopenInContainer, useContainer } from "../lib/continuity";
import { openProfilesModal, ProfilesTab, startServices, useProfilesModal } from "../lib/services";

/** "Managed by your organization" marker for settings locked by the policy file. */
export function ManagedBadge({ k }: { k: keyof Settings | string }) {
  if (!isManaged(k)) return null;
  return <span className="managed-badge" title={`Set by the organization policy: ${policyInfo().path}`}><i className="codicon codicon-organization" /> Managed by your organization</span>;
}

/** Top-of-Settings notice listing what the organization policy locks. */
export function ManagedBanner() {
  const keys = managedKeys();
  const info = policyInfo();
  if (!info.present) return null;
  if (info.error) return <div className="pm-note error">Organization policy {info.path} is invalid and was ignored: {info.error}</div>;
  return (
    <div className="pm-note managed">
      <i className="codicon codicon-organization" /> Some settings are managed by your organization{keys.length ? `: ${keys.join(", ")}` : ""}. Changes to them are ignored.{" "}
      <a href="#" onClick={(e) => { e.preventDefault(); openProfilesModal("organization"); }}>View policy</a>
    </div>
  );
}

const TABS: { id: ProfilesTab; label: string; icon: string }[] = [
  { id: "profiles", label: "Profiles", icon: "account" },
  { id: "sync", label: "Settings Sync", icon: "sync" },
  { id: "updates", label: "Updates", icon: "cloud-download" },
  { id: "container", label: "Dev Container", icon: "remote" },
  { id: "organization", label: "Network & Policy", icon: "organization" },
];

export default function ProfilesModal() {
  const { open, tab } = useProfilesModal();
  useEffect(() => { startServices(); }, []);
  if (!open) return null;
  const close = () => useProfilesModal.setState({ open: false });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal profiles-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <h2><i className="codicon codicon-account" /> Profiles, Sync &amp; Updates</h2>
          <button className="icon-btn" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <div className="pm-body">
          <nav className="pm-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => openProfilesModal(t.id)}>
                <i className={`codicon codicon-${t.icon}`} /> {t.label}
              </button>
            ))}
          </nav>
          <div className="pm-content">
            {tab === "profiles" && <ProfilesTabView />}
            {tab === "sync" && <SyncTab />}
            {tab === "updates" && <UpdatesTab />}
            {tab === "container" && <ContainerTab />}
            {tab === "organization" && <OrganizationTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function run(fn: () => Promise<unknown>) {
  fn().catch((e) => toast(errMsg(e), "error"));
}

function ProfilesTabView() {
  const { profiles, active } = useProfiles();
  const ws = useStore((s) => s.workspace);
  const [name, setName] = useState("");
  const [from, setFrom] = useState<"empty" | "current">("current");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const assoc = ws ? folderProfile(ws) : undefined;

  return (
    <section>
      <h3>Profiles</h3>
      <div className="muted small">A profile holds settings, keyboard shortcuts, enabled extensions, user snippets and the layout (side bar, panel and agent sizes). API keys, SSH hosts and network settings are shared by all profiles.</div>
      <div className="pm-list">
        {profiles.map((p) => (
          <div key={p.id} className={`pm-row ${p.id === active ? "on" : ""}`}>
            <i className={`codicon codicon-${p.id === active ? "pass-filled" : "circle-large-outline"}`} />
            {renaming?.id === p.id ? (
              <input
                autoFocus
                className="grow"
                value={renaming.name}
                onChange={(e) => setRenaming({ id: p.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { run(() => renameProfile(p.id, renaming.name)); setRenaming(null); }
                  if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <span className="grow ellipsis">{p.name}{p.id === active && <span className="muted small"> · active</span>}{p.folders.length > 0 && <span className="muted small"> · {p.folders.length} folder{p.folders.length > 1 ? "s" : ""}</span>}</span>
            )}
            {p.id !== active && <button className="btn small primary" onClick={() => run(() => switchProfile(p.id))}>Switch</button>}
            <button className="icon-btn small" title="Export…" onClick={() => run(() => exportProfile(p.id))}><i className="codicon codicon-export" /></button>
            {p.id !== DEFAULT_PROFILE && (
              <>
                <button className="icon-btn small" title="Rename" onClick={() => setRenaming({ id: p.id, name: p.name })}><i className="codicon codicon-edit" /></button>
                <button className="icon-btn small" title="Delete" onClick={() => run(() => deleteProfile(p.id))}><i className="codicon codicon-trash" /></button>
              </>
            )}
          </div>
        ))}
      </div>

      <label>New profile</label>
      <div className="row gap">
        <input className="grow" placeholder="Profile name, e.g. Python, Writing, Demo" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run(async () => { await createProfile(name, from); setName(""); })} />
        <select value={from} onChange={(e) => setFrom(e.target.value as "empty" | "current")}>
          <option value="current">Copy current</option>
          <option value="empty">Empty (defaults)</option>
        </select>
        <button className="btn primary" disabled={!name.trim()} onClick={() => run(async () => { await createProfile(name, from); setName(""); })}>Create</button>
      </div>
      <div className="row gap" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => run(importProfile)}><i className="codicon codicon-desktop-download" /> Import profile…</button>
      </div>

      {ws && (
        <>
          <label>Profile for this folder</label>
          <select value={assoc?.id ?? ""} onChange={(e) => run(async () => { await setFolderProfile(ws, e.target.value || null); if (e.target.value) await switchProfile(e.target.value); })}>
            <option value="">None (keep the current profile)</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="muted small">Opening this folder switches to the chosen profile automatically.</div>
        </>
      )}
    </section>
  );
}

function ago(ts: number) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleString();
}

function SyncTab() {
  const sync = useSync();
  const token = useStore((s) => s.settings.githubToken);
  return (
    <section>
      <h3>Settings Sync</h3>
      <div className="muted small">Syncs all profiles (settings, keyboard shortcuts, enabled extensions, layout), user snippets and the list of installed extensions through a <b>private GitHub Gist</b> using the GitHub account you signed in with. API keys and tokens are never synced.</div>
      {!token && <div className="pm-note error"><i className="codicon codicon-warning" /> Sign in to GitHub first (GitHub panel in the activity bar). The token needs the <code>gist</code> scope.</div>}
      <label className="check">
        <input type="checkbox" checked={sync.excludeMachine} onChange={(e) => setExcludeMachine(e.target.checked)} />
        Exclude machine-specific settings (terminal shell, language server paths, recent folders, SSH hosts)
      </label>
      <div className="row gap" style={{ marginTop: 10 }}>
        {sync.enabled ? (
          <>
            <button className="btn primary" disabled={sync.busy} onClick={() => syncNow()}><i className={`codicon codicon-${sync.busy ? "loading codicon-modifier-spin" : "sync"}`} /> Sync now</button>
            <button className="btn" onClick={turnOffSync}>Turn off</button>
          </>
        ) : (
          <button className="btn primary" disabled={!token || sync.busy} onClick={() => run(() => turnOnSync(sync.excludeMachine))}>Turn on Settings Sync</button>
        )}
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>
        {sync.enabled ? "On" : "Off"} · last synced {ago(sync.lastSync)}{sync.gistId && <> · gist <code>{sync.gistId.slice(0, 8)}</code></>}
      </div>
      {sync.error && <div className="pm-note error">{sync.error}</div>}
      {sync.conflict && (
        <div className="pm-note">
          <b>Conflict:</b> your settings changed here and on another machine since the last sync ({sync.conflict.profiles?.length ?? 0} remote profile(s), last remote change {new Date(sync.conflict.updatedAt).toLocaleString()}).
          <div className="row gap" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => syncNow("local")}>Keep local (upload)</button>
            <button className="btn" onClick={() => syncNow("remote")}>Use remote (replace local)</button>
          </div>
        </div>
      )}
    </section>
  );
}

function UpdatesTab() {
  const u = useUpdater();
  const settings = useStore((s) => s.settings);
  const mode = updateMode();
  const managed = !!u.config?.policyMode;
  const pct = u.progress?.total ? Math.round((u.progress.downloaded / u.progress.total) * 100) : null;
  return (
    <section>
      <h3>Updates</h3>
      <div className="muted small">Version {u.config?.currentVersion ?? "?"}{u.config?.configured ? ` · update feed: ${u.config.endpoint}${u.config.source === "policy" ? " (organization)" : ""}` : " · this build has no update feed configured, so updates are off."}</div>
      <label>Update mode {managed && <ManagedBadge k="updateMode" />}</label>
      <select disabled={managed} value={mode} onChange={(e) => saveSettings({ ...get().settings, updateMode: e.target.value as Settings["updateMode"] })}>
        <option value="automatic">Automatic — download in the background, then ask to restart</option>
        <option value="startup">On startup — check when Cepheus starts and notify</option>
        <option value="manual">Manual — only Help › Check for Updates…</option>
        <option value="none">None — never check</option>
      </select>
      <div className="row gap" style={{ marginTop: 12 }}>
        <button className="btn" disabled={!u.config?.configured || u.status === "checking" || u.status === "downloading" || mode === "none"} onClick={() => checkForUpdates(true, mode === "automatic")}>
          <i className={`codicon codicon-${u.status === "checking" ? "loading codicon-modifier-spin" : "refresh"}`} /> Check for Updates…
        </button>
        {u.status === "available" && <button className="btn primary" onClick={downloadUpdate}>Download {u.info?.version}</button>}
        {u.status === "ready" && <button className="btn primary" onClick={restartToUpdate}><i className="codicon codicon-debug-restart" /> Restart to update</button>}
      </div>
      {u.status === "downloading" && (
        <div className="pm-progress"><div style={{ width: `${pct ?? 30}%` }} className={pct === null ? "indeterminate" : ""} /><span>{pct !== null ? `${pct}%` : `${Math.round((u.progress?.downloaded ?? 0) / 1e6)} MB`}</span></div>
      )}
      {u.status === "none" && <div className="muted small">You are on the latest version.</div>}
      {u.info?.notes && (u.status === "available" || u.status === "ready") && <pre className="pm-notes">{u.info.notes}</pre>}
      {u.error && <div className="pm-note error">{u.error}</div>}
    </section>
  );
}

function ContainerTab() {
  const c = useContainer();
  const ws = useStore((s) => s.workspace);
  const d = c.detect;
  return (
    <section>
      <h3>Dev Container</h3>
      <div className="muted small">Open the folder in a container defined by <code>.devcontainer/devcontainer.json</code>. Files stay on this computer (bind-mounted); terminals and agent commands run inside the container.</div>
      {!ws ? <div className="pm-note">Open a folder first.</div>
        : !d?.hasConfig ? <div className="pm-note">This folder has no <code>.devcontainer/devcontainer.json</code>.</div>
        : !d.docker ? <div className="pm-note error"><i className="codicon codicon-warning" /> Docker was not found on PATH. Install Docker Desktop and restart Cepheus.</div>
        : (
          <div className="row gap" style={{ marginTop: 10 }}>
            {c.active ? (
              <>
                <span className="grow">In container <b>{c.active.name}</b> <code>{c.active.container}</code> at {c.active.workspaceFolder}</span>
                <button className="btn" disabled={c.busy} onClick={() => reopenInContainer(true)}>Rebuild</button>
                <button className="btn" onClick={leaveContainer}>Reopen locally</button>
              </>
            ) : (
              <button className="btn primary" disabled={c.busy} onClick={() => reopenInContainer(false)}>
                <i className={`codicon codicon-${c.busy ? "loading codicon-modifier-spin" : "remote"}`} /> Reopen in Container{d.name ? ` (${d.name})` : ""}
              </button>
            )}
          </div>
        )}
      {c.log.length > 0 && <pre className="pm-log">{c.log.join("\n")}</pre>}
    </section>
  );
}

function OrganizationTab() {
  const settings = useStore((s) => s.settings);
  const [proxy, setProxy] = useState(settings.proxy);
  const [certs, setCerts] = useState(settings.trustedCertificates.join("\n"));
  const [registry, setRegistry] = useState(settings.extensionRegistryUrl);
  const info = policyInfo();
  const p = info.policy;
  const proxyLocked = isManaged("proxy");
  const save = () =>
    saveSettings({
      ...get().settings,
      proxy,
      trustedCertificates: certs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      extensionRegistryUrl: registry.trim(),
    }).then(() => toast("Network settings saved"));
  const rows: [string, unknown][] = [
    ["Allowed providers", p.allowedProviders],
    ["Allowed models", p.allowedModels],
    ["Allowed agent tools", p.allowedAgentTools],
    ["Allowed MCP servers", p.allowedMcpServers],
    ["Minimum approval mode", p.minimumApprovalMode],
    ["Shared agent instructions", p.sharedInstructions],
    ["Extension allowlist", p.extensionAllowlist],
    ["Preinstalled extensions", p.preinstallExtensions?.length ? p.preinstallExtensions : null],
    ["Extension registry", p.extensionRegistryUrl],
    ["Update mode", p.updateMode],
    ["Update feed", p.updateEndpoint],
    ["Proxy", p.proxy ? [p.proxy.http, p.proxy.https, p.proxy.noProxy && `no_proxy: ${p.proxy.noProxy}`].filter(Boolean).join(" · ") : null],
    ["Trusted certificates", p.trustedCertificates?.length ? p.trustedCertificates : null],
    ["Locked settings", Object.keys(p.settings ?? {}).length ? Object.keys(p.settings) : null],
  ];
  return (
    <section>
      <h3>Network</h3>
      <div className="grid2">
        <div>
          <label>HTTP proxy <ManagedBadge k="proxy" /></label>
          <input disabled={proxyLocked} placeholder="http://proxy.example.com:3128" value={proxy.http} onChange={(e) => setProxy({ ...proxy, http: e.target.value })} />
        </div>
        <div>
          <label>HTTPS proxy <span className="muted">(empty = same as HTTP)</span></label>
          <input disabled={proxyLocked} placeholder="http://proxy.example.com:3128" value={proxy.https} onChange={(e) => setProxy({ ...proxy, https: e.target.value })} />
        </div>
      </div>
      <label>No proxy for</label>
      <input disabled={proxyLocked} placeholder="localhost,127.0.0.1,.corp.example.com" value={proxy.noProxy} onChange={(e) => setProxy({ ...proxy, noProxy: e.target.value })} />
      <label>Extra trusted CA certificates <span className="muted">(PEM file paths, one per line)</span></label>
      <textarea rows={2} placeholder="C:\certs\corporate-root.pem" value={certs} onChange={(e) => setCerts(e.target.value)} />
      <div className="muted small">Used by every request Cepheus makes (AI providers, extensions, GitHub, updates); the proxy is also passed to git and docker. Restart Cepheus after changing them so already-open connections pick them up.</div>
      <label>Extension registry <ManagedBadge k="extensionRegistryUrl" /></label>
      <input disabled={isManaged("extensionRegistryUrl")} placeholder="https://open-vsx.org (any Open VSX-compatible registry)" value={registry} onChange={(e) => setRegistry(e.target.value)} />
      <div className="row gap" style={{ marginTop: 10 }}><button className="btn primary" onClick={save}>Save network settings</button></div>

      <h3>Telemetry</h3>
      <label>Telemetry level <ManagedBadge k="telemetryLevel" /></label>
      <select disabled value="off"><option value="off">Off</option></select>
      <div className="muted small">Cepheus collects no telemetry, crash reports or usage data — “off” is the only level. Network traffic goes only to the AI provider, extension registry, GitHub and update feed you configure.</div>

      <h3>Organization policy</h3>
      {!info.present ? (
        <div className="muted small">No policy file. Administrators can deploy one at <code>{info.path}</code> to lock settings and restrict AI providers, models, agent tools, MCP servers and extensions.</div>
      ) : info.error ? (
        <div className="pm-note error">{info.path}: {info.error}</div>
      ) : (
        <>
          <div className="muted small">Managed by <code>{info.path}</code>.</div>
          <table className="pm-policy">
            <tbody>
              {rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
                <tr key={k}><td>{k}</td><td>{Array.isArray(v) ? v.join(", ") : String(v)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Status bar items: active profile, sync state, update ready, dev container. */
export function ProfileStatus() {
  const active = useProfiles((s) => s.profiles.find((p) => p.id === s.active));
  const syncOn = useSync((s) => s.enabled);
  const syncBusy = useSync((s) => s.busy);
  const conflict = useSync((s) => !!s.conflict);
  const update = useUpdater((s) => s.status);
  const container = useContainer((s) => s.active);
  const canContainer = useContainer((s) => !!s.detect?.hasConfig && s.detect.docker);
  const ws = useStore((s) => s.workspace);
  return (
    <>
      {container && container.workspace === ws ? (
        <button className="remote-badge" title="Dev Container" onClick={() => openProfilesModal("container")}><i className="codicon codicon-remote" /> Dev Container: {container.name}</button>
      ) : canContainer ? (
        <button title="Reopen in Container" onClick={() => reopenInContainer(false)}><i className="codicon codicon-remote" /> Reopen in Container</button>
      ) : null}
      {update === "ready" && <button className="attention" title="Restart to update" onClick={restartToUpdate}><i className="codicon codicon-debug-restart" /> Restart to update</button>}
      <button title={`Profile: ${active?.name ?? "Default"}${syncOn ? " · Settings Sync on" : ""}`} onClick={() => openProfilesModal(conflict ? "sync" : "profiles")} className={conflict ? "attention" : ""}>
        <i className="codicon codicon-account" /> {active?.name ?? "Default"}
        {syncOn && <i className={`codicon codicon-${syncBusy ? "sync codicon-modifier-spin" : conflict ? "warning" : "sync"}`} style={{ marginLeft: 4 }} />}
      </button>
    </>
  );
}
