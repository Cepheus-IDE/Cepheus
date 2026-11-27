import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { get, set, useStore, ChatItem, AgentSession } from "../store";
import { acceptSessionChanges, editorContext, respondApproval, revertSessionChanges, sendMessage, stopSession } from "../lib/agent";
import { editorRef } from "../lib/ai";
import { openDiff, openFile, saveSettings } from "../lib/workspace";
import { api } from "../lib/api";
import { basename, join, relative } from "../lib/paths";
import type { ApprovalMode } from "../lib/settings";
import { shortModel, useNvidiaModels } from "../lib/nvidia";
import { ModelPicker } from "./ModelPicker";
import { takePrefill } from "../lib/continuity";
import { ComposerOptions, ContextChips, DebugLog, PlanActions } from "./AgentExtras";

/** Per-session composer draft and scroll position, kept across remounts (pop out / dock). */
const drafts = new Map<string, string>();
const scrollPos = new Map<string, { top: number; stick: boolean }>();

marked.setOptions({ gfm: true, breaks: false });

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

const TOOL_META: Record<string, { icon: string; verb: string }> = {
  list_dir: { icon: "folder", verb: "Listed" },
  find_files: { icon: "search", verb: "Found files" },
  read_file: { icon: "file", verb: "Read" },
  search: { icon: "search", verb: "Searched" },
  write_file: { icon: "new-file", verb: "Wrote" },
  edit_file: { icon: "edit", verb: "Edited" },
  run_command: { icon: "terminal", verb: "Ran" },
  run_check: { icon: "beaker", verb: "Self-check" },
  load_skill: { icon: "lightbulb", verb: "Loaded skill" },
};

function toolSummary(name: string, args: any): string {
  switch (name) {
    case "list_dir": return args?.path ?? ".";
    case "find_files": return `"${args?.pattern ?? ""}"`;
    case "read_file": return `${args?.path ?? ""}${args?.start_line ? ` L${args.start_line}-${args.end_line ?? ""}` : ""}`;
    case "search": return `"${args?.query ?? ""}"`;
    case "write_file":
    case "edit_file": return args?.path ?? "";
    case "run_command": return args?.command ?? "";
    case "run_check": return args?.command ?? "";
    case "load_skill": return args?.name ?? "";
    default: return name.startsWith("mcp__") ? JSON.stringify(args ?? {}).slice(0, 120) : "";
  }
}

