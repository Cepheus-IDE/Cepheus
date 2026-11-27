import { useEffect, useMemo, useState } from "react";
import { api, errMsg, ExtInfo } from "../lib/api";
import {
  checkExtensionUpdates, extOptions, importFromEditor, installFromOpenVsx, setAutoUpdate, setExtensionEnabled,
  updateAllExtensions, useManifests, useRecommendations, useUpdates,
} from "../lib/extensions";
import {
  CATEGORIES, Category, compatibility, CompatLevel, FEATURED, Collection, fmtCount, Hit, hitFor, registryManifest,
  searchRegistry, SortKey, useExtProgress,
} from "../lib/marketplace";
import { extensionAllowed, policy } from "../lib/policy";
import { openExtension } from "../lib/workspace";
import { toast, useStore } from "../store";
import { bridgeFor } from "../lib/bridges/registry";
import { BridgeBadge } from "./BridgeCard";

function LocalIcon({ ext }: { ext: ExtInfo }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (ext.icon) api.readDataUrl(ext.icon).then(setUrl).catch(() => {});
  }, [ext.icon]);
  return url ? <img src={url} alt="" /> : <div className="ext-ph">{ext.displayName[0]}</div>;
}

const settingsRegistry = () => useStore.getState().settings.extensionRegistryUrl;

const SHORT: Record<CompatLevel, string> = { full: "Works", partial: "Partly works", pack: "Pack", code: "Needs extension code", empty: "Nothing to run" };
const CODE_WHY = "Its features are JavaScript for VS Code's extension host, which Cepheus doesn't have. Open it to suggest a bridge.";

/**
 * Small "works in Cepheus" badge; `level` undefined while the manifest is loading. Extensions with a
 * Cepheus bridge (src/lib/bridges) show the bridge's status instead.
 */
export function CompatBadge({ level, title, extId }: { level?: CompatLevel; title?: string; extId?: string }) {
  if (extId && bridgeFor(extId)) return <BridgeBadge extId={extId} />;
  if (!level) return null;
  return <span className={`ext-compat ${level}`} title={level === "code" ? CODE_WHY : title}>{SHORT[level]}</span>;
}

function Stars({ rating, count }: { rating?: number; count?: number }) {
  if (!rating) return null;
  return <span title={`${rating.toFixed(1)} from ${count ?? 0} reviews`}>★ {rating.toFixed(1)}</span>;
}

const SORTS: { id: SortKey; label: string }[] = [
  { id: "relevance", label: "Relevance" }, { id: "downloadCount", label: "Downloads" }, { id: "rating", label: "Rating" },
  { id: "timestamp", label: "Recently updated" }, { id: "name", label: "Name" },
];

type Compat = Record<string, { level: CompatLevel; label: string }>;
const hitId = (h: Hit) => `${h.namespace}.${h.name}`.toLowerCase();

