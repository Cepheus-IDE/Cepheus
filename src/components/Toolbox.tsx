import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { errMsg } from "../lib/api";
import { basename, relative } from "../lib/paths";
import { openFile } from "../lib/workspace";
import { ToolboxTab, useToolbox } from "../lib/toolbox/state";
import { detectTasks, loadExits, loadPins, runTask, savePins, taskKey, TaskGroup } from "../lib/toolbox/scripts";
import type { Task } from "../lib/toolbox/scriptsDetect";
import { killPid, listPorts, localUrl, openPortInBrowser } from "../lib/toolbox/ports";
import { isLocalReachable, ListeningPort } from "../lib/toolbox/portsParse";
import { scanTodos, TODO_TAGS, TodoItem, TodoTag } from "../lib/toolbox/todos";
import { copy } from "./GitWidgets";
import EnvManager from "./ToolboxEnv";
import Sweeper from "./ToolboxSweeper";
import DevUtils from "./ToolboxUtils";

const TABS: { id: ToolboxTab; label: string; icon: string }[] = [
  { id: "tasks", label: "Scripts", icon: "play" },
  { id: "ports", label: "Ports", icon: "plug" },
  { id: "env", label: ".env", icon: "key" },
  { id: "todo", label: "TODO", icon: "checklist" },
  { id: "disk", label: "Disk", icon: "trash" },
  { id: "utils", label: "Utils", icon: "symbol-misc" },
];

export default function Toolbox() {
  const tab = useToolbox((s) => s.tab);
  const todos = useToolbox((s) => s.todoCount);
  return (
    <div className="panel tb-panel">
      <div className="panel-header"><span>TOOLBOX</span></div>
      <div className="scm-tabs tb-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} title={t.label} onClick={() => useToolbox.setState({ tab: t.id })}>
            <i className={`codicon codicon-${t.icon}`} /> {t.label}
            {t.id === "todo" && todos > 0 && <span className="tb-count">{todos}</span>}
          </button>
        ))}
      </div>
      <div className="tb-body">
        {tab === "tasks" && <Tasks />}
        {tab === "ports" && <Ports />}
        {tab === "env" && <EnvManager />}
        {tab === "todo" && <Todos />}
        {tab === "disk" && <Sweeper />}
        {tab === "utils" && <DevUtils />}
      </div>
    </div>
  );
}

export function NoWorkspace({ what }: { what: string }) {
  return <div className="empty-state"><p>Open a folder to see its {what}.</p></div>;
}

// ------------------------------------------------------------------ Scripts

const KIND_ICON: Record<Task["kind"], string> = { npm: "package", make: "tools", just: "terminal", cargo: "gear", composer: "package", python: "symbol-namespace", compose: "server-environment" };

