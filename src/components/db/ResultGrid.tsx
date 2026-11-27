// Virtualized data grid shared by query results and table data: resizable columns, sortable
// headers, optional per-column filter row, row selection, inline editing with dirty highlighting,
// NULL handling, a long-text / JSON cell editor and copy as TSV / JSON / INSERT.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../store";
import ContextMenu, { MenuItem } from "../ContextMenu";
import { sqlValue, quoteIdent } from "../../lib/db/sql";
import type { Dialect } from "../../lib/db/types";
import { Modal } from "./DbDialogs";

export interface GridColumn { name: string; type?: string; pk?: boolean; nullable?: boolean; auto?: boolean }
export type RowState = "new" | "deleted" | undefined;

export interface GridProps {
  columns: GridColumn[];
  rows: unknown[][];
  dialect: Dialect;
  /** Table name used for "Copy as INSERT" */
  tableName?: string;
  editable?: boolean;
  /** Cells edited but not saved: `${row}:${col}` */
  dirty?: Set<string>;
  rowState?: (row: number) => RowState;
  onEdit?: (row: number, col: number, value: unknown) => void;
  sort?: { col: number; desc: boolean } | null;
  onSort?: (col: number) => void;
  filters?: Record<number, string>;
  onFilter?: (col: number, value: string) => void;
  selected?: Set<number>;
  onSelect?: (rows: Set<number>) => void;
  /** Row number offset for the gutter (paging). */
  rowOffset?: number;
  emptyText?: string;
  onScrollEnd?: () => void;
}

const ROW_H = 24;
const MIN_W = 48;