export default function ExtensionsPanel() {
  const installed = useStore((s) => s.extensions);
  const disabled = useStore((s) => s.settings.disabledExtensions);
  const autoUpdate = useStore((s) => s.settings.extensionOptions?.autoUpdate ?? false);
  const activeTab = useStore((s) => s.activeId);
  const manifests = useManifests();
  const updates = useUpdates();
  const progress = useExtProgress();
  const [tab, setTab] = useState<"market" | "installed">("market");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>(CATEGORIES[0]);
  const [sort, setSort] = useState<SortKey>("downloadCount");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [supportedOnly, setSupportedOnly] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [compat, setCompat] = useState<Compat>({});
  const [busy, setBusy] = useState<string>("");
  const recommended = useRecommendations((s) => s.ids);
  const [editors, setEditors] = useState<{ name: string; hasSettings: boolean; extensionCount: number }[]>([]);

  const featured = cat.id === "featured" && !q.trim();

  /** Fetches manifests of shown hits (a few at a time) to tell whether they work in Cepheus. */
  const probe = (list: Hit[]) => {
    for (const h of list) {
      if (compat[hitId(h)]) continue;
      registryManifest(h.namespace, h.name, h.version)
        .then((pkg) => { const c = compatibility(pkg); setCompat((m) => ({ ...m, [hitId(h)]: { level: c.level, label: c.label } })); })
        .catch(() => {});
    }
  };

  const search = async (query = q, c = cat, s = sort) => {
    if (c.id === "featured" && !query.trim()) return setHits([]);
    setBusy("search");
    try {
      const terms = [c.query, query].filter(Boolean).join(" ");
      const r = await searchRegistry({ query: terms, category: c.category, sort: s });
      setHits(r);
      probe(r);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    api.vscodeDetect().then(setEditors).catch(() => {});
  }, []);

  const findInstalled = (ns: string, name: string) => installed.find((e) => e.id === `${ns}.${name}`.toLowerCase());

  const install = async (h: { namespace: string; name: string; displayName?: string }) => {
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

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast(errMsg(e), "error"); } finally { setBusy(""); }
  };

  const isOpen = (ns: string, name: string) => activeTab === `ext:${ns}.${name}`.toLowerCase();

  const shown = useMemo(() => hits.filter((h) => {
    if (verifiedOnly && !h.verified) return false;
    const c = compat[hitId(h)];
    if (supportedOnly && c && (c.level === "code" || c.level === "empty") && !bridgeFor(hitId(h))) return false;
    return true;
  }), [hits, compat, verifiedOnly, supportedOnly]);

  const hitRow = (h: Hit) => {
    const inst = findInstalled(h.namespace, h.name);
    const off = inst && disabled.includes(inst.id);
    const c = compat[hitId(h)] ?? (cat.unsupported ? { level: "code" as CompatLevel, label: "Needs extension code (not supported)" } : undefined);
    return (
      <div key={hitId(h)} className={`ext-row clickable ${isOpen(h.namespace, h.name) ? "open" : ""}`} onClick={() => openExtension(h.namespace, h.name, h.displayName)} title="Show details">
        {h.files?.icon ? <img src={h.files.icon} alt="" /> : <div className="ext-ph">{(h.displayName ?? h.name)[0]}</div>}
        <div className="ext-info">
          <div className="ext-name ellipsis">
            {h.displayName || h.name}
            {h.verified && <i className="codicon codicon-verified-filled ext-verified" title="Verified publisher" />}
          </div>
          <div className="ext-desc">{h.description}</div>
          <div className="ext-meta">
            <span>{h.namespace}</span>
            {h.downloadCount ? <span title={`${h.downloadCount.toLocaleString()} installs`}><i className="codicon codicon-cloud-download" /> {fmtCount(h.downloadCount)}</span> : null}
            <Stars rating={h.averageRating} count={h.reviewCount} />
            <CompatBadge level={c?.level} title={c?.label} extId={hitId(h)} />
          </div>
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
  };

  return (
    <div className="panel">
      <div className="panel-header"><span>Extensions</span></div>
      <div className="ext-tabs">
        <button className={tab === "market" ? "on" : ""} onClick={() => setTab("market")}>Marketplace</button>
        <button className={tab === "installed" ? "on" : ""} onClick={() => setTab("installed")}>
          Installed <span className="count">{installed.length}</span>
          {updates.list.length > 0 && <span className="ext-upd-dot" title={`${updates.list.length} update(s) available`} />}
        </button>
      </div>
      {"total" in progress && (
        <div className="ext-progress" role="status">
          <span className="ellipsis">{progress.label} · {progress.done}/{progress.total}</span>
          <div className="bar"><div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} /></div>
        </div>
      )}

      {tab === "market" && (
        <>
          <div className="ext-search">
            <input
              placeholder={policy().extensionRegistryUrl || settingsRegistry() ? "Search the extension registry…" : "Search Open VSX…"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const c = cat.id === "featured" && q.trim() ? CATEGORIES.find((x) => x.id === "all")! : cat;
                setCat(c);
                search(q, c);
              }}
            />
            <div className="ext-cats wrap">
              {CATEGORIES.map((c) => (
                <button key={c.id} className={cat.id === c.id ? "on" : ""} title={c.unsupported ? "These run extension code; popular ones work through Cepheus bridges" : undefined} onClick={() => { setCat(c); search(q, c); }}>
                  {c.label}{c.unsupported && <span className="ext-cat-x">*</span>}
                </button>
              ))}
            </div>
            {!featured && (
              <div className="ext-filters">
                <select value={sort} onChange={(e) => { const s = e.target.value as SortKey; setSort(s); search(q, cat, s); }} aria-label="Sort by">
                  {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                </select>
                <label><input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} /> Verified</label>
                <label title="Hide extensions that only contain code Cepheus does not run"><input type="checkbox" checked={supportedOnly} onChange={(e) => setSupportedOnly(e.target.checked)} /> Works in Cepheus</label>
              </div>
            )}
          </div>
          <div className="tree">
            {cat.unsupported && (
              <div className="ext-unsupported-note">
                <b>Extension code doesn't run in Cepheus.</b> {cat.label} extensions work by running their own JavaScript, which Cepheus never executes. Popular ones have a <b>Cepheus bridge</b> instead (badges “Works in Cepheus”, “Works after setup”, “Built into Cepheus”): it runs the same tool from your project or PATH.
              </div>
            )}
            {featured ? (
              <>
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
                            : <button className="btn small primary" disabled={!!busy} onClick={(e) => { e.stopPropagation(); install({ namespace: ns, name }); }}>{busy === ns + name ? "…" : "Install"}</button>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {FEATURED.map((col) => <FeaturedSection key={col.title} col={col} render={(h) => hitRow(h)} onHits={probe} onMore={() => {
                  const c = col.search?.category ? CATEGORIES.find((x) => x.category === col.search!.category && !x.query) ?? cat : cat;
                  setCat(c); setQ(col.search?.query ?? ""); search(col.search?.query ?? "", c);
                }} />)}
              </>
            ) : (
              <>
                {busy === "search" && <div className="muted small pad">Searching…</div>}
                {busy !== "search" && shown.length === 0 && <div className="muted small pad">No extensions found.</div>}
                {shown.map((h) => hitRow(h))}
              </>
            )}
            <div className="ext-note">
              Cepheus runs the declarative parts of extensions: <b>color themes</b>, <b>file icon themes</b>, <b>snippets</b>, <b>language grammars</b>, <b>editing rules</b>, <b>keymaps</b> and <b>extension packs</b>. Extension code is never executed; popular formatters, linters, language servers and agents (Prettier, ESLint, Ruff, YAML, Svelte, Claude Code…) work through <b>bridges</b> that run the real tool instead. Each extension's page shows what works.
            </div>
          </div>
        </>
      )}

      {tab === "installed" && (
        <div className="tree">
          <div className="ext-update-bar">
            <label title="Check for and install new versions when Cepheus starts">
              <input type="checkbox" checked={autoUpdate} onChange={(e) => run("auto", () => setAutoUpdate(e.target.checked))} /> Auto-update
            </label>
            {updates.list.length > 0 ? (
              <button className="btn small primary" disabled={!!busy || "total" in progress} onClick={() => run("updateAll", () => updateAllExtensions())}>
                Update all ({updates.list.length})
              </button>
            ) : (
              <button className="btn small" disabled={updates.checking} onClick={() => run("check", async () => { const l = await checkExtensionUpdates(); if (!l.length) toast("All extensions are up to date"); })}>
                {updates.checking ? "Checking…" : "Check for updates"}
              </button>
            )}
          </div>
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
            const c = manifests[e.id] ? compatibility(manifests[e.id]) : null;
            const upd = updates.list.find((u) => u.id === e.id);
            const pinned = extOptions().pins[e.id];
            return (
              <div key={e.id} className={`ext-row clickable ${off ? "disabled" : ""} ${isOpen(ns, e.name) ? "open" : ""}`} onClick={() => openExtension(ns, e.name, e.displayName)}>
                <LocalIcon ext={e} />
                <div className="ext-info">
                  <div className="ext-name ellipsis">{e.displayName}</div>
                  <div className="ext-desc">{e.description}</div>
                  <div className="ext-meta">
                    <span>{e.publisher} · v{e.version}{pinned ? " (pinned)" : ""}</span>
                    {upd && <span className="ext-upd">→ v{upd.latest}</span>}
                    {e.source !== "openvsx" && <span>from {e.source}</span>}
                    <CompatBadge level={c?.level} title={c?.label} extId={e.id} />
                  </div>
                </div>
                <button className="btn small" title={off ? "Enable" : "Disable"} onClick={(ev) => { ev.stopPropagation(); run("toggle", () => setExtensionEnabled(e.id, off)); }}>
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

/** One curated collection on the Featured page: a search, or a fixed list of extension ids. */
function FeaturedSection({ col, render, onHits, onMore }: { col: Collection; render: (h: Hit) => JSX.Element; onHits: (h: Hit[]) => void; onMore: () => void }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    let alive = true;
    const p = col.search
      ? searchRegistry({ query: col.search.query, category: col.search.category, sort: "downloadCount", size: 6 })
      : Promise.all((col.ids ?? []).map(hitFor)).then((l) => l.filter((h): h is Hit => !!h));
    p.then((l) => { if (alive) { setHits(l); onHits(l); } }).catch(() => alive && setHits([]));
    return () => { alive = false; };
  }, [col.title]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ext-featured">
      <div className="section-title">
        <span>{col.title}</span>
        {col.search && <button className="link" onClick={onMore}>More</button>}
      </div>
      {col.note && <div className="ext-featured-note">{col.note}</div>}
      {hits === null ? <div className="muted small pad">Loading…</div> : hits.length === 0 ? <div className="muted small pad">Unavailable offline.</div> : hits.map(render)}
    </div>
  );
}
