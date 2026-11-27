import { RefObject, useEffect, useState } from "react";
import { Settings } from "../lib/settings";
import { useStore } from "../store";
import { WORKSPACE_KEYS, openUserSettingsJson, openWorkspaceSettingsJson, workspaceOverrides } from "../lib/settingsLevels";
import { configureSnippets } from "../lib/snippets";

/**
 * Filters the Settings body in place: a section stays when its title matches; otherwise only
 * its matching fields (a `label` plus the controls after it) stay. Works on the rendered DOM so
 * every section — including ones other features add — is searchable without registering.
 */
function filterSettings(body: HTMLElement, q: string): number {
  const needle = q.trim().toLowerCase();
  const sections = [...body.querySelectorAll<HTMLElement>("section")];
  let hits = 0;
  const textOf = (el: Element) => (el.textContent ?? "") + " " + [...el.querySelectorAll<HTMLInputElement>("input[placeholder], textarea[placeholder]")].map((i) => i.placeholder).join(" ");
  for (const sec of sections) {
    const children = [...sec.children] as HTMLElement[];
    children.forEach((c) => c.classList.remove("settings-hidden"));
    sec.classList.remove("settings-hidden");
    if (!needle) continue;
    const title = sec.querySelector("h3")?.textContent?.toLowerCase() ?? "";
    if (title.includes(needle)) { hits++; continue; }
    // Group into rows: a row starts at each <label> (a `.check` label is a row by itself).
    const rows: HTMLElement[][] = [];
    let cur: HTMLElement[] | null = null;
    for (const c of children) {
      if (c.tagName === "H3") continue;
      if (c.tagName === "LABEL" || !cur) { cur = [c]; rows.push(cur); if (c.classList.contains("check")) cur = null; }
      else cur.push(c);
    }
    let any = false;
    for (const row of rows) {
      const match = row.some((el) => textOf(el).toLowerCase().includes(needle));
      if (match) { any = true; hits++; }
      else row.forEach((el) => el.classList.add("settings-hidden"));
    }
    if (!any) sec.classList.add("settings-hidden");
  }
  return hits;
}

export function SettingsSearch({ bodyRef }: { bodyRef: RefObject<HTMLDivElement> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let busy = false;
    const run = () => { busy = true; setHits(filterSettings(body, q)); busy = false; };
    run();
    // Fields appear/disappear as the draft changes; keep the filter applied.
    const mo = new MutationObserver(() => { if (!busy) requestAnimationFrame(run); });
    mo.observe(body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [q, bodyRef]);
  return (
    <div className="settings-search">
      <i className="codicon codicon-search" aria-hidden="true" />
      <input autoFocus placeholder="Search settings" aria-label="Search settings" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && q && (e.stopPropagation(), setQ(""))} />
      {q.trim() && <span className="hits">{hits ? `${hits} match${hits > 1 ? "es" : ""}` : "No settings found"}</span>}
      <button className="btn small" title="Edit the user settings file (settings.json)" onClick={openUserSettingsJson}><i className="codicon codicon-json" /> User JSON</button>
      <button className="btn small" title="Edit .cepheus/settings.json — overrides user settings in this folder" onClick={openWorkspaceSettingsJson}><i className="codicon codicon-folder" /> Workspace JSON</button>
    </div>
  );
}

/** "Code Editing & Accessibility" section. */
export function EditingSettings({ draft, upd }: { draft: Settings; upd: (p: Partial<Settings>) => void }) {
  const ws = useStore((s) => s.workspace);
  const overridden = ws ? Object.keys(workspaceOverrides()) : [];
  return (
    <section>
      <h3>Code Editing &amp; Accessibility</h3>
      {overridden.length > 0 && (
        <div className="settings-ws-note">
          <i className="codicon codicon-folder" /> This folder's .cepheus/settings.json overrides: {overridden.join(", ")}. Changing those here updates the workspace file.
        </div>
      )}
      <label className="check"><input type="checkbox" checked={draft.tsSemanticValidation !== false} onChange={(e) => upd({ tsSemanticValidation: e.target.checked })} /> Type-check TypeScript in the editor (semantic errors + quick fixes; unresolvable imports are ignored)</label>
      <label className="check"><input type="checkbox" checked={draft.lspWorkspaceDiagnostics !== false} onChange={(e) => upd({ lspWorkspaceDiagnostics: e.target.checked })} /> Show problems for files that aren't open (language server workspace diagnostics; restart servers to apply)</label>
      <label htmlFor="a11y-support">Screen reader support</label>
      <select id="a11y-support" value={draft.accessibilitySupport ?? "auto"} onChange={(e) => upd({ accessibilitySupport: e.target.value as Settings["accessibilitySupport"] })}>
        <option value="auto">Auto-detect</option>
        <option value="on">On (optimized for screen readers; also enables terminal screen reader mode)</option>
        <option value="off">Off</option>
      </select>
      <div className="muted small">High-contrast themes are under Appearance. Workspace-level keys: {[...WORKSPACE_KEYS].join(", ")}.</div>
      <label>Snippets</label>
      <div className="row gap">
        <button className="btn small" onClick={() => configureSnippets("user")}><i className="codicon codicon-symbol-snippet" /> User snippets (current language)</button>
        <button className="btn small" onClick={() => configureSnippets("workspace")} disabled={!ws}><i className="codicon codicon-symbol-snippet" /> Workspace snippets</button>
      </div>
    </section>
  );
}
