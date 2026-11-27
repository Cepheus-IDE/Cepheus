import { useCallback, useEffect, useMemo, useState } from "react";
import { api, DirEntry, errMsg } from "../lib/api";
import { basename, dirname, fileIcon, join, relative, samePath } from "../lib/paths";
import { closeTab, openFile, pickFolder, openFolder } from "../lib/workspace";
import { get, set, toast, useStore } from "../store";
import ContextMenu, { MenuItem } from "./ContextMenu";
import FileIcon from "./FileIcon";
import { hidesArrows, iconThemeActive } from "../lib/iconTheme";
import { ensureSession, sendMessage } from "../lib/agent";
import { arrangeEntries } from "../lib/explorerOptions";
import { confirmDialog } from "./ConfirmDialog";

type Pending = { kind: "file" | "folder" | "rename"; dir: string; target?: string } | null;

export default function Explorer() {
  const ws = useStore((s) => s.workspace);
  const recent = useStore((s) => s.settings.recent);
  const filesExclude = useStore((s) => s.settings.filesExclude);
  const explorerSortOrder = useStore((s) => s.settings.explorerSortOrder);
  const treeVersion = useStore((s) => s.treeVersion);
  const git = useStore((s) => s.git);
  useStore((s) => s.iconThemeVersion);
  const activePath = useStore((s) => s.tabs.find((t) => t.id === s.activeId)?.path);
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async (dir: string) => {
    try {
      const list = await api.readDir(dir);
      setChildren((c) => ({ ...c, [dir]: list }));
    } catch {
      setChildren((c) => {
        const n = { ...c };
        delete n[dir];
        return n;
      });
    }
  }, []);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    if (ws) load(ws);
  }, [ws, load]);

  // Refresh loaded folders when the file system changes.
  useEffect(() => {
    if (!ws) return;
    load(ws);
    expanded.forEach((d) => load(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVersion]);

  const gitMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of git?.files ?? []) {
      const code = f.index === "?" ? "U" : f.worktree !== " " ? f.worktree : f.index;
      m.set(f.path.replace(/\\/g, "/").toLowerCase(), code);
      // mark parent folders as containing changes
      let d = dirname(f.path);
      for (let i = 0; i < 30 && ws && d.length > ws.length; i++) {
        const k = d.replace(/\\/g, "/").toLowerCase();
        if (!m.has(k)) m.set(k, "•");
        d = dirname(d);
      }
    }
    return m;
  }, [git, ws]);

  const toggle = (dir: string) => {
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(dir)) n.delete(dir);
      else {
        n.add(dir);
        load(dir);
      }
      return n;
    });
  };

  const commitPending = async (name: string) => {
    const p = pending;
    setPending(null);
    if (!p || !name.trim()) return;
    try {
      if (p.kind === "rename" && p.target) {
        const to = join(dirname(p.target), name.trim());
        await api.rename(p.target, to);
        const st = get();
        for (const t of st.tabs) if (samePath(t.path, p.target)) await closeTab(t.id, true);
      } else {
        const target = join(p.dir, name.trim());
        if (p.kind === "folder") await api.createDir(target);
        else {
          if (await api.exists(target)) throw new Error("File already exists");
          await api.writeFile(target, "");
          openFile(target);
        }
        setExpanded((e) => new Set(e).add(p.dir));
      }
      load(p.dir);
      if (p.target) load(dirname(p.target));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const del = async (entry: DirEntry) => {
    if (get().settings.confirmDelete !== false && !(await confirmDialog({ title: `Delete “${entry.name}”?`, message: entry.isDir ? "The folder and its contents will be moved to the trash." : "The file will be moved to the trash.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api.remove(entry.path);
      for (const t of get().tabs) if (t.path.toLowerCase().startsWith(entry.path.toLowerCase())) await closeTab(t.id, true);
      toast(`Moved ${entry.name} to Recycle Bin`);
      load(dirname(entry.path));
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  if (!ws) {
    return (
      <div className="panel">
        <div className="panel-header"><span>EXPLORER</span></div>
        <div className="empty-state">
          <p>No folder opened.</p>
          <button className="btn primary" onClick={pickFolder}>Open Folder</button>
          {recent.length > 0 && (
            <div className="recent">
              <div className="muted small">Recent</div>
              {recent.map((r) => (
                <button key={r} className="link" title={r} onClick={() => openFolder(r)}>{basename(r)}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const menuItems = (entry: DirEntry | null): MenuItem[] => {
    const dir = entry ? (entry.isDir ? entry.path : dirname(entry.path)) : ws;
    const items: MenuItem[] = [
      { label: "New File…", icon: "new-file", onClick: () => { setExpanded((e) => new Set(e).add(dir)); load(dir); setPending({ kind: "file", dir }); } },
      { label: "New Folder…", icon: "new-folder", onClick: () => { setExpanded((e) => new Set(e).add(dir)); load(dir); setPending({ kind: "folder", dir }); } },
    ];
    if (entry) {
      items.push(
        { label: "", onClick: () => {}, separator: true },
        { label: "Rename…", icon: "edit", onClick: () => setPending({ kind: "rename", dir: dirname(entry.path), target: entry.path }) },
        { label: "Copy Path", icon: "copy", onClick: () => navigator.clipboard.writeText(entry.path) },
        { label: "Copy Relative Path", icon: "copy", onClick: () => navigator.clipboard.writeText(relative(ws, entry.path)) },
        { label: "", onClick: () => {}, separator: true },
        {
          label: "Ask Agent to Explain",
          icon: "hubot",
          onClick: () => {
            const s = ensureSession();
            set({ agentOpen: true });
            sendMessage(s.id, `Explain what \`${relative(ws, entry.path)}\` does and how it fits into the project.`, null);
          },
        },
        { label: "", onClick: () => {}, separator: true },
        { label: "Delete", icon: "trash", danger: true, onClick: () => del(entry) }
      );
    }
    return items;
  };

  const renderInput = (depth: number, initial = "") => (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
      <i className={`codicon codicon-${pending?.kind === "folder" ? "folder" : "file"}`} />
      <input
        autoFocus
        className="tree-input"
        defaultValue={initial}
        onFocus={(e) => {
          const dot = initial.lastIndexOf(".");
          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitPending(e.currentTarget.value);
          if (e.key === "Escape") setPending(null);
        }}
        onBlur={(e) => commitPending(e.currentTarget.value)}
      />
    </div>
  );

  const renderDir = (dir: string, depth: number): JSX.Element[] => {
    const list = children[dir] && arrangeEntries([...children[dir]], ws, { filesExclude, explorerSortOrder }); // Settings › Files & Explorer
    if (!list) return [];
    const rows: JSX.Element[] = [];
    if (pending && pending.kind !== "rename" && samePath(pending.dir, dir)) rows.push(<div key="__pending">{renderInput(depth)}</div>);
    for (const e of list) {
      if (pending?.kind === "rename" && pending.target && samePath(pending.target, e.path)) {
        rows.push(<div key={e.path}>{renderInput(depth, e.name)}</div>);
        continue;
      }
      const open = expanded.has(e.path);
      const g = gitMap.get(e.path.replace(/\\/g, "/").toLowerCase());
      const isActive = activePath && samePath(activePath, e.path);
      rows.push(
        <div
          key={e.path}
          className={`tree-row ${isActive ? "active" : ""} ${selected === e.path ? "selected" : ""} ${g ? "git-" + (g === "•" ? "dot" : g) : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => {
            setSelected(e.path);
            e.isDir ? toggle(e.path) : openFile(e.path);
          }}
          onContextMenu={(ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setSelected(e.path);
            setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
          }}
          title={e.path}
        >
          {e.isDir && !(hidesArrows() && iconThemeActive()) && <i className={`codicon codicon-chevron-${open ? "down" : "right"}`} />}
          <FileIcon name={e.name} isDir={e.isDir} open={open} />
          <span className="name">{e.name}</span>
          {g && <span className="git-letter">{g === "•" ? "●" : g}</span>}
        </div>
      );
      if (e.isDir && open) rows.push(...renderDir(e.path, depth + 1));
    }
    return rows;
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span title={ws}>{basename(ws).toUpperCase()}</span>
        <div className="actions">
          <button title="New File" onClick={() => setPending({ kind: "file", dir: ws })}><i className="codicon codicon-new-file" /></button>
          <button title="New Folder" onClick={() => setPending({ kind: "folder", dir: ws })}><i className="codicon codicon-new-folder" /></button>
          <button title="Refresh" onClick={() => { load(ws); expanded.forEach((d) => load(d)); }}><i className="codicon codicon-refresh" /></button>
          <button title="Collapse All" onClick={() => setExpanded(new Set())}><i className="codicon codicon-collapse-all" /></button>
        </div>
      </div>
      <div
        className="tree"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {renderDir(ws, 0)}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />}
    </div>
  );
}
