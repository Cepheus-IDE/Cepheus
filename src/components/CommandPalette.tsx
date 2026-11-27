import { useEffect, useMemo, useRef, useState } from "react";
import { set, useStore } from "../store";
import { commands, keyFor } from "../lib/commands";
import { api } from "../lib/api";
import { basename, dirname, fileIcon, relative } from "../lib/paths";
import { openFile } from "../lib/workspace";
import { editorRef } from "../lib/ai";
import FileIcon from "./FileIcon";

/** Fuzzy subsequence score; lower is better, -1 = no match. */
function fuzzy(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return -1;
    gaps += idx - ti;
    ti = idx + 1;
  }
  return 100 + gaps;
}

let fileCache: { root: string; files: string[]; at: number } | null = null;

export default function CommandPalette() {
  const palette = useStore((s) => s.palette);
  const ws = useStore((s) => s.workspace);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const mode = palette?.mode ?? null;

  useEffect(() => {
    if (!palette) return;
    setQ(palette.mode === "commands" ? ">" : palette.mode === "line" ? ":" : "");
    setSel(0);
    setTimeout(() => inputRef.current?.focus(), 0);
    if (ws && palette.mode === "files") {
      if (fileCache && fileCache.root === ws && Date.now() - fileCache.at < 15000) setFiles(fileCache.files);
      api.listFiles(ws).then((f) => {
        fileCache = { root: ws, files: f, at: Date.now() };
        setFiles(f);
      });
    }
  }, [palette, ws]);

  const effMode = q.startsWith(">") ? "commands" : q.startsWith(":") ? "line" : "files";
  const term = effMode === "files" ? q : q.slice(1).trim();

  const items = useMemo(() => {
    if (!mode) return [];
    if (effMode === "commands") {
      return commands
        .map((c) => ({ c, score: fuzzy(term, c.label) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score)
        .map(({ c }) => ({ key: c.id, label: c.label, detail: keyFor(c) ?? "", icon: "symbol-event", run: c.run }));
    }
    if (effMode === "line") {
      const n = parseInt(term, 10);
      return [{
        key: "line",
        label: Number.isFinite(n) ? `Go to line ${n}` : "Type a line number",
        detail: "",
        icon: "go-to-file",
        run: () => {
          const ed = editorRef.current;
          if (ed && Number.isFinite(n)) {
            ed.revealLineInCenter(n);
            ed.setPosition({ lineNumber: n, column: 1 });
            ed.focus();
          }
        },
      }];
    }
    if (!ws) return [{ key: "none", label: "Open a folder first", detail: "", icon: "info", run: () => {} }];
    const scored: { path: string; score: number }[] = [];
    for (const f of files) {
      const rel = relative(ws, f);
      let score = fuzzy(term, basename(f));
      if (score < 0) {
        const s2 = fuzzy(term, rel);
        if (s2 < 0) continue;
        score = s2 + 500;
      }
      scored.push({ path: f, score: score + rel.length / 1000 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 80).map(({ path }) => ({
      key: path,
      label: basename(path),
      detail: relative(ws, dirname(path)),
      icon: "",
      path,
      run: () => openFile(path),
    }));
  }, [mode, effMode, term, files, ws]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!palette) return null;
  const close = () => set({ palette: null });
  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    close();
    setTimeout(() => it.run(), 0);
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder="Search files by name (> for commands, : for line)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((it, i) => {
            return (
              <div key={it.key} className={`palette-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(i)}>
                {"path" in it ? <FileIcon name={it.label} /> : <i className={`codicon codicon-${it.icon}`} />}
                <span className="label">{it.label}</span>
                <span className="detail">{it.detail}</span>
              </div>
            );
          })}
          {items.length === 0 && <div className="palette-item muted">No results</div>}
        </div>
      </div>
    </div>
  );
}
