import { useEffect, useRef, useState } from "react";
import { set, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import { MODEL_SUGGESTIONS, Provider, Settings } from "../lib/settings";
import Appearance from "./Appearance";
import { ManagedBadge, ManagedBanner } from "./ProfilesModal";
import { isManaged, policy, providerAllowed } from "../lib/policy";
import { useNvidiaModels } from "../lib/nvidia";
import { KNOWN_SERVERS, restartLanguageServers } from "../lib/lsp";
import McpServers from "./McpServers";
import { EditingSettings, SettingsSearch } from "./SettingsExtras";

const PROVIDERS: { id: Provider; name: string; keyHint: string; baseHint: string }[] = [
  { id: "nvidia", name: "NVIDIA (Free) - open models on NVIDIA NIM, no key needed", keyHint: "Optional: your own nvapi-… key", baseHint: "https://integrate.api.nvidia.com/v1" },
  { id: "anthropic", name: "Anthropic (Claude)", keyHint: "sk-ant-…", baseHint: "https://api.anthropic.com" },
  { id: "gemini", name: "Google Gemini", keyHint: "AIza…", baseHint: "https://generativelanguage.googleapis.com" },
  { id: "openai", name: "OpenAI-compatible (OpenAI, OpenRouter, Ollama, LM Studio…)", keyHint: "sk-… (leave empty for Ollama)", baseHint: "https://api.openai.com/v1  ·  Ollama: http://localhost:11434/v1" },
];

export default function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nv = useNvidiaModels(open && draft.provider === "nvidia");

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const p = draft.provider;
  const meta = PROVIDERS.find((x) => x.id === p)!;
  const upd = (patch: Partial<Settings>) => setDraft((d) => ({ ...d, ...patch }));
  const close = () => set({ settingsOpen: false });
  const save = async () => {
    const lspChanged = JSON.stringify(draft.languageServers) !== JSON.stringify(settings.languageServers);
    await saveSettings(draft);
    if (lspChanged) restartLanguageServers();
    close();
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="modal-head">
          <h2><i className="codicon codicon-settings-gear" /> Settings</h2>
          <button className="icon-btn" onClick={close}><i className="codicon codicon-close" /></button>
        </div>
        <SettingsSearch bodyRef={bodyRef} />
        <div className="modal-body" ref={bodyRef}>
          <ManagedBanner />
          <Appearance onChange={upd} />
          <EditingSettings draft={draft} upd={upd} />
          <section>
            <h3>AI Agent</h3>
            <label>Provider</label>
            <div className="seg">
              {PROVIDERS.map((x) => (
                <button key={x.id} className={p === x.id ? "on" : ""} disabled={!providerAllowed(x.id) || isManaged("provider")} title={providerAllowed(x.id) ? undefined : "Not allowed by your organization"} onClick={() => upd({ provider: x.id })}>{x.name.split(" (")[0]}</button>
              ))}
            </div>
            <div className="muted small">{meta.name}</div>

            <label>API key</label>
            <div className="row gap">
              <input
                type={showKey ? "text" : "password"}
                className="grow"
                placeholder={meta.keyHint}
                value={draft.keys[p]}
                onChange={(e) => upd({ keys: { ...draft.keys, [p]: e.target.value.trim() } })}
              />
              <button className="btn" onClick={() => setShowKey((v) => !v)}><i className={`codicon codicon-eye${showKey ? "-closed" : ""}`} /></button>
            </div>
            <div className="muted small">{p === "nvidia" ? "Leave empty to use the free built-in access. Add your own key from build.nvidia.com for higher limits." : "Stored locally in your app config folder. Requests go directly from this computer to the provider."}</div>

            <label>Model</label>
            {p === "nvidia" ? (
              <div className="row gap">
                <select className="grow" value={draft.models.nvidia} onChange={(e) => upd({ models: { ...draft.models, nvidia: e.target.value } })}>
                  {[...new Set([draft.models.nvidia, ...(nv.models ?? [])])].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <button className="btn" title="Refresh model list" onClick={nv.refresh}><i className={`codicon codicon-${nv.models === null && !nv.error ? "loading codicon-modifier-spin" : "refresh"}`} /></button>
              </div>
            ) : (
              <input list={`models-${p}`} value={draft.models[p]} onChange={(e) => upd({ models: { ...draft.models, [p]: e.target.value } })} />
            )}
            {p === "nvidia" && <div className="muted small">{nv.error ? `Couldn’t load models: ${nv.error}` : nv.models ? `${nv.models.length} models available, loaded live from NVIDIA.` : "Loading models from NVIDIA…"}</div>}
            <datalist id={`models-${p}`}>
              {MODEL_SUGGESTIONS[p].map((m) => <option key={m} value={m.replace(/ \(.*\)$/, "")} />)}
            </datalist>

            <label>Base URL <span className="muted">(optional)</span></label>
            <input placeholder={meta.baseHint} value={draft.baseUrls[p]} onChange={(e) => upd({ baseUrls: { ...draft.baseUrls, [p]: e.target.value.trim() } })} />

            {p === "anthropic" && (
              <>
                <label>Effort</label>
                <div className="seg">
                  {(["low", "medium", "high", "xhigh", "max"] as const).map((e) => (
                    <button key={e} className={draft.effort === e ? "on" : ""} onClick={() => upd({ effort: e })}>{e}</button>
                  ))}
                </div>
                <div className="muted small">Higher effort = deeper reasoning, more tokens. "high" is a good default for coding.</div>
              </>
            )}

            <label>Review policy <ManagedBadge k="approvalMode" /></label>
            <select disabled={isManaged("approvalMode") && !policy().minimumApprovalMode} value={draft.approvalMode} onChange={(e) => upd({ approvalMode: e.target.value as Settings["approvalMode"] })}>
              <option value="ask">Ask before file edits and commands</option>
              <option value="auto-edit">Edit files automatically, ask before commands</option>
              <option value="turbo">Turbo: run everything automatically</option>
            </select>

            <label>Custom instructions for the agent</label>
            <textarea rows={3} placeholder="e.g. Use TypeScript strict mode. Prefer functional components. Reply in Bahasa Indonesia." value={draft.customInstructions} onChange={(e) => upd({ customInstructions: e.target.value })} />

            <label className="check">
              <input type="checkbox" checked={draft.inlineCompletion} onChange={(e) => upd({ inlineCompletion: e.target.checked })} />
              AI inline completion (ghost text while typing — uses API tokens)
            </label>
            {draft.inlineCompletion && (
              <>
                <label>Completion model <span className="muted">(optional, empty = same as agent; a small fast model works best)</span></label>
                <input placeholder={draft.models[p]} value={draft.completionModel} onChange={(e) => upd({ completionModel: e.target.value })} />
              </>
            )}
          </section>

          {/* Agent platform: MCP servers (McpServers.tsx) */}
          <McpServers value={draft.mcpServers ?? {}} onChange={(mcpServers) => upd({ mcpServers })} />

          <section>
            <h3>Editor</h3>
            <div className="grid2">
              <div>
                <label>Tab size</label>
                <input type="number" min={1} max={8} value={draft.tabSize} onChange={(e) => upd({ tabSize: Number(e.target.value) || 2 })} />
              </div>
              <div>
                <label>Terminal shell <span className="muted">(empty = default)</span></label>
                <input placeholder="powershell.exe / pwsh.exe / cmd.exe" value={draft.shell} onChange={(e) => upd({ shell: e.target.value })} />
              </div>
            </div>
            <label className="check"><input type="checkbox" checked={draft.wordWrap} onChange={(e) => upd({ wordWrap: e.target.checked })} /> Word wrap</label>
            <label className="check"><input type="checkbox" checked={draft.minimap} onChange={(e) => upd({ minimap: e.target.checked })} /> Minimap</label>
            <label className="check"><input type="checkbox" checked={draft.autoSave} onChange={(e) => upd({ autoSave: e.target.checked })} /> Auto save</label>
            <label className="check"><input type="checkbox" checked={draft.inlineBlame} onChange={(e) => upd({ inlineBlame: e.target.checked })} /> Git blame on the current line</label>
          </section>

          <section>
            <h3>Language Servers</h3>
            <div className="muted small">Go to definition, rename, diagnostics and completion for each language. Leave empty to auto-detect the server on PATH (shown as placeholder); install one, e.g. <code>npm i -g pyright</code>, <code>rustup component add rust-analyzer</code>, <code>go install golang.org/x/tools/gopls@latest</code>.</div>
            <div className="lsp-grid">
              {Object.entries(KNOWN_SERVERS).filter(([l]) => l !== "c").map(([lang, specs]) => (
                <div key={lang} className="lsp-row">
                  <span className="lsp-lang">{lang === "cpp" ? "c / c++" : lang}</span>
                  <input
                    placeholder={specs.map((s) => s.command).join("  |  ")}
                    value={draft.languageServers[lang] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      const ls = { ...draft.languageServers, [lang]: v };
                      if (lang === "cpp") ls.c = v;
                      if (!v.trim()) { delete ls[lang]; if (lang === "cpp") delete ls.c; }
                      upd({ languageServers: ls });
                    }}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
