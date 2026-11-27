import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, errMsg } from "../lib/api";
import { allThemes, BUILTIN, convertVsTheme, currentUi } from "../lib/themes";
import { CustomTheme, parseJsonc, Settings } from "../lib/settings";
import { importFromEditor, setIconThemeSetting } from "../lib/extensions";
import { saveSettings } from "../lib/workspace";
import { get, toast, useStore } from "../store";

/** Theme gallery + Theme Studio + import. Changes apply live (and are saved immediately). */
export default function Appearance({ onChange }: { onChange: (patch: Partial<Settings>) => void }) {
  const settings = useStore((s) => s.settings);
  const themeVersion = useStore((s) => s.themeVersion);
  const exts = useStore((s) => s.extensions);
  const themes = useMemo(() => allThemes(settings.customThemes), [settings.customThemes, themeVersion]);
  const [studio, setStudio] = useState<CustomTheme | null>(null);
  const [editors, setEditors] = useState<{ name: string; hasSettings: boolean }[]>([]);
  const [busy, setBusy] = useState("");

  useEffect(() => { api.vscodeDetect().then(setEditors).catch(() => {}); }, []);

  const apply = async (patch: Partial<Settings>) => {
    onChange(patch);
    await saveSettings({ ...get().settings, ...patch });
  };

  const startStudio = () => {
    const ui = currentUi;
    const base = BUILTIN.find((b) => b.id === settings.theme) ?? settings.customThemes.find((c) => c.id === settings.theme);
    setStudio({
      id: "custom:" + Date.now().toString(36),
      name: "My Theme",
      kind: ui.kind,
      ui: base?.ui ?? { bg: ui.bg, surface: ui.bg1, border: ui.border, fg: ui.fg, accent: ui.accent },
      syntax: base?.syntax ?? { keyword: ui.accent, string: ui.green, number: ui.accent, comment: ui.fgFaint, type: ui.fg },
    });
  };

  const saveStudio = async () => {
    if (!studio) return;
    const list = [...settings.customThemes.filter((c) => c.id !== studio.id), studio];
    await apply({ customThemes: list, theme: studio.id });
    setStudio(null);
    toast(`Saved theme “${studio.name}”`);
  };

  const importJson = async () => {
    const file = await openDialog({ filters: [{ name: "VS Code theme", extensions: ["json", "jsonc"] }], title: "Import VS Code color theme" });
    if (typeof file !== "string") return;
    try {
      const json = parseJsonc(await api.readFile(file));
      const r = convertVsTheme({ colors: json.colors ?? {}, tokenColors: Array.isArray(json.tokenColors) ? json.tokenColors : [] }, json.type === "light" ? "vs" : "vs-dark");
      const find = (p: string) => r.monaco.rules.find((x) => x.token.startsWith(p))?.foreground;
      const t: CustomTheme = {
        id: "custom:" + Date.now().toString(36),
        name: json.name ?? file.split(/[\\/]/).pop()!.replace(/\.jsonc?$/, ""),
        kind: r.ui.kind,
        ui: { bg: r.ui.bg, surface: r.ui.bg1, border: r.ui.border, fg: r.ui.fg, accent: r.ui.accent },
        syntax: {
          keyword: "#" + (find("keyword") ?? r.ui.accent.slice(1)),
          string: "#" + (find("string") ?? r.ui.green.slice(1)),
          number: "#" + (find("constant.numeric") ?? find("number") ?? r.ui.accent.slice(1)),
          comment: "#" + (find("comment") ?? r.ui.fgFaint.slice(1)),
          type: "#" + (find("entity.name.type") ?? find("support.type") ?? r.ui.fg.slice(1)),
        },
      };
      setStudio(t);
      toast("Theme imported into Theme Studio — tweak it, then save.");
    } catch (e) {
      toast("Not a valid theme file: " + errMsg(e), "error");
    }
  };

  const doImport = async (name: string) => {
    setBusy(name);
    try {
      const notes = await importFromEditor(name);
      onChange({ ...get().settings });
      toast(`Imported from ${name}: ${notes.join(" · ")}`);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const groups: [string, typeof themes][] = [
    ["Cepheus", themes.filter((t) => t.source === "builtin")],
    ["Yours", themes.filter((t) => t.source === "custom")],
    ["From extensions", themes.filter((t) => t.source === "extension")],
  ];

  return (
    <section className="appearance-block">
      {groups.map(([label, list]) =>
        list.length ? (
          <div key={label}>
            <label>{label}</label>
            <div className="theme-grid">
              {list.map((t) => (
                <button key={t.id} className={`theme-card ${settings.theme === t.id ? "on" : ""}`} onClick={() => apply({ theme: t.id })} title={t.name}>
                  <div className="theme-preview" style={{ background: t.swatch[0] }}>
                    <span style={{ background: t.swatch[3], width: "34%" }} />
                    <span style={{ background: t.swatch[1], width: "58%", opacity: 0.7 }} />
                    <span style={{ background: t.swatch[4], width: "44%" }} />
                    <i style={{ background: t.swatch[2] }} />
                  </div>
                  <div className="theme-name">
                    <span className="ellipsis">{t.name}</span>
                    {t.source === "custom" && (
                      <span
                        className="theme-edit"
                        title="Edit in Theme Studio"
                        onClick={(e) => { e.stopPropagation(); setStudio(settings.customThemes.find((c) => c.id === t.id) ?? null); }}
                      >
                        edit
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : null
      )}

      <div className="row gap" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <button className="btn small" onClick={startStudio}><i className="codicon codicon-symbol-color" /> Theme Studio</button>
        <button className="btn small" onClick={importJson}><i className="codicon codicon-cloud-download" /> Import theme .json</button>
        {editors.map((e) => (
          <button key={e.name} className="btn small" disabled={!!busy} onClick={() => doImport(e.name)}>
            {busy === e.name ? "Importing…" : `Import from ${e.name}`}
          </button>
        ))}
      </div>

      {studio && (
        <div className="studio">
          <div className="studio-head">
            <input value={studio.name} onChange={(e) => setStudio({ ...studio, name: e.target.value })} />
            <div className="seg" style={{ width: 160 }}>
              {(["dark", "light"] as const).map((k) => (
                <button key={k} className={studio.kind === k ? "on" : ""} onClick={() => setStudio({ ...studio, kind: k })}>{k}</button>
              ))}
            </div>
          </div>
          <div className="studio-grid">
            {(["bg", "surface", "border", "fg", "accent"] as const).map((k) => (
              <ColorField key={k} label={{ bg: "Background", surface: "Surface", border: "Lines", fg: "Text", accent: "Accent" }[k]} value={studio.ui[k]} onChange={(v) => setStudio({ ...studio, ui: { ...studio.ui, [k]: v } })} />
            ))}
            {(["keyword", "string", "number", "type", "comment"] as const).map((k) => (
              <ColorField key={k} label={k[0].toUpperCase() + k.slice(1)} value={studio.syntax[k]} onChange={(v) => setStudio({ ...studio, syntax: { ...studio.syntax, [k]: v } })} />
            ))}
          </div>
          <StudioPreview t={studio} />
          <div className="row gap" style={{ justifyContent: "flex-end", marginTop: 10 }}>
            {settings.customThemes.some((c) => c.id === studio.id) && (
              <button
                className="btn small"
                onClick={async () => {
                  await apply({ customThemes: settings.customThemes.filter((c) => c.id !== studio.id), theme: settings.theme === studio.id ? "builtin:ink" : settings.theme });
                  setStudio(null);
                }}
              >
                Delete
              </button>
            )}
            <button className="btn small" onClick={() => setStudio(null)}>Cancel</button>
            <button className="btn small primary" onClick={saveStudio}>Save &amp; apply</button>
          </div>
        </div>
      )}

      <div className="grid2" style={{ marginTop: 6 }}>
        <div>
          <label>File icon theme</label>
          <select value={settings.iconTheme} onChange={(e) => { onChange({ iconTheme: e.target.value }); setIconThemeSetting(e.target.value); }}>
            <option value="">Cepheus (minimal monograms)</option>
            {exts.filter((x) => !settings.disabledExtensions.includes(x.id)).flatMap((x) =>
              x.iconThemes.map((t) => <option key={x.id + t.id} value={`${x.id}:${t.id}`}>{t.label}</option>)
            )}
          </select>
        </div>
        <div className="muted small appearance-hint">Fonts live under Editor Text and Terminal; motion and contrast under Motion &amp; Accessibility.</div>
      </div>
    </section>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-field">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <span>{label}</span>
      <code>{value}</code>
    </label>
  );
}

function StudioPreview({ t }: { t: CustomTheme }) {
  const s = t.syntax;
  return (
    <pre className="studio-preview" style={{ background: t.ui.bg, color: t.ui.fg, borderColor: t.ui.border }}>
      <span style={{ color: s.comment, fontStyle: "italic" }}>{"// Cepheus — a quiet place to think\n"}</span>
      <span style={{ color: s.keyword }}>export async function </span>
      <span>orbit</span>(<span>star</span>: <span style={{ color: s.type }}>Star</span>, <span>n</span> = <span style={{ color: s.number }}>5</span>) {"{\n"}
      {"  "}<span style={{ color: s.keyword }}>const </span>name = <span style={{ color: s.string }}>"Alderamin"</span>;{"\n"}
      {"  "}<span style={{ color: s.keyword }}>return </span>star.<span>trace</span>(name, n);{"\n"}
      {"}"}
      <span className="studio-cursor" style={{ background: t.ui.accent }} />
    </pre>
  );
}
