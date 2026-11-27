// Settings editor: categories on the left, grouped settings on the right, search with match
// highlighting, "Modified" filter, per-setting and per-category reset, policy locks. Every change
// applies (and is saved) immediately; the registry lives in src/lib/settingsSchema.ts.
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { get, set, toast, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import { DEFAULT_SETTINGS, MODEL_SUGGESTIONS, Provider, Settings } from "../lib/settings";
import { allDefs, CATEGORIES, CategoryId, isModified, matches, SettingDef } from "../lib/settingsSchema";
import Appearance from "./Appearance";
import { ManagedBanner } from "./ProfilesModal";
import { isManaged, policy, providerAllowed } from "../lib/policy";
import { useNvidiaModels } from "../lib/nvidia";
import { KNOWN_SERVERS, restartLanguageServers } from "../lib/lsp";
import McpServers from "./McpServers";
import { Hl, LazyText, SettingControl, SettingsSearch } from "./SettingsExtras";
import { workspaceOverrides } from "../lib/settingsLevels";
import { configureSnippets } from "../lib/snippets";
import { openProfilesModal } from "../lib/services";
import { openLanguageModels } from "../lib/models";
import { playSound } from "../lib/sounds";
import { confirmDialog } from "./ConfirmDialog";

const PROVIDERS: { id: Provider; name: string; keyHint: string; baseHint: string }[] = [
  { id: "nvidia", name: "NVIDIA (Free) - open models on NVIDIA NIM, no key needed", keyHint: "Optional: your own nvapi-… key", baseHint: "https://integrate.api.nvidia.com/v1" },
  { id: "anthropic", name: "Anthropic (Claude)", keyHint: "sk-ant-…", baseHint: "https://api.anthropic.com" },
  { id: "gemini", name: "Google Gemini", keyHint: "AIza…", baseHint: "https://generativelanguage.googleapis.com" },
  { id: "openai", name: "OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio…)", keyHint: "sk-… (leave empty for Ollama)", baseHint: "https://api.openai.com/v1  ·  Ollama: http://localhost:11434/v1" },
];

/** Static notes shown under a group (category/group). */
const NOTES: Record<string, string> = {
  "terminal/Appearance": "Terminals render with xterm's DOM renderer; there is no separate GPU acceleration switch in this build.",
  "editor/On save": "Format on save uses the language's formatter (built-in for TS/JS/JSON/CSS/HTML, or a language server).",
};

const change = (patch: Partial<Settings>) => saveSettings({ ...get().settings, ...patch });
const keyOf = (d: SettingDef) => d.key as string;
const telemetryLocked = (k: string) => k === "telemetryLevel";

export default function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const [cat, setCat] = useState<CategoryId>("motion");
  const [q, setQ] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lspAtOpen = useRef("");

  useEffect(() => {
    if (open) lspAtOpen.current = JSON.stringify(get().settings.languageServers);
  }, [open]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [cat]);

  const defs = useMemo(() => allDefs().filter((d) => d.control.type !== "internal"), []);
  const filtering = !!q.trim() || modifiedOnly;
  const visible = useMemo(
    () => defs.filter((d) => matches(d, q) && (!modifiedOnly || isModified(settings, d.key)) && (filtering || !d.when || d.when(settings))),
    [defs, q, modifiedOnly, settings, filtering]
  );
  const counts = useMemo(() => {
    const m = new Map<CategoryId, number>();
    for (const d of visible) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [visible]);
  const modifiedCounts = useMemo(() => {
    const m = new Map<CategoryId, number>();
    for (const d of defs) if (isModified(settings, d.key) && !d.noReset && d.control.type !== "custom") m.set(d.category, (m.get(d.category) ?? 0) + 1);
    return m;
  }, [defs, settings]);

  if (!open) return null;

  const close = () => {
    if (JSON.stringify(get().settings.languageServers) !== lspAtOpen.current) restartLanguageServers();
    set({ settingsOpen: false });
  };

  const resetCategory = async (c: CategoryId) => {
    const keys = defs.filter((d) => d.category === c && !d.noReset && d.control.type !== "custom" && !isManaged(d.key) && isModified(settings, d.key)).map(keyOf);
    if (!keys.length) return toast("Nothing to reset here.");
    const label = CATEGORIES.find((x) => x.id === c)?.label;
    if (!(await confirmDialog({ title: `Reset ${keys.length} setting${keys.length > 1 ? "s" : ""} in ${label}?`, message: keys.join(", "), confirmLabel: "Reset", danger: true }))) return;
    await change(Object.fromEntries(keys.map((k) => [k, structuredClone((DEFAULT_SETTINGS as any)[k])])) as Partial<Settings>);
    toast(`${label}: defaults restored`);
  };

  // Searching/filtering shows hits from every category; otherwise the selected category.
  const shown = filtering ? CATEGORIES.filter((c) => counts.get(c.id)) : CATEGORIES.filter((c) => c.id === cat);
  const navCats = CATEGORIES.filter((c) => c.id !== "other" || defs.some((d) => d.category === "other"));

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal settings-editor" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <h2><i className="codicon codicon-settings-gear" /> Settings</h2>
          <button className="icon-btn" aria-label="Close settings" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <SettingsSearch q={q} setQ={setQ} hits={visible.length} modifiedOnly={modifiedOnly} setModifiedOnly={setModifiedOnly} inputRef={searchRef} />
        <div className="settings-split">
          <nav className="settings-nav" aria-label="Settings categories">
            {navCats.map((c) => {
              const n = counts.get(c.id) ?? 0;
              const mod = modifiedCounts.get(c.id) ?? 0;
              const dim = filtering && !n;
              return (
                <button
                  key={c.id}
                  className={`settings-nav-item ${!filtering && cat === c.id ? "on" : ""} ${dim ? "dim" : ""}`}
                  aria-current={!filtering && cat === c.id ? "page" : undefined}
                  onClick={() => {
                    if (filtering) { setQ(""); setModifiedOnly(false); }
                    setCat(c.id);
                  }}
                >
                  <i className={`codicon codicon-${c.icon}`} aria-hidden="true" />
                  <span className="grow">{c.label}</span>
                  {filtering ? n > 0 && <span className="settings-count">{n}</span> : mod > 0 && <span className="settings-count mod" title={`${mod} changed`}>{mod}</span>}
                </button>
              );
            })}
          </nav>
          <div className="settings-body modal-body" ref={bodyRef}>
            <ManagedBanner />
            {shown.length === 0 && <div className="empty-state">No settings match “{q}”{modifiedOnly ? " among modified settings" : ""}.</div>}
            {shown.map((c) => (
              <CategoryView key={c.id} id={c.id} defs={visible.filter((d) => d.category === c.id)} settings={settings} q={q} filtering={filtering}
                onReset={() => resetCategory(c.id)} canReset={(modifiedCounts.get(c.id) ?? 0) > 0} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CategoryView({ id, defs, settings, q, filtering, onReset, canReset }: { id: CategoryId; defs: SettingDef[]; settings: Settings; q: string; filtering: boolean; onReset: () => void; canReset: boolean }) {
  const meta = CATEGORIES.find((c) => c.id === id)!;
  const groups: [string, SettingDef[]][] = [];
  for (const d of defs) {
    const g = groups.find(([name]) => name === d.group);
    if (g) g[1].push(d);
    else groups.push([d.group, [d]]);
  }
  return (
    <div className="settings-cat">
      <div className="settings-cat-head">
        <div>
          <h2><i className={`codicon codicon-${meta.icon}`} aria-hidden="true" /> {meta.label}</h2>
          {!filtering && <div className="muted small">{meta.blurb}</div>}
        </div>
        {!filtering && <button className="btn small" disabled={!canReset} title="Restore this category's defaults" onClick={onReset}><i className="codicon codicon-discard" /> Reset category</button>}
      </div>
      {groups.map(([group, list]) => {
        const blocks = new Set<string>();
        return (
          <section key={group} className="settings-group" aria-label={group}>
            <h3>{group}</h3>
            {list.map((d) => {
              if (d.control.type === "custom") {
                if (blocks.has(d.control.block)) return null;
                blocks.add(d.control.block);
                return <div key={d.control.block} className="settings-custom">{customBlock(d.control.block, settings)}</div>;
              }
              return <SettingRow key={keyOf(d)} d={d} s={settings} q={q} />;
            })}
            {NOTES[`${id}/${group}`] && <div className="settings-note"><i className="codicon codicon-info" /> {NOTES[`${id}/${group}`]}</div>}
            {!filtering && id === "languages" && group === "Language servers" && <SnippetsRow />}
          </section>
        );
      })}
    </div>
  );
}

function SettingRow({ d, s, q }: { d: SettingDef; s: Settings; q: string }) {
  const k = keyOf(d);
  // A minimum approval mode still lets the user pick a stricter one (applyPolicy enforces the floor).
  const managed = isManaged(k) && !(k === "approvalMode" && policy().minimumApprovalMode);
  const locked = managed || telemetryLocked(k);
  const modified = isModified(s, d.key);
  const overridden = k in workspaceOverrides();
  const stacked = d.control.type === "list" || d.control.type === "map" || (d.control.type === "string" && d.control.multiline);
  return (
    <div className={`setting-row ${modified ? "modified" : ""} ${stacked ? "stacked" : ""}`} data-key={k}>
      <div className="setting-text">
        <label className="setting-label" htmlFor={`set-${k}`}>
          <Hl text={d.label} q={q} />
          {managed && <span className="managed-badge" title="Set by your organization's policy"><i className="codicon codicon-lock" /> Managed by your organization</span>}
          {!managed && telemetryLocked(k) && <span className="managed-badge"><i className="codicon codicon-lock" /> Always off</span>}
          {overridden && <span className="ws-badge" title="Overridden by this folder's .cepheus/settings.json"><i className="codicon codicon-folder" /> Workspace</span>}
        </label>
        <div className="setting-desc"><Hl text={d.description} q={q} /></div>
        <code className="setting-key"><Hl text={k} q={q} /></code>
      </div>
      <div className="setting-control">
        <SettingControl k={d.key} c={d.control} s={s} onChange={change} disabled={locked} />
        {k === "soundVolume" && <button className="btn small" onClick={() => playSound("done", true)}><i className="codicon codicon-play" /> Test</button>}
        {modified && !locked && (
          <button className="icon-btn small setting-reset" title={`Reset to default (${JSON.stringify(DEFAULT_SETTINGS[d.key])})`} aria-label={`Reset ${d.label}`}
            onClick={() => change({ [k]: structuredClone(DEFAULT_SETTINGS[d.key]) } as Partial<Settings>)}>
            <i className="codicon codicon-discard" />
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Custom blocks (settings that need more than one control)
// ---------------------------------------------------------------------------------------------

function customBlock(block: string, s: Settings): ReactNode {
  switch (block) {
    case "appearance": return <Appearance onChange={() => { /* Appearance saves itself */ }} />;
    case "aiProvider": return <AiProviderBlock s={s} />;
    case "mcpServers": return <McpServers value={s.mcpServers ?? {}} onChange={(mcpServers) => change({ mcpServers })} />;
    case "languageServers": return <LanguageServersBlock s={s} />;
    case "keyboard": return (
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Keyboard shortcuts</div>
          <div className="setting-desc">{Object.keys(s.keybindings).length} customized shortcut{Object.keys(s.keybindings).length === 1 ? "" : "s"}. Search, rebind and reset shortcuts in the shortcuts editor (Ctrl+K Ctrl+S).</div>
          <code className="setting-key">keybindings</code>
        </div>
        <div className="setting-control"><button className="btn small" onClick={() => set({ settingsOpen: false, keybindingsOpen: true })}><i className="codicon codicon-keyboard" /> Open shortcuts</button></div>
      </div>
    );
    case "network": return (
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Proxy & certificates {isManaged("proxy") && <span className="managed-badge"><i className="codicon codicon-lock" /> Managed by your organization</span>}</div>
          <div className="setting-desc">{s.proxy.http || s.proxy.https ? `Proxy: ${s.proxy.https || s.proxy.http}` : "No proxy."} {s.trustedCertificates.length} extra trusted certificate{s.trustedCertificates.length === 1 ? "" : "s"}.</div>
          <code className="setting-key">proxy · trustedCertificates</code>
        </div>
        <div className="setting-control"><button className="btn small" onClick={() => openProfilesModal("organization")}><i className="codicon codicon-globe" /> Edit network</button></div>
      </div>
    );
    case "privacy": return <PrivacyBlock s={s} />;
    default: return null;
  }
}

function SnippetsRow() {
  const ws = useStore((s) => s.workspace);
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">Snippets</div>
        <div className="setting-desc">Your own snippets, per language (user) or for this folder (workspace).</div>
      </div>
      <div className="setting-control">
        <button className="btn small" onClick={() => configureSnippets("user")}><i className="codicon codicon-symbol-snippet" /> User</button>
        <button className="btn small" onClick={() => configureSnippets("workspace")} disabled={!ws}><i className="codicon codicon-symbol-snippet" /> Workspace</button>
      </div>
    </div>
  );
}

function PrivacyBlock({ s }: { s: Settings }) {
  const sessions = useStore((st) => st.sessions.filter((x) => x.items.length > 0).length);
  const clearRecent = async () => {
    if (await confirmDialog({ title: "Clear recent folders?", message: `${s.recent.length} folder${s.recent.length === 1 ? "" : "s"} will be removed from the list (the folders themselves are untouched).`, confirmLabel: "Clear" })) {
      await change({ recent: [] });
      toast("Recent folders cleared");
    }
  };
  const clearAgents = async () => {
    if (!(await confirmDialog({ title: "Delete all agent tasks?", message: "Every saved conversation, plan and change list is deleted. Files the agent changed stay as they are.", confirmLabel: "Delete all", danger: true }))) return;
    const { deleteSession, stopSession } = await import("../lib/agent");
    for (const x of get().sessions) {
      if (x.status === "running" || x.status === "waiting") stopSession(x.id);
      deleteSession(x.id);
    }
    toast("Agent history cleared");
  };
  return (
    <>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Recent folders</div>
          <div className="setting-desc">{s.recent.length ? s.recent.slice(0, 3).join(" · ") + (s.recent.length > 3 ? ` and ${s.recent.length - 3} more` : "") : "None stored."}</div>
          <code className="setting-key">recent</code>
        </div>
        <div className="setting-control"><button className="btn small" disabled={!s.recent.length} onClick={clearRecent}><i className="codicon codicon-clear-all" /> Clear</button></div>
      </div>
      <div className="setting-row">
        <div className="setting-text">
          <div className="setting-label">Agent history</div>
          <div className="setting-desc">{sessions} saved agent task{sessions === 1 ? "" : "s"} (conversations, plans, change lists, debug logs).</div>
        </div>
        <div className="setting-control"><button className="btn small" disabled={!sessions} onClick={clearAgents}><i className="codicon codicon-trash" /> Delete all</button></div>
      </div>
    </>
  );
}

function AiProviderBlock({ s }: { s: Settings }) {
  const [showKey, setShowKey] = useState(false);
  const p = s.provider;
  const meta = PROVIDERS.find((x) => x.id === p) ?? PROVIDERS[0];
  const nv = useNvidiaModels(p === "nvidia");
  const lock = (k: string) => isManaged(k) && <span className="managed-badge"><i className="codicon codicon-lock" /> Managed by your organization</span>;
  return (
    <div className="ai-block">
      <label>Provider {lock("provider")}</label>
      <div className="seg">
        {PROVIDERS.map((x) => (
          <button key={x.id} className={p === x.id ? "on" : ""} disabled={!providerAllowed(x.id) || isManaged("provider")} title={providerAllowed(x.id) ? x.name : "Not allowed by your organization"} onClick={() => change({ provider: x.id })}>{x.name.split(" (")[0]}</button>
        ))}
      </div>
      <div className="muted small">{meta.name}</div>

      <label htmlFor="ai-key">API key {lock("keys")}</label>
      <div className="row gap">
        <span className="grow"><LazyText id="ai-key" type={showKey ? "text" : "password"} placeholder={meta.keyHint} value={s.keys[p]} disabled={isManaged("keys")} onCommit={(v) => change({ keys: { ...get().settings.keys, [p]: v.trim() } })} /></span>
        <button className="btn" aria-label={showKey ? "Hide key" : "Show key"} onClick={() => setShowKey((v) => !v)}><i className={`codicon codicon-eye${showKey ? "-closed" : ""}`} /></button>
      </div>
      <div className="muted small">{p === "nvidia" ? "No key needed: free access works out of the box (fair-use limits, Nemotron models). Add your own key from build.nvidia.com for higher limits and the full model catalog." : "Stored locally in your app config folder. Requests go directly from this computer to the provider."}</div>

      <label htmlFor="ai-model">Model {lock("models")}</label>
      {p === "nvidia" ? (
        <div className="row gap">
          <select id="ai-model" className="grow" disabled={isManaged("models")} value={s.models.nvidia} onChange={(e) => change({ models: { ...s.models, nvidia: e.target.value } })}>
            {[...new Set([s.models.nvidia, ...(nv.models ?? [])])].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn" title="Refresh model list" aria-label="Refresh model list" onClick={nv.refresh}><i className={`codicon codicon-${nv.models === null && !nv.error ? "loading codicon-modifier-spin" : "refresh"}`} /></button>
        </div>
      ) : (
        <>
          <LazyText id="ai-model" value={s.models[p]} disabled={isManaged("models")} onCommit={(v) => change({ models: { ...get().settings.models, [p]: v } })} />
          <div className="muted small">Suggestions: {MODEL_SUGGESTIONS[p].join(" · ")}</div>
        </>
      )}
      {p === "nvidia" && <div className="muted small">{nv.error ? `Couldn’t load models: ${nv.error}` : nv.models ? `${nv.models.length} models available, loaded live from ${s.keys.nvidia.trim() ? "NVIDIA" : "the free tier"}.` : "Loading models from NVIDIA…"}</div>}

      <label htmlFor="ai-base">Base URL <span className="muted">(optional)</span> {lock("baseUrls")}</label>
      <LazyText id="ai-base" placeholder={meta.baseHint} value={s.baseUrls[p]} disabled={isManaged("baseUrls")} onCommit={(v) => change({ baseUrls: { ...get().settings.baseUrls, [p]: v.trim() } })} />

      {p === "anthropic" && (
        <>
          <label>Effort</label>
          <div className="seg">
            {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => (
              <button key={e} className={s.effort === e ? "on" : ""} onClick={() => change({ effort: e })}>{e}</button>
            ))}
          </div>
          <div className="muted small">Higher effort = deeper reasoning, more tokens. "high" is a good default for coding.</div>
        </>
      )}
      <div className="row gap" style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => { set({ settingsOpen: false }); openLanguageModels(); }}><i className="codicon codicon-sparkle" /> Language Models manager</button>
        <span className="muted small">Custom providers, hidden models and the default chat model{s.customProviders.length ? ` (${s.customProviders.length} custom provider${s.customProviders.length > 1 ? "s" : ""})` : ""}.</span>
      </div>
    </div>
  );
}

function LanguageServersBlock({ s }: { s: Settings }) {
  return (
    <div>
      <div className="muted small">Go to definition, rename, diagnostics and completion per language. Leave empty to auto-detect the server on PATH (shown as placeholder); servers restart when you close Settings. Install one with e.g. <code>npm i -g pyright</code>, <code>rustup component add rust-analyzer</code>, <code>go install golang.org/x/tools/gopls@latest</code>.</div>
      <div className="lsp-grid">
        {Object.entries(KNOWN_SERVERS).filter(([l]) => l !== "c").map(([lang, specs]) => (
          <div key={lang} className="lsp-row">
            <span className="lsp-lang">{lang === "cpp" ? "c / c++" : lang}</span>
            <LazyText
              placeholder={specs.map((x) => x.command).join("  |  ")}
              value={s.languageServers[lang] ?? ""}
              onCommit={(v) => {
                const ls = { ...get().settings.languageServers, [lang]: v };
                if (lang === "cpp") ls.c = v;
                if (!v.trim()) { delete ls[lang]; if (lang === "cpp") delete ls.c; }
                change({ languageServers: ls });
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
