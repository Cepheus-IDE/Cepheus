import { useEffect, useState } from "react";
import { toast, useStore } from "../store";
import { errMsg } from "../lib/api";
import { join, relative } from "../lib/paths";
import { openFile } from "../lib/workspace";
import { addKeysToEnv, addKeysToTemplate, EnvGroup, scanEnv } from "../lib/toolbox/envManager";
import { useToolbox } from "../lib/toolbox/state";
import { NoWorkspace } from "./Toolbox";

export default function EnvManager() {
  const ws = useStore((s) => s.workspace);
  const presenting = useToolbox((s) => s.presenting);
  const [groups, setGroups] = useState<EnvGroup[] | null>(null);
  const [error, setError] = useState("");
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = () => {
    if (!ws) return;
    setError("");
    scanEnv(ws).then(setGroups, (e) => setError(errMsg(e)));
  };
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  // Never leave values revealed once screen sharing starts.
  useEffect(() => { if (presenting) setRevealed(new Set()); }, [presenting]);
  if (!ws) return <NoWorkspace what=".env files" />;

  const act = async (fn: () => Promise<string>, what: string) => {
    try {
      const path = await fn();
      toast(`${what} (${relative(ws, path)})`);
      load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const toggle = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };

  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <span className="tb-hint-inline">Values are masked; click the eye to reveal one.</span>
        <span className="spacer" />
        <button className="icon-btn" title="Rescan" onClick={load}><i className="codicon codicon-refresh" /></button>
      </div>
      {error && <div className="tb-error">{error}</div>}
      {!groups && !error && <div className="tb-hint"><i className="codicon codicon-loading codicon-modifier-spin" /> Reading .env files and scanning code…</div>}
      {groups && !groups.length && <div className="tb-hint">No .env files and no environment variable reads found.</div>}
      <div className="tb-scroll">
        {groups?.map((g) => {
          const r = g.report;
          const hasTemplate = g.files.some((f) => f.template);
          const templateName = g.files.find((f) => f.template)?.name ?? ".env.example";
          return (
            <div key={g.dir} className="tb-group">
              <div className="tb-group-title"><i className="codicon codicon-folder" /> {g.rel || "Workspace root"}</div>
              {!g.files.length && <div className="tb-hint">No .env file here.</div>}
              {g.files.map((f) => (
                <div key={f.path}>
                  <div className="tree-row tb-file" onClick={() => setOpen((s) => toggle(s, f.path))}>
                    <i className={`codicon codicon-chevron-${open.has(f.path) ? "down" : "right"}`} />
                    <span className="tb-name">{f.name}</span>
                    <span className="tb-detail">{f.template ? "template" : ""}</span>
                    <span className="tb-count">{f.entries.length}</span>
                    <button className="icon-btn small" title="Open file" onClick={(e) => { e.stopPropagation(); openFile(f.path); }}><i className="codicon codicon-go-to-file" /></button>
                  </div>
                  {open.has(f.path) && f.entries.map((en) => {
                    const id = `${f.path}#${en.key}`;
                    const show = revealed.has(id) && !presenting;
                    return (
                      <div key={id} className="tree-row tb-row tb-env" onClick={() => openFile(f.path, en.line, 1)}>
                        <span className="tb-key">{en.key}</span>
                        <span className={`tb-val ${show ? "" : "masked"}`}>{en.value === "" ? <span className="muted">empty</span> : show ? en.value : "•".repeat(Math.min(12, Math.max(6, en.value.length)))}</span>
                        {en.value !== "" && !f.template && (
                          <button
                            className="icon-btn small"
                            disabled={presenting}
                            title={presenting ? "Hidden while presenting" : show ? "Hide value" : "Reveal value"}
                            onClick={(e) => { e.stopPropagation(); setRevealed((s) => toggle(s, id)); }}
                          >
                            <i className={`codicon codicon-${show ? "eye-closed" : "eye"}`} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {r.missingInEnv.length > 0 && (
                <div className="tb-issue">
                  <div className="tb-issue-title"><i className="codicon codicon-warning" /> Used in code but defined nowhere ({r.missingInEnv.length})</div>
                  {r.missingInEnv.map((m) => {
                    const [file, line] = splitWhere(m.where[0]);
                    return (
                      <div key={m.key} className="tree-row tb-row" title={m.where.join("\n")} onClick={() => openFile(join(ws, file), Number(line) || 1, 1)}>
                        <span className="tb-key">{m.key}</span>
                        <span className="tb-detail">{m.where[0]}{m.where.length > 1 ? ` +${m.where.length - 1}` : ""}</span>
                      </div>
                    );
                  })}
                  <div className="tb-issue-actions">
                    <button className="btn small" onClick={() => act(() => addKeysToTemplate(g, r.missingInEnv.map((m) => m.key)), "Added names to the template")}>Add to {templateName}</button>
                    <button className="btn small" onClick={() => act(() => addKeysToEnv(g, r.missingInEnv.map((m) => m.key)), "Added empty keys to .env")}>Add empty to .env</button>
                  </div>
                </div>
              )}
              {r.missingFromEnv.length > 0 && (
                <div className="tb-issue">
                  <div className="tb-issue-title"><i className="codicon codicon-warning" /> In {templateName}, missing from .env ({r.missingFromEnv.length})</div>
                  <div className="tb-keys">{r.missingFromEnv.join(", ")}</div>
                  <div className="tb-issue-actions">
                    <button className="btn small" onClick={() => act(() => addKeysToEnv(g, r.missingFromEnv), "Added empty keys to .env")}>Add empty to .env</button>
                  </div>
                </div>
              )}
              {r.missingFromExample.length > 0 && g.files.some((f) => !f.template) && (
                <div className="tb-issue">
                  <div className="tb-issue-title"><i className="codicon codicon-info" /> In .env, {hasTemplate ? `missing from ${templateName}` : "no .env.example yet"} ({r.missingFromExample.length})</div>
                  <div className="tb-keys">{r.missingFromExample.join(", ")}</div>
                  <div className="tb-issue-actions">
                    <button className="btn small primary" onClick={() => act(() => addKeysToTemplate(g, r.missingFromExample), `Added ${r.missingFromExample.length} key names (no values)`)}>
                      {hasTemplate ? `Add to ${templateName}` : "Create .env.example"} (names only)
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function splitWhere(w: string): [string, string] {
  const i = w.lastIndexOf(":");
  return i < 0 ? [w, "1"] : [w.slice(0, i), w.slice(i + 1)];
}
