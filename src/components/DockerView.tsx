// Docker view: engine status, containers (logs, shell, stats, inspect), Compose projects, images
// (run, pull, build), volumes and networks, and a cleanup card. Backend: src/lib/docker.ts.
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { get, toast, useStore } from "../store";
import { errMsg } from "../lib/api";
import { basename, dirname, relative } from "../lib/paths";
import { runInTerminal } from "../lib/terminalBus";
import { monaco } from "../lib/monaco";
import { copy } from "./GitWidgets";
import {
  bumpRefresh, ComposeFile, ComposeProject, composeProjects, composeQuick, composeStream, dk, dkAction, DockerStatus, DockerTab,
  findComposeFiles, findDockerfiles, getStatus, INSTALL_URL, inspect, LINUX_START, listContainers, listImages, listNetworks,
  listStats, listVolumes, openShell, platform, PODMAN_URL, runCompose, runInDockerTerminal, startEngine, Stream, streamDocker,
  systemDf, useDocker,
} from "../lib/docker";
import {
  Container, ContainerState, DfRow, formatBytes, Image, imageInUse, isBrowsable, isDaemonDown, Network, parseEnvSpecs, parsePortSpecs,
  PortMap, portLabel, Stats, Volume,
} from "../lib/dockerParse";

const TABS: { id: DockerTab; label: string; icon: string }[] = [
  { id: "containers", label: "Containers", icon: "server-environment" },
  { id: "compose", label: "Compose", icon: "layers" },
  { id: "images", label: "Images", icon: "file-binary" },
  { id: "volumes", label: "Volumes", icon: "database" },
  { id: "cleanup", label: "Cleanup", icon: "trash" },
];

// ------------------------------------------------------------------ hooks / small pieces

function usePageVisible() {
  const [v, setV] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const f = () => setV(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return v;
}

/** Loads data while `active`, re-polls every `interval` ms (0 = no polling); `refresh` is debounced and coalesced. */
function useResource<T>(loader: () => Promise<T>, active: boolean, interval: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const st = useRef({ inflight: false, again: false, timer: 0 as unknown as ReturnType<typeof setTimeout>, alive: true });
  const run = useCallback(async () => {
    const s = st.current;
    if (s.inflight) { s.again = true; return; }
    s.inflight = true;
    setBusy(true);
    try {
      const d = await loaderRef.current();
      if (s.alive) { setData(d); setError(""); }
    } catch (e) {
      if (s.alive) setError(errMsg(e));
    } finally {
      s.inflight = false;
      if (s.alive) setBusy(false);
      if (s.again) { s.again = false; if (s.alive) run(); }
    }
  }, []);
  const refresh = useCallback(() => {
    clearTimeout(st.current.timer);
    st.current.timer = setTimeout(run, 200);
  }, [run]);
  useEffect(() => {
    st.current.alive = true;
    return () => { st.current.alive = false; clearTimeout(st.current.timer); };
  }, []);
  useEffect(() => {
    if (!active) return;
    run();
    if (!interval) return;
    const t = setInterval(() => { if (!st.current.inflight) run(); }, interval);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, interval, ...deps]);
  return { data, error, busy, refresh };
}

function Spin({ on, icon = "refresh" }: { on: boolean; icon?: string }) {
  const still = useStore((s) => s.settings.reduceMotion ?? false);
  return <i className={`codicon codicon-${on ? `loading${still ? "" : " codicon-modifier-spin"}` : icon}`} aria-hidden="true" />;
}

function IconBtn({ icon, title, onClick, disabled, busy, className = "" }: { icon: string; title: string; onClick: () => void; disabled?: boolean; busy?: boolean; className?: string }) {
  return (
    <button className={`icon-btn small ${className}`} title={title} aria-label={title} disabled={disabled || busy} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {busy ? <Spin on /> : <i className={`codicon codicon-${icon}`} aria-hidden="true" />}
    </button>
  );
}

/** Inline confirmation strip with optional checkboxes. Escape cancels. */
function InlineConfirm({ message, confirmLabel, options = [], onConfirm, onCancel, danger = true }: {
  message: ReactNode; confirmLabel: string; danger?: boolean;
  options?: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }[];
  onConfirm: () => void; onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div className={`dk-confirm ${danger ? "danger" : ""}`} role="alertdialog" aria-label={confirmLabel} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <div className="dk-confirm-msg"><i className={`codicon codicon-${danger ? "warning" : "question"}`} aria-hidden="true" /> <div>{message}</div></div>
      {options.map((o) => (
        <label key={o.label} className="check small dk-check" title={o.hint}>
          <input type="checkbox" checked={o.checked} onChange={(e) => o.onChange(e.target.checked)} /> {o.label}
        </label>
      ))}
      <div className="dk-confirm-actions">
        <button className={`btn small ${danger ? "danger" : ""}`} onClick={onConfirm}>{confirmLabel}</button>
        <button ref={cancel} className="btn small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const listNames = (names: string[], max = 8) => names.length ? names.slice(0, max).join(", ") + (names.length > max ? ` and ${names.length - max} more` : "") : "nothing";

function StateDot({ state }: { state: ContainerState | "partial" | "none" }) {
  return <span className={`dk-dot st-${state}`} title={state} aria-label={state} />;
}

function rowKeys(toggle: () => void) {
  return (e: React.KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); toggle(); } };
}

async function openPort(p: PortMap) {
  try { await (await import("../lib/browser")).openBrowser(`http://localhost:${p.hostPort}`); } catch (e) { toast(errMsg(e), "error"); }
}

// ------------------------------------------------------------------ modals: logs + inspect

export type LogTarget =
  | { kind: "container"; id: string; title: string }
  | { kind: "compose"; project: ComposeProject; service?: string; title: string };

const MAX_LINES = 5000;