function ToolItem({ item, sessionId }: { item: Extract<ChatItem, { kind: "tool" }>; sessionId: string }) {
  const [open, setOpen] = useState(item.status === "approval");
  const ws = useStore((s) => s.workspace);
  const mcp = item.name.match(/^mcp__(.+?)__(.+)$/);
  const meta = TOOL_META[item.name] ?? (mcp ? { icon: "plug", verb: `${mcp[1]}: ${mcp[2]}` } : { icon: "tools", verb: item.name });
  useEffect(() => {
    if (item.status === "approval") setOpen(true);
  }, [item.status]);

  const absPath = item.args?.path && ws ? join(ws, String(item.args.path).replace(/\//g, ws.includes("\\") ? "\\" : "/")) : null;

  const previewDiff = async () => {
    if (!absPath) return;
    if (item.name === "edit_file") {
      openDiff(absPath, item.args.old_str ?? "", item.args.new_str ?? "", "Proposed edit");
    } else if (item.name === "write_file") {
      let current = "";
      try { current = await api.readFile(absPath); } catch { /* new file */ }
      openDiff(absPath, current, item.args.content ?? "", "Proposed");
    }
  };

  const statusIcon =
    item.status === "running" ? "loading codicon-modifier-spin" :
    item.status === "approval" ? "question" :
    item.status === "rejected" ? "circle-slash" :
    item.status === "error" ? "error" : "check";

  return (
    <div className={`tool-item status-${item.status}`}>
      <div className="tool-head" onClick={() => setOpen((o) => !o)}>
        <i className={`codicon codicon-${meta.icon}`} />
        <span className="verb">{meta.verb}</span>
        <code className="ellipsis">{toolSummary(item.name, item.args)}</code>
        <i className={`codicon codicon-${statusIcon} st`} />
      </div>
      {open && (
        <div className="tool-body">
          {item.name === "run_command" && <pre className="cmd">$ {item.args?.command}</pre>}
          {item.name === "edit_file" && item.status === "approval" && (
            <div className="mini-diff">
              <pre className="del">{item.args?.old_str}</pre>
              <pre className="add">{item.args?.new_str}</pre>
            </div>
          )}
          {item.name === "write_file" && item.status === "approval" && (
            <pre className="add">{String(item.args?.content ?? "").slice(0, 3000)}{String(item.args?.content ?? "").length > 3000 ? "\n…" : ""}</pre>
          )}
          {item.output && <pre className={`out ${item.isError ? "err" : ""}`}>{item.output.length > 8000 ? item.output.slice(0, 8000) + "\n…" : item.output}</pre>}
          <div className="row gap">
            {(item.name === "edit_file" || item.name === "write_file") && (
              <button className="btn small" onClick={previewDiff}><i className="codicon codicon-diff" /> Diff</button>
            )}
            {absPath && item.name !== "list_dir" && item.status === "done" && (
              <button className="btn small" onClick={() => openFile(absPath)}><i className="codicon codicon-go-to-file" /> Open</button>
            )}
          </div>
        </div>
      )}
      {item.status === "approval" && item.approvalId && (
        <div className="approval">
          <span>{item.name === "run_command" ? "Run this command?" : mcp ? "Call this MCP tool?" : "Apply this change?"}</span>
          <button className="btn small" onClick={() => respondApproval(sessionId, item.approvalId!, false)}>Reject</button>
          <button className="btn small primary" onClick={() => respondApproval(sessionId, item.approvalId!, true)}>
            {item.name === "run_command" ? "Run" : "Accept"}
          </button>
        </div>
      )}
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thinking" onClick={() => setOpen((o) => !o)}>
      <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} /> Thought
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}

export function PlanView({ session }: { session: AgentSession }) {
  if (!session.plan.length) return null;
  const done = session.plan.filter((p) => p.status === "done").length;
  return (
    <div className="plan">
      <div className="plan-head">
        <i className="codicon codicon-checklist" /> Plan <span className="muted small">{done}/{session.plan.length}</span>
        <div className="progress"><div style={{ width: `${(done / session.plan.length) * 100}%` }} /></div>
      </div>
      {session.plan.map((p, i) => (
        <div key={i} className={`plan-item ${p.status}`}>
          <i className={`codicon codicon-${p.status === "done" ? "pass-filled" : p.status === "in_progress" ? "loading codicon-modifier-spin" : "circle-large-outline"}`} />
          <span>{p.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ChangesView({ session }: { session: AgentSession }) {
  const ws = useStore((s) => s.workspace);
  const entries = Object.entries(session.changes);
  if (!entries.length) return null;
  const busy = session.status === "running" || session.status === "waiting";
  return (
    <div className="changes">
      <div className="plan-head">
        <i className="codicon codicon-git-compare" /> {entries.length} file{entries.length > 1 ? "s" : ""} changed
        <div className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => revertSessionChanges(session.id)} title="Restore files to how they were before the agent changed them">
          <i className="codicon codicon-discard" /> Revert all
        </button>
        <button className="btn small primary" disabled={busy} onClick={() => acceptSessionChanges(session.id)}>
          <i className="codicon codicon-check-all" /> Keep
        </button>
      </div>
      {entries.map(([path, ch]) => (
        <div key={path} className="tree-row" onClick={() => openDiff(path, ch.before ?? "", ch.after, "Before agent")} title="Show diff">
          <i className={`codicon codicon-${ch.before === null ? "diff-added" : "diff-modified"}`} />
          <span className="name">{basename(path)}</span>
          <span className="muted small ellipsis">{relative(ws, path)}</span>
        </div>
      ))}
    </div>
  );
}

export default function AgentChat({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const approvalMode = useStore((s) => s.settings.approvalMode);
  const provider = useStore((s) => s.settings.provider);
  const model = useStore((s) => s.settings.models[s.settings.provider]);
  const nv = useNvidiaModels(provider === "nvidia");
  const hasActiveFile = useStore((s) => s.tabs.some((t) => t.id === s.activeId && t.kind === "file"));
  // Draft and scroll position survive remounts (pop out to the Agent Manager / dock back).
  const [text, setTextRaw] = useState(() => drafts.get(sessionId) ?? "");
  const setText = (t: string) => { drafts.set(sessionId, t); setTextRaw(t); };
  // Prompt from a cepheus://agent/new?prompt=… link (prefilled, never auto-sent).
  useEffect(() => { const p = takePrefill(sessionId); if (p) setText(p); }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [withContext, setWithContext] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(scrollPos.get(sessionId)?.stick ?? true);

  useLayoutEffect(() => {
    const el = scroller.current;
    const saved = scrollPos.get(sessionId);
    if (el && saved && !saved.stick) el.scrollTop = saved.top;
  }, [sessionId, session?.showDebug]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [session?.items.length, session?.status, session?.plan, session?.showDebug]);

  if (!session) return null;
  const busy = session.status === "running" || session.status === "waiting";

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    // While the agent works, the message is queued and injected at its next turn (steering).
    setText("");
    stick.current = true;
    sendMessage(session.id, t, withContext ? editorContext(editorRef.current) : null);
  };

  const setMode = (m: ApprovalMode) => saveSettings({ ...get().settings, approvalMode: m });

  return (
    <div className={`agent-chat ${compact ? "compact" : ""}`}>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!session.showDebug) scrollPos.set(session.id, { top: el.scrollTop, stick: stick.current });
        }}
      >
        {session.showDebug && <DebugLog session={session} />}
        {!session.showDebug && <>
        {session.items.length === 0 && (
          <div className="chat-empty">
            <i className="codicon codicon-hubot" />
            <h3>What should we build?</h3>
            <p className="muted">The agent can read and edit files, search the codebase, and run commands in your workspace.</p>
            <div className="suggestions">
              {["Explain the structure of this project", "Find and fix bugs in the current file", "Write tests for the current file", "Add a README for this project"].map((s) => (
                <button key={s} onClick={() => setText(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {session.items.map((it, i) => {
          switch (it.kind) {
            case "user": return (
              <div key={i} className={`msg user ${it.queued ? "queued" : ""}`}>
                <div className="bubble">{it.text}</div>
                {it.queued && <div className="muted small queued-note"><i className="codicon codicon-clock" /> Queued: delivered at the agent's next step</div>}
              </div>
            );
            case "context": return <ContextChips key={i} item={it} />;
            case "assistant": return <div key={i} className="msg assistant"><Markdown text={it.text} /></div>;
            case "thinking": return <Thinking key={i} text={it.text} />;
            case "warning": return <div key={i} className="note warn"><i className="codicon codicon-warning" /> {it.text}</div>;
            case "error": return <div key={i} className="note err"><i className="codicon codicon-error" /> {it.text}</div>;
            case "tool": return <ToolItem key={i} item={it} sessionId={session.id} />;
          }
        })}
        {busy && (
          <div className="working">
            <span className="dots"><span /><span /><span /></span>
            {session.status === "waiting" ? "Waiting for your approval" : "Working"}
          </div>
        )}
        {!compact && <PlanView session={session} />}
        <PlanActions session={session} />
        </>}
      </div>
      {compact && !session.showDebug && <PlanView session={session} />}
      <ChangesView session={session} />
      <div className="composer">
        <textarea
          placeholder={
            busy ? "Agent is working… type to steer it (queued for its next step)"
            : session.planMode ? "Describe the task: the agent researches read-only and proposes a plan"
            : "Ask the agent to do anything (Enter to send, Shift+Enter for newline)"
          }
          value={text}
          rows={3}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-bar">
          <select value={approvalMode} onChange={(e) => setMode(e.target.value as ApprovalMode)} title="Review policy">
            <option value="ask">Ask before edits &amp; commands</option>
            <option value="auto-edit">Auto-edit, ask for commands</option>
            <option value="turbo">Turbo (fully autonomous)</option>
          </select>
          {hasActiveFile && (
            <button className={`chip ${withContext ? "on" : ""}`} onClick={() => setWithContext((v) => !v)} title="Include the active file / selection as context">
              <i className="codicon codicon-file-code" /> context
            </button>
          )}
          {/* Agent platform (AgentExtras.tsx): Plan mode, Verify with checks, custom agent. */}
          <ComposerOptions session={session} />
          <div className="spacer" />
          {/* Language Models (ModelPicker.tsx): harness + model for every provider, Auto, effort. */}
          <ModelPicker sessionId={session.id} />
          {busy && text.trim() && (
            <button className="send" onClick={submit} title="Steer: queue this message for the agent's next step"><i className="codicon codicon-send" /></button>
          )}
          {busy ? (
            <button className="send stop" onClick={() => stopSession(session.id)} title="Stop"><i className="codicon codicon-debug-stop" /></button>
          ) : (
            <button className="send" onClick={submit} disabled={!text.trim()} title="Send"><i className="codicon codicon-send" /></button>
          )}
        </div>
      </div>
    </div>
  );
}