function display(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

const isLong = (v: unknown) => typeof v === "string" && (v.length > 120 || v.includes("\n") || /^\s*[[{]/.test(v));

export function rowsAsTsv(cols: GridColumn[], rows: unknown[][], header = true): string {
  const cell = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\t/g, " ").replace(/\r?\n/g, " ");
  const lines = rows.map((r) => r.map(cell).join("\t"));
  return (header ? [cols.map((c) => c.name).join("\t"), ...lines] : lines).join("\n");
}
export function rowsAsJson(cols: GridColumn[], rows: unknown[][]): string {
  return JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c, i) => [c.name, r[i] ?? null]))), null, 2);
}
export function rowsAsInsert(d: Dialect, table: string, cols: GridColumn[], rows: unknown[][]): string {
  const names = cols.map((c) => quoteIdent(d, c.name)).join(", ");
  return rows.map((r) => `INSERT INTO ${table} (${names}) VALUES (${r.map((v) => sqlValue(d, v)).join(", ")});`).join("\n");
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`), () => toast("Clipboard unavailable", "error"));
}

export default memo(function ResultGrid(p: GridProps) {
  const { columns, rows } = p;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [widths, setWidths] = useState<number[]>([]);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; text: string } | null>(null);
  const [bigEdit, setBigEdit] = useState<{ r: number; c: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const anchor = useRef<number | null>(null);
  const selected = p.selected ?? new Set<number>();

  // Initial column widths from header + first rows.
  useEffect(() => {
    setWidths(
      columns.map((c, i) => {
        let w = Math.max(c.name.length * 8 + 34, MIN_W);
        for (const r of rows.slice(0, 50)) w = Math.max(w, Math.min(display(r[i]).length * 7.2 + 18, 360));
        return Math.round(Math.min(w, 380));
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.map((c) => c.name).join("\u0001")]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const headerRows = p.onFilter ? 2 : 1;
  const top = headerRows * ROW_H;
  const first = Math.max(0, Math.floor((scrollTop - top) / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 8);
  const totalW = 46 + widths.reduce((a, b) => a + b, 0);
  const tpl = `46px ${widths.map((w) => `${w}px`).join(" ")}`;

  const onScroll = () => {
    const el = scroller.current!;
    setScrollTop(el.scrollTop);
    if (p.onScrollEnd && el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 3) p.onScrollEnd();
  };

  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: MouseEvent) => setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(MIN_W, w0 + ev.clientX - x0) : w)));
    const upFn = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", upFn);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", upFn);
  };

  const selectRow = (r: number, e: React.MouseEvent) => {
    if (!p.onSelect) return;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, r), Math.max(anchor.current, r)];
      for (let i = a; i <= b; i++) next.add(i);
    } else {
      if (next.has(r) && (e.ctrlKey || e.metaKey)) next.delete(r);
      else next.add(r);
      anchor.current = r;
    }
    p.onSelect(next);
  };

  const commitEdit = () => {
    if (!editing || !p.onEdit) return setEditing(null);
    const old = rows[editing.r]?.[editing.c];
    const v = editing.text;
    if (String(old ?? "") !== v || old === null) p.onEdit(editing.r, editing.c, v);
    setEditing(null);
  };

  const beginEdit = (r: number, c: number) => {
    if (!p.editable || p.rowState?.(r) === "deleted") return;
    const v = rows[r]?.[c];
    if (isLong(v)) setBigEdit({ r, c });
    else setEditing({ r, c, text: v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) });
  };

  const targetRows = useCallback((r: number) => (selected.has(r) && selected.size > 0 ? [...selected].sort((a, b) => a - b) : [r]), [selected]);

  const cellMenu = (e: React.MouseEvent, r: number, c: number) => {
    e.preventDefault();
    const rs = targetRows(r);
    const data = rs.map((i) => rows[i]);
    const tname = p.tableName ?? quoteIdent(p.dialect, "table_name");
    const items: MenuItem[] = [
      { label: "Copy cell", icon: "copy", onClick: () => copy(rows[r][c] === null ? "NULL" : display(rows[r][c]), "cell") },
      { label: `Copy ${rs.length > 1 ? rs.length + " rows" : "row"} as TSV`, icon: "copy", onClick: () => copy(rowsAsTsv(columns, data, false), "rows") },
      { label: "Copy with headers (TSV)", icon: "copy", onClick: () => copy(rowsAsTsv(columns, data, true), "rows") },
      { label: "Copy as JSON", icon: "json", onClick: () => copy(rowsAsJson(columns, data), "JSON") },
      { label: "Copy as INSERT", icon: "symbol-keyword", onClick: () => copy(rowsAsInsert(p.dialect, tname, columns, data), "INSERT statements") },
    ];
    if (p.editable && p.onEdit && p.rowState?.(r) !== "deleted") {
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Edit cell…", icon: "edit", onClick: () => setBigEdit({ r, c }) });
      items.push({ label: "Set NULL", icon: "circle-slash", onClick: () => p.onEdit!(r, c, null) });
    }
    if (p.onFilter && rows[r][c] !== undefined) {
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Filter by this value", icon: "filter", onClick: () => p.onFilter!(c, rows[r][c] === null ? "IS NULL" : `= ${display(rows[r][c])}`) });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const rs = selected.size ? [...selected].sort((a, b) => a - b) : focus ? [focus.r] : [];
      if (!rs.length) return;
      e.preventDefault();
      if (focus && !selected.size) copy(display(rows[focus.r][focus.c]), "cell");
      else copy(rowsAsTsv(columns, rs.map((i) => rows[i]), false), `${rs.length} row${rs.length > 1 ? "s" : ""}`);
      return;
    }
    if (!focus) return;
    const mv = (r: number, c: number) => {
      const nr = Math.max(0, Math.min(rows.length - 1, r));
      const nc = Math.max(0, Math.min(columns.length - 1, c));
      setFocus({ r: nr, c: nc });
      const el = scroller.current;
      if (el) {
        const y = top + nr * ROW_H;
        if (y < el.scrollTop + top) el.scrollTop = y - top;
        else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
      }
    };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); mv(focus.r + 1, focus.c); break;
      case "ArrowUp": e.preventDefault(); mv(focus.r - 1, focus.c); break;
      case "ArrowLeft": e.preventDefault(); mv(focus.r, focus.c - 1); break;
      case "ArrowRight": case "Tab": e.preventDefault(); mv(focus.r, focus.c + (e.shiftKey && e.key === "Tab" ? -1 : 1)); break;
      case "Enter": case "F2": e.preventDefault(); beginEdit(focus.r, focus.c); break;
      case "Delete": if (p.editable && p.onEdit && e.shiftKey) p.onEdit(focus.r, focus.c, null); break;
    }
  };

  const visible = useMemo(() => {
    const out: number[] = [];
    for (let i = first; i < last; i++) out.push(i);
    return out;
  }, [first, last]);

  if (!columns.length) return <div className="db-grid-empty muted small">{p.emptyText ?? "No columns"}</div>;

  return (
    <div className="db-grid" ref={scroller} onScroll={onScroll} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={rows.length} aria-colcount={columns.length}>
      <div className="db-grid-inner" style={{ width: totalW, height: top + rows.length * ROW_H }}>
        <div className="db-grid-head" style={{ gridTemplateColumns: tpl, width: totalW }} role="row">
          <div className="db-gh db-rn">#</div>
          {columns.map((c, i) => (
            <div
              key={i}
              role="columnheader"
              aria-sort={p.sort?.col === i ? (p.sort.desc ? "descending" : "ascending") : undefined}
              className={`db-gh ${p.onSort ? "sortable" : ""}`}
              title={`${c.name}${c.type ? ` · ${c.type}` : ""}${c.pk ? " · primary key" : ""}`}
              onClick={() => p.onSort?.(i)}
            >
              {c.pk && <i className="codicon codicon-key db-pk" aria-label="primary key" />}
              <span className="ellipsis">{c.name}</span>
              {c.type && <span className="db-type">{c.type.toLowerCase()}</span>}
              {p.sort?.col === i && <i className={`codicon codicon-arrow-${p.sort.desc ? "down" : "up"}`} />}
              <span className="db-resize" onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); setWidths((ws) => ws.map((w, j) => (j === i ? 160 : w))); }} />
            </div>
          ))}
        </div>
        {p.onFilter && (
          <div className="db-grid-head db-filter-row" style={{ gridTemplateColumns: tpl, width: totalW, top: ROW_H }}>
            <div className="db-gh db-rn"><i className="codicon codicon-filter" /></div>
            {columns.map((c, i) => (
              <FilterCell key={i} value={p.filters?.[i] ?? ""} name={c.name} onChange={(v) => p.onFilter!(i, v)} />
            ))}
          </div>
        )}
        {visible.map((r) => {
          const st = p.rowState?.(r);
          const row = rows[r];
          return (
            <div
              key={r}
              role="row"
              className={`db-grid-row ${selected.has(r) ? "sel" : ""} ${st ? "st-" + st : ""}`}
              style={{ gridTemplateColumns: tpl, top: top + r * ROW_H, width: totalW }}
            >
              <div className="db-rn" onMouseDown={(e) => selectRow(r, e)} title={st === "new" ? "New row" : st === "deleted" ? "Marked for deletion" : undefined}>
                {st === "new" ? "+" : st === "deleted" ? "−" : (p.rowOffset ?? 0) + r + 1}
              </div>
              {columns.map((_, c) => {
                const v = row?.[c];
                const isFocus = focus?.r === r && focus?.c === c;
                const dirty = p.dirty?.has(`${r}:${c}`);
                if (editing && editing.r === r && editing.c === c) {
                  return (
                    <input
                      key={c}
                      className="db-cell-input"
                      autoFocus
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitEdit(); scroller.current?.focus(); }
                        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(null); scroller.current?.focus(); }
                      }}
                    />
                  );
                }
                return (
                  <div
                    key={c}
                    role="gridcell"
                    className={`db-cell ${isFocus ? "focus" : ""} ${dirty ? "dirty" : ""} ${v === null ? "null" : typeof v === "number" ? "num" : ""}`}
                    onMouseDown={(e) => { if (e.button === 0) { setFocus({ r, c }); if (!e.shiftKey && !e.ctrlKey && !e.metaKey && selected.size && p.onSelect) p.onSelect(new Set()); } }}
                    onDoubleClick={() => beginEdit(r, c)}
                    onContextMenu={(e) => { setFocus({ r, c }); cellMenu(e, r, c); }}
                    title={typeof v === "string" && v.length > 60 ? v.slice(0, 2000) : undefined}
                  >
                    {v === null ? "NULL" : display(v)}
                  </div>
                );
              })}
            </div>
          );
        })}
        {rows.length === 0 && <div className="db-grid-empty muted small" style={{ top }}>{p.emptyText ?? "No rows"}</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {bigEdit && (
        <CellEditor
          column={columns[bigEdit.c]}
          value={rows[bigEdit.r]?.[bigEdit.c]}
          readOnly={!p.editable}
          onClose={() => setBigEdit(null)}
          onSave={(v) => { p.onEdit?.(bigEdit.r, bigEdit.c, v); setBigEdit(null); }}
        />
      )}
    </div>
  );
});

function FilterCell({ value, name, onChange }: { value: string; name: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="db-gh db-filter-cell">
      <input
        aria-label={`Filter ${name}`}
        placeholder="filter…"
        value={v}
        title={"Examples: abc (contains), = 5, > 10, <> x, IS NULL, IS NOT NULL, IN a,b"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onChange(v); if (e.key === "Escape") { setV(""); onChange(""); } }}
        onBlur={() => v !== value && onChange(v)}
      />
    </div>
  );
}

/** JSON / long text cell editor with NULL toggle. */
export function CellEditor({ column, value, readOnly, onClose, onSave }: { column: GridColumn; value: unknown; readOnly?: boolean; onClose: () => void; onSave: (v: unknown) => void }) {
  const [isNull, setIsNull] = useState(value === null);
  const [text, setText] = useState(value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
  const json = /json/i.test(column.type ?? "") || /^\s*[[{]/.test(text);
  let jsonError = "";
  if (json && !isNull && text.trim()) {
    try { JSON.parse(text); } catch (e) { jsonError = (e as Error).message; }
  }
  return (
    <Modal
      wide
      title={<>{column.name} <span className="muted small">{column.type}</span></>}
      onClose={onClose}
      footer={
        <>
          {!readOnly && <label className="check small"><input type="checkbox" checked={isNull} onChange={(e) => setIsNull(e.target.checked)} /> NULL</label>}
          {json && <button className="btn small" disabled={!!jsonError || isNull} onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}>Format JSON</button>}
          <button className="btn small" onClick={() => copy(isNull ? "NULL" : text, "value")}>Copy</button>
          <span className="grow" />
          <button className="btn small" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</button>
          {!readOnly && <button className="btn small primary" onClick={() => onSave(isNull ? null : text)}>Apply</button>}
        </>
      }
    >
      <textarea className="db-cell-editor mono" value={isNull ? "" : text} disabled={isNull} readOnly={readOnly} onChange={(e) => setText(e.target.value)} spellCheck={false} rows={16} />
      {jsonError && <div className="tb-error small">JSON: {jsonError}</div>}
    </Modal>
  );
}
