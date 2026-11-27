import { useMemo, useRef, useState } from "react";
import { api, errMsg, SearchMatch } from "../lib/api";
import { basename, relative, dirname } from "../lib/paths";
import { openFile } from "../lib/workspace";
import { useStore } from "../store";

export default function SearchPanel() {
  const ws = useStore((s) => s.workspace);
  const [query, setQuery] = useState("");
  const [isRegex, setRegex] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [wholeWord, setWord] = useState(false);
  const [replace, setReplace] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const run = async (q = query) => {
    if (!ws || !q) {
      setResults([]);
      return;
    }
    const my = ++seq.current;
    setBusy(true);
    setError("");
    try {
      const r = await api.search(ws, { query: q, isRegex, caseSensitive, wholeWord, maxResults: 5000 });
      if (my === seq.current) setResults(r);
    } catch (e) {
      if (my === seq.current) setError(errMsg(e));
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const r of results) {
      if (!m.has(r.path)) m.set(r.path, []);
      m.get(r.path)!.push(r);
    }
    return [...m.entries()];
  }, [results]);

  const replaceAll = async () => {
    if (!ws || !query) return;
    const flags = (caseSensitive ? "" : "i") + "g";
    let src = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (wholeWord) src = `\\b(?:${src})\\b`;
    const re = new RegExp(src, flags);
    let files = 0;
    for (const [path] of grouped) {
      try {
        const text = await api.readFile(path);
        const next = text.replace(re, replace);
        if (next !== text) {
          await api.writeFile(path, next);
          files++;
        }
      } catch (e) {
        setError(errMsg(e));
      }
    }
    setError(`Replaced in ${files} file(s).`);
    run();
  };

  if (!ws) return <div className="panel"><div className="panel-header"><span>SEARCH</span></div><div className="empty-state">Open a folder to search.</div></div>;

  return (
    <div className="panel">
      <div className="panel-header"><span>SEARCH</span></div>
      <div className="search-box">
        <div className="search-row">
          <button className="icon-btn small" onClick={() => setShowReplace((v) => !v)} title="Toggle Replace">
            <i className={`codicon codicon-chevron-${showReplace ? "down" : "right"}`} />
          </button>
          <div className="input-with-opts">
            <input
              autoFocus
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
            />
            <button className={caseSensitive ? "on" : ""} title="Match Case" onClick={() => setCase((v) => !v)}><i className="codicon codicon-case-sensitive" /></button>
            <button className={wholeWord ? "on" : ""} title="Match Whole Word" onClick={() => setWord((v) => !v)}><i className="codicon codicon-whole-word" /></button>
            <button className={isRegex ? "on" : ""} title="Use Regular Expression" onClick={() => setRegex((v) => !v)}><i className="codicon codicon-regex" /></button>
          </div>
        </div>
        {showReplace && (
          <div className="search-row">
            <span style={{ width: 22 }} />
            <div className="input-with-opts">
              <input placeholder="Replace" value={replace} onChange={(e) => setReplace(e.target.value)} />
              <button title="Replace All" onClick={replaceAll} disabled={!results.length}><i className="codicon codicon-replace-all" /></button>
            </div>
          </div>
        )}
        <div className="muted small search-summary">
          {busy ? "Searching…" : error ? error : query && results.length ? `${results.length} results in ${grouped.length} files` : ""}
        </div>
      </div>
      <div className="tree">
        {grouped.map(([path, matches]) => (
          <div key={path}>
            <div className="tree-row search-file" onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(path) ? n.delete(path) : n.add(path); return n; })}>
              <i className={`codicon codicon-chevron-${collapsed.has(path) ? "right" : "down"}`} />
              <span className="name">{basename(path)}</span>
              <span className="muted small ellipsis">{relative(ws, dirname(path))}</span>
              <span className="count">{matches.length}</span>
            </div>
            {!collapsed.has(path) &&
              matches.map((m, i) => {
                const start = Math.max(0, m.col - 1 - 30);
                const pre = m.text.slice(start, m.col - 1).trimStart();
                const hit = m.text.slice(m.col - 1, m.col - 1 + m.len);
                const post = m.text.slice(m.col - 1 + m.len, m.col - 1 + m.len + 120);
                return (
                  <div key={i} className="tree-row match" style={{ paddingLeft: 30 }} onClick={() => openFile(path, m.line, m.col)} title={`Line ${m.line}`}>
                    <span className="ellipsis">{start > 0 && "…"}{pre}<mark>{hit}</mark>{post}</span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
