import { useEffect } from "react";
import { get, toast, useStore } from "../store";
import { saveSettings } from "../lib/workspace";
import type { Settings } from "../lib/settings";
import {
  AUTO, capabilities, defaultPick, enabledModels, ensureModelLists, fmtTokens, openLanguageModels, pickKey,
  providerName, setSessionPick, splitPick, sumUsage, useModelLists, useSessionPicks, useUnavailable, useUsage, withDefaultPick,
} from "../lib/models";
import { detectHarnesses, Harness, HARNESSES, setHarness, setHarnessModel, useHarness } from "../lib/harness";
import { shortModel } from "../lib/nvidia";

const EFFORTS: Settings["effort"][] = ["low", "medium", "high", "xhigh", "max"];

/** Chat footer: harness, model (grouped by provider, enabled models only, plus Auto) and effort. */
export function ModelPicker({ sessionId }: { sessionId: string }) {
  const settings = useStore((s) => s.settings);
  useModelLists((s) => s.lists); // re-render when a provider's live list arrives
  const unavailable = useUnavailable((s) => s.keys);
  const pick = useSessionPicks((s) => s.picks[sessionId]) ?? defaultPick(settings);
  const fallbackHarness = useStore((s) => s.settings.agentHarness ?? "cepheus");
  const harness = useHarness((s) => s.bySession[sessionId]) ?? fallbackHarness;
  const harnessModel = useHarness((s) => s.model[sessionId] ?? "default");
  const installed = useHarness((s) => s.installed);

  const providerKey = settings.customProviders.map((c) => c.id + c.baseUrl).join() + Object.values(settings.keys).map((k) => !!k).join() + settings.baseUrls.openai;
  useEffect(() => { ensureModelLists(); }, [providerKey]);
  useEffect(() => { detectHarnesses(); }, []);

  const chooseHarness = async (h: Harness) => {
    const meta = HARNESSES.find((x) => x.id === h)!;
    if (meta.exe) {
      const found = await detectHarnesses(true);
      if (!found[meta.exe]) {
        toast(`${meta.name} CLI (\`${meta.exe}\`) was not found on PATH. Install: ${meta.install}`, "error");
        return;
      }
    }
    setHarness(sessionId, h);
  };

  const choose = (v: string) => {
    if (v === "__manage") return openLanguageModels("models");
    setSessionPick(sessionId, v);
    // The choice also becomes the default for new sessions.
    saveSettings(withDefaultPick(get().settings, v));
  };

  const groups = enabledModels(settings);
  const listed = new Set(groups.flatMap((g) => g.models.map((m) => pickKey(g.provider.id, m.id))));
  const [pid, model] = pick === AUTO ? ["", ""] : splitPick(pick);
  const reasoning = pick === AUTO || !!capabilities(model).reasoning || pid === "anthropic";

  return (
    <>
      <select
        className="model-chip harness-chip"
        value={harness}
        title="Agent harness for this session"
        onChange={(e) => chooseHarness(e.target.value as Harness)}
      >
        {HARNESSES.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}{h.exe && installed && !installed[h.exe] ? " (not installed)" : ""}
          </option>
        ))}
      </select>
      {harness !== "cepheus" ? (
        <select className="model-chip" value={harnessModel} title="Model used by the CLI" onChange={(e) => setHarnessModel(sessionId, e.target.value)}>
          {HARNESSES.find((h) => h.id === harness)!.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <>
          <select
            className="model-chip"
            value={pick}
            title={pick === AUTO ? "Auto: picks a model per request and falls back on errors" : `${providerName(settings, pid)} · ${model}`}
            onChange={(e) => choose(e.target.value)}
          >
            <option value={AUTO}>Auto</option>
            {pick !== AUTO && !listed.has(pick) && <option value={pick}>{shortModel(model)}</option>}
            {groups.map((g) => (
              <optgroup key={g.provider.id} label={g.provider.name}>
                {g.models.map((m) => {
                  const k = pickKey(g.provider.id, m.id);
                  return (
                    <option key={k} value={k}>
                      {shortModel(m.id)}{unavailable.includes(k) ? " (unavailable)" : ""}
                    </option>
                  );
                })}
              </optgroup>
            ))}
            <option value="__manage">Manage models…</option>
          </select>
          {reasoning && (
            <select
              className="model-chip effort-chip"
              value={settings.effort}
              title="Thinking effort (for models with reasoning controls)"
              onChange={(e) => saveSettings({ ...get().settings, effort: e.target.value as Settings["effort"] })}
            >
              {EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          )}
        </>
      )}
    </>
  );
}

/** Compact token counter for the chat header; click opens the Usage view. */
export function UsageBadge({ sessionId }: { sessionId: string }) {
  const by = useUsage((s) => s.bySession[sessionId]);
  const settings = useStore((s) => s.settings);
  const t = sumUsage(by);
  if (!t.requests) return null;
  const detail = Object.entries(by ?? {})
    .map(([k, u]) => {
      const [p, m] = splitPick(k);
      return `${providerName(settings, p)} · ${m}: ${u.requests} req, ${fmtTokens(u.input)} in, ${fmtTokens(u.output)} out${u.cacheRead ? `, ${fmtTokens(u.cacheRead)} cached` : ""}`;
    })
    .join("\n");
  return (
    <button className="usage-badge" title={`Session usage\n${detail}`} onClick={() => openLanguageModels("usage")}>
      <i className="codicon codicon-pulse" /> {fmtTokens(t.input)}↑ {fmtTokens(t.output)}↓ · {t.requests}
    </button>
  );
}
