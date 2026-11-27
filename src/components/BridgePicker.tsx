import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/** A small standalone quick pick (same look as the command palette), used by bridge commands. */
export interface PickItem<T> { label: string; detail?: string; icon?: string; value: T }

export function pickOne<T>(title: string, items: PickItem<T>[]): Promise<T | undefined> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const prevFocus = document.activeElement as HTMLElement | null;
    const done = (v: T | undefined) => {
      root.unmount();
      host.remove();
      prevFocus?.focus?.();
      resolve(v);
    };
    root.render(<Picker title={title} items={items} done={done} />);
  });
}

function Picker<T>({ title, items, done }: { title: string; items: PickItem<T>[]; done: (v: T | undefined) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => input.current?.focus(), 0); }, []);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((i) => (i.label + " " + (i.detail ?? "")).toLowerCase().includes(t)) : items;
  }, [q, items]);
  return (
    <div className="overlay" onMouseDown={() => done(undefined)}>
      <div className="palette bridge-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="bridge-picker-title">{title}</div>
        <input
          ref={input}
          value={q}
          placeholder="Type to filter"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); done(undefined); }
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(shown.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); if (shown[sel]) done(shown[sel].value); }
          }}
        />
        <div className="palette-list">
          {shown.map((it, i) => (
            <div key={i} className={`palette-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => done(it.value)}>
              <i className={`codicon codicon-${it.icon ?? "circle-small"}`} />
              <span className="label">{it.label}</span>
              {it.detail && <span className="detail">{it.detail}</span>}
            </div>
          ))}
          {shown.length === 0 && <div className="palette-item muted">No results</div>}
        </div>
      </div>
    </div>
  );
}