function LogPanel({ target, onClose }: { target: LogTarget; onClose: () => void }) {
  const [lines, setLines] = useState<{ t: string; err: boolean }[]>([]);
  const [follow, setFollow] = useState(true);
  const [timestamps, setTimestamps] = useState(false);
  const [filter, setFilter] = useState("");
  const [live, setLive] = useState(true);
  const [exit, setExit] = useState<number | null | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stream: Stream | null = null;
    let closed = false;
    setLines([]);
    setLive(true);
    setExit(undefined);
    const pending: { t: string; err: boolean }[] = [];
    let raf = 0;
    const flush = () => { raf = 0; const add = pending.splice(0); setLines((l) => { const n = l.concat(add); return n.length > MAX_LINES ? n.slice(-MAX_LINES) : n; }); };
    const onLines = (ls: string[], s: "stdout" | "stderr") => {
      if (closed) return;
      for (const t of ls) pending.push({ t, err: s === "stderr" });
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onExit = (c: number | null) => { if (!closed) { setLive(false); setExit(c); } };
    const ts = timestamps ? ["-t"] : [];
    const p = target.kind === "container"
      ? streamDocker(["logs", "-f", "--tail", "500", ...ts, target.id], onLines, onExit)
      : composeStream(target.project, ["logs", "-f", "--tail", "500", ...ts, ...(target.service ? [target.service] : [])], onLines, onExit);
    p.then((s) => { if (closed) s.kill(); else stream = s; });
    return () => { closed = true; stream?.kill(); if (raf) cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timestamps]);

  useEffect(() => { panel.current?.focus(); }, []);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow, filter]);

  const f = filter.trim().toLowerCase();
  const shown = f ? lines.filter((l) => l.t.toLowerCase().includes(f)) : lines;
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (follow !== atBottom) setFollow(atBottom);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div ref={panel} tabIndex={-1} className="modal dk-modal" role="dialog" aria-modal="true" aria-label={`Logs: ${target.title}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="modal-head">
          <h2>Logs · {target.title}</h2>
          <span className={`dk-live ${live ? "on" : ""}`}>{live ? "streaming" : exit === undefined ? "" : `stopped${exit ? ` (exit ${exit})` : ""}`}</span>
          <button className="icon-btn" title="Close (Esc)" aria-label="Close logs" onClick={onClose}><i className="codicon codicon-close" /></button>
        </div>
        <div className="tb-toolbar dk-log-toolbar">
          <input className="grow" placeholder="Filter lines" aria-label="Filter log lines" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>
          <label className="check small"><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps</label>
          <IconBtn icon="copy" title="Copy shown lines" onClick={() => copy(shown.map((l) => l.t).join("\n"), "Log copied")} />
          <IconBtn icon="clear-all" title="Clear" onClick={() => setLines([])} />
        </div>
        <div ref={box} className="dk-log" onScroll={onScroll} tabIndex={0} aria-live="off">
          {shown.length === 0 && <div className="tb-hint">{lines.length ? "No lines match the filter." : live ? "Waiting for output…" : "No output."}</div>}
          {shown.map((l, i) => <div key={i} className={`dk-log-line ${l.err ? "err" : ""}`}>{l.t || " "}</div>)}
        </div>
        <div className="dk-log-foot muted small">{lines.length} lines{lines.length >= MAX_LINES ? ` (last ${MAX_LINES} kept)` : ""}{f ? ` · ${shown.length} shown` : ""}</div>
      </div>
    </div>
  );
}

function InspectModal({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const model = monaco.editor.createModel(text, "json");
    const ed = monaco.editor.create(host.current!, {
      model, readOnly: true, automaticLayout: true, fontSize: get().settings.fontSize, minimap: { enabled: false },
      scrollBeyondLastLine: false, folding: true, wordWrap: "on", renderLineHighlight: "none",
    });
    ed.focus();
    const sub = ed.onKeyDown((e) => { if (e.keyCode === monaco.KeyCode.Escape) onClose(); });
    return () => { sub.dispose(); ed.dispose(); model.dispose(); };
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal dk-modal" role="dialog" aria-modal="true" aria-label={`Inspect ${title}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="modal-head">
          <h2>Inspect · {title}</h2>
          <span className="spacer" />
          <IconBtn icon="copy" title="Copy JSON" onClick={() => copy(text, "JSON copied")} />
          <button className="icon-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}><i className="codicon codicon-close" /></button>
        </div>
        <div ref={host} className="dk-inspect" />
      </div>
    </div>
  );
}

type Modal = { kind: "logs"; target: LogTarget } | { kind: "inspect"; title: string; text: string } | null;
let openModal: (m: Modal) => void = () => {};

async function showInspect(kind: "container" | "image" | "volume" | "network", id: string, title: string) {
  try { openModal({ kind: "inspect", title, text: await inspect(kind, id) }); } catch (e) { toast(errMsg(e), "error"); }
}

// ------------------------------------------------------------------ root

export default function DockerView() {
  const tab = useDocker((s) => s.tab);
  const tick = useDocker((s) => s.refreshTick);
  const ws = useStore((s) => s.workspace);
  const shown = useStore((s) => s.view === "editor" && s.sidebar === "docker");
  const pageVisible = usePageVisible();
  const visible = shown && pageVisible;
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const still = useStore((s) => s.settings.reduceMotion ?? false);
  openModal = setModal;

  const check = useCallback(async (force = false) => {
    try { setStatus(await getStatus(force)); } catch (e) { setStatus({ kind: "down", cli: { exe: "docker", engine: "docker" }, info: null, error: errMsg(e) }); }
  }, []);
  useEffect(() => { check(); }, [check]);
  const ok = status?.kind === "ok";
  // Re-check while the engine is down (it may be starting); every 3 s while we started it, 10 s otherwise.
  useEffect(() => {
    if (!visible || !status || ok) return;
    const t = setInterval(() => check(), starting ? 3000 : 10000);
    return () => clearInterval(t);
  }, [visible, status, ok, starting, check]);
  useEffect(() => { if (ok) setStarting(false); }, [ok]);
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setStarting(false), 180000);
    return () => clearTimeout(t);
  }, [starting]);

  const containers = useResource(listContainers, ok && visible, 5000);
  useEffect(() => { if (ok) containers.refresh(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // The engine stopped while the view was open: go back to the status screen.
  useEffect(() => { if (containers.error && isDaemonDown(containers.error)) check(); }, [containers.error, check]);

  const engine = status && status.kind !== "missing" ? status.cli.engine : "docker";
  const title = engine === "podman" ? "PODMAN" : "DOCKER";

  return (
    <div className={`panel tb-panel dk-panel${still ? " reduce-motion" : ""}`}>
      <div className="panel-header">
        <span>{title}</span>
        {status?.kind === "ok" && (
          <span className="dk-version" title={`Client ${status.info.client ?? "?"} · Server ${status.info.server ?? "?"}${status.info.serverOs ? ` (${status.info.serverOs})` : ""}${status.info.context ? ` · context ${status.info.context}` : ""}${status.info.apiVersion ? ` · API ${status.info.apiVersion}` : ""}`}>
            <StateDot state="running" /> {status.info.client ?? "?"} / {status.info.server ?? "?"}
          </span>
        )}
        <button className="icon-btn small" title="Refresh" aria-label="Refresh" onClick={() => { check(true); bumpRefresh(); }}>
          <Spin on={!status || containers.busy} />
        </button>
      </div>
      {!status && <div className="tb-hint"><Spin on /> Looking for Docker…</div>}
      {status && status.kind !== "ok" && <EngineState status={status} starting={starting} onStart={async () => {
        try { setStarting(true); await startEngine(status.kind === "down" ? status.cli : null); } catch (e) { setStarting(false); toast(errMsg(e), "error"); }
      }} onCheck={() => check(true)} />}
      {ok && (
        <>
          <div className="scm-tabs tb-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} title={t.label} onClick={() => useDocker.setState({ tab: t.id })}>
                <i className={`codicon codicon-${t.icon}`} aria-hidden="true" /> {t.label}
              </button>
            ))}
          </div>
          <div className="tb-body">
            {tab === "containers" && <Containers res={containers} visible={visible} />}
            {tab === "compose" && <Compose ws={ws} containers={containers.data ?? []} refreshContainers={containers.refresh} tick={tick} />}
            {tab === "images" && <Images ws={ws} containers={containers.data ?? []} visible={visible} tick={tick} />}
            {tab === "volumes" && <VolumesNetworks visible={visible} tick={tick} engine={engine} />}
            {tab === "cleanup" && <Cleanup containers={containers.data ?? []} refreshContainers={containers.refresh} tick={tick} engine={engine} />}
          </div>
        </>
      )}
      {modal?.kind === "logs" && createPortal(<LogPanel target={modal.target} onClose={() => setModal(null)} />, document.body)}
      {modal?.kind === "inspect" && createPortal(<InspectModal title={modal.title} text={modal.text} onClose={() => setModal(null)} />, document.body)}
    </div>
  );
}

