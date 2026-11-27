// ER diagram: tables as SVG cards (PK / FK markers), relationship lines with crow's-foot ends,
// layered auto-layout, drag to rearrange, wheel zoom + drag to pan, positions saved per
// connection + database + schema, click to open a table, export as SVG / PNG.
import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg } from "../../lib/api";
import { toast, useStore, type Tab } from "../../store";
import { dbApi } from "../../lib/db/api";
import { connById, ensureConnected, getOverview, loadErLayout, openDbTab, saveErLayout, useDb, type ErLayout } from "../../lib/db/store";
import { askDbAi } from "../../lib/db/ai";
import type { ForeignKey, OverviewTable, SchemaOverview } from "../../lib/db/types";
import Spin from "./Spin";

const HEAD = 26;
const ROW = 18;
const CHAR = 6.9;
const MAX_COLS = 30;

interface Box { x: number; y: number; w: number; h: number }

function cardSize(t: OverviewTable): { w: number; h: number } {
  const shown = t.columns.slice(0, MAX_COLS);
  const longest = Math.max(t.name.length * 7.6 + 30, ...shown.map((c) => (c.name.length + c.type.length) * CHAR + 48));
  return { w: Math.round(Math.min(Math.max(longest, 150), 340)), h: HEAD + Math.max(1, shown.length + (t.columns.length > MAX_COLS ? 1 : 0)) * ROW + 6 };
}

