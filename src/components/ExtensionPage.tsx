import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errMsg } from "../lib/api";
import { extensionAllowed } from "../lib/policy";
import {
  applyKeymap, extDir, featureSummary, installFromOpenVsx, installVersion, keymapPlan, removeKeymap,
  setExtensionEnabled, setGrammarPreference, setIconThemeSetting, uninstallExtension, useManifests, useUpdates,
} from "../lib/extensions";
import { useGrammarLanguages } from "../lib/extGrammars";
import { compatibility, dirSize, fmtBytes, fmtCount, registryBase, withProgress } from "../lib/marketplace";
import { saveSettings, openExtension } from "../lib/workspace";
import { parseJsonc } from "../lib/settings";
import { get, toast, useStore } from "../store";
import { CompatBadge } from "./ExtensionsPanel";

const CONTRIB_LABEL: Record<string, string> = {
  commands: "Commands", configuration: "Settings", debuggers: "Debuggers", menus: "Menus", views: "Views", viewsContainers: "View containers",
  taskDefinitions: "Tasks", jsonValidation: "JSON validation", problemMatchers: "Problem matchers", walkthroughs: "Walkthroughs",
  terminal: "Terminal profiles", customEditors: "Custom editors", notebooks: "Notebooks", productIconThemes: "Product icon themes",
};

type Tab = "details" | "features" | "pack" | "changelog";

