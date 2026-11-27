// Settings editor building blocks: search bar, highlighted text, and one control per setting type.
import { Fragment, ReactNode, useEffect, useRef, useState } from "react";
import { Settings } from "../lib/settings";
import { Control } from "../lib/settingsSchema";
import { openUserSettingsJson, openWorkspaceSettingsJson } from "../lib/settingsLevels";

export function SettingsSearch({ q, setQ, hits, modifiedOnly, setModifiedOnly, inputRef }: {
  q: string; setQ: (q: string) => void; hits: number; modifiedOnly: boolean; setModifiedOnly: (v: boolean) => void; inputRef?: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className="settings-search">
      <i className="codicon codicon-search" aria-hidden="true" />
      <input
        ref={inputRef}
        autoFocus
        placeholder="Search settings by name, description or key"
        aria-label="Search settings"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && q && (e.stopPropagation(), setQ(""))}
      />
      {(q.trim() || modifiedOnly) && <span className="hits" aria-live="polite">{hits ? `${hits} setting${hits > 1 ? "s" : ""}` : "No settings found"}</span>}
      <button className={`btn small ${modifiedOnly ? "on" : ""}`} aria-pressed={modifiedOnly} title="Show only settings you changed" onClick={() => setModifiedOnly(!modifiedOnly)}>
        <i className="codicon codicon-filter" /> Modified
      </button>
      <button className="btn small" title="Edit the user settings file (settings.json)" onClick={openUserSettingsJson}><i className="codicon codicon-json" /> User JSON</button>
      <button className="btn small" title="Edit .cepheus/settings.json — overrides user settings in this folder" onClick={openWorkspaceSettingsJson}><i className="codicon codicon-folder" /> Workspace JSON</button>
    </div>
  );
}

