import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { api, errMsg } from "../lib/api";
import { get, set, useStore } from "../store";
import { terminalTheme } from "../lib/themes";
import ProblemsPanel from "./ProblemsPanel";
import { DebugConsole } from "./DebugPanel";
import TestResults from "./TestResults";
import { detectProfiles, DONE_RE, RUN_EVENT, RunRequest, TermProfile, wrapForPowerShell } from "../lib/terminalBus";
import { findLinks, resolveAgainst } from "../lib/termLinks";
import { terminalShell } from "../lib/continuity";

/** One shell. `run` = a command typed once the shell is up, with an exit-code callback. */
interface Pane { key: number; profile?: TermProfile; run?: RunRequest }
/** A terminal tab; split terminals are several panes side by side. */
interface Group { id: number; title: string; panes: Pane[]; activePane: number }
let keySeq = 0;
let groupSeq = 0;

const IS_WINDOWS = navigator.userAgent.includes("Windows");
const POWERSHELL: TermProfile = { id: "powershell", label: "Windows PowerShell", shell: "powershell.exe" };

export default function TerminalPanel() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<TermProfile[]>([]);
  const [profileMenu, setProfileMenu] = useState(false);
  const panelOpen = useStore((s) => s.panelOpen);
  const ws = useStore((s) => s.workspace);
  const tab = useStore((s) => s.panelTab);
  const problems = useStore((s) => s.problems);
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => { detectProfiles().then(setProfiles); }, []);

  const add = (profile?: TermProfile, run?: RunRequest) => {
    const id = ++groupSeq;
    const key = ++keySeq;
    const title = run?.title ?? (profile ? profile.label : `terminal ${id}`);
    setGroups((g) => [...g, { id, title, panes: [{ key, profile, run }], activePane: key }]);
    setActive(id);
  };
  const split = () => {
    const gid = activeRef.current;
    if (gid === null) return add();
    const key = ++keySeq;
    setGroups((gs) => gs.map((g) => {
      if (g.id !== gid) return g;
      const profile = g.panes.find((p) => p.key === g.activePane)?.profile;
      return { ...g, panes: [...g.panes, { key, profile }], activePane: key };
    }));
  };
  const closeGroup = (id: number) => {
    setGroups((gs) => {
      const next = gs.filter((x) => x.id !== id);
      if (activeRef.current === id) setActive(next[next.length - 1]?.id ?? null);
      if (next.length === 0) set({ panelOpen: false });
      return next;
    });
  };
  /** Kill the focused pane; the tab goes away with its last pane. */
  const killActive = () => {
    const g = groups.find((x) => x.id === active);
    if (!g) return;
    if (g.panes.length <= 1) return closeGroup(g.id);
    setGroups((gs) => gs.map((x) => {
      if (x.id !== g.id) return x;
      const panes = x.panes.filter((p) => p.key !== x.activePane);
      return { ...x, panes, activePane: panes[panes.length - 1].key };
    }));
  };
  const rename = (id: number, title: string) => {
    if (title.trim()) setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, title: title.trim() } : g)));
    setRenaming(null);
  };

  // Title bar menu / command palette / other features.
  useEffect(() => {
    const onNew = () => add();
    const onSplit = () => { set({ panelOpen: true, panelTab: "terminal" }); split(); };
    const onRename = () => { set({ panelOpen: true, panelTab: "terminal" }); if (activeRef.current !== null) setRenaming(activeRef.current); };
    const onRun = (e: Event) => {
      const req = (e as CustomEvent<RunRequest>).detail;
      add(IS_WINDOWS ? POWERSHELL : undefined, req);
    };
    window.addEventListener("cepheus:new-terminal", onNew);
    window.addEventListener("cepheus:terminal-split", onSplit);
    window.addEventListener("cepheus:terminal-rename", onRename);
    window.addEventListener(RUN_EVENT, onRun);
    return () => {
      window.removeEventListener("cepheus:new-terminal", onNew);
      window.removeEventListener("cepheus:terminal-split", onSplit);
      window.removeEventListener("cepheus:terminal-rename", onRename);
      window.removeEventListener(RUN_EVENT, onRun);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open a terminal the first time the panel is shown.
  useEffect(() => {
    if (panelOpen && tab === "terminal" && groups.length === 0) add();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOpen, tab]);

  // New workspace → start fresh terminals in the new folder.
  useEffect(() => {
    setGroups([]);
    setActive(null);
    if (get().panelOpen) setTimeout(() => add(), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  const remote = !!ws?.startsWith("ssh://");

  return (
    <div className="terminal-panel">
      <div className="panel-tabs">
        <button className={`panel-tab ${tab === "problems" ? "active" : ""}`} onClick={() => set({ panelTab: "problems" })}>
          PROBLEMS {problems.length > 0 && <span className="panel-count">{problems.length}</span>}
        </button>
        <button className={`panel-tab ${tab === "debug" ? "active" : ""}`} onClick={() => set({ panelTab: "debug" })}>DEBUG CONSOLE</button>
        <button className={`panel-tab ${tab === "tests" ? "active" : ""}`} onClick={() => set({ panelTab: "tests" })}>TEST RESULTS</button>
        <button className={`panel-tab ${tab === "terminal" ? "active" : ""}`} onClick={() => set({ panelTab: "terminal" })}>TERMINAL</button>
        <div className="term-list" style={{ display: tab === "terminal" ? undefined : "none" }}>
          {groups.map((g) => (
            <button
              key={g.id}
              className={`term-tab ${g.id === active ? "on" : ""}`}
              onClick={() => setActive(g.id)}
              onDoubleClick={() => setRenaming(g.id)}
              title={`${g.title}${g.panes.length > 1 ? ` (${g.panes.length} split)` : ""} — double-click to rename`}
            >
              <i className={`codicon codicon-${g.panes.length > 1 ? "split-horizontal" : "terminal"}`} />{" "}
              {renaming === g.id ? (
                <input
                  className="term-rename"
                  autoFocus
                  defaultValue={g.title}
                  aria-label="Terminal name"
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => rename(g.id, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") rename(g.id, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                />
              ) : g.title}
              <span className="x" role="button" aria-label={`Kill ${g.title}`} onClick={(e) => { e.stopPropagation(); closeGroup(g.id); }}><i className="codicon codicon-close" /></span>
            </button>
          ))}
        </div>
        <div className="actions">
          {tab === "problems" && <span className="muted small problem-sum"><i className="codicon codicon-error" /> {errors} <i className="codicon codicon-warning" /> {warnings}</span>}
          {tab === "terminal" && <button className="icon-btn small" title="New Terminal" aria-label="New Terminal" onClick={() => add()}><i className="codicon codicon-add" /></button>}
          {tab === "terminal" && !remote && profiles.length > 0 && (
            <span className="term-profile-wrap">
              <button className="icon-btn small" title="Launch Profile…" aria-label="Launch Profile" aria-haspopup="menu" aria-expanded={profileMenu} onClick={() => setProfileMenu((v) => !v)}>
                <i className="codicon codicon-chevron-down" />
              </button>
              {profileMenu && (
                <div className="term-profile-menu" role="menu" onMouseLeave={() => setProfileMenu(false)}>
                  {profiles.map((p) => (
                    <button key={p.id} role="menuitem" onClick={() => { setProfileMenu(false); add(p); }}>
                      <i className="codicon codicon-terminal" /> {p.label}
                    </button>
                  ))}
                  <div className="sep" />
                  <button role="menuitem" onClick={() => { setProfileMenu(false); split(); }}><i className="codicon codicon-split-horizontal" /> Split Terminal</button>
                  <button role="menuitem" onClick={() => { setProfileMenu(false); if (active !== null) setRenaming(active); }}><i className="codicon codicon-edit" /> Rename Terminal</button>
                </div>
              )}
            </span>
          )}
          {tab === "terminal" && <button className="icon-btn small" title="Split Terminal (Ctrl+\)" aria-label="Split Terminal" onClick={split}><i className="codicon codicon-split-horizontal" /></button>}
          {tab === "terminal" && <button className="icon-btn small" title="Kill Terminal" aria-label="Kill Terminal" onClick={killActive}><i className="codicon codicon-trash" /></button>}
          <button className="icon-btn small" title="Close Panel" aria-label="Close Panel" onClick={() => set({ panelOpen: false })}><i className="codicon codicon-chevron-down" /></button>
        </div>
      </div>
      <div className="term-bodies" style={{ display: tab === "terminal" ? undefined : "none" }}>
        {groups.map((g) => (
          <div key={g.id} className="term-group" style={{ display: g.id === active ? "flex" : "none" }}>
            {g.panes.map((p) => (
              <div
                key={p.key}
                className={`term-pane ${g.panes.length > 1 && p.key === g.activePane ? "focused" : ""}`}
                onMouseDown={() => g.activePane !== p.key && setGroups((gs) => gs.map((x) => (x.id === g.id ? { ...x, activePane: p.key } : x)))}
              >
                <TermView
                  visible={g.id === active && panelOpen && tab === "terminal"}
                  focused={p.key === g.activePane}
                  cwd={ws}
                  shell={p.profile?.shell}
                  args={p.profile?.args}
                  run={p.run}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      {tab === "problems" && <ProblemsPanel />}
      {tab === "debug" && <DebugConsole />}
      {tab === "tests" && <TestResults />}
    </div>
  );
}

/** Ctrl+click file links: existence is checked (and cached briefly) before a link is shown. */
const existsCache = new Map<string, { at: number; ok: Promise<boolean> }>();
function exists(path: string) {
  const hit = existsCache.get(path);
  if (hit && Date.now() - hit.at < 10000) return hit.ok;
  const ok = api.exists(path).catch(() => false);
  existsCache.set(path, { at: Date.now(), ok });
  return ok;
}

function TermView({ visible, focused, cwd, shell, args, run }: { visible: boolean; focused: boolean; cwd: string | null; shell?: string; args?: string[]; run?: RunRequest }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: terminalTheme(),
      screenReaderMode: get().settings.accessibilitySupport === "on",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch { /* hidden */ }

    // File links in output (path, path:line, path:line:col, path(line,col), Python tracebacks).
    const linkSub = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const matches = findLinks(text);
        if (!matches.length) return callback(undefined);
        Promise.all(matches.map(async (m) => {
          const abs = resolveAgainst(m.path, cwd);
          return abs && (await exists(abs)) ? { m, abs } : null;
        })).then((found) => {
          const links = found.filter((f): f is NonNullable<typeof f> => !!f).map(({ m, abs }) => ({
            range: { start: { x: m.start + 1, y }, end: { x: m.end, y } },
            text: text.slice(m.start, m.end),
            decorations: { underline: true, pointerCursor: true },
            hover: () => { if (host.current) host.current.title = `${abs} — Ctrl+click to open`; },
            leave: () => { if (host.current) host.current.title = ""; },
            activate: (e: MouseEvent) => {
              if (!(e.ctrlKey || e.metaKey)) return;
              import("../lib/workspace").then((w) => w.openFile(abs, m.line, m.col));
            },
          }));
          callback(links.length ? links : undefined);
        });
      },
    });

    let disposed = false;
    const unlisteners: Promise<() => void>[] = [];
    // Allow Ctrl+C to copy when text is selected, and Ctrl+V to paste.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection());
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.key === "v") {
        navigator.clipboard.readText().then((t) => {
          if (idRef.current) api.termWrite(idRef.current, t);
        });
        return false;
      }
      return true;
    });

    // "Reopen in Container": docker exec -it … inside the dev container (not for host installs).
    const dc = run ? null : terminalShell();
    api
      .termSpawn(cwd, term.cols, term.rows, dc?.shell ?? shell ?? get().settings.shell, dc ? dc.args : args)
      .then((id) => {
        if (disposed) {
          api.termKill(id);
          return;
        }
        idRef.current = id;
        // For `run` panes: type the command once, then watch the output for the exit-code marker.
        let tail = "";
        let typed = false;
        let reported = false;
        const typeCommand = () => {
          if (typed || !run) return;
          typed = true;
          const line = IS_WINDOWS ? wrapForPowerShell(run.command) : `${run.command}; printf '__CEPHEUS_%s_%s__\\n' DONE $?\r`;
          api.termWrite(id, line);
        };
        unlisteners.push(listen<{ id: number; data: string }>("term-data", (e) => {
          if (e.payload.id !== id) return;
          term.write(e.payload.data);
          if (!run || reported) return;
          // Type after the shell printed something (its prompt), not into a half-started shell.
          if (!typed) setTimeout(typeCommand, 300);
          tail = (tail + e.payload.data).slice(-400);
          const m = tail.match(DONE_RE);
          if (m && typed) {
            reported = true;
            run.onExit?.(Number(m[1]));
          }
        }));
        unlisteners.push(listen<number>("term-exit", (e) => e.payload === id && term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n")));
        if (run) setTimeout(typeCommand, 2500);
        term.onData((d) => api.termWrite(id, d));
        term.onResize(({ cols, rows }) => api.termResize(id, cols, rows));
      })
      .catch((e) => term.write(`\x1b[31mFailed to start shell: ${errMsg(e)}\x1b[0m\r\n`));

    const onTheme = (e: Event) => { term.options.theme = (e as CustomEvent).detail; };
    window.addEventListener("cepheus-theme", onTheme);
    unlisteners.push(Promise.resolve(() => window.removeEventListener("cepheus-theme", onTheme)));

    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetParent !== null) {
        try { fit.fit(); } catch { /* ignore */ }
      }
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      linkSub.dispose();
      unlisteners.forEach((p) => p.then((f) => f()));
      if (idRef.current) api.termKill(idRef.current);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        try { fitRef.current?.fit(); } catch { /* ignore */ }
        if (focused) termRef.current?.focus();
      });
    }
  }, [visible, focused]);

  return <div className="term-host" ref={host} style={{ display: visible ? "block" : "none" }} />;
}