export default function ExtensionPage({ namespace, name }: { namespace: string; name: string }) {
  const id = `${namespace}.${name}`.toLowerCase();
  const installed = useStore((s) => s.extensions.find((e) => e.id === id));
  const allInstalled = useStore((s) => s.extensions);
  const disabled = useStore((s) => s.settings.disabledExtensions.includes(id));
  const theme = useStore((s) => s.settings.theme);
  const iconTheme = useStore((s) => s.settings.iconTheme);
  const opts = useStore((s) => s.settings.extensionOptions);
  const localPkg = useManifests((m) => m[id]);
  const allGrammarLangs = useGrammarLanguages((s) => s.list);
  const grammarLangs = useMemo(() => allGrammarLangs.filter((g) => g.extId === id), [allGrammarLangs, id]);
  const update = useUpdates((s) => s.list.find((u) => u.id === id));
  const [meta, setMeta] = useState<any>(null);
  const [remotePkg, setRemotePkg] = useState<any>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [changelog, setChangelog] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  const [busy, setBusy] = useState("");
  const [offline, setOffline] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [pickVersion, setPickVersion] = useState("");
  const [confirmPack, setConfirmPack] = useState(false);

  useEffect(() => {
    let alive = true;
    api.openvsxMeta(namespace, name)
      .then(async (m) => {
        if (!alive) return;
        if (m?.error) throw new Error(m.error);
        setMeta(m);
        if (m.files?.icon) setIcon(m.files.icon);
        if (m.files?.readme) api.openvsxText(m.files.readme).then((t) => alive && setReadme(t)).catch(() => {});
        if (m.files?.changelog) api.openvsxText(m.files.changelog).then((t) => alive && setChangelog(t)).catch(() => {});
        if (m.files?.manifest) api.openvsxText(m.files.manifest).then((t) => alive && setRemotePkg(parseJsonc(t))).catch(() => {});
      })
      .catch(() => alive && setOffline(true));
    return () => { alive = false; };
  }, [namespace, name]);

  // Fall back to the local copy (works offline and for extensions imported from VS Code).
  useEffect(() => {
    if (!installed) return;
    if (installed.icon && !icon) api.readDataUrl(installed.icon).then(setIcon).catch(() => {});
    if (!readme && installed.readme) api.readFile(installed.readme).then(setReadme).catch(() => {});
    if (!changelog && installed.changelog) api.readFile(installed.changelog).then(setChangelog).catch(() => {});
  }, [installed?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Size on disk (asked from the shell; the backend has no size command).
  useEffect(() => {
    setSize(null);
    if (!installed) return;
    let alive = true;
    extDir(id).then(dirSize).then((n) => alive && setSize(n)).catch(() => {});
    return () => { alive = false; };
  }, [id, installed?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // The installed manifest describes what is active; the registry one what an install would bring.
  const pkg = installed && localPkg ? localPkg : remotePkg ?? localPkg;
  const contributes = pkg?.contributes ?? (installed ? Object.fromEntries([
    ...(installed.themes.length ? [["themes", installed.themes]] : []),
    ...(installed.iconThemes.length ? [["iconThemes", installed.iconThemes]] : []),
    ...(installed.snippets.length ? [["snippets", installed.snippets]] : []),
    ...installed.otherContributions.map((k) => [k, true]),
  ]) : undefined);
  const features = featureSummary(contributes);
  const compat = pkg ? compatibility(pkg) : null;
  const plan = useMemo(() => (pkg?.contributes?.keybindings ? keymapPlan(pkg) : null), [pkg]);
  const keymapActive = opts?.keymap?.extId === id;
  const packIds: string[] = compat?.pack ?? [];
  const installedIds = new Set(allInstalled.map((e) => e.id));
  const packInstalled = packIds.filter((x) => installedIds.has(x.toLowerCase()));
  const packMissing = packIds.filter((x) => !installedIds.has(x.toLowerCase()));
  const versions = meta?.allVersions ? Object.keys(meta.allVersions).filter((v) => v !== "latest" && v !== "pre-release").slice(0, 40) : [];
  const pinned = opts?.pins?.[id];

  const html = useMemo(() => (readme ? DOMPurify.sanitize(marked.parse(readme, { async: false }) as string) : ""), [readme]);
  const changelogHtml = useMemo(() => (changelog ? DOMPurify.sanitize(marked.parse(changelog, { async: false }) as string) : ""), [changelog]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); }
  };

  const installMembers = () => act("pack", async () => {
    const failed: string[] = [];
    await withProgress(`Installing ${title}`, packMissing, async (m) => {
      const [ns, ...rest] = m.split(".");
      try { await installFromOpenVsx(ns, rest.join("."), undefined, { quiet: true, depth: 1 }); } catch { failed.push(m); }
    });
    toast(failed.length ? `Could not install: ${failed.join(", ")}` : "Pack extensions installed", failed.length ? "error" : "info");
  });

  const uninstall = () => {
    if (packInstalled.length && !confirmPack) return setConfirmPack(true);
    act("uninstall", () => uninstallExtension(id));
  };

  const title = meta?.displayName || installed?.displayName || name;
  const description = meta?.description || installed?.description || "";
  const version = installed?.version || meta?.version;
  const repo = meta?.repository || installed?.repository;
  const status = !installed ? null : disabled ? "Disabled" : features.supported.length ? "Active" : "Installed — nothing to run";
  const tabs: Tab[] = ["details", "features", ...(packIds.length ? (["pack"] as Tab[]) : []), "changelog"];

  return (
    <div
      className="ext-page"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a?.href) {
          e.preventDefault();
          if (/^https?:/.test(a.href)) openUrl(a.href);
        }
      }}
    >
      <header className="ext-hero">
        {icon ? <img src={icon} alt="" /> : <div className="ext-ph big">{title[0]}</div>}
        <div className="ext-hero-info">
          <h1>{title}</h1>
          <div className="ext-hero-meta">
            <span>
              {meta?.namespaceDisplayName || namespace}
              {meta?.verified && <i className="codicon codicon-verified-filled ext-verified" title="Verified publisher" />}
            </span>
            {version && <span>v{version}{pinned ? " · pinned" : ""}</span>}
            {meta && <span>{fmtCount(meta.downloadCount)} installs</span>}
            {meta?.averageRating ? <span>★ {Number(meta.averageRating).toFixed(1)} ({meta.reviewCount ?? 0})</span> : null}
            {size !== null && <span title="Size of the extracted files on disk">{fmtBytes(size)} on disk</span>}
            {meta?.timestamp && <span title="Last published">updated {new Date(meta.timestamp).toLocaleDateString()}</span>}
            {status && <span className={`ext-status ${disabled ? "off" : ""}`}>● {status}</span>}
          </div>
          <p>{description}</p>
          {compat && (
            <div className={`ext-compat-banner ${compat.level}`}>
              <CompatBadge level={compat.level} />
              <span>{compat.label}</span>
            </div>
          )}
          <div className="ext-actions">
            {!installed ? (
              <button className="btn primary" disabled={!!busy || offline || !extensionAllowed(id, meta?.version)} title={extensionAllowed(id, meta?.version) ? undefined : "Not on your organization's extension allowlist"} onClick={() => act("install", () => installFromOpenVsx(namespace, name, pickVersion || undefined))}>
                {busy === "install" ? "Installing…" : !extensionAllowed(id, meta?.version) ? "Blocked by policy" : pickVersion ? `Install v${pickVersion}` : "Install"}
              </button>
            ) : (
              <>
                {update && (
                  <button className="btn primary" disabled={!!busy} onClick={() => act("update", () => installVersion(namespace, name, ""))}>
                    {busy === "update" ? "Updating…" : `Update to v${update.latest}`}
                  </button>
                )}
                <button className="btn" disabled={!!busy} onClick={() => act("toggle", () => setExtensionEnabled(id, disabled))}>
                  {disabled ? "Enable" : "Disable"}
                </button>
                <button className="btn" disabled={!!busy} onClick={uninstall}>
                  {busy === "uninstall" ? "Removing…" : "Uninstall"}
                </button>
                {!disabled && installed.themes.length > 0 && (
                  <select
                    className="ext-select"
                    value={installed.themes.some((t) => theme === `ext:${id}:${t.label}`) ? theme : ""}
                    onChange={(e) => e.target.value && saveSettings({ ...get().settings, theme: e.target.value })}
                  >
                    <option value="">Set color theme…</option>
                    {installed.themes.map((t) => <option key={t.label} value={`ext:${id}:${t.label}`}>{t.label}{t.uiTheme.startsWith("hc-") ? " (high contrast)" : ""}</option>)}
                  </select>
                )}
                {!disabled && installed.iconThemes.length > 0 && (
                  installed.iconThemes.some((t) => iconTheme === `${id}:${t.id}`) ? (
                    <button className="btn" onClick={() => setIconThemeSetting("")}>Use Cepheus icons</button>
                  ) : (
                    <button className="btn primary" onClick={() => setIconThemeSetting(`${id}:${installed.iconThemes[0].id}`)}>Set file icon theme</button>
                  )
                )}
                {!disabled && compat?.works.includes("keymap") && (
                  keymapActive
                    ? <button className="btn" disabled={!!busy} onClick={() => act("keymap", removeKeymap)}>Remove keymap</button>
                    : <button className="btn primary" disabled={!!busy} onClick={() => act("keymap", () => applyKeymap(id))}>Apply keymap</button>
                )}
              </>
            )}
            {versions.length > 1 && (!installed || installed.source === "openvsx") && (
              <select
                className="ext-select"
                aria-label="Version"
                value={installed ? (pinned ?? "") : pickVersion}
                disabled={!!busy}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!installed) return setPickVersion(v);
                  act("version", () => installVersion(namespace, name, v));
                }}
              >
                <option value="">Latest version</option>
                {versions.map((v) => <option key={v} value={v}>v{v}{v === installed?.version ? " (installed)" : ""}</option>)}
              </select>
            )}
            {repo && <button className="link" onClick={() => openUrl(repo)}>Repository ↗</button>}
            {meta && <button className="link" onClick={() => openUrl(`${registryBase()}/extension/${namespace}/${name}`)}>Registry page ↗</button>}
          </div>
          {confirmPack && (
            <div className="ext-confirm">
              <span>{title} installed {packInstalled.length} extension{packInstalled.length > 1 ? "s" : ""}. Remove them too?</span>
              <button className="btn small" disabled={!!busy} onClick={() => { setConfirmPack(false); act("uninstall", () => uninstallExtension(id)); }}>Remove pack only</button>
              <button className="btn small primary" disabled={!!busy} onClick={() => { setConfirmPack(false); act("uninstall", () => uninstallExtension(id, packInstalled.map((x) => x.toLowerCase()))); }}>Remove all {packInstalled.length + 1}</button>
              <button className="link" onClick={() => setConfirmPack(false)}>Cancel</button>
            </div>
          )}
        </div>
      </header>

      <nav className="ext-page-tabs">
        {tabs.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "pack" ? `pack (${packIds.length})` : t}</button>
        ))}
      </nav>

      <div className="ext-page-body">
        {tab === "details" && (
          html ? <div className="md readme" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="muted">{offline ? "Offline — no README available." : "Loading README…"}</div>
        )}

        {tab === "features" && (
          <div className="ext-features">
            <p className="muted small">
              Cepheus activates the declarative parts of VS Code extensions. Parts that need VS Code's Node.js extension host are listed but never run{compat?.needsCode ? " — this extension also ships code, so some of what its README describes will not be available" : ""}.
            </p>
            <table>
              <tbody>
                {features.supported.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className="n">{f.n}</td>
                    <td className="ok">Supported{installed && !disabled ? " · active" : ""}</td>
                  </tr>
                ))}
                {features.unsupported.map((k) => (
                  <tr key={k}>
                    <td>{CONTRIB_LABEL[k] ?? k}</td>
                    <td className="n">{Array.isArray(contributes?.[k]) ? contributes[k].length : ""}</td>
                    <td className="no">Needs extension code</td>
                  </tr>
                ))}
                {!contributes && <tr><td colSpan={3} className="muted">Loading…</td></tr>}
              </tbody>
            </table>

            {installed && grammarLangs.length > 0 && (
              <>
                <h4>Syntax highlighting</h4>
                <p className="muted small">Languages Monaco already highlights keep its built-in tokenizer unless you switch to this extension's grammar.</p>
                <table>
                  <tbody>
                    {grammarLangs.map((g) => (
                      <tr key={g.lang}>
                        <td>{g.lang} <span className="muted small">{g.scopeName}</span></td>
                        <td className="n">{g.builtin ? "built-in" : "new"}</td>
                        <td className="ok">
                          <label className="ext-toggle">
                            <input type="checkbox" checked={g.active} disabled={disabled || !!busy} onChange={(e) => act("grammar", () => setGrammarPreference(g.lang, e.target.checked, g.builtin))} />
                            Use extension grammar
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {plan && (plan.unmapped.length > 0 || compat?.works.includes("keymap")) && (
              <>
                <h4>Keybindings</h4>
                <p className="muted small">
                  {Object.keys(plan.cepheus).length} map to Cepheus commands, {plan.editor.length} to editor commands
                  {plan.unmapped.length ? `, ${plan.unmapped.length} have no equivalent` : ""}.
                  {keymapActive && ` Active as “${opts?.keymap?.label}” (see Preferences: Keyboard Shortcuts).`}
                </p>
                {plan.unmapped.length > 0 && (
                  <details className="ext-unmapped">
                    <summary>Not mapped ({plan.unmapped.length})</summary>
                    <table>
                      <tbody>
                        {plan.unmapped.map((u, i) => (
                          <tr key={i}><td className="mono">{u.command}</td><td className="n">{u.key}</td><td className="no">{u.reason}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </>
            )}

            {installed && installed.themes.length > 0 && (
              <>
                <h4>Color themes</h4>
                <div className="ext-chip-list">{installed.themes.map((t) => <button key={t.label} className={theme === `ext:${id}:${t.label}` ? "on" : ""} onClick={() => saveSettings({ ...get().settings, theme: `ext:${id}:${t.label}` })}>{t.label}</button>)}</div>
              </>
            )}
            {installed && installed.snippets.length > 0 && (
              <>
                <h4>Snippets</h4>
                <div className="ext-chip-list">{[...new Set(installed.snippets.map((s) => s.language))].map((l) => <span key={l}>{l}</span>)}</div>
              </>
            )}
          </div>
        )}

        {tab === "pack" && (
          <div className="ext-features">
            <p className="muted small">
              Extensions this {pkg?.extensionPack?.length ? "pack bundles" : "extension depends on"}. Installing the pack installs the ones Cepheus can use; extensions that only contain code are skipped.
            </p>
            {installed && packMissing.length > 0 && (
              <button className="btn primary" disabled={!!busy} onClick={installMembers}>{busy === "pack" ? "Installing…" : `Install missing (${packMissing.length})`}</button>
            )}
            <table>
              <tbody>
                {packIds.map((m) => {
                  const [ns, ...rest] = m.split(".");
                  return (
                    <tr key={m} className="clickable" onClick={() => openExtension(ns, rest.join("."))}>
                      <td>{m}</td>
                      <td className={installedIds.has(m.toLowerCase()) ? "ok" : "no"}>{installedIds.has(m.toLowerCase()) ? "Installed" : "Not installed"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === "changelog" && (
          changelogHtml ? <div className="md readme" dangerouslySetInnerHTML={{ __html: changelogHtml }} /> : <div className="muted">No changelog.</div>
        )}
      </div>
    </div>
  );
}
