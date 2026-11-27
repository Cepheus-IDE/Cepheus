import { useMemo, useState } from "react";
import { useStore, Problem } from "../store";
import { openFile } from "../lib/workspace";
import { basename, dirname, relative } from "../lib/paths";
import FileIcon from "./FileIcon";

const ICON = { error: "error", warning: "warning", info: "info" } as const;

export default function ProblemsPanel() {
  const problems = useStore((s) => s.problems);
  const ws = useStore((s) => s.workspace);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, Problem[]>();
    for (const p of problems) {
      if (q && !p.message.toLowerCase().includes(q) && !p.path.toLowerCase().includes(q)) continue;
      if (!map.has(p.path)) map.set(p.path, []);
      map.get(p.path)!.push(p);
    }
    return [...map.entries()];
  }, [problems, filter]);

  if (problems.length === 0) {
    return <div className="problems-empty muted">No problems have been detected in the workspace.</div>;
  }

  return (
    <div className="problems">
      <div className="problems-filter">
        <i className="codicon codicon-filter" />
        <input placeholder="Filter (e.g. text, path)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="problems-list">
        {groups.map(([path, list]) => (
          <div key={path}>
            <div className="problem-file" onClick={() => setCollapsed((c) => ({ ...c, [path]: !c[path] }))}>
              <i className={`codicon codicon-chevron-${collapsed[path] ? "right" : "down"}`} />
              <FileIcon name={basename(path)} />
              <span className="name">{basename(path)}</span>
              <span className="muted small ellipsis">{ws ? relative(ws, dirname(path)) : dirname(path)}</span>
              <span className="count">{list.length}</span>
            </div>
            {!collapsed[path] &&
              list.map((p, i) => (
                <div key={i} className={`problem-row sev-${p.severity}`} onClick={() => openFile(p.path, p.line, p.col)} title={p.message}>
                  <i className={`codicon codicon-${ICON[p.severity]}`} />
                  <span className="msg">{p.message}</span>
                  <span className="muted small">{p.source}</span>
                  <span className="muted small loc">[Ln {p.line}, Col {p.col}]</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
