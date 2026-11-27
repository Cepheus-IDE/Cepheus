import { useEffect, useMemo, useState } from "react";
import { get, set, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import { errMsg } from "../lib/api";
import type { CustomProvider } from "../lib/settings";
import {
  CacheTurn, capabilities, ensureModelLists, fetchModels, fmtTokens, modelsOf, ModelsTab, pickKey, providerEntries,
  ProviderEntry, providerName, resetUnavailable, splitPick, sumUsage, Usage, useModelLists, useModelsView,
  useUnavailable, useUsage,
} from "../lib/models";
import { detectHarnesses, HARNESSES, useHarness } from "../lib/harness";

const fmtCtx = (n?: number | null) => (n ? (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`) : "—");

function Cap({ on, icon, label }: { on?: boolean | null; icon: string; label: string }) {
  const state = on == null ? "unknown" : on ? "yes" : "no";
  return <i className={`codicon codicon-${icon} lm-cap ${state}`} title={`${label}: ${state}`} />;
}

function ModelsTabView() {
  const settings = useStore((s) => s.settings);
  const lists = useModelLists((s) => s.lists);
  const unavailable = useUnavailable((s) => s.keys);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const entries = providerEntries(settings);
  const hidden = new Set(settings.hiddenModels);

  const toggle = (keys: string[], hide: boolean) => {
    const s = get().settings;
    const next = new Set(s.hiddenModels);
    keys.forEach((k) => (hide ? next.add(k) : next.delete(k)));
    saveSettings({ ...s, hiddenModels: [...next] });
  };

  return (
    <>
      <div className="lm-toolbar">
        <input autoFocus placeholder="Filter models" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn small" onClick={() => ensureModelLists(true)}><i className="codicon codicon-refresh" /> Refresh all</button>
        {unavailable.length > 0 && (
          <button className="btn small" title="Try models marked unavailable again" onClick={() => resetUnavailable()}>
            Reset {unavailable.length} unavailable
          </button>
        )}
      </div>
      <div className="lm-list">
        {entries.map((p) => {
          if (!p.configured) {
            return (
              <div key={p.id} className="lm-group off">
                <div className="lm-group-head">
                  <span className="lm-pname">{p.name}</span>
                  <span className="muted small">not configured</span>
                  <div className="spacer" />
                  <button className="btn small" onClick={() => set({ settingsOpen: true })}>Add key…</button>
                </div>
              </div>
            );
          }
          const l = lists[p.id];
          const t = q.toLowerCase();
          const models = modelsOf(settings, p.id).filter((m) => !t || m.id.toLowerCase().includes(t) || (m.name ?? "").toLowerCase().includes(t));
          const keys = models.map((m) => pickKey(p.id, m.id));
          const shown = keys.filter((k) => !hidden.has(k)).length;
          const open = !collapsed[p.id];
          return (
            <div key={p.id} className="lm-group">
              <div className="lm-group-head">
                <button className="icon-btn small" onClick={() => setCollapsed((c) => ({ ...c, [p.id]: open }))}>
                  <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} />
                </button>
                <span className="lm-pname">{p.name}</span>
                <span className="muted small">{shown}/{models.length} shown{!l?.models && !l?.loading ? " · suggestions (live list unavailable)" : ""}</span>
                {l?.loading && <i className="codicon codicon-loading codicon-modifier-spin" />}
                <div className="spacer" />
                <button className="btn small" onClick={() => toggle(keys, false)}>Show all</button>
                <button className="btn small" onClick={() => toggle(keys, true)}>Hide all</button>
                <button className="icon-btn small" title="Refresh" onClick={() => fetchModels(p.id, true)}><i className="codicon codicon-refresh" /></button>
              </div>
              {l?.error && <div className="note err small">{l.error}</div>}
              {open && models.map((m) => {
                const k = pickKey(p.id, m.id);
                const c = capabilities(m.id, m);
                const bad = unavailable.includes(k);
                return (
                  <div key={k} className={`lm-row ${hidden.has(k) ? "hidden" : ""}`}>
                    <input type="checkbox" checked={!hidden.has(k)} title="Show in model pickers" onChange={(e) => toggle([k], !e.target.checked)} />
                    <span className="lm-id ellipsis" title={m.id}>{m.name && m.name !== m.id ? <>{m.name} <span className="muted">{m.id}</span></> : m.id}</span>
                    {bad && (
                      <button className="lm-badge bad" title="Returned 'not found / not available' for this account. Click to try again." onClick={() => resetUnavailable([k])}>
                        unavailable
                      </button>
                    )}
                    <span className="lm-ctx" title="Context window">{fmtCtx(c.contextWindow)}</span>
                    <Cap on={c.tools} icon="tools" label="Tool calling" />
                    <Cap on={c.vision} icon="eye" label="Vision" />
                    <Cap on={c.reasoning} icon="lightbulb" label="Reasoning / thinking effort" />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

const PRESETS: { name: string; baseUrl: string }[] = [
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
];

function CustomProviderForm({ initial, onDone }: { initial?: CustomProvider; onDone: () => void }) {
  const [d, setD] = useState<CustomProvider>(initial ?? { id: "", name: "", baseUrl: "", apiKey: "", models: [] });
  const [modelsText, setModelsText] = useState((initial?.models ?? []).join(", "));
  const save = async () => {
    const s = get().settings;
    const id = d.id || (d.name || "provider").toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);
    const cp: CustomProvider = { ...d, id, name: d.name.trim() || d.baseUrl, baseUrl: d.baseUrl.trim(), models: modelsText.split(/[,\s]+/).filter(Boolean) };
    const list = s.customProviders.some((c) => c.id === id) ? s.customProviders.map((c) => (c.id === id ? cp : c)) : [...s.customProviders, cp];
    await saveSettings({ ...s, customProviders: list });
    fetchModels(`custom:${id}`, true);
    onDone();
  };
  return (
    <div className="lm-form">
      <div className="row gap wrap">
        {PRESETS.map((p) => (
          <button key={p.name} className="btn small" onClick={() => setD({ ...d, name: d.name || p.name, baseUrl: p.baseUrl })}>{p.name}</button>
        ))}
      </div>
      <label>Name</label>
      <input value={d.name} placeholder="My provider" onChange={(e) => setD({ ...d, name: e.target.value })} />
      <label>Base URL (OpenAI-compatible, ends before /chat/completions)</label>
      <input value={d.baseUrl} placeholder="https://host/v1" onChange={(e) => setD({ ...d, baseUrl: e.target.value })} />
      <label>API key (optional for local servers)</label>
      <input type="password" value={d.apiKey} onChange={(e) => setD({ ...d, apiKey: e.target.value })} />
      <label>Extra model ids (optional, for servers without a /models list)</label>
      <input value={modelsText} placeholder="qwen2.5-coder:14b, llama3.1" onChange={(e) => setModelsText(e.target.value)} />
      <div className="row gap">
        <div className="spacer" />
        <button className="btn small" onClick={onDone}>Cancel</button>
        <button className="btn small primary" disabled={!d.baseUrl.trim()} onClick={save}>Save</button>
      </div>
    </div>
  );
}

function ProvidersTabView() {
  const settings = useStore((s) => s.settings);
  const lists = useModelLists((s) => s.lists);
  const installed = useHarness((s) => s.installed);
  const [editing, setEditing] = useState<string | null>(null); // custom id or "new"
  useEffect(() => { detectHarnesses(true); }, []);

  const remove = (id: string) => {
    const s = get().settings;
    saveSettings({
      ...s,
      customProviders: s.customProviders.filter((c) => c.id !== id),
      hiddenModels: s.hiddenModels.filter((k) => !k.startsWith(`custom:${id}|`)),
      modelPick: s.modelPick.startsWith(`custom:${id}|`) ? "" : s.modelPick,
    });
  };
  const status = (p: ProviderEntry) => {
    const l = lists[p.id];
    if (!p.configured) return <span className="muted small">not configured</span>;
    if (l?.loading) return <span className="muted small">checking…</span>;
    if (l?.error) return <span className="lm-badge bad" title={l.error}>error</span>;
    if (l?.models) return <span className="lm-badge ok">{l.models.length} models</span>;
    return null;
  };

  return (
    <div className="lm-list">
      <h3>Built-in providers</h3>
      {providerEntries(settings).filter((p) => !p.custom).map((p) => (
        <div key={p.id} className="lm-prow">
          <span className="lm-pname">{p.name}</span>
          {status(p)}
          <div className="spacer" />
          {p.configured && <button className="btn small" onClick={() => fetchModels(p.id, true)}>Test</button>}
          <button className="btn small" onClick={() => set({ settingsOpen: true })}>Keys…</button>
        </div>
      ))}
      <h3>Custom OpenAI-compatible providers</h3>
      {settings.customProviders.map((c) =>
        editing === c.id ? (
          <CustomProviderForm key={c.id} initial={c} onDone={() => setEditing(null)} />
        ) : (
          <div key={c.id} className="lm-prow">
            <span className="lm-pname">{c.name}</span>
            <span className="muted small ellipsis">{c.baseUrl}</span>
            {status(providerEntries(settings).find((p) => p.id === `custom:${c.id}`)!)}
            <div className="spacer" />
            <button className="btn small" onClick={() => fetchModels(`custom:${c.id}`, true)}>Test</button>
            <button className="icon-btn small" title="Edit" onClick={() => setEditing(c.id)}><i className="codicon codicon-edit" /></button>
            <button className="icon-btn small" title="Remove" onClick={() => remove(c.id)}><i className="codicon codicon-trash" /></button>
          </div>
        )
      )}
      {editing === "new" ? (
        <CustomProviderForm onDone={() => setEditing(null)} />
      ) : (
        <button className="btn small lm-add" onClick={() => setEditing("new")}><i className="codicon codicon-add" /> Add provider</button>
      )}
      <h3>Agent harnesses</h3>
      {HARNESSES.map((h) => (
        <div key={h.id} className="lm-prow">
          <span className="lm-pname">{h.name}</span>
          {!h.exe ? (
            <span className="lm-badge ok">built in</span>
          ) : installed?.[h.exe] ? (
            <span className="lm-badge ok">`{h.exe}` on PATH</span>
          ) : (
            <span className="muted small">not installed: {h.install}</span>
          )}
        </div>
      ))}
      <p className="muted small">Pick the harness per session in the chat footer. Claude Code and Codex run headless in the workspace with your review policy mapped to their permission modes (Ask = read-only, Auto-edit = edits allowed, Turbo = no prompts).</p>
    </div>
  );
}

function UsageTable({ rows }: { rows: Record<string, Usage> | undefined }) {
  const settings = useStore((s) => s.settings);
  const entries = Object.entries(rows ?? {}).sort((a, b) => b[1].input + b[1].output - (a[1].input + a[1].output));
  if (!entries.length) return <p className="muted small">No requests yet.</p>;
  const total = sumUsage(rows);
  const line = (label: React.ReactNode, u: Usage, key: string, bold = false) => (
    <tr key={key} className={bold ? "total" : ""}>
      <td className="ellipsis">{label}</td>
      <td>{u.requests}</td>
      <td>{fmtTokens(u.input)}</td>
      <td>{fmtTokens(u.output)}</td>
      <td>{u.cacheRead || u.cacheWrite ? `${fmtTokens(u.cacheRead)} / ${fmtTokens(u.cacheWrite)}` : "—"}</td>
    </tr>
  );
  return (
    <table className="lm-table">
      <thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache read / write</th></tr></thead>
      <tbody>
        {entries.map(([k, u]) => {
          const [p, m] = splitPick(k);
          return line(<>{m} <span className="muted">{providerName(settings, p)}</span></>, u, k);
        })}
        {entries.length > 1 && line("Total", total, "__total", true)}
      </tbody>
    </table>
  );
}

function UsageTabView() {
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const bySession = useUsage((s) => s.bySession);
  const today = useUsage((s) => s.today);
  return (
    <div className="lm-list">
      <h3>This session{session ? `: ${session.title}` : ""}</h3>
      <UsageTable rows={activeId ? bySession[activeId] : undefined} />
      <h3>Today ({today.date})</h3>
      <UsageTable rows={today.byModel} />
      <p className="muted small">Input includes cached prompt tokens. Counts come from each provider's usage report; Claude Code and Codex report per run.</p>
    </div>
  );
}

function CacheTabView() {
  const settings = useStore((s) => s.settings);
  const cache = useUsage((s) => s.cache);
  const turns = useMemo(() => [...cache].reverse(), [cache]);
  const read = cache.reduce((a, c) => a + c.cacheRead, 0);
  const input = cache.reduce((a, c) => a + c.input, 0);
  const hits = cache.filter((c) => c.cacheRead > 0).length;
  const kind = (c: CacheTurn) => (c.cacheRead > 0 ? "hit" : c.cacheWrite > 0 ? "write" : "miss");
  return (
    <div className="lm-list">
      <div className="lm-stats">
        <div><b>{cache.length ? Math.round((hits / cache.length) * 100) : 0}%</b><span>turns with a cache hit</span></div>
        <div><b>{input ? Math.round((read / input) * 100) : 0}%</b><span>input tokens served from cache</span></div>
        <div><b>{fmtTokens(read)}</b><span>cached tokens read</span></div>
      </div>
      {!turns.length && <p className="muted small">No cache data yet. Anthropic (and Claude Code) report cache reads/writes per turn; OpenAI and Gemini report cached tokens when they cache automatically.</p>}
      {turns.length > 0 && (
        <table className="lm-table">
          <thead><tr><th>Time</th><th>Model</th><th>Result</th><th>Input</th><th>Read</th><th>Write</th></tr></thead>
          <tbody>
            {turns.map((c, i) => {
              const [p, m] = splitPick(c.model);
              return (
                <tr key={i}>
                  <td>{new Date(c.at).toLocaleTimeString()}</td>
                  <td className="ellipsis" title={providerName(settings, p)}>{m}</td>
                  <td><span className={`lm-badge ${kind(c) === "hit" ? "ok" : kind(c) === "miss" ? "bad" : ""}`}>{kind(c)}</span></td>
                  <td>{fmtTokens(c.input)}</td>
                  <td>{fmtTokens(c.cacheRead)}</td>
                  <td>{fmtTokens(c.cacheWrite)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">The built-in agent asks Claude to cache tools, system prompt and conversation prefix on every turn. A "write" turn stores the prefix; later turns should be hits. Repeated misses mean the prefix changed or is below the model's minimum cacheable size.</p>
    </div>
  );
}

const TABS: { id: ModelsTab; label: string }[] = [
  { id: "models", label: "Models" },
  { id: "providers", label: "Providers" },
  { id: "usage", label: "Usage" },
  { id: "cache", label: "Cache" },
];

/** Language Models editor: providers, models + capabilities, visibility, usage and cache stats. */
export default function LanguageModels() {
  const { open, tab } = useModelsView();
  useEffect(() => {
    if (open) {
      try { ensureModelLists(); } catch (e) { console.warn(errMsg(e)); }
    }
  }, [open]);
  if (!open) return null;
  const close = () => useModelsView.setState({ open: false });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal lm-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
        <div className="modal-head">
          <h2><i className="codicon codicon-sparkle" /> Language Models</h2>
          <div className="lm-tabs">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => useModelsView.setState({ tab: t.id })}>{t.label}</button>
            ))}
          </div>
          <button className="icon-btn" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <div className="modal-body lm-body">
          {tab === "models" && <ModelsTabView />}
          {tab === "providers" && <ProvidersTabView />}
          {tab === "usage" && <UsageTabView />}
          {tab === "cache" && <CacheTabView />}
        </div>
      </div>
    </div>
  );
}
