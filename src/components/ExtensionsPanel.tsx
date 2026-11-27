import { useEffect, useState } from "react";
import { api, errMsg, ExtInfo } from "../lib/api";
import { importFromEditor, installFromOpenVsx, setExtensionEnabled, useRecommendations } from "../lib/extensions";
import { extensionAllowed, policy } from "../lib/policy";
import { openExtension } from "../lib/workspace";
import { toast, useStore } from "../store";

interface Hit {
  namespace: string;
  name: string;
  displayName?: string;
  description?: string;
  version: string;
  downloadCount?: number;
  files?: { icon?: string };
}

function fmt(n?: number) {
  if (!n) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
}

function LocalIcon({ ext }: { ext: ExtInfo }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (ext.icon) api.readDataUrl(ext.icon).then(setUrl).catch(() => {});
  }, [ext.icon]);
  return url ? <img src={url} alt="" /> : <div className="ext-ph">{ext.displayName[0]}</div>;
}

const settingsRegistry = () => useStore.getState().settings.extensionRegistryUrl;

export default function ExtensionsPanel() {
  const installed = useStore((s) => s.extensions);
  const disabled = useStore((s) => s.settings.disabledExtensions);
  const activeTab = useStore((s) => s.activeId);
  const [tab, setTab] = useState<"market" | "installed">("market");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("Themes");
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState<string>("");
  const recommended = useRecommendations((s) => s.ids);
  const [editors, setEditors] = useState<{ name: string; hasSettings: boolean; extensionCount: number }[]>([]);

  const search = async (query = q, cat = category) => {
    setBusy("search");
    try {
      const r = await api.openvsxSearch(query, cat);
      setHits(r.extensions ?? []);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    search("", "Themes");
    api.vscodeDetect().then(setEditors).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const findInstalled = (ns: string, name: string) => installed.find((e) => e.id === `${ns}.${name}`.toLowerCase());

  const install = async (h: Hit) => {
    setBusy(h.namespace + h.name);
    try {
      await installFromOpenVsx(h.namespace, h.name);
      openExtension(h.namespace, h.name, h.displayName);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const doImport = async (name: string) => {
    setBusy("import:" + name);
    try {
      const notes = await importFromEditor(name);
      toast(`Imported from ${name}: ${notes.join(" · ")}`);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const isOpen = (ns: string, name: string) => activeTab === `ext:${ns}.${name}`.toLowerCase();

  return (
    <div className="panel">
      <div className="panel-header"><span>Extensions</span></div>
      <div className="ext-tabs">
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Marketplace</button>
        <button className={tab === "installed" ? "on" : ""} onClick={() => setTab("installed")}>Installed <span className="count">{installed.length}</span></button>
      </div>

      {tab === "market" && (
        <>
          <div className="ext-search">
            <input placeholder={policy().extensionRegistryUrl || settingsRegistry() ? "Search the extension registry…" : "Search Open VSX…"} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
            <div className="ext-cats">
              {["Themes", "Snippets", ""].map((c) => (
                <button key={c || "all"} className={category === c ? "on" : ""} onClick={() => { setCategory(c); search(q, c); }}>
                  {c || "All"}
                </button>
              ))}
            </div>
          </div>
          <div className="tree">
            {recommended.length > 0 && (
              <div className="ext-reco">
                <div className="section-title">Recommended for this workspace</div>
                {recommended.map((id) => {
                  const [ns, ...rest] = id.split(".");
                  const name = rest.join(".");
                  const inst = findInstalled(ns, name);
                  return (
                    <div key={id} className={`ext-row clickable ${isOpen(ns, name) ? "open" : ""}`} onClick={() => openExtension(ns, name)}>
                      <div className="ext-ph">{name[0]?.toUpperCase()}</div>
                      <div className="ext-info">
                        <div className="ext-name ellipsis">{name}</div>
                        <div className="ext-meta">{ns}</div>
                      </div>
                      {inst ? <span className="ext-badge">Installed</span>
                        : !extensionAllowed(id) && policy().extensionAllowlist && !policy().extensionAllowlist!.some((e) => e.toLowerCase().startsWith(id + "@")) ? <span className="ext-badge off" title="Not on your organization's extension allowlist">Blocked</span>
                        : <button className="btn small primary" disabled={!!busy} onClick={(e) => { e.stopPropagation(); install({ namespace: ns, name, version: "" }); }}>{busy === ns + name ? "…" : "Install"}</button>}
                    </div>
                  );
                })}
              </div>
            )}
            {busy === "search" && <div className="muted small pad">Searching…</div>}
            {hits.map((h) => {
              const inst = findInstalled(h.namespace, h.name);
              const off = inst && disabled.includes(inst.id);
              return (
                <div
                  key={h.namespace + "." + h.name}
                  className={`ext-row clickable ${isOpen(h.namespace, h.name) ? "open" : ""}`}
                  onClick={() => openExtension(h.namespace, h.name, h.displayName)}
                  title="Show details"
                >
                  {h.files?.icon ? <img src={h.files.icon} alt="" /> : <div className="ext-ph">{(h.displayName ?? h.name)[0]}</div>}
                  <div className="ext-info">
                    <div className="ext-name ellipsis">{h.displayName || h.name}</div>
                    <div className="ext-desc">{h.description}</div>
                    <div className="ext-meta">{h.namespace} · v{h.version}{h.downloadCount ? ` · ${fmt(h.downloadCount)}` : ""}</div>
                  </div>
                  {inst ? (
                    <span className={`ext-badge ${off ? "off" : ""}`}>{off ? "Disabled" : "Installed"}</span>
                  ) : !extensionAllowed(`${h.namespace}.${h.name}`, h.version) ? (
                    <span className="ext-badge off" title="Not on your organization's extension allowlist">Blocked</span>
                  ) : (
                    <button className="btn small primary" disabled={!!busy} onClick={(e) => { e.stopPropagation(); install(h); }}>
                      {busy === h.namespace + h.name ? "…" : "Install"}
                    </button>
                  )}
                </div>
              );
            })}
            <div className="ext-note">
              Active in Cepheus: <b>color themes</b>, <b>file icon themes</b> and <b>snippets</b>. Parts that need VS Code's Node runtime (language servers, debuggers, commands) are shown on each extension's Features tab.
            </div>
          </div>
        </>
      )}

      {tab === "installed" && (
        <div className="tree">
          {editors.length > 0 && (
            <div className="import-box">
              <div className="section-title" style={{ padding: "0 0 8px" }}>Import from another editor</div>
              {editors.map((ed) => (
                <button key={ed.name} className="import-row" disabled={!!busy} onClick={() => doImport(ed.name)}>
                  <span>{ed.name}</span>
                  <span className="muted small">{busy === "import:" + ed.name ? "importing…" : `${ed.hasSettings ? "settings · " : ""}${ed.extensionCount} extensions`}</span>
                  <i className="codicon codicon-arrow-right" />
                </button>
              ))}
            </div>
          )}
          {installed.length === 0 && <div className="muted small pad">Nothing installed yet.</div>}
          {installed.map((e) => {
            const off = disabled.includes(e.id);
            const ns = e.publisher || e.id.split(".")[0];
            const what = [
              e.themes.length && `${e.themes.length} theme${e.themes.length > 1 ? "s" : ""}`,
              e.iconThemes.length && "file icons",
              e.snippets.length && "snippets",
            ].filter(Boolean).join(" · ");
            return (
              <div key={e.id} className={`ext-row clickable ${off ? "disabled" : ""} ${isOpen(ns, e.name) ? "open" : ""}`} onClick={() => openExtension(ns, e.name, e.displayName)}>
                <LocalIcon ext={e} />
                <div className="ext-info">
                  <div className="ext-name ellipsis">{e.displayName}</div>
                  <div className="ext-desc">{e.description}</div>
                  <div className="ext-meta">{e.publisher} · v{e.version}{what ? ` · ${what}` : " · nothing Cepheus can run"}{e.source !== "openvsx" ? ` · from ${e.source}` : ""}</div>
                </div>
                <button
                  className="btn small"
                  title={off ? "Enable" : "Disable"}
                  onClick={(ev) => { ev.stopPropagation(); setExtensionEnabled(e.id, off); }}
                >
                  {off ? "Enable" : "Disable"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
