// Skills sidebar view (installed + gallery) and the skill modals (creator, gallery preview,
// "Run Skill" picker). Logic lives in src/lib/skills.ts.
import { memo, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useStore, toast } from "../store";
import { errMsg } from "../lib/api";
import { openFile } from "../lib/workspace";
import { refreshCustomizations, useCustomizations } from "../lib/agentPlatform";
import {
  BundledSkill, createSkill, deleteSkill, duplicateSkill, exportSkill, GALLERY, importSkill, improveDraftWithAI,
  InstalledSkill, installBundled, installedCopies, namesInScope, needsUpdate, newSkill, reloadSkills, revealSkill,
  runSkill, SCOPE_LABEL, setEnabled, SkillDraft, SkillScope, skillFromSession, useSkills, useSkillsUI,
} from "../lib/skills";
import { join } from "../lib/paths";
import { parseFrontmatter, toKebab, validateDescription, validateName } from "../lib/skillFormat";

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

const match = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));

// ---------------------------------------------------------------------------------------------
// Sidebar view
// ---------------------------------------------------------------------------------------------

export default function SkillsView() {
  const ws = useStore((s) => s.workspace);
  const tab = useSkillsUI((s) => s.tab);
  const { installed, loading } = useSkills();
  const [q, setQ] = useState("");
  const [importScope, setImportScope] = useState(false);

  useEffect(() => { reloadSkills(); }, [ws]);

  const query = q.trim().toLowerCase();
  return (
    <div className="panel skills-view">
      <div className="panel-header">
        <span>SKILLS</span>
        <div className="actions">
          <button title="New skill" onClick={() => newSkill()}><i className="codicon codicon-add" /></button>
          <button title="Create skill from the current agent task" onClick={() => skillFromSession()}><i className="codicon codicon-comment-discussion" /></button>
          <button title="Import .cepheus-skill" onClick={() => setImportScope((v) => !v)}><i className="codicon codicon-cloud-download" /></button>
          <button title="Refresh" onClick={() => reloadSkills()}><i className={`codicon codicon-refresh ${loading ? "codicon-modifier-spin" : ""}`} /></button>
        </div>
      </div>
      {importScope && (
        <div className="skill-confirm">
          <span>Import into</span>
          <button className="btn small" disabled={!ws} onClick={() => { setImportScope(false); importSkill("project"); }}>Project</button>
          <button className="btn small" onClick={() => { setImportScope(false); importSkill("user"); }}>User</button>
          <button className="btn small" onClick={() => setImportScope(false)}>Cancel</button>
        </div>
      )}
      <div className="panel-tabs">
        <button className={`panel-tab ${tab === "installed" ? "active" : ""}`} onClick={() => useSkillsUI.setState({ tab: "installed" })}>
          INSTALLED <span className="muted">{installed.length}</span>
        </button>
        <button className={`panel-tab ${tab === "gallery" ? "active" : ""}`} onClick={() => useSkillsUI.setState({ tab: "gallery" })}>
          GALLERY <span className="muted">{GALLERY.length}</span>
        </button>
      </div>
      <div className="skills-search">
        <input placeholder={tab === "installed" ? "Search installed skills" : "Search the gallery"} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="skills-scroll">
        {tab === "installed" ? <InstalledList query={query} /> : <GalleryList query={query} />}
      </div>
    </div>
  );
}

function InstalledList({ query }: { query: string }) {
  const ws = useStore((s) => s.workspace);
  const { installed, loaded } = useSkills();
  const shown = installed.filter((s) => match(query, s.name, s.description));
  const scopes: SkillScope[] = ["project", "user"];
  if (loaded && !installed.length) {
    return (
      <div className="skills-empty muted">
        <p>No skills installed yet. Skills are reusable instructions the agent loads on demand with <code>load_skill</code>.</p>
        <button className="btn small primary" onClick={() => useSkillsUI.setState({ tab: "gallery" })}>Browse the gallery</button>{" "}
        <button className="btn small" onClick={() => newSkill()}>New skill</button>
      </div>
    );
  }
  return (
    <>
      {scopes.map((scope) => {
        const list = shown.filter((s) => s.scope === scope);
        if (scope === "project" && !ws) return null;
        return (
          <div key={scope}>
            <div className="section-title">
              {SCOPE_LABEL[scope].toUpperCase()} <span className="count">{list.length}</span>
              <span className="muted small skills-where">{scope === "project" ? ".cepheus/skills" : "app data/skills"}</span>
            </div>
            {list.map((s) => <InstalledRow key={s.dir} s={s} />)}
            {!list.length && <div className="muted small skills-none">{query ? "No matches." : "None."}</div>}
          </div>
        );
      })}
    </>
  );
}

