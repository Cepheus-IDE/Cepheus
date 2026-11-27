import { useMemo, useState } from "react";
import { get, set, useStore } from "../store";
import { commands, keyFor, normalize } from "../lib/commands";
import { saveSettings } from "../lib/workspace";
import { applyPreset, currentPreset, exportShortcuts, KEYMAP_PRESETS } from "../lib/keymaps";

const MODIFIERS = ["Control", "Shift", "Alt", "Meta"];

/** VS Code-style Keyboard Shortcuts editor: click a row, press the new combo. */
export default function KeybindingsModal() {
  const open = useStore((s) => s.keybindingsOpen);
  const overrides = useStore((s) => s.settings.keybindings);
  // Overrides that came from an installed keymap extension are labelled with its name.
  const keymap = useStore((s) => s.settings.extensionOptions?.keymap ?? null);
  const [q, setQ] = useState("");
  const [recording, setRecording] = useState<string | null>(null);

  const rows = useMemo(() => {
    const t = q.toLowerCase();
    return commands
      .map((c) => ({ c, key: keyFor(c) ?? "", custom: c.id in overrides }))
      .filter(({ c, key }) => !t || c.label.toLowerCase().includes(t) || key.toLowerCase().includes(t) || c.id.includes(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, overrides]);

  if (!open) return null;
  const close = () => { setRecording(null); set({ keybindingsOpen: false }); };

  const setBinding = (id: string, combo: string | undefined) => {
    const s = get().settings;
    const kb = { ...s.keybindings };
    const def = commands.find((c) => c.id === id)?.keys;
    if (combo === undefined || combo === def) delete kb[id];
    else kb[id] = combo;
    saveSettings({ ...s, keybindings: kb });
  };

  const onRecordKey = (e: React.KeyboardEvent) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(null);
    if (MODIFIERS.includes(e.key)) return;
    setBinding(recording, normalize(e.nativeEvent));
    setRecording(null);
  };

  const conflicts = (id: string, key: string) =>
    key ? commands.filter((c) => c.id !== id && keyFor(c) === key).map((c) => c.label) : [];

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="modal keybindings"
        onMouseDown={(e) => e.stopPropagation()}
        // Capture so the global shortcut handler never sees keys while recording.
        onKeyDownCapture={onRecordKey}
        onKeyDown={(e) => !recording && e.key === "Escape" && close()}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2><i className="codicon codicon-record-keys" /> Keyboard Shortcuts</h2>
          <div className="kb-head-actions">
            <label className="muted small" htmlFor="kb-preset">Keymap</label>
            <select
              id="kb-preset"
              value={currentPreset() ?? "custom"}
              onChange={(e) => e.target.value !== "custom" && applyPreset(e.target.value)}
            >
              {KEYMAP_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              {currentPreset() === null && <option value="custom">Customized</option>}
            </select>
            <button className="btn small" title="Export a printable cheat sheet (HTML or Markdown)" onClick={exportShortcuts}>
              <i className="codicon codicon-export" /> Export…
            </button>
            <button className="icon-btn" title="Close" aria-label="Close" onClick={close}><i className="codicon codicon-close" /></button>
          </div>
        </div>
        <div className="kb-search">
          <input autoFocus placeholder="Search commands or keys" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="kb-list">
          <div className="kb-row kb-head"><span>Command</span><span>Keybinding</span><span /></div>
          {rows.map(({ c, key, custom }) => {
            const clash = conflicts(c.id, key);
            return (
              <div key={c.id} className={`kb-row ${recording === c.id ? "rec" : ""}`} onDoubleClick={() => setRecording(c.id)}>
                <span className="kb-label">{c.label}</span>
                <span className="kb-key">
                  {recording === c.id ? (
                    <em className="muted">Press the new key combination… (Esc to cancel)</em>
                  ) : key ? (
                    <kbd>{key}</kbd>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {custom && recording !== c.id && <span className="kb-badge">{keymap && c.id in keymap.applied && keymap.applied[c.id] === overrides[c.id] ? `Keymap: ${keymap.label}` : "User"}</span>}
                  {clash.length > 0 && recording !== c.id && (
                    <span className="kb-clash" title={`Also bound to: ${clash.join(", ")}`}><i className="codicon codicon-warning" /> conflict</span>
                  )}
                </span>
                <span className="kb-actions">
                  <button className="icon-btn small" title="Change Keybinding" onClick={() => setRecording(c.id)}><i className="codicon codicon-edit" /></button>
                  {key && <button className="icon-btn small" title="Remove Keybinding" onClick={() => setBinding(c.id, "")}><i className="codicon codicon-close" /></button>}
                  {custom && <button className="icon-btn small" title="Reset to Default" onClick={() => setBinding(c.id, undefined)}><i className="codicon codicon-discard" /></button>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