/** Layered layout: referenced tables to the left, their dependents to the right. */
export function autoLayout(o: SchemaOverview): ErLayout {
  const level = new Map<string, number>();
  for (const t of o.tables) level.set(t.name, 0);
  for (let pass = 0; pass < o.tables.length + 1; pass++) {
    let changed = false;
    for (const f of o.foreignKeys) {
      if (f.fromTable === f.toTable || !level.has(f.fromTable) || !level.has(f.toTable)) continue;
      const want = Math.min((level.get(f.toTable) ?? 0) + 1, 12);
      if ((level.get(f.fromTable) ?? 0) < want) {
        level.set(f.fromTable, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const cols = new Map<number, OverviewTable[]>();
  for (const t of o.tables) {
    const l = level.get(t.name) ?? 0;
    cols.set(l, [...(cols.get(l) ?? []), t]);
  }
  // Wrap very tall columns.
  const out: ErLayout = {};
  let x = 40;
  for (const l of [...cols.keys()].sort((a, b) => a - b)) {
    const ts = cols.get(l)!;
    const perCol = Math.max(4, Math.ceil(Math.sqrt(o.tables.length) * 1.4));
    for (let k = 0; k < ts.length; k += perCol) {
      let y = 40;
      let w = 0;
      for (const t of ts.slice(k, k + perCol)) {
        const s = cardSize(t);
        out[t.name] = { x, y };
        y += s.h + 36;
        w = Math.max(w, s.w);
      }
      x += w + 110;
    }
  }
  return out;
}

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    bg: v("--bg", "#111"),
    card: v("--bg-1", "#1a1a1a"),
    head: v("--bg-2", "#222"),
    border: v("--border", "#333"),
    fg: v("--fg", "#eee"),
    dim: v("--fg-dim", "#aaa"),
    faint: v("--fg-faint", "#777"),
    accent: v("--accent", "#e5352b"),
    yellow: v("--yellow", "#d7b54a"),
    font: v("--font", "system-ui, sans-serif"),
    mono: v("--mono", "monospace"),
  };
}

export default function ErDiagramTab({ tab }: { tab: Tab }) {
  const ref = tab.db!;
  const c = connById(ref.conn);
  const [schema, setSchema] = useState(ref.schema ?? "");
  const [ov, setOv] = useState<SchemaOverview | null>(null);
  const [pos, setPos] = useState<ErLayout>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ kind: "pan" | "card"; name?: string; x0: number; y0: number; ox: number; oy: number; moved: boolean } | null>(null);
  const version = useDb((s) => s.version);
  const themeVersion = useStore((s) => s.themeVersion);
  const reduceMotion = useStore((s) => s.settings.reduceMotion ?? false);
  const key = `${ref.conn}|${ref.database ?? ""}|${schema}`;
  const colors = useMemo(palette, [themeVersion]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!(await ensureConnected(ref.conn))) return;
      setBusy(true);
      try {
        let sc = schema;
        if (!sc) {
          const list = await dbApi.listSchemas(ref.conn, ref.database);
          sc = c?.kind === "sqlite" ? "main" : list.includes("public") ? "public" : list.includes("dbo") ? "dbo" : list[0] ?? ref.database ?? "";
          if (alive) setSchema(sc);
        }
        const o = await getOverview(ref.conn, ref.database, sc, true);
        if (!alive || !o) return;
        setOv(o);
        const saved = loadErLayout(`${ref.conn}|${ref.database ?? ""}|${sc}`) ?? {};
        const auto = autoLayout(o);
        // Keep saved positions; place new tables with the auto layout.
        setPos(Object.fromEntries(o.tables.map((t) => [t.name, saved[t.name] ?? auto[t.name]])));
        setError("");
      } catch (e) {
        if (alive) setError(errMsg(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.conn, ref.database, schema, version]);

  const boxes = useMemo(() => {
    const m = new Map<string, Box>();
    for (const t of ov?.tables ?? []) {
      const p = pos[t.name];
      if (!p) continue;
      m.set(t.name, { ...p, ...cardSize(t) });
    }
    return m;
  }, [ov, pos]);

  const persist = (p: ErLayout) => saveErLayout(key, p).catch(() => {});

  const toWorld = (cx: number, cy: number) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const k = Math.min(3, Math.max(0.15, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    setView({ k, x: mx - ((mx - view.x) * k) / view.k, y: my - ((my - view.y) * k) / view.k });
  };

  const onDown = (e: React.MouseEvent, name?: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (name) drag.current = { kind: "card", name, x0: e.clientX, y0: e.clientY, ox: pos[name].x, oy: pos[name].y, moved: false };
    else drag.current = { kind: "pan", x0: e.clientX, y0: e.clientY, ox: view.x, oy: view.y, moved: false };
    const move = (ev: MouseEvent) => {
      const dr = drag.current;
      if (!dr) return;
      const dx = ev.clientX - dr.x0;
      const dy = ev.clientY - dr.y0;
      if (Math.abs(dx) + Math.abs(dy) > 3) dr.moved = true;
      if (dr.kind === "pan") setView((v) => ({ ...v, x: dr.ox + dx, y: dr.oy + dy }));
      else setPos((p) => ({ ...p, [dr.name!]: { x: Math.round(dr.ox + dx / view.k), y: Math.round(dr.oy + dy / view.k) } }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const dr = drag.current;
      drag.current = null;
      if (dr?.kind === "card") {
        if (dr.moved) setPos((p) => { persist(p); return p; });
        else openDbTab("dbtable", { conn: ref.conn, database: ref.database, schema, table: dr.name });
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fit = () => {
    if (!boxes.size || !svg.current) return;
    const xs = [...boxes.values()];
    const minX = Math.min(...xs.map((b) => b.x)) - 30;
    const minY = Math.min(...xs.map((b) => b.y)) - 30;
    const maxX = Math.max(...xs.map((b) => b.x + b.w)) + 30;
    const maxY = Math.max(...xs.map((b) => b.y + b.h)) + 30;
    const r = svg.current.getBoundingClientRect();
    const k = Math.min(1.5, Math.max(0.15, Math.min(r.width / (maxX - minX), r.height / (maxY - minY))));
    setView({ k, x: -minX * k + (r.width - (maxX - minX) * k) / 2, y: -minY * k + (r.height - (maxY - minY) * k) / 2 });
  };

  useEffect(() => {
    if (ov) requestAnimationFrame(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov]);

  const relayout = () => {
    if (!ov) return;
    const p = autoLayout(ov);
    setPos(p);
    persist(p);
    requestAnimationFrame(fit);
  };

  const exportAs = async (kind: "svg" | "png") => {
    const el = svg.current;
    if (!el || !boxes.size) return;
    const xs = [...boxes.values()];
    const minX = Math.min(...xs.map((b) => b.x)) - 20;
    const minY = Math.min(...xs.map((b) => b.y)) - 20;
    const w = Math.max(...xs.map((b) => b.x + b.w)) + 20 - minX;
    const h = Math.max(...xs.map((b) => b.y + b.h)) + 20 - minY;
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(Math.ceil(w)));
    clone.setAttribute("height", String(Math.ceil(h)));
    clone.setAttribute("viewBox", `${minX} ${minY} ${w} ${h}`);
    clone.removeAttribute("class");
    clone.querySelector("g.er-root")?.setAttribute("transform", "");
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    bg.setAttribute("x", String(minX));
    bg.setAttribute("y", String(minY));
    bg.setAttribute("width", String(w));
    bg.setAttribute("height", String(h));
    bg.setAttribute("fill", colors.bg);
    clone.insertBefore(bg, clone.firstChild);
    const text = new XMLSerializer().serializeToString(clone);
    const name = `${schema || c?.name || "schema"}-er.${kind}`;
    const path = await saveDialog({ defaultPath: name, filters: [{ name: kind.toUpperCase(), extensions: [kind] }] });
    if (!path) return;
    try {
      if (kind === "svg") {
        await api.writeFile(path, text);
      } else {
        const img = new Image();
        const scale = 2;
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error("Could not render the diagram"));
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(w * scale);
        canvas.height = Math.ceil(h * scale);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        const b64 = canvas.toDataURL("image/png").split(",")[1];
        await dbApi.saveBytes(path, b64);
      }
      toast(`Exported ${path}`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const fkCols = useMemo(() => {
    const s = new Set<string>();
    for (const f of ov?.foreignKeys ?? []) for (const col of f.fromColumns) s.add(`${f.fromTable}.${col}`);
    return s;
  }, [ov]);

  const rowY = (t: string, col: string) => {
    const tb = ov?.tables.find((x) => x.name === t);
    const i = tb ? tb.columns.slice(0, MAX_COLS).findIndex((x) => x.name === col) : -1;
    return HEAD + (i < 0 ? 0 : i) * ROW + ROW / 2 + 2;
  };

  const edge = (f: ForeignKey, i: number) => {
    const a = boxes.get(f.fromTable);
    const b = boxes.get(f.toTable);
    if (!a || !b) return null;
    const nullable = ov?.tables.find((t) => t.name === f.fromTable)?.columns.find((x) => x.name === f.fromColumns[0])?.nullable ?? true;
    const ay = a.y + rowY(f.fromTable, f.fromColumns[0]);
    const by = b.y + rowY(f.toTable, f.toColumns[0]);
    const hi = hover === f.fromTable || hover === f.toTable;
    const stroke = hi ? colors.accent : colors.faint;
    let path: string;
    let aEnd: { x: number; dir: number };
    let bEnd: { x: number; dir: number };
    if (f.fromTable === f.toTable) {
      const x = a.x + a.w;
      path = `M ${x} ${ay} C ${x + 60} ${ay}, ${x + 60} ${by}, ${x} ${by}`;
      aEnd = { x, dir: 1 };
      bEnd = { x, dir: 1 };
    } else {
      const leftToRight = a.x + a.w / 2 > b.x + b.w / 2;
      const ax = leftToRight ? a.x : a.x + a.w;
      const bx = leftToRight ? b.x + b.w : b.x;
      const dx = Math.max(40, Math.abs(ax - bx) / 2);
      const s = leftToRight ? -1 : 1;
      path = `M ${ax} ${ay} C ${ax + s * dx} ${ay}, ${bx - s * dx} ${by}, ${bx} ${by}`;
      aEnd = { x: ax, dir: s };
      bEnd = { x: bx, dir: -s };
    }
    // Crow's foot (many) at the child, "||" or "o|" (one / zero-or-one) at the parent.
    const crow = (x: number, y: number, dir: number) => {
      const tip = x + dir * 12;
      return `M ${tip} ${y} L ${x} ${y - 6} M ${tip} ${y} L ${x} ${y} M ${tip} ${y} L ${x} ${y + 6} M ${x + dir * 16} ${y - 6} L ${x + dir * 16} ${y + 6}`;
    };
    const one = (x: number, y: number, dir: number) => `M ${x + dir * 8} ${y - 6} L ${x + dir * 8} ${y + 6}` + (nullable ? "" : ` M ${x + dir * 13} ${y - 6} L ${x + dir * 13} ${y + 6}`);
    return (
      <g key={i} className="er-edge">
        <title>{`${f.fromTable}(${f.fromColumns.join(", ")}) → ${f.toTable}(${f.toColumns.join(", ")})${f.onDelete && f.onDelete !== "NO ACTION" ? ` ON DELETE ${f.onDelete}` : ""}`}</title>
        <path d={path} fill="none" stroke={stroke} strokeWidth={hi ? 1.8 : 1.2} />
        <path d={crow(aEnd.x, ay, aEnd.dir)} fill="none" stroke={stroke} strokeWidth={1.2} />
        <path d={one(bEnd.x, by, bEnd.dir)} fill="none" stroke={stroke} strokeWidth={1.2} />
        {nullable && <circle cx={bEnd.x + bEnd.dir * 15} cy={by} r={3.2} fill={colors.bg} stroke={stroke} strokeWidth={1.1} />}
      </g>
    );
  };

  return (
    <div className="db-tab db-er-tab">
      <div className="db-toolbar">
        {c?.color && <span className="db-color-bar" style={{ background: c.color }} />}
        <i className="codicon codicon-type-hierarchy" />
        <span className="db-title">{c?.name}{ref.database ? ` / ${ref.database}` : ""}{schema && c?.kind !== "sqlite" ? ` / ${schema}` : ""}</span>
        <span className="muted small">{ov ? `${ov.tables.length} tables · ${ov.foreignKeys.length} relationships` : ""}</span>
        {busy && <Spin />}
        <span className="grow" />
        <button className="icon-btn small" title="Zoom in" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.2) }))}><i className="codicon codicon-zoom-in" /></button>
        <button className="icon-btn small" title="Zoom out" onClick={() => setView((v) => ({ ...v, k: Math.max(0.15, v.k / 1.2) }))}><i className="codicon codicon-zoom-out" /></button>
        <button className="btn small" onClick={fit} title="Fit to window"><i className="codicon codicon-screen-full" /> Fit</button>
        <button className="btn small" onClick={relayout} title="Discard manual positions and lay out again"><i className="codicon codicon-layout" /> Auto layout</button>
        <button className="btn small" onClick={() => exportAs("svg")}>SVG</button>
        <button className="btn small" onClick={() => exportAs("png")}>PNG</button>
        <form className="db-ask" onSubmit={(e) => { e.preventDefault(); askDbAi(ask, { conn: ref.conn, database: ref.database, schema }); setAsk(""); }}>
          <i className="codicon codicon-sparkle" />
          <input aria-label="Ask AI about this schema" placeholder="Ask AI: add a tags table, review this schema…" value={ask} onChange={(e) => setAsk(e.target.value)} />
        </form>
      </div>
      {error && <pre className="tb-error db-tab-error">{error}</pre>}
      {ov && !ov.tables.length && <div className="db-results-empty muted small">No tables in this schema yet. Create one with the designer or ask the AI to design a schema.</div>}
      <svg ref={svg} className={`db-er ${reduceMotion ? "still" : ""}`} onMouseDown={(e) => onDown(e)} onWheel={onWheel} role="img" aria-label="Entity relationship diagram" fontFamily={colors.font} fontSize={12}>
        <g className="er-root" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {(ov?.foreignKeys ?? []).map(edge)}
          {(ov?.tables ?? []).map((t) => {
            const b = boxes.get(t.name);
            if (!b) return null;
            const hi = hover === t.name;
            return (
              <g key={t.name} transform={`translate(${b.x} ${b.y})`} onMouseDown={(e) => onDown(e, t.name)} onMouseEnter={() => setHover(t.name)} onMouseLeave={() => setHover(null)} style={{ cursor: "pointer" }}>
                <title>{`${t.name} (${t.kind}) — click to open, drag to move`}</title>
                <rect width={b.w} height={b.h} rx={6} fill={colors.card} stroke={hi ? colors.accent : colors.border} strokeWidth={hi ? 1.5 : 1} />
                <path d={`M 0 6 a 6 6 0 0 1 6 -6 h ${b.w - 12} a 6 6 0 0 1 6 6 v ${HEAD - 6} h ${-b.w} z`} fill={colors.head} />
                <text x={10} y={17} fill={colors.fg} fontWeight={600}>{t.name}</text>
                {t.kind !== "table" && <text x={b.w - 8} y={17} fill={colors.faint} textAnchor="end" fontSize={10}>{t.kind === "materialized_view" ? "mview" : t.kind}</text>}
                {t.columns.slice(0, MAX_COLS).map((col, i) => {
                  const y = HEAD + i * ROW + 14;
                  const fk = fkCols.has(`${t.name}.${col.name}`);
                  return (
                    <g key={col.name}>
                      {col.pk && <text x={9} y={y} fill={colors.yellow} fontSize={10} fontWeight={700}>PK</text>}
                      {!col.pk && fk && <text x={9} y={y} fill={colors.accent} fontSize={10} fontWeight={700}>FK</text>}
                      <text x={30} y={y} fill={col.pk ? colors.fg : colors.dim} fontWeight={col.pk ? 600 : 400}>{col.name}</text>
                      <text x={b.w - 8} y={y} fill={colors.faint} textAnchor="end" fontFamily={colors.mono} fontSize={10.5}>{col.type.toLowerCase()}{col.nullable ? "" : " ✱"}</text>
                    </g>
                  );
                })}
                {t.columns.length > MAX_COLS && <text x={30} y={HEAD + MAX_COLS * ROW + 14} fill={colors.faint}>… {t.columns.length - MAX_COLS} more</text>}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="db-er-legend small muted">PK primary key · FK foreign key · ✱ NOT NULL · crow's foot = many · || one · o optional</div>
    </div>
  );
}
