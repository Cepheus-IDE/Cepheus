import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errMsg } from "../lib/api";
import { extensionAllowed } from "../lib/policy";
import { featureSummary, installFromOpenVsx, setExtensionEnabled, setIconThemeSetting, uninstallExtension } from "../lib/extensions";
import { saveSettings } from "../lib/workspace";
import { parseJsonc } from "../lib/settings";
import { get, toast, useStore } from "../store";

function fmt(n?: number) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

const CONTRIB_LABEL: Record<string, string> = {
  languages: "Language definitions", grammars: "Syntax grammars (TextMate)", commands: "Commands", keybindings: "Keybindings",
  configuration: "Settings", debuggers: "Debuggers", menus: "Menus", views: "Views", viewsContainers: "View containers",
  taskDefinitions: "Tasks", jsonValidation: "JSON validation", problemMatchers: "Problem matchers", walkthroughs: "Walkthroughs",
  terminal: "Terminal profiles", customEditors: "Custom editors", notebooks: "Notebooks", productIconThemes: "Product icon themes",
};

export default function ExtensionPage({ namespace, name }: { namespace: string; name: string }) {
  const id = `${namespace}.${name}`.toLowerCase();
  const installed = useStore((s) => s.extensions.find((e) => e.id === id));
  const disabled = useStore((s) => s.settings.disabledExtensions.includes(id));
  const theme = useStore((s) => s.settings.theme);
  const iconTheme = useStore((s) => s.settings.iconTheme);
  const [meta, setMeta] = useState<any>(null);
  const [manifest, setManifest] = useState<any>(null);
  const [readme, setReadme] = useState<string | null>(null);
  const [changelog, setChangelog] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [tab, setTab] = useState<"details" | "features" | "changelog">("details");
  const [busy, setBusy] = useState("");
  const [offline, setOffline] = useState(false);

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
        if (m.files?.manifest) api.openvsxText(m.files.manifest).then((t) => alive && setManifest(parseJsonc(t))).catch(() => {});
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

  const contributes = manifest?.contributes ?? (installed ? Object.fromEntries([
    ...(installed.themes.length ? [["themes", installed.themes]] : []),
    ...(installed.iconThemes.length ? [["iconThemes", installed.iconThemes]] : []),
    ...(installed.snippets.length ? [["snippets", installed.snippets]] : []),
    ...installed.otherContributions.map((k) => [k, true]),
  ]) : undefined);
  const features = featureSummary(contributes);

  const html = useMemo(() => (readme ? DOMPurify.sanitize(marked.parse(readme, { async: false }) as string) : ""), [readme]);
  const changelogHtml = useMemo(() => (changelog ? DOMPurify.sanitize(marked.parse(changelog, { async: false }) as string) : ""), [changelog]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); }
  };

  const title = meta?.displayName || installed?.displayName || name;
  const description = meta?.description || installed?.description || "";
  const version = installed?.version || meta?.version;
  const repo = meta?.repository || installed?.repository;
  const status = !installed ? null : disabled ? "Disabled" : features.supported.length ? "Active" : "Installed — nothing to run";

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
            <span>{meta?.publishedBy?.loginName ? meta.namespace : namespace}</span>
            {version && <span>v{version}</span>}
            {meta && <span>{fmt(meta.downloadCount)} downloads</span>}
            {meta?.averageRating ? <span>★ {Number(meta.averageRating).toFixed(1)}</span> : null}
            {status && <span className={`ext-status ${disabled ? "off" : ""}`}>● {status}</span>}
          </div>
          <p>{description}</p>
          <div className="ext-actions">
            {!installed ? (
              <button className="btn primary" disabled={!!busy || offline || !extensionAllowed(id, meta?.version)} title={extensionAllowed(id, meta?.version) ? undefined : "Not on your organization's extension allowlist"} onClick={() => act("install", () => installFromOpenVsx(namespace, name))}>
                {busy === "install" ? "Installing…" : extensionAllowed(id, meta?.version) ? "Install" : "Blocked by policy"}
              </button>
            ) : (
              <>
                <button className="btn" disabled={!!busy} onClick={() => act("toggle", () => setExtensionEnabled(id, disabled))}>
                  {disabled ? "Enable" : "Disable"}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => act("uninstall", () => uninstallExtension(id))}>
                  {busy === "uninstall" ? "Removing…" : "Uninstall"}
                </button>
                {!disabled && installed.themes.length > 0 && (
                  <select
                    className="ext-select"
                    value={installed.themes.some((t) => theme === `ext:${id}:${t.label}`) ? theme : ""}
                    onChange={(e) => e.target.value && saveSettings({ ...get().settings, theme: e.target.value })}
                  >
                    <option value="">Set color theme…</option>
                    {installed.themes.map((t) => <option key={t.label} value={`ext:${id}:${t.label}`}>{t.label}</option>)}
                  </select>
                )}
                {!disabled && installed.iconThemes.length > 0 && (
                  installed.iconThemes.some((t) => iconTheme === `${id}:${t.id}`) ? (
                    <button className="btn" onClick={() => setIconThemeSetting("")}>Use Cepheus icons</button>
                  ) : (
                    <button className="btn primary" onClick={() => setIconThemeSetting(`${id}:${installed.iconThemes[0].id}`)}>Set file icon theme</button>
                  )
                )}
              </>
            )}
            {repo && <button className="link" onClick={() => openUrl(repo)}>Repository ↗</button>}
            {meta && <button className="link" onClick={() => openUrl(`https://open-vsx.org/extension/${namespace}/${name}`)}>Open VSX ↗</button>}
          </div>
        </div>
      </header>

      <nav className="ext-page-tabs">
        {(["details", "features", "changelog"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      <div className="ext-page-body">
        {tab === "details" && (
          html ? <div className="md readme" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="muted">{offline ? "Offline — no README available." : "Loading README…"}</div>
        )}

        {tab === "features" && (
          <div className="ext-features">
            <p className="muted small">
              Cepheus activates the declarative parts of VS Code extensions. Parts that need VS Code's Node.js extension host are listed but not run.
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
                    <td className="no">Needs VS Code runtime</td>
                  </tr>
                ))}
                {!contributes && <tr><td colSpan={3} className="muted">Loading…</td></tr>}
              </tbody>
            </table>
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

        {tab === "changelog" && (
          changelogHtml ? <div className="md readme" dangerouslySetInnerHTML={{ __html: changelogHtml }} /> : <div className="muted">No changelog.</div>
        )}
      </div>
    </div>
  );
}