function Tasks() {
  const ws = useStore((s) => s.workspace);
  const [groups, setGroups] = useState<TaskGroup[] | null>(null);
  const [error, setError] = useState("");
  const [pins, setPins] = useState(loadPins);
  const [exits, setExits] = useState(loadExits);
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState<Record<string, boolean>>({});

  const load = () => {
    if (!ws) return;
    setError("");
    detectTasks(ws).then(setGroups, (e) => setError(errMsg(e)));
  };
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ws) return <NoWorkspace what="scripts" />;
  if (ws.startsWith("ssh://")) return <div className="empty-state"><p>Scripts run locally; this workspace is remote.</p></div>;

  const run = (g: TaskGroup, t: Task) => {
    const k = taskKey(g, t);
    setRunning((r) => ({ ...r, [k]: true }));
    runTask(g, t, () => { setRunning((r) => ({ ...r, [k]: false })); setExits(loadExits()); });
  };
  const togglePin = (k: string) => {
    const next = pins.includes(k) ? pins.filter((p) => p !== k) : [...pins, k];
    setPins(next);
    savePins(next);
  };
  const f = filter.trim().toLowerCase();
  const match = (t: Task) => !f || t.name.toLowerCase().includes(f) || (t.detail ?? "").toLowerCase().includes(f);
  const pinned = (groups ?? []).flatMap((g) => g.tasks.filter((t) => pins.includes(taskKey(g, t)) && match(t)).map((t) => ({ g, t })));

  const row = (g: TaskGroup, t: Task, showGroup = false) => {
    const k = taskKey(g, t);
    const ex = exits[k];
    return (
      <div key={k} className="tree-row tb-row" title={`${t.command}${t.detail ? `\n${t.detail}` : ""}`} onDoubleClick={() => run(g, t)}>
        <button className="icon-btn small tb-run" title={`Run: ${t.command}`} onClick={() => run(g, t)}>
          <i className={`codicon codicon-${running[k] ? "loading codicon-modifier-spin" : "play"}`} />
        </button>
        <span className="tb-name">{t.name}</span>
        <span className="tb-detail">{showGroup ? g.label : t.detail ?? ""}</span>
        {ex && (
          <span className={`tb-exit ${ex.code === 0 ? "ok" : "fail"}`} title={`Last run ${new Date(ex.at).toLocaleString()} — exit code ${ex.code}`}>
            {ex.code === 0 ? <i className="codicon codicon-check" /> : `✗ ${ex.code}`}
          </span>
        )}
        <button className={`icon-btn small tb-pin ${pins.includes(k) ? "on" : ""}`} title={pins.includes(k) ? "Unpin" : "Pin to top"} onClick={() => togglePin(k)}>
          <i className={`codicon codicon-${pins.includes(k) ? "pinned" : "pin"}`} />
        </button>
      </div>
    );
  };

  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <input className="grow" placeholder="Filter scripts" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="icon-btn" title="Rescan" onClick={load}><i className="codicon codicon-refresh" /></button>
      </div>
      {error && <div className="tb-error">{error}</div>}
      {!groups && !error && <div className="tb-hint"><i className="codicon codicon-loading codicon-modifier-spin" /> Looking for scripts…</div>}
      {groups && !groups.length && (
        <div className="tb-hint">No package.json scripts, Makefile, justfile, Cargo, composer, Python or Docker Compose tasks found in this folder or its first-level folders.</div>
      )}
      <div className="tb-scroll">
        {pinned.length > 0 && (
          <div className="tb-group">
            <div className="tb-group-title"><i className="codicon codicon-pinned" /> Pinned</div>
            {pinned.map(({ g, t }) => row(g, t, true))}
          </div>
        )}
        {groups?.map((g) => {
          const tasks = g.tasks.filter(match);
          if (!tasks.length) return null;
          return (
            <div key={g.label} className="tb-group">
              <div className="tb-group-title"><i className={`codicon codicon-${KIND_ICON[g.kind]}`} /> {g.label}</div>
              {tasks.map((t) => row(g, t))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Ports

const SYSTEM_PROC = /^(system|svchost\.exe|lsass\.exe|wininit\.exe|services\.exe|spoolsv\.exe|smss\.exe|csrss\.exe|rapportd|controlce|controlcenter|launchd|systemd.*|cupsd|avahi-daemon|sharingd|identityservicesd|remoted|chronyd|dnsmasq)$/i;

function Ports() {
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState("");
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    listPorts().then((p) => { setPorts(p); setError(""); }, (e) => setError(errMsg(e))).finally(() => setBusy(false));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const f = filter.trim().toLowerCase();
  const shown = useMemo(() => (ports ?? []).filter((p) => {
    if (f) return String(p.port).includes(f) || p.process.toLowerCase().includes(f) || String(p.pid).includes(f);
    return all || (!SYSTEM_PROC.test(p.process) && p.port < 49152 && p.pid !== 4);
  }), [ports, f, all]);

  const kill = async (p: ListeningPort) => {
    setConfirm(null);
    try {
      await killPid(p.pid!);
      load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <input className="grow" placeholder="Filter by port, process or PID" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check small" title="Include system services and ephemeral ports"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All</label>
        <button className="icon-btn" title="Refresh" onClick={load}><i className={`codicon codicon-${busy ? "loading codicon-modifier-spin" : "refresh"}`} /></button>
      </div>
      {error && <div className="tb-error">{error}</div>}
      {!ports && !error && <div className="tb-hint"><i className="codicon codicon-loading codicon-modifier-spin" /> Reading listening ports…</div>}
      {ports && !shown.length && <div className="tb-hint">{all || f ? "No matching listeners." : "No dev servers listening. Tick “All” to see system services."}</div>}
      <div className="tb-scroll">
        {shown.map((p) => {
          const id = p.port * 1e7 + (p.pid ?? 0);
          return (
            <div key={id} className="tree-row tb-row tb-port" title={`Bound on ${p.addresses.join(", ")}`}>
              <span className="tb-portnum">:{p.port}</span>
              <span className="tb-name">{p.process || "unknown"}</span>
              <span className="tb-detail">{p.pid ? `PID ${p.pid}` : "other user"}</span>
              {confirm === id ? (
                <span className="tb-confirm">
                  Kill?
                  <button className="btn small danger" onClick={() => kill(p)}>Kill</button>
                  <button className="btn small" onClick={() => setConfirm(null)}>Cancel</button>
                </span>
              ) : (
                <span className="tb-actions">
                  {isLocalReachable(p) && (
                    <>
                      <button className="icon-btn small" title={`Open ${localUrl(p.port)} in the integrated browser`} onClick={() => openPortInBrowser(p.port)}><i className="codicon codicon-globe" /></button>
                      <button className="icon-btn small" title="Open in external browser" onClick={() => openPortInBrowser(p.port, true)}><i className="codicon codicon-link-external" /></button>
                      <button className="icon-btn small" title="Copy URL" onClick={() => copy(localUrl(p.port), "URL copied")}><i className="codicon codicon-copy" /></button>
                    </>
                  )}
                  {p.pid && p.pid > 4 && <button className="icon-btn small" title={`Stop ${p.process || "process"} (PID ${p.pid})`} onClick={() => setConfirm(id)}><i className="codicon codicon-debug-stop" /></button>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ TODO tree

function Todos() {
  const ws = useStore((s) => s.workspace);
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [error, setError] = useState("");
  const [tags, setTags] = useState<Set<TodoTag>>(new Set(TODO_TAGS));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const load = () => {
    if (!ws) return;
    setError("");
    scanTodos(ws).then(setItems, (e) => setError(errMsg(e)));
  };
  useEffect(load, [ws]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ws) return <NoWorkspace what="TODO comments" />;

  const shown = (items ?? []).filter((t) => tags.has(t.tag));
  const byFile = new Map<string, TodoItem[]>();
  for (const t of shown) byFile.set(t.path, [...(byFile.get(t.path) ?? []), t]);
  const counts = new Map<TodoTag, number>();
  for (const t of items ?? []) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);

  return (
    <div className="tb-section">
      <div className="tb-toolbar tb-chips">
        {TODO_TAGS.map((tag) => (
          <button
            key={tag}
            className={`tb-chip tag-${tag.toLowerCase()} ${tags.has(tag) ? "on" : ""}`}
            onClick={() => setTags((s) => { const n = new Set(s); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; })}
          >
            {tag} <span className="muted">{counts.get(tag) ?? 0}</span>
          </button>
        ))}
        <span className="spacer" />
        <button className="icon-btn" title="Rescan" onClick={load}><i className="codicon codicon-refresh" /></button>
      </div>
      {error && <div className="tb-error">{error}</div>}
      {!items && !error && <div className="tb-hint"><i className="codicon codicon-loading codicon-modifier-spin" /> Scanning comments…</div>}
      {items && !shown.length && <div className="tb-hint">No matching comments.</div>}
      <div className="tb-scroll">
        {[...byFile].map(([path, list]) => (
          <div key={path} className="tb-group">
            <div className="tree-row tb-file" onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; })} title={relative(ws, path)}>
              <i className={`codicon codicon-chevron-${collapsed.has(path) ? "right" : "down"}`} />
              <span className="tb-name">{basename(path)}</span>
              <span className="tb-detail">{relative(ws, path).split("/").slice(0, -1).join("/")}</span>
              <span className="tb-count">{list.length}</span>
            </div>
            {!collapsed.has(path) && list.map((t) => (
              <div key={t.line} className="tree-row tb-row tb-todo" onClick={() => openFile(t.path, t.line, t.col)} title={`${relative(ws, t.path)}:${t.line}`}>
                <span className={`tb-tag tag-${t.tag.toLowerCase()}`}>{t.tag}</span>
                <span className="tb-text">{t.text || <span className="muted">(no text)</span>}</span>
                <span className="tb-detail">{t.line}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