/** Wraps search words in <mark>. */
export function Hl({ text, q }: { text: string; q: string }) {
  const words = q.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join("|")})`, "gi"));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** Text input that commits after a pause or on blur (so typing doesn't write settings.json per key). */
export function LazyText({ value, onCommit, placeholder, multiline, disabled, id, type = "text" }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; multiline?: boolean; disabled?: boolean; id?: string; type?: string;
}) {
  const [v, setV] = useState(value);
  const timer = useRef(0);
  const latest = useRef(value);
  useEffect(() => { if (value !== latest.current) { latest.current = value; setV(value); } }, [value]);
  const commit = (next: string) => { clearTimeout(timer.current); if (next !== latest.current) { latest.current = next; onCommit(next); } };
  const change = (next: string) => { setV(next); clearTimeout(timer.current); timer.current = window.setTimeout(() => commit(next), 500); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return multiline
    ? <textarea id={id} rows={3} disabled={disabled} placeholder={placeholder} value={v} onChange={(e) => change(e.target.value)} onBlur={() => commit(v)} />
    : <input id={id} type={type} disabled={disabled} placeholder={placeholder} value={v} onChange={(e) => change(e.target.value)} onBlur={() => commit(v)} onKeyDown={(e) => e.key === "Enter" && commit(v)} />;
}

function NumberInput({ value, c, onCommit, disabled, id }: { value: number; c: Extract<Control, { type: "number" }>; onCommit: (v: number) => void; disabled?: boolean; id: string }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const clamp = (n: number) => Math.min(c.max, Math.max(c.min, n));
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return setV(String(value));
    const next = clamp(n);
    setV(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <span className="set-number">
      <input id={id} type="number" disabled={disabled} min={c.min} max={c.max} step={c.step ?? 1} value={v}
        onChange={(e) => { setV(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() && Number.isFinite(n) && n >= c.min && n <= c.max && n !== value) onCommit(n); }}
        onBlur={(e) => commit(e.target.value)} />
      {c.unit && <span className="muted small">{c.unit}</span>}
    </span>
  );
}

function ListInput({ value, c, onCommit, disabled, id }: { value: (string | number)[]; c: Extract<Control, { type: "list" }>; onCommit: (v: any[]) => void; disabled?: boolean; id: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const items = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const vals = c.numeric ? items.map(Number).filter((n) => Number.isFinite(n) && n > 0) : items;
    const next = [...value, ...vals.filter((x) => !value.includes(x as never))];
    if (next.length !== value.length) onCommit(next);
    setDraft("");
  };
  return (
    <div className="set-list">
      {c.presets && (
        <div className="set-presets">
          {c.presets.map(([glob, label]) => {
            const on = value.includes(glob);
            return (
              <button key={glob} disabled={disabled} className={`chip ${on ? "on" : ""}`} aria-pressed={on} title={glob} onClick={() => onCommit(on ? value.filter((x) => x !== glob) : [...value, glob])}>
                <i className={`codicon codicon-${on ? "eye-closed" : "eye"}`} /> {label}
              </button>
            );
          })}
        </div>
      )}
      <div className="set-chips">
        {value.map((x) => (
          <span key={String(x)} className="set-chip">
            <code>{String(x)}</code>
            <button disabled={disabled} aria-label={`Remove ${x}`} onClick={() => onCommit(value.filter((y) => y !== x))}><i className="codicon codicon-close" /></button>
          </span>
        ))}
        <input id={id} disabled={disabled} className="set-chip-input" placeholder={c.placeholder ? `Add ${c.placeholder}…` : "Add…"} value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add(draft)} onBlur={() => draft.trim() && add(draft)} />
      </div>
    </div>
  );
}

function MapInput({ value, c, onCommit, disabled }: { value: Record<string, string>; c: Extract<Control, { type: "map" }>; onCommit: (v: Record<string, string>) => void; disabled?: boolean }) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value));
  useEffect(() => { if (JSON.stringify(Object.fromEntries(rows.filter(([k]) => k.trim()))) !== JSON.stringify(value)) setRows(Object.entries(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: [string, string][]) => onCommit(Object.fromEntries(next.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])));
  return (
    <div className="set-map">
      {rows.map(([k, v], i) => (
        <div key={i} className="set-map-row">
          <input disabled={disabled} placeholder={c.keyPlaceholder} aria-label="Name" value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} onBlur={() => commit(rows)} />
          <input disabled={disabled} placeholder={c.valuePlaceholder} aria-label="Value" value={v} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} onBlur={() => commit(rows)} />
          <button className="icon-btn small" disabled={disabled} aria-label="Remove" onClick={() => { const next = rows.filter((_, j) => j !== i); setRows(next); commit(next); }}><i className="codicon codicon-trash" /></button>
        </div>
      ))}
      <button className="btn small" disabled={disabled} onClick={() => setRows([...rows, ["", ""]])}><i className="codicon codicon-add" /> Add variable</button>
    </div>
  );
}

/** The control for one setting. */
export function SettingControl({ k, c, s, onChange, disabled }: { k: keyof Settings; c: Control; s: Settings; onChange: (patch: Partial<Settings>) => void; disabled?: boolean }): ReactNode {
  const v: any = s[k];
  const id = `set-${k}`;
  const put = (x: unknown) => onChange({ [k]: x } as Partial<Settings>);
  switch (c.type) {
    case "bool":
      return (
        <label className="switch" htmlFor={id}>
          <input id={id} type="checkbox" role="switch" disabled={disabled} checked={!!v} onChange={(e) => put(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
        </label>
      );
    case "enum":
      return c.options.length <= 3 && c.options.every(([, l]) => l.length <= 14) ? (
        <div className="seg set-seg" role="radiogroup">
          {c.options.map(([val, label]) => (
            <button key={val} role="radio" aria-checked={String(v) === val} disabled={disabled} className={String(v) === val ? "on" : ""} onClick={() => put(val)}>{label}</button>
          ))}
        </div>
      ) : (
        <select id={id} disabled={disabled} value={String(v)} onChange={(e) => put(e.target.value)}>
          {c.options.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
        </select>
      );
    case "number":
      return <NumberInput id={id} value={Number(v)} c={c} disabled={disabled} onCommit={put} />;
    case "string":
      return <LazyText id={id} value={String(v ?? "")} placeholder={c.placeholder} multiline={c.multiline} disabled={disabled} onCommit={put} />;
    case "list":
      return <ListInput id={id} value={Array.isArray(v) ? v : []} c={c} disabled={disabled} onCommit={put} />;
    case "map":
      return <MapInput value={v && typeof v === "object" ? v : {}} c={c} disabled={disabled} onCommit={put} />;
    default:
      return null;
  }
}