function EngineState({ status, starting, onStart, onCheck }: { status: Exclude<DockerStatus, { kind: "ok" }>; starting: boolean; onStart: () => void; onCheck: () => void }) {
  const p = platform();
  if (status.kind === "missing") {
    return (
      <div className="empty-state dk-empty">
        <p><b>Docker isn't installed</b> (no <code>docker</code> or <code>podman</code> on PATH).</p>
        <p className="muted small">Install Docker Desktop (Windows, macOS, Linux) or Docker Engine (Linux), then check again. Podman works too when <code>docker</code> isn't present.</p>
        <div className="dk-btns">
          <button className="btn primary small" onClick={() => openUrl(INSTALL_URL).catch((e) => toast(errMsg(e), "error"))}><i className="codicon codicon-link-external" /> Get Docker</button>
          <button className="btn small" onClick={() => openUrl(PODMAN_URL).catch((e) => toast(errMsg(e), "error"))}>Install Podman</button>
          <button className="btn small" onClick={onCheck}>Check again</button>
        </div>
      </div>
    );
  }
  const podman = status.cli.engine === "podman";
  return (
    <div className="empty-state dk-empty">
      <p><b>{podman ? "Podman" : "Docker"} is installed but the engine isn't running.</b>{status.info?.client ? <span className="muted"> Client {status.info.client}.</span> : null}</p>
      {status.error && <pre className="dk-stderr">{status.error}</pre>}
      {starting ? (
        <p className="muted small"><Spin on /> Starting… this can take a minute. The view updates when the engine answers.</p>
      ) : podman ? (
        <div className="dk-btns"><button className="btn primary small" onClick={onStart}><i className="codicon codicon-play" /> Start Podman machine</button><button className="btn small" onClick={onCheck}>Check again</button></div>
      ) : p === "linux" ? (
        <>
          <p className="muted small">Start the Docker service (or Docker Desktop for Linux), then check again:</p>
          <code className="dk-cmd">{LINUX_START}</code>
          <div className="dk-btns">
            <button className="btn primary small" onClick={() => runInTerminal({ title: "start docker", command: LINUX_START, onExit: () => onCheck() })}><i className="codicon codicon-terminal" /> Run in terminal</button>
            <button className="btn small" onClick={() => copy(LINUX_START, "Command copied")}>Copy</button>
            <button className="btn small" onClick={onStart} title="systemctl --user start docker-desktop">Start Docker Desktop</button>
            <button className="btn small" onClick={onCheck}>Check again</button>
          </div>
        </>
      ) : (
        <div className="dk-btns">
          <button className="btn primary small" onClick={onStart}><i className="codicon codicon-play" /> Start Docker Desktop</button>
          <button className="btn small" onClick={onCheck}>Check again</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ containers

type Res<T> = ReturnType<typeof useResource<T>>;

function statsFor(c: Container, stats: Stats[] | null): Stats | undefined {
  return stats?.find((s) => (s.id && (c.id.startsWith(s.id) || s.id.startsWith(c.id))) || (s.name && s.name === c.name));
}

const STATE_ORDER: Record<string, number> = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5, removing: 6, unknown: 7 };

function Containers({ res, visible }: { res: Res<Container[]>; visible: boolean }) {
  const [filter, setFilter] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = res.data;
  const anyRunning = !!list?.some((c) => c.state === "running");
  const stats = useResource(listStats, visible && anyRunning, 3000);
  const f = filter.trim().toLowerCase();
  const shown = useMemo(() => (list ?? [])
    .filter((c) => (!runningOnly || c.state === "running") && (!f || c.name.toLowerCase().includes(f) || c.image.toLowerCase().includes(f) || c.id.startsWith(f) || (c.project ?? "").includes(f)))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name)), [list, f, runningOnly]);

  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <input className="grow" placeholder="Filter by name, image, ID or project" aria-label="Filter containers" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check small"><input type="checkbox" checked={runningOnly} onChange={(e) => setRunningOnly(e.target.checked)} /> Running</label>
      </div>
      {res.error && <pre className="tb-error">{res.error}</pre>}
      {!list && !res.error && <div className="tb-hint"><Spin on /> Listing containers…</div>}
      {list && !list.length && <div className="tb-hint">No containers yet. Run one from the Images tab, or <code>compose up</code> a project.</div>}
      {list && list.length > 0 && !shown.length && <div className="tb-hint">No matching containers.</div>}
      <div className="tb-scroll" role="list">
        {shown.map((c) => (
          <ContainerRow key={c.id} c={c} stats={statsFor(c, stats.data)} open={open === c.id} toggle={() => setOpen(open === c.id ? null : c.id)} refresh={res.refresh} />
        ))}
      </div>
    </div>
  );
}