function InstalledRow({ s }: { s: InstalledSkill }) {
  const [confirm, setConfirm] = useState(false);
  const shadowed = useSkills((st) => s.scope === "user" && s.enabled && st.installed.some((x) => x.scope === "project" && x.enabled && x.name === s.name));
  return (
    <div className={`skill-row ${s.enabled ? "" : "disabled"}`}>
      <div className="skill-row-main" onClick={() => openFile(join(s.dir, "SKILL.md"))} title="Open SKILL.md">
        <div className="skill-row-top">
          <i className="codicon codicon-lightbulb" />
          <span className="name">{s.name}</span>
          <span className={`skill-badge ${s.scope}`}>{SCOPE_LABEL[s.scope]}</span>
          {!s.enabled && <span className="skill-badge off">Disabled</span>}
          {shadowed && <span className="skill-badge off" title="A Project skill with the same name takes precedence">Shadowed</span>}
          <span className="muted small skill-meta">{s.version && `v${s.version} · `}{s.files} file{s.files === 1 ? "" : "s"}</span>
        </div>
        <div className="skill-desc muted small">{s.description || "No description"}</div>
      </div>
      <div className="skill-actions">
        <button title="Use in a new agent task" disabled={!s.enabled} onClick={() => runSkill(s.name)}><i className="codicon codicon-play" /></button>
        <button title={s.enabled ? "Disable" : "Enable"} onClick={() => setEnabled(s, !s.enabled)}><i className={`codicon codicon-${s.enabled ? "eye" : "eye-closed"}`} /></button>
        <button title="Duplicate" onClick={() => duplicateSkill(s)}><i className="codicon codicon-copy" /></button>
        <button title="Export as .cepheus-skill" onClick={() => exportSkill(s)}><i className="codicon codicon-export" /></button>
        <button title="Reveal folder" onClick={() => revealSkill(s)}><i className="codicon codicon-folder-opened" /></button>
        <button title="Delete" onClick={() => setConfirm(true)}><i className="codicon codicon-trash" /></button>
      </div>
      {confirm && (
        <div className="skill-confirm">
          <span>Delete “{s.name}”? The folder goes to the trash.</span>
          <button className="btn small primary" onClick={() => { setConfirm(false); deleteSkill(s); }}>Delete</button>
          <button className="btn small" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function GalleryList({ query }: { query: string }) {
  const installed = useSkills((s) => s.installed);
  const shown = GALLERY.filter((b) => match(query, b.name, b.description, b.category));
  const cats = [...new Set(shown.map((b) => b.category))];
  return (
    <>
      {cats.map((c) => (
        <div key={c}>
          <div className="section-title">{c.toUpperCase()}</div>
          {shown.filter((b) => b.category === c).map((b) => <GalleryRow key={b.name} b={b} installed={installed} />)}
        </div>
      ))}
      {!shown.length && <div className="muted small skills-none">No matches.</div>}
    </>
  );
}

function InstallButtons({ b, installed }: { b: BundledSkill; installed: InstalledSkill[] }) {
  const ws = useStore((s) => s.workspace);
  const copies = installedCopies(b.name, installed);
  return (
    <>
      {(["project", "user"] as SkillScope[]).map((scope) => {
        const copy = copies.find((c) => c.scope === scope);
        if (copy && !needsUpdate(b, copy)) return <span key={scope} className={`skill-badge ${scope}`} title={`Installed in ${SCOPE_LABEL[scope]} scope`}><i className="codicon codicon-check" /> {SCOPE_LABEL[scope]}</span>;
        return (
          <button key={scope} className="btn small" disabled={scope === "project" && !ws} onClick={() => installBundled(b, scope)}
            title={copy ? `Update ${SCOPE_LABEL[scope]} copy from v${copy.version || "?"} to v${b.version} (replaces SKILL.md)` : `Install into ${SCOPE_LABEL[scope]} scope`}>
            {copy ? `Update ${SCOPE_LABEL[scope]}` : `+ ${SCOPE_LABEL[scope]}`}
          </button>
        );
      })}
    </>
  );
}

function GalleryRow({ b, installed }: { b: BundledSkill; installed: InstalledSkill[] }) {
  return (
    <div className="skill-row">
      <div className="skill-row-main" onClick={() => useSkillsUI.setState({ preview: b })} title="Preview SKILL.md">
        <div className="skill-row-top">
          <i className="codicon codicon-lightbulb" />
          <span className="name">{b.name}</span>
          <span className="muted small skill-meta">v{b.version}</span>
        </div>
        <div className="skill-desc muted small">{b.description}</div>
      </div>
      <div className="skill-install">
        <button className="btn small" onClick={() => useSkillsUI.setState({ preview: b })}>Preview</button>
        <InstallButtons b={b} installed={installed} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Modals (mounted once in App.tsx)
// ---------------------------------------------------------------------------------------------

export function SkillsModals() {
  const { editor, preview, runPicker } = useSkillsUI();
  return (
    <>
      {preview && <PreviewModal b={preview} />}
      {editor && <EditorModal key={editor.fromSession ?? "new"} />}
      {runPicker && <RunPicker />}
    </>
  );
}

function PreviewModal({ b }: { b: BundledSkill }) {
  const installed = useSkills((s) => s.installed);
  const close = () => useSkillsUI.setState({ preview: null });
  const { body } = parseFrontmatter(b.text);
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal skill-modal" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
        <div className="modal-head">
          <h2>{b.name} <span className="muted small">v{b.version} · {b.category}</span></h2>
          <button className="icon-btn" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <div className="modal-body">
          <p className="muted">{b.description}</p>
          <div className="skill-preview"><Markdown text={body} /></div>
        </div>
        <div className="skill-modal-foot">
          <span className="muted small">Installs SKILL.md into <code>.cepheus/skills/{b.name}</code> (Project) or your user skills folder.</span>
          <div className="spacer" />
          <InstallButtons b={b} installed={installed} />
        </div>
      </div>
    </div>
  );
}

function EditorModal() {
  const ws = useStore((s) => s.workspace);
  const ed = useSkillsUI((s) => s.editor)!;
  const installed = useSkills((s) => s.installed);
  const [draft, setDraft] = useState<SkillDraft>(ed.draft);
  const [rawName, setRawName] = useState(ed.draft.name);
  const [scope, setScope] = useState<SkillScope>(ed.scope);
  const [mode, setMode] = useState<"split" | "edit" | "preview">("split");
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const close = () => useSkillsUI.setState({ editor: null });

  useEffect(() => { useSkills.getState().loaded || reloadSkills(); }, []);

  const name = toKebab(rawName);
  const taken = useMemo(() => namesInScope(scope), [scope, installed]); // eslint-disable-line react-hooks/exhaustive-deps
  const nameErr = validateName(name, taken);
  const descErr = validateDescription(draft.description);
  const bodyErr = draft.body.trim() ? null : "Instructions are required.";
  const valid = !nameErr && !descErr && !bodyErr;
  const patch = (p: Partial<SkillDraft>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    try {
      const path = await createSkill({ ...draft, name }, scope);
      toast(`Created skill "${name}" (${SCOPE_LABEL[scope]})`);
      close();
      openFile(path);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const improve = async () => {
    if (!ed.fromSession) return;
    setBusy(true);
    try {
      const d = await improveDraftWithAI(ed.fromSession, { ...draft, name });
      setDraft(d);
      setRawName(d.name);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal skill-modal skill-editor" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()} tabIndex={-1}>
        <div className="modal-head">
          <h2>{ed.fromSession ? "Create skill from conversation" : "New skill"}</h2>
          <button className="icon-btn" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <div className="modal-body">
          <div className="skill-form-row">
            <label>
              Name
              <input value={rawName} onChange={(e) => setRawName(e.target.value)} placeholder="e.g. write-unit-tests" autoFocus />
            </label>
            <label>
              Scope
              <select value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
                <option value="project" disabled={!ws}>Project (.cepheus/skills)</option>
                <option value="user">User (all workspaces)</option>
              </select>
            </label>
          </div>
          <div className="muted small">
            Folder: <code>{name || "…"}</code>{rawName && name !== rawName && " (converted to kebab-case)"}
          </div>
          {(touched || rawName) && nameErr && <div className="skill-err">{nameErr}</div>}
          <label>
            Description <span className="muted small">(the agent reads this to decide when to load the skill)</span>
            <input value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="Use when …" />
          </label>
          {touched && descErr && <div className="skill-err">{descErr}</div>}
          <div className="skill-body-head">
            <label>Instructions (Markdown)</label>
            <div className="spacer" />
            {ed.fromSession && (
              <button className="btn small" disabled={busy} onClick={improve} title="Ask the configured model to generalize the transcript into a skill">
                <i className="codicon codicon-sparkle" /> Improve with AI
              </button>
            )}
            {(["edit", "split", "preview"] as const).map((m) => (
              <button key={m} className={`chip ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
          <div className={`skill-md-editor ${mode}`}>
            {mode !== "preview" && (
              <textarea value={draft.body} spellCheck={false} onChange={(e) => patch({ body: e.target.value })} />
            )}
            {mode !== "edit" && <div className="skill-preview"><Markdown text={draft.body} /></div>}
          </div>
          {touched && bodyErr && <div className="skill-err">{bodyErr}</div>}
          <div className="skill-body-head">
            <label>Extra files <span className="muted small">(templates, scripts — the agent sees them listed when it loads the skill)</span></label>
            <div className="spacer" />
            <button className="btn small" onClick={() => patch({ extras: [...draft.extras, { path: "", content: "" }] })}>
              <i className="codicon codicon-add" /> Add file
            </button>
          </div>
          {draft.extras.map((x, i) => (
            <div key={i} className="skill-extra">
              <div className="row gap">
                <input value={x.path} placeholder="templates/example.md" onChange={(e) => patch({ extras: draft.extras.map((y, j) => (j === i ? { ...y, path: e.target.value } : y)) })} />
                <button className="icon-btn" title="Remove" onClick={() => patch({ extras: draft.extras.filter((_, j) => j !== i) })}><i className="codicon codicon-trash" /></button>
              </div>
              <textarea rows={4} value={x.content} spellCheck={false} onChange={(e) => patch({ extras: draft.extras.map((y, j) => (j === i ? { ...y, content: e.target.value } : y)) })} />
            </div>
          ))}
        </div>
        <div className="skill-modal-foot">
          <div className="spacer" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" disabled={busy || (touched && !valid)} onClick={save}>Create skill</button>
        </div>
      </div>
    </div>
  );
}

function RunPicker() {
  const ws = useStore((s) => s.workspace);
  const skills = useCustomizations((c) => c.data.skills);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  useEffect(() => { refreshCustomizations(true); }, [ws]);
  const close = () => useSkillsUI.setState({ runPicker: false });
  const query = q.trim().toLowerCase();
  const list = skills.filter((s) => match(query, s.name, s.description));
  const pick = (name: string) => { close(); runSkill(name); };
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette skill-run" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={skills.length ? "Run skill in a new agent task…" : "No enabled skills — install some from the Skills view"}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(list.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter" && list[sel]) pick(list[sel].name);
          }}
        />
        <div className="palette-list">
          {list.map((s, i) => (
            <div key={s.name} className={`palette-item skill-run-item ${i === sel ? "sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => pick(s.name)}>
              <span className="name">{s.name}</span>
              <span className={`skill-badge ${s.source === "workspace" ? "project" : "user"}`}>{s.source === "workspace" ? "Project" : "User"}</span>
              <span className="muted small ellipsis">{s.description}</span>
            </div>
          ))}
          {!list.length && skills.length > 0 && <div className="muted small skills-none">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
