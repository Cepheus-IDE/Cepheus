// Agent platform UI: context chips, Plan mode actions, composer options (Plan / Verify /
// custom agent) and the per-session debug log.
import { useEffect, useState } from "react";
import { useStore, AgentSession, ChatItem, AgentDebugEntry } from "../store";
import { debugSummary, refreshCustomizations, setSessionOption, startImplementation, useCustomizations } from "../lib/agentPlatform";
import { openFile } from "../lib/workspace";
import { join } from "../lib/paths";

export function ContextChips({ item }: { item: Extract<ChatItem, { kind: "context" }> }) {
  const ws = useStore((s) => s.workspace);
  const [open, setOpen] = useState(false);
  const n = item.instructions.length + item.skills.length;
  if (!n && !item.agent && !item.mcpTools && !item.planMode) return null;
  const openRel = (p: string) => ws && openFile(join(ws, p.replace(/\//g, ws.includes("\\") ? "\\" : "/")));
  return (
    <div className="ctx-chips">
      {item.planMode && <span className="ctx-chip plan" title="Read-only research; the agent will propose a plan"><i className="codicon codicon-checklist" /> Plan mode</span>}
      {item.agent && <span className="ctx-chip" title="Custom agent"><i className="codicon codicon-person" /> {item.agent}</span>}
      {item.instructions.map((p) => (
        <button key={p} className="ctx-chip" title={`Instruction file loaded: ${p}`} onClick={() => openRel(p)}>
          <i className="codicon codicon-book" /> {p.split("/").pop()}
        </button>
      ))}
      {item.skills.length > 0 && (
        <button className="ctx-chip" title={item.skills.join(", ")} onClick={() => setOpen((o) => !o)}>
          <i className="codicon codicon-lightbulb" /> {item.skills.length} skill{item.skills.length > 1 ? "s" : ""}
        </button>
      )}
      {!!item.mcpTools && <span className="ctx-chip" title="Tools from MCP servers"><i className="codicon codicon-plug" /> {item.mcpTools} MCP tools</span>}
      {open && <div className="muted small ctx-skills">{item.skills.join(" · ")}</div>}
    </div>
  );
}

/** Shown after a Plan-mode run: continue the same session in normal mode. */
export function PlanActions({ session }: { session: AgentSession }) {
  const busy = session.status === "running" || session.status === "waiting";
  if (!session.planMode || busy) return null;
  const last = session.items[session.items.length - 1];
  if (!last || last.kind === "user" || !session.items.some((i) => i.kind === "assistant")) return null;
  return (
    <div className="plan-actions">
      <span className="muted small">Review the plan, ask for changes, or:</span>
      <button className="btn primary small" onClick={() => startImplementation(session.id)}>
        <i className="codicon codicon-play" /> Start implementation
      </button>
    </div>
  );
}

/** Plan toggle, "Verify with checks" toggle and custom-agent picker for the composer bar. */
export function ComposerOptions({ session }: { session: AgentSession }) {
  const ws = useStore((s) => s.workspace);
  const agents = useCustomizations((c) => c.data.agents);
  useEffect(() => {
    refreshCustomizations();
  }, [ws]);
  const busy = session.status === "running" || session.status === "waiting";
  return (
    <>
      <button
        className={`chip ${session.planMode ? "on" : ""}`}
        disabled={busy}
        onClick={() => setSessionOption(session.id, { planMode: !session.planMode })}
        title="Plan mode: the agent only reads and researches, then proposes a plan for you to approve"
      >
        <i className="codicon codicon-checklist" /> Plan
      </button>
      <button
        className={`chip ${session.verify ? "on" : ""}`}
        onClick={() => setSessionOption(session.id, { verify: !session.verify })}
        title="Verify with checks: after the agent finishes, run the project's typecheck/lint/tests (or cargo check, go test, pytest) and let it fix failures (up to 3 rounds)"
      >
        <i className="codicon codicon-beaker" /> Verify
      </button>
      {(agents.length > 0 || session.agent) && (
        <select
          className="agent-pick"
          value={session.agent ?? ""}
          disabled={busy}
          onFocus={() => refreshCustomizations(true)}
          onChange={(e) => setSessionOption(session.id, { agent: e.target.value || undefined })}
          title="Custom agent (.cepheus/agents/*.md)"
        >
          <option value="">Default agent</option>
          {agents.map((a) => (
            <option key={a.name} value={a.name} title={a.description}>{a.name}</option>
          ))}
          {session.agent && !agents.some((a) => a.name === session.agent) && <option value={session.agent}>{session.agent} (missing)</option>}
        </select>
      )}
    </>
  );
}

const fmtMs = (ms: number) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function DebugRow({ e }: { e: AgentDebugEntry }) {
  const [open, setOpen] = useState(false);
  let icon = "circle-small";
  let title = e.kind;
  let detail = "";
  let bad = false;
  switch (e.kind) {
    case "turn":
      icon = "hubot";
      title = `Model turn · ${e.provider ?? ""}/${e.model ?? ""}`;
      detail = e.error ? `error: ${e.error}` : `${e.inputTokens ?? 0} in · ${e.outputTokens ?? 0} out${e.cacheReadTokens ? ` · ${e.cacheReadTokens} cached` : ""} · ${e.toolCalls ?? 0} tool calls`;
      bad = !!e.error;
      break;
    case "tool":
      icon = "tools";
      title = `Tool · ${e.name}`;
      detail = `${e.resultSize ?? 0} chars${e.error ? " · error" : ""}`;
      bad = !!e.error;
      break;
    case "hook":
      icon = "zap";
      title = `Hook · ${e.event}${e.tool ? ` (${e.tool})` : ""}`;
      detail = `exit ${e.exitCode}${e.blocked ? " · BLOCKED" : ""}`;
      bad = e.exitCode !== 0;
      break;
    case "check":
      icon = "beaker";
      title = `Self-check (round ${e.round}) · ${e.command}`;
      detail = `exit ${e.exitCode}`;
      bad = e.exitCode !== 0;
      break;
    case "steer":
      icon = "comment";
      title = "Steering message injected";
      detail = e.text;
      break;
    case "context":
      icon = "book";
      title = "Run context";
      detail = `${e.provider}/${e.model} · ${e.tools?.length ?? 0} tools · ${e.instructions?.length ?? 0} instruction files · ${e.skills?.length ?? 0} skills · ${e.hooks ?? 0} hooks${e.agent ? ` · agent ${e.agent}` : ""}${e.planMode ? " · plan mode" : ""}`;
      break;
  }
  return (
    <div className={`dbg-row ${bad ? "bad" : ""}`}>
      <div className="dbg-head" onClick={() => setOpen((o) => !o)}>
        <span className="muted small dbg-ts">{fmtTime(e.ts)}</span>
        <i className={`codicon codicon-${icon}`} />
        <span className="ellipsis dbg-title">{title}</span>
        {e.durationMs != null && <span className="muted small">{fmtMs(e.durationMs)}</span>}
      </div>
      {detail && <div className="muted small dbg-detail ellipsis">{detail}</div>}
      {open && <pre className="dbg-json">{JSON.stringify(e, null, 2)}</pre>}
    </div>
  );
}

/** Chronological debug log with a compact flow summary on top. */
export function DebugLog({ session }: { session: AgentSession }) {
  const entries = session.debug ?? [];
  const sum = debugSummary(entries);
  const [filter, setFilter] = useState<string>("all");
  const shown = filter === "all" ? entries : entries.filter((e) => e.kind === filter);
  // Flow: one block per model turn with the tools it triggered.
  const flow: { turn: AgentDebugEntry; tools: AgentDebugEntry[] }[] = [];
  for (const e of entries) {
    if (e.kind === "turn") flow.push({ turn: e, tools: [] });
    else if ((e.kind === "tool" || e.kind === "hook" || e.kind === "check") && flow.length) flow[flow.length - 1].tools.push(e);
  }
  return (
    <div className="debug-log">
      <div className="dbg-summary">
        <div><b>{sum.turns}</b><span>model turns</span></div>
        <div><b>{sum.toolCalls}</b><span>tool calls</span></div>
        <div><b>{(sum.input / 1000).toFixed(1)}k</b><span>in tokens</span></div>
        <div><b>{(sum.output / 1000).toFixed(1)}k</b><span>out tokens</span></div>
        <div><b>{fmtMs(sum.modelMs)}</b><span>model time</span></div>
        <div><b>{fmtMs(sum.toolMs)}</b><span>tool time</span></div>
      </div>
      {entries.length === 0 && <div className="muted small pad">No activity recorded yet. Send a message to the agent.</div>}
      {flow.length > 0 && (
        <div className="dbg-flow" title="Flow: each box is a model turn, followed by the tools it called">
          {flow.slice(-40).map((f, i) => (
            <div key={i} className="dbg-flow-step">
              <span className={`dbg-node turn ${f.turn.error ? "bad" : ""}`} title={`${f.turn.model} · ${fmtMs(f.turn.durationMs ?? 0)}`}>T{flow.length > 40 ? flow.length - 40 + i + 1 : i + 1}</span>
              {f.tools.map((t, j) => (
                <span key={j} className={`dbg-node ${t.kind} ${t.error || (t.kind !== "tool" && t.exitCode !== 0) ? "bad" : ""}`} title={`${t.name ?? t.command ?? t.event} · ${fmtMs(t.durationMs ?? 0)}`}>
                  {t.kind === "tool" ? String(t.name).replace(/^mcp__/, "mcp:").slice(0, 14) : t.kind === "hook" ? `hook:${t.event}` : "check"}
                </span>
              ))}
              {i < flow.slice(-40).length - 1 && <i className="codicon codicon-arrow-right muted" />}
            </div>
          ))}
        </div>
      )}
      {Object.keys(sum.byTool).length > 0 && (
        <div className="dbg-tools muted small">
          {Object.entries(sum.byTool).map(([n, b]) => (
            <span key={n}>{n} ×{b.n}{b.errors ? ` (${b.errors} err)` : ""} · {fmtMs(b.ms)}</span>
          ))}
        </div>
      )}
      <div className="row gap dbg-filter">
        {["all", "turn", "tool", "hook", "check", "steer", "context"].map((k) => (
          <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{k}</button>
        ))}
      </div>
      <div className="dbg-list">
        {shown.map((e, i) => <DebugRow key={i} e={e} />)}
      </div>
    </div>
  );
}

/** Header buttons shared by the side panel and the Agent Manager. */
export function DebugToggle({ session }: { session: AgentSession }) {
  return (
    <button
      className={session.showDebug ? "on" : ""}
      title={session.showDebug ? "Back to chat" : "Debug log: model turns, tool calls, hooks, tokens"}
      onClick={() => setSessionOption(session.id, { showDebug: !session.showDebug })}
    >
      <i className={`codicon codicon-${session.showDebug ? "comment-discussion" : "debug-console"}`} />
    </button>
  );
}