function ContainerRow({ c, stats, open, toggle, refresh }: { c: Container; stats?: Stats; open: boolean; toggle: () => void; refresh: () => void }) {
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [rmVolumes, setRmVolumes] = useState(false);
  const act = async (key: string, label: string, args: string[]) => {
    setBusy(key);
    await dkAction(label, args);
    setBusy("");
    refresh();
  };
  const running = c.state === "running" || c.state === "restarting";
  const paused = c.state === "paused";
  const remove = async () => {
    setConfirm(false);
    await act("rm", `Removed ${c.name}`, ["rm", ...(running || paused ? ["-f"] : []), ...(rmVolumes ? ["-v"] : []), c.id]);
  };
  const links = c.ports.filter(isBrowsable);
  return (
    <div className={`dk-item ${open ? "open" : ""}`} role="listitem">
      <div className="tree-row tb-row dk-row" tabIndex={0} role="button" aria-expanded={open} onClick={toggle} onKeyDown={rowKeys(toggle)} title={`${c.name}\n${c.image}\n${c.status}`}>
        <i className={`codicon codicon-chevron-${open ? "down" : "right"} dk-chev`} aria-hidden="true" />
        <StateDot state={c.state} />
        <span className="tb-name">{c.name}</span>
        <span className="tb-detail">{c.image}</span>
        {!open && stats && running && <span className="dk-mini" title="CPU / memory">{stats.cpu?.toFixed(1) ?? "?"}% · {formatBytes(stats.memUsed)}</span>}
        <span className="tb-actions dk-actions">
          {running ? <IconBtn icon="debug-stop" title="Stop" busy={busy === "stop"} onClick={() => act("stop", `Stopped ${c.name}`, ["stop", c.id])} />
            : paused ? <IconBtn icon="debug-continue" title="Unpause" busy={busy === "pause"} onClick={() => act("pause", `Unpaused ${c.name}`, ["unpause", c.id])} />
            : <IconBtn icon="play" className="tb-run" title="Start" busy={busy === "start"} onClick={() => act("start", `Started ${c.name}`, ["start", c.id])} />}
          <IconBtn icon="debug-restart" title="Restart" busy={busy === "restart"} onClick={() => act("restart", `Restarted ${c.name}`, ["restart", c.id])} />
          <IconBtn icon="output" title="Logs" onClick={() => openModal({ kind: "logs", target: { kind: "container", id: c.id, title: c.name } })} />
          {running && <IconBtn icon="terminal" title="Open a shell in a terminal" onClick={() => openShell(c)} />}
        </span>
      </div>
      {open && (
        <div className="dk-detail">
          <div className="dk-kv"><span>Status</span><span>{c.status || c.state}</span></div>
          <div className="dk-kv"><span>Image</span><span className="mono">{c.image}</span></div>
          {c.created && <div className="dk-kv"><span>Created</span><span>{c.created}</span></div>}
          {c.project && <div className="dk-kv"><span>Compose</span><span>{c.project}{c.service ? ` › ${c.service}` : ""}</span></div>}
          {c.ports.length > 0 && (
            <div className="dk-kv"><span>Ports</span><span className="dk-ports">
              {c.ports.map((p, i) => isBrowsable(p)
                ? <button key={i} className="dk-port link" title={`Open http://localhost:${p.hostPort} in the integrated browser`} onClick={() => openPort(p)}>{portLabel(p)}</button>
                : <span key={i} className="dk-port">{portLabel(p)}</span>)}
            </span></div>
          )}
          {running && (
            <div className="dk-kv"><span>Usage</span><span className="mono">
              {stats ? `CPU ${stats.cpu?.toFixed(1) ?? "?"}% · Mem ${formatBytes(stats.memUsed)}${stats.memLimit ? ` / ${formatBytes(stats.memLimit)}` : ""} · Net ${formatBytes(stats.netRx)} ↓ ${formatBytes(stats.netTx)} ↑ · Block ${formatBytes(stats.blockRead)} r ${formatBytes(stats.blockWrite)} w` : "reading…"}
            </span></div>
          )}
          <div className="dk-kv"><span>ID</span><span className="mono">{c.id.slice(0, 12)}</span></div>
          <div className="dk-btns">
            {(running || paused) && <button className="btn small" disabled={!!busy} onClick={() => act("pause", paused ? `Unpaused ${c.name}` : `Paused ${c.name}`, [paused ? "unpause" : "pause", c.id])}>{paused ? "Unpause" : "Pause"}</button>}
            {running && <button className="btn small" onClick={() => openShell(c)}>Shell</button>}
            <button className="btn small" onClick={() => showInspect("container", c.id, c.name)}>Inspect</button>
            <button className="btn small" onClick={() => copy(c.id, "Container ID copied")}>Copy ID</button>
            {links.length > 0 && <button className="btn small" onClick={() => openPort(links[0])}>Open :{links[0].hostPort}</button>}
            <button className="btn small danger" disabled={!!busy} onClick={() => setConfirm(true)}>{busy === "rm" ? "Removing…" : "Remove"}</button>
          </div>
          {confirm && (
            <InlineConfirm
              message={<>Remove container <b>{c.name}</b>{running || paused ? " (it is running and will be killed)" : ""}? Its writable layer is deleted.</>}
              confirmLabel="Remove"
              options={[{ label: "Also remove its anonymous volumes (-v)", checked: rmVolumes, onChange: setRmVolumes }]}
              onConfirm={remove}
              onCancel={() => setConfirm(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ compose

function Compose({ ws, containers, refreshContainers, tick }: { ws: string | null; containers: Container[]; refreshContainers: () => void; tick: number }) {
  const files = useResource<ComposeFile[]>(() => (ws ? findComposeFiles(ws) : Promise.resolve([])), true, 0, [ws, tick]);
  const projects = useMemo(() => composeProjects(files.data ?? [], containers), [files.data, containers]);
  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <span className="tb-hint-inline grow">{ws?.startsWith("ssh://") ? "Remote workspace: only projects running on this computer are listed." : "Compose files in this folder and its first-level folders, plus running projects."}</span>
        <IconBtn icon="refresh" title="Rescan compose files" busy={files.busy} onClick={() => { files.refresh(); refreshContainers(); }} />
      </div>
      {files.error && <pre className="tb-error">{files.error}</pre>}
      {files.data && !projects.length && <div className="tb-hint">No compose.yaml / docker-compose.yml found{ws ? "" : " (open a folder)"} and no Compose projects running.</div>}
      <div className="tb-scroll">
        {projects.map((p) => <ProjectCard key={p.name} p={p} ws={ws} refresh={refreshContainers} />)}
      </div>
    </div>
  );
}

function ProjectCard({ p, ws, refresh }: { p: ComposeProject; ws: string | null; refresh: () => void }) {
  const [open, setOpen] = useState(true);
  const [build, setBuild] = useState(false);
  const [confirmDown, setConfirmDown] = useState(false);
  const [downVolumes, setDownVolumes] = useState(false);
  const running = p.containers.filter((c) => c.state === "running").length;
  const services = [...new Set([...(p.file?.services ?? []), ...p.containers.map((c) => c.service).filter((s): s is string => !!s)])];
  const hasFiles = p.configFiles.length > 0;
  const where = p.file ? relative(ws, p.file.path) : p.configFiles[0] ?? p.workingDir ?? "not in this workspace";
  const state = running === 0 ? "none" : running === p.containers.length ? "running" : "partial";
  const toggle = () => setOpen(!open);
  return (
    <div className="dk-card">
      <div className="tree-row dk-proj" tabIndex={0} role="button" aria-expanded={open} onClick={toggle} onKeyDown={rowKeys(toggle)} title={p.configFiles.join("\n") || p.name}>
        <i className={`codicon codicon-chevron-${open ? "down" : "right"} dk-chev`} aria-hidden="true" />
        <StateDot state={state as "running" | "partial" | "none"} />
        <span className="tb-name">{p.name}</span>
        <span className="tb-detail">{where}</span>
        <span className="dk-mini">{running}/{p.containers.length || services.length}</span>
      </div>
      {open && (
        <div className="dk-detail">
          <div className="dk-btns">
            <button className="btn small primary" disabled={!hasFiles} title={hasFiles ? `compose up -d${build ? " --build" : ""}` : "The compose file isn't known"} onClick={() => runCompose(p, ["up", "-d", ...(build ? ["--build"] : [])])}><i className="codicon codicon-play" /> Up</button>
            <label className="check small" title="Build images before starting (--build)"><input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} /> build</label>
            <button className="btn small" onClick={() => setConfirmDown(true)}>Down</button>
            <button className="btn small" onClick={() => runCompose(p, ["restart"])}>Restart</button>
            <button className="btn small" disabled={!hasFiles} onClick={() => runCompose(p, ["pull"])}>Pull</button>
            <button className="btn small" onClick={() => openModal({ kind: "logs", target: { kind: "compose", project: p, title: p.name } })}>Logs</button>
            <button className="btn small" onClick={() => runCompose(p, ["ps", "-a"])}>ps</button>
          </div>
          {confirmDown && (
            <InlineConfirm
              message={<>Stop and remove the containers and networks of <b>{p.name}</b> ({listNames(p.containers.map((c) => c.name))}).{downVolumes ? <> <b>Named volumes declared in the compose file and anonymous volumes are deleted, with their data.</b></> : " Volumes are kept."}</>}
              confirmLabel="Down"
              options={[{ label: "Also remove volumes (-v): deletes data", checked: downVolumes, onChange: setDownVolumes }]}
              onConfirm={() => { setConfirmDown(false); runCompose(p, ["down", ...(downVolumes ? ["-v"] : [])]); }}
              onCancel={() => setConfirmDown(false)}
            />
          )}
          {services.map((s) => <ServiceRow key={s} p={p} service={s} containers={p.containers.filter((c) => c.service === s)} refresh={refresh} />)}
          {!services.length && <div className="tb-hint">No services found.</div>}
        </div>
      )}
    </div>
  );
}

function ServiceRow({ p, service, containers, refresh }: { p: ComposeProject; service: string; containers: Container[]; refresh: () => void }) {
  const [busy, setBusy] = useState("");
  const running = containers.filter((c) => c.state === "running");
  const state: ContainerState | "none" = running.length ? "running" : containers[0]?.state ?? "none";
  const act = async (key: string, args: string[], label: string) => { setBusy(key); await composeQuick(p, args, label); setBusy(""); refresh(); };
  const ports = containers.flatMap((c) => c.ports.filter(isBrowsable));
  return (
    <div className="tree-row tb-row dk-svc" title={containers.map((c) => `${c.name}: ${c.status}`).join("\n") || "not created"}>
      <StateDot state={state} />
      <span className="tb-name">{service}</span>
      <span className="tb-detail">{containers.length ? containers[0].status : "not created"}</span>
      {ports.slice(0, 2).map((pt, i) => <button key={i} className="dk-port link" title={`Open http://localhost:${pt.hostPort}`} onClick={() => openPort(pt)}>:{pt.hostPort}</button>)}
      <span className="tb-actions dk-actions">
        {running.length
          ? <IconBtn icon="debug-stop" title={`Stop ${service}`} busy={busy === "stop"} onClick={() => act("stop", ["stop", service], `Stopped ${service}`)} />
          : <IconBtn icon="play" className="tb-run" title={containers.length ? `Start ${service}` : `Create and start ${service} (up -d)`} busy={busy === "start"} disabled={!containers.length && !p.configFiles.length} onClick={() => act("start", containers.length ? ["start", service] : ["up", "-d", service], `Started ${service}`)} />}
        <IconBtn icon="debug-restart" title={`Restart ${service}`} busy={busy === "restart"} disabled={!containers.length} onClick={() => act("restart", ["restart", service], `Restarted ${service}`)} />
        <IconBtn icon="output" title={`Logs of ${service}`} onClick={() => openModal({ kind: "logs", target: { kind: "compose", project: p, service, title: `${p.name} › ${service}` } })} />
        <IconBtn icon="terminal" title={`Shell in ${service}`} disabled={!running.length} onClick={() => running[0] && openShell(running[0])} />
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ images

function Images({ ws, containers, visible, tick }: { ws: string | null; containers: Container[]; visible: boolean; tick: number }) {
  const res = useResource(listImages, visible, 5000, [tick]);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<"" | "pull" | "build">("");
  const f = filter.trim().toLowerCase();
  const list = res.data;
  const shown = (list ?? []).filter((i) => !f || i.ref.toLowerCase().includes(f) || i.id.startsWith(f));
  return (
    <div className="tb-section">
      <div className="tb-toolbar">
        <input className="grow" placeholder="Filter images" aria-label="Filter images" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className={`btn small ${panel === "pull" ? "on" : ""}`} aria-pressed={panel === "pull"} onClick={() => setPanel(panel === "pull" ? "" : "pull")}><i className="codicon codicon-cloud-download" /> Pull</button>
        <button className={`btn small ${panel === "build" ? "on" : ""}`} aria-pressed={panel === "build"} onClick={() => setPanel(panel === "build" ? "" : "build")}><i className="codicon codicon-tools" /> Build</button>
      </div>
      {panel === "pull" && <PullForm onDone={res.refresh} />}
      {panel === "build" && <BuildForm ws={ws} onDone={res.refresh} />}
      {res.error && <pre className="tb-error">{res.error}</pre>}
      {!list && !res.error && <div className="tb-hint"><Spin on /> Listing images…</div>}
      {list && !list.length && <div className="tb-hint">No images. Pull one (e.g. <code>nginx:alpine</code>) or build the workspace Dockerfile.</div>}
      <div className="tb-scroll" role="list">
        {shown.map((img) => (
          <ImageRow key={img.id + img.ref} img={img} ws={ws} inUse={imageInUse(img, containers)} open={open === img.id + img.ref} toggle={() => setOpen(open === img.id + img.ref ? null : img.id + img.ref)} refresh={res.refresh} />
        ))}
      </div>
    </div>
  );
}

function ImageRow({ img, ws, inUse, open, toggle, refresh }: { img: Image; ws: string | null; inUse: boolean; open: boolean; toggle: () => void; refresh: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(false);
  const remove = async () => {
    setConfirm(false);
    setBusy(true);
    await dkAction(`Removed ${img.ref}`, ["rmi", ...(force ? ["-f"] : []), img.dangling ? img.id : img.ref]);
    setBusy(false);
    refresh();
  };
  return (
    <div className={`dk-item ${open ? "open" : ""}`} role="listitem">
      <div className="tree-row tb-row dk-row" tabIndex={0} role="button" aria-expanded={open} onClick={toggle} onKeyDown={rowKeys(toggle)} title={`${img.ref}\n${img.id}`}>
        <i className={`codicon codicon-chevron-${open ? "down" : "right"} dk-chev`} aria-hidden="true" />
        <span className={`tb-name ${img.dangling ? "muted" : ""}`}>{img.dangling ? "<none>" : img.ref}</span>
        {inUse && <span className="dk-badge" title="Used by at least one container">in use</span>}
        <span className="tb-detail">{img.created}</span>
        <span className="tb-size">{img.sizeText}</span>
        <span className="tb-actions dk-actions">
          <IconBtn icon="play" className="tb-run" title="Run…" onClick={() => { if (!open) toggle(); setRun(true); }} />
          <IconBtn icon="trash" title="Remove…" busy={busy} onClick={() => { if (!open) toggle(); setConfirm(true); }} />
        </span>
      </div>
      {open && (
        <div className="dk-detail">
          <div className="dk-kv"><span>ID</span><span className="mono">{img.id.slice(0, 12)}</span></div>
          <div className="dk-kv"><span>Size</span><span>{img.sizeText}</span></div>
          <div className="dk-btns">
            <button className="btn small" onClick={() => setRun(!run)}>Run…</button>
            <button className="btn small" onClick={() => showInspect("image", img.id, img.ref)}>Inspect</button>
            <button className="btn small" onClick={() => copy(img.id, "Image ID copied")}>Copy ID</button>
            <button className="btn small danger" disabled={busy} onClick={() => setConfirm(true)}>Remove</button>
          </div>
          {confirm && (
            <InlineConfirm
              message={<>Remove image <b>{img.ref}</b> ({img.sizeText})?{inUse ? " It is used by a container: removal fails unless forced." : ""}</>}
              confirmLabel="Remove"
              options={[{ label: "Force (-f): also untag when used by stopped containers", checked: force, onChange: setForce }]}
              onConfirm={remove}
              onCancel={() => setConfirm(false)}
            />
          )}
          {run && <RunForm img={img} ws={ws} onDone={() => { setRun(false); bumpRefresh(); }} />}
        </div>
      )}
    </div>
  );
}

function RunForm({ img, ws, onDone }: { img: Image; ws: string | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [ports, setPorts] = useState("");
  const [env, setEnv] = useState("");
  const [mount, setMount] = useState(false);
  const [target, setTarget] = useState("/workspace");
  const [detached, setDetached] = useState(true);
  const [rm, setRm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const p = parsePortSpecs(ports);
  const e = parseEnvSpecs(env);
  const local = !!ws && !ws.startsWith("ssh://");
  const args = [
    "run", ...(detached ? ["-d"] : ["-it"]), ...(rm ? ["--rm"] : []), ...(name.trim() ? ["--name", name.trim()] : []),
    ...p.ok.flatMap((x) => ["-p", x]), ...e.ok.flatMap((x) => ["-e", x]),
    ...(mount && local && target.trim() ? ["-v", `${ws}:${target.trim()}`, "-w", target.trim()] : []),
    img.dangling ? img.id : img.ref,
  ];
  const submit = async () => {
    if (p.bad.length) return setError(`Invalid port mapping: ${p.bad.join(", ")} (use host:container, e.g. 8080:80)`);
    if (e.bad.length) return setError(`Invalid environment line: ${e.bad.join(", ")} (use KEY=value)`);
    if (name.trim() && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name.trim())) return setError("Container names may contain letters, digits, _ . and -");
    setError("");
    if (!detached) { runInDockerTerminal(`run ${img.ref}`, args); onDone(); return; }
    setBusy(true);
    try {
      const id = (await dk(args)).trim();
      toast(`Started ${name.trim() || id.slice(0, 12)}`);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="dk-form" onSubmit={(ev) => { ev.preventDefault(); submit(); }}>
      <label>Name <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="optional" /></label>
      <label>Ports <input value={ports} onChange={(ev) => setPorts(ev.target.value)} placeholder="8080:80, 5432:5432" /></label>
      <label>Environment <textarea rows={2} value={env} onChange={(ev) => setEnv(ev.target.value)} placeholder={"KEY=value\nOTHER=value"} /></label>
      <label className="check small" title={local ? ws ?? "" : "Needs a local workspace"}><input type="checkbox" disabled={!local} checked={mount} onChange={(ev) => setMount(ev.target.checked)} /> Mount the workspace at</label>
      {mount && <input aria-label="Container path for the workspace" value={target} onChange={(ev) => setTarget(ev.target.value)} />}
      <div className="dk-btns">
        <label className="check small"><input type="checkbox" checked={detached} onChange={(ev) => setDetached(ev.target.checked)} /> Detached</label>
        <label className="check small"><input type="checkbox" checked={rm} onChange={(ev) => setRm(ev.target.checked)} /> Remove when it exits</label>
      </div>
      <code className="dk-cmd">run {args.slice(1).join(" ")}</code>
      {error && <pre className="tb-error">{error}</pre>}
      <div className="dk-btns">
        <button type="submit" className="btn small primary" disabled={busy}>{busy ? "Starting…" : detached ? "Run" : "Run in terminal"}</button>
        <button type="button" className="btn small" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function PullForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  const stream = useRef<Stream | null>(null);
  useEffect(() => () => stream.current?.kill(), []);
  const pull = async () => {
    const n = name.trim();
    if (!n) return;
    if (!/^[\w./:@-]+$/.test(n)) { setLines([`Not a valid image name: ${n}`]); setFailed(true); return; }
    setLines([]);
    setFailed(false);
    setRunning(true);
    stream.current = await streamDocker(["pull", n], (ls) => setLines((l) => l.concat(ls).slice(-200)), (code) => {
      setRunning(false);
      stream.current = null;
      if (code === 0) { toast(`Pulled ${n}`); onDone(); } else setFailed(true);
    });
  };
  return (
    <form className="dk-form" onSubmit={(e) => { e.preventDefault(); pull(); }}>
      <div className="dk-btns">
        <input className="grow" aria-label="Image to pull" placeholder="image[:tag], e.g. postgres:16-alpine" value={name} onChange={(e) => setName(e.target.value)} disabled={running} />
        {running
          ? <button type="button" className="btn small" onClick={() => stream.current?.kill()}>Cancel</button>
          : <button type="submit" className="btn small primary" disabled={!name.trim()}>Pull</button>}
      </div>
      {lines.length > 0 && <pre className={`dk-progress ${failed ? "fail" : ""}`}>{lines.slice(-12).join("\n")}</pre>}
    </form>
  );
}

function BuildForm({ ws, onDone }: { ws: string | null; onDone: () => void }) {
  const files = useResource(() => (ws ? findDockerfiles(ws) : Promise.resolve([])), true, 0, [ws]);
  const [file, setFile] = useState("");
  const [tag, setTag] = useState("");
  const [context, setContext] = useState("");
  const list = files.data ?? [];
  const chosen = file || list[0] || "";
  useEffect(() => {
    if (!chosen) return;
    setContext(dirname(chosen));
    if (!tag) setTag(`${(ws ? basename(ws) : "app").toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}:latest`);
  }, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ws) return <div className="tb-hint">Open a folder to build its Dockerfile.</div>;
  if (files.data && !list.length) return <div className="tb-hint">No Dockerfile or Containerfile in this folder or its first-level folders.</div>;
  const tagOk = /^[a-z0-9][a-z0-9_.\-/]*(:[\w][\w.-]{0,127})?$/.test(tag.trim());
  const build = () => {
    if (!tagOk) return toast("Tags are lowercase: name[:tag], e.g. myapp:dev", "error");
    runInDockerTerminal(`build ${tag.trim()}`, ["build", "-f", chosen, "-t", tag.trim(), context || dirname(chosen)], (code) => { if (code === 0) onDone(); });
  };
  return (
    <form className="dk-form" onSubmit={(e) => { e.preventDefault(); build(); }}>
      <label>Dockerfile
        <select value={chosen} onChange={(e) => setFile(e.target.value)}>
          {list.map((f) => <option key={f} value={f}>{relative(ws, f)}</option>)}
        </select>
      </label>
      <label>Tag <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="myapp:dev" aria-invalid={!tagOk} /></label>
      <label>Context <input value={context} onChange={(e) => setContext(e.target.value)} /></label>
      <div className="dk-btns"><button type="submit" className="btn small primary" disabled={!chosen || !tagOk}>Build in terminal</button></div>
    </form>
  );
}

// ------------------------------------------------------------------ volumes + networks

const BUILTIN_NETS = new Set(["bridge", "host", "none", "podman"]);

function VolumesNetworks({ visible, tick, engine }: { visible: boolean; tick: number; engine: "docker" | "podman" }) {
  // Sizes need `system df -v` (slow): read them on open / manual refresh, poll the plain lists.
  const [sizesTick, setSizesTick] = useState(0);
  const sized = useResource(() => listVolumes(true), visible, 0, [tick, sizesTick]);
  const vols = useResource(() => listVolumes(false), visible, 5000);
  const nets = useResource(listNetworks, visible, 5000, [tick]);
  const [confirm, setConfirm] = useState<"" | "vols" | "nets">("");
  const [allVols, setAllVols] = useState(false);
  const [busy, setBusy] = useState("");
  const sizes = new Map((sized.data ?? []).map((v) => [v.name, v]));
  const volumes: Volume[] = (vols.data ?? sized.data ?? []).map((v) => ({ ...v, size: v.size ?? sizes.get(v.name)?.size ?? null, links: v.links ?? sizes.get(v.name)?.links ?? null }));
  const unusedVols = volumes.filter((v) => v.links === 0);
  const refresh = () => { setSizesTick((t) => t + 1); vols.refresh(); nets.refresh(); };
  const prune = async (what: "vols" | "nets") => {
    setConfirm("");
    setBusy(what);
    const ok = what === "vols"
      ? await dkAction("Removed unused volumes", ["volume", "prune", "-f", ...(allVols && engine === "docker" ? ["-a"] : [])])
      : await dkAction("Removed unused networks", ["network", "prune", "-f"]);
    setBusy("");
    if (ok) refresh();
  };
  return (
    <div className="tb-section">
      <div className="tb-scroll">
        <div className="tb-group-title"><i className="codicon codicon-database" /> Volumes <span className="spacer" />
          <IconBtn icon="refresh" title="Refresh (with sizes)" busy={sized.busy} onClick={refresh} />
          <button className="btn small" disabled={!!busy} onClick={() => setConfirm("vols")}>{busy === "vols" ? "Removing…" : "Remove unused"}</button>
        </div>
        {confirm === "vols" && (
          <InlineConfirm
            message={<><b>Deletes data.</b> Removes {engine === "docker" && !allVols ? "unused anonymous volumes (Docker 23+; older versions remove all unused volumes)" : "every volume not used by a container"}{unusedVols.length ? `, e.g. ${listNames(unusedVols.map((v) => v.name), 5)}` : ""}. Files stored in them cannot be recovered.</>}
            confirmLabel="Delete volumes"
            options={engine === "docker" ? [{ label: "Include named volumes (-a)", checked: allVols, onChange: setAllVols }] : []}
            onConfirm={() => prune("vols")}
            onCancel={() => setConfirm("")}
          />
        )}
        {(vols.error || sized.error) && <pre className="tb-error">{vols.error || sized.error}</pre>}
        {!vols.data && !sized.data && !vols.error && <div className="tb-hint"><Spin on /> Listing volumes…</div>}
        {(vols.data ?? sized.data) && !volumes.length && <div className="tb-hint">No volumes.</div>}
        {volumes.map((v) => <VolumeRow key={v.name} v={v} refresh={refresh} />)}

        <div className="tb-group-title"><i className="codicon codicon-type-hierarchy" /> Networks <span className="spacer" />
          <button className="btn small" disabled={!!busy} onClick={() => setConfirm("nets")}>{busy === "nets" ? "Removing…" : "Remove unused"}</button>
        </div>
        {confirm === "nets" && (
          <InlineConfirm
            message={<>Removes every custom network not used by at least one container. The built-in bridge, host and none networks stay.</>}
            confirmLabel="Remove networks"
            onConfirm={() => prune("nets")}
            onCancel={() => setConfirm("")}
          />
        )}
        {nets.error && <pre className="tb-error">{nets.error}</pre>}
        {(nets.data ?? []).map((n) => <NetworkRow key={n.id || n.name} n={n} refresh={nets.refresh} />)}
      </div>
    </div>
  );
}

function VolumeRow({ v, refresh }: { v: Volume; refresh: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="tree-row tb-row dk-row" title={`${v.name}\n${v.mountpoint}`}>
        <span className="tb-name mono">{v.name.length > 28 ? v.name.slice(0, 12) + "…" + v.name.slice(-8) : v.name}</span>
        <span className="tb-detail">{v.driver}{v.links !== null ? ` · ${v.links ? `${v.links} container${v.links > 1 ? "s" : ""}` : "unused"}` : ""}</span>
        <span className="tb-size">{v.size !== null ? formatBytes(v.size) : ""}</span>
        <span className="tb-actions dk-actions">
          <IconBtn icon="json" title="Inspect" onClick={() => showInspect("volume", v.name, v.name)} />
          <IconBtn icon="copy" title="Copy name" onClick={() => copy(v.name, "Volume name copied")} />
          <IconBtn icon="trash" title="Remove…" busy={busy} onClick={() => setConfirm(true)} />
        </span>
      </div>
      {confirm && (
        <InlineConfirm
          message={<><b>Deletes data.</b> Remove volume <b>{v.name}</b>{v.size !== null ? ` (${formatBytes(v.size)})` : ""}? Fails while a container uses it.</>}
          confirmLabel="Delete volume"
          onConfirm={async () => { setConfirm(false); setBusy(true); await dkAction(`Removed volume ${v.name}`, ["volume", "rm", v.name]); setBusy(false); refresh(); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

function NetworkRow({ n, refresh }: { n: Network; refresh: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const builtin = BUILTIN_NETS.has(n.name);
  return (
    <>
      <div className="tree-row tb-row dk-row" title={`${n.name}\n${n.id}`}>
        <span className="tb-name">{n.name}</span>
        <span className="tb-detail">{n.driver} · {n.scope}</span>
        <span className="tb-actions dk-actions">
          <IconBtn icon="json" title="Inspect" onClick={() => showInspect("network", n.id || n.name, n.name)} />
          {!builtin && <IconBtn icon="trash" title="Remove…" onClick={() => setConfirm(true)} />}
        </span>
      </div>
      {confirm && (
        <InlineConfirm
          message={<>Remove network <b>{n.name}</b>? Fails while containers are connected to it.</>}
          confirmLabel="Remove"
          onConfirm={async () => { setConfirm(false); await dkAction(`Removed network ${n.name}`, ["network", "rm", n.id || n.name]); refresh(); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ cleanup

type PruneKind = "containers" | "dangling" | "images" | "cache" | "volumes";

function Cleanup({ containers, refreshContainers, tick, engine }: { containers: Container[]; refreshContainers: () => void; tick: number; engine: "docker" | "podman" }) {
  const df = useResource<DfRow[]>(systemDf, true, 30000, [tick]);
  const imgs = useResource(listImages, true, 0, [tick]);
  const vols = useResource(() => listVolumes(false), true, 0, [tick]);
  const [confirm, setConfirm] = useState<PruneKind | "">("");
  const [allVols, setAllVols] = useState(false);
  const [busy, setBusy] = useState<PruneKind | "">("");
  const [last, setLast] = useState("");

  const rows = df.data ?? [];
  const row = (re: RegExp) => rows.find((r) => re.test(r.type));
  const totalSize = rows.reduce((a, r) => a + (r.size ?? 0), 0);
  const totalRecl = rows.reduce((a, r) => a + (r.reclaimable ?? 0), 0);
  const stopped = containers.filter((c) => c.state !== "running" && c.state !== "paused" && c.state !== "restarting");
  const images = imgs.data ?? [];
  const dangling = images.filter((i) => i.dangling && !imageInUse(i, containers));
  const unusedImages = images.filter((i) => !imageInUse(i, containers));
  const unusedVols = (vols.data ?? []).filter((v) => v.links === 0);

  const PRUNES: { id: PruneKind; label: string; args: string[]; what: ReactNode; size?: string; danger?: boolean; disabled?: string }[] = [
    { id: "containers", label: "Stopped containers", args: ["container", "prune", "-f"], size: row(/^containers/i)?.reclaimableText,
      what: <>Deletes {stopped.length} stopped container{stopped.length === 1 ? "" : "s"}: {listNames(stopped.map((c) => c.name))}.</> },
    { id: "dangling", label: "Dangling images", args: ["image", "prune", "-f"],
      what: <>Deletes {dangling.length} untagged <code>&lt;none&gt;</code> image{dangling.length === 1 ? "" : "s"} not used by any container (old build layers).</> },
    { id: "images", label: "All unused images", args: ["image", "prune", "-a", "-f"], size: row(/^images/i)?.reclaimableText,
      what: <>Deletes every image not used by a container ({unusedImages.length}): {listNames(unusedImages.map((i) => i.ref))}. They are downloaded or rebuilt again when needed.</> },
    { id: "cache", label: "Build cache", args: ["builder", "prune", "-a", "-f"], size: row(/build/i)?.reclaimableText,
      what: <>Deletes all build cache{row(/build/i)?.sizeText ? ` (${row(/build/i)?.sizeText})` : ""}. The next builds start from scratch and are slower.</>,
      disabled: engine === "podman" ? "Podman has no builder cache command; use `buildah prune`." : undefined },
    { id: "volumes", label: "Unused volumes", args: ["volume", "prune", "-f", ...(allVols && engine === "docker" ? ["-a"] : [])], size: row(/volume/i)?.reclaimableText, danger: true,
      what: <><b>Deletes data.</b> Removes {engine === "docker" && !allVols ? "unused anonymous volumes" : "every volume not used by a container"}{unusedVols.length ? ` (unused now: ${listNames(unusedVols.map((v) => v.name), 5)})` : ""}. Databases and files stored in them are lost for good.</> },
  ];

  const prune = async (p: (typeof PRUNES)[number]) => {
    setConfirm("");
    setBusy(p.id);
    try {
      const out = await dk(p.args);
      const m = out.match(/Total reclaimed space:\s*(.+)/i);
      setLast(`${p.label}: ${m ? `reclaimed ${m[1].trim()}` : "done"}`);
      toast(`${p.label} removed${m ? ` (${m[1].trim()})` : ""}`);
    } catch (e) {
      toast(errMsg(e), "error");
    }
    setBusy("");
    df.refresh(); imgs.refresh(); vols.refresh(); refreshContainers();
  };

  return (
    <div className="tb-section">
      <div className="tb-scroll">
        <div className="dk-card dk-df">
          <div className="dk-df-head">
            <b>Free space</b>
            <span className="muted small">{rows.length ? `${formatBytes(totalSize)} used · ${formatBytes(totalRecl)} reclaimable` : ""}</span>
            <IconBtn icon="refresh" title="Refresh" busy={df.busy} onClick={df.refresh} />
          </div>
          {df.error && <pre className="tb-error">{df.error}</pre>}
          {!df.data && !df.error && <div className="tb-hint"><Spin on /> Reading disk usage…</div>}
          {rows.length > 0 && (
            <table className="dk-table">
              <thead><tr><th>Type</th><th>Total</th><th>Active</th><th>Size</th><th>Reclaimable</th></tr></thead>
              <tbody>
                {rows.map((r) => <tr key={r.type}><td>{r.type}</td><td>{r.total ?? "—"}</td><td>{r.active ?? "—"}</td><td>{r.sizeText || formatBytes(r.size)}</td><td>{r.reclaimableText || formatBytes(r.reclaimable)}</td></tr>)}
              </tbody>
            </table>
          )}
          {last && <div className="tb-ok">{last}</div>}
        </div>
        {PRUNES.map((p) => (
          <div key={p.id} className="dk-prune">
            <div className="tree-row tb-row">
              <span className="tb-name">{p.label}</span>
              <span className="tb-detail">{p.size ? `${p.size} reclaimable` : ""}</span>
              <button className={`btn small ${p.danger ? "danger" : ""}`} disabled={!!busy || !!p.disabled} title={p.disabled ?? `${engine} ${p.args.join(" ")}`} onClick={() => setConfirm(p.id)}>
                {busy === p.id ? "Removing…" : "Prune…"}
              </button>
            </div>
            {p.disabled && <div className="tb-note dk-note">{p.disabled}</div>}
            {confirm === p.id && (
              <InlineConfirm
                message={<>{p.what} <span className="muted">(<code>{engine} {p.args.join(" ")}</code>)</span></>}
                confirmLabel={p.danger ? "Delete data" : "Prune"}
                options={p.id === "volumes" && engine === "docker" ? [{ label: "Include named volumes (-a)", checked: allVols, onChange: setAllVols }] : []}
                onConfirm={() => prune(p)}
                onCancel={() => setConfirm("")}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
