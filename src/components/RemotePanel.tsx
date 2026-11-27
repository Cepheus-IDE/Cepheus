import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, DirEntry, errMsg } from "../lib/api";
import { SshHost } from "../lib/settings";
import { openFolder, saveSettings } from "../lib/workspace";
import { get, set, toast, useStore } from "../store";

const blank = (): SshHost => ({
  id: "h" + Date.now().toString(36),
  label: "",
  host: "",
  port: 22,
  user: "",
  auth: "auto",
  keyPath: "",
  lastFolder: "",
});

type Prompt =
  | { kind: "password"; host: SshHost }
  | { kind: "passphrase"; host: SshHost; message: string }
  | { kind: "hostkey"; host: SshHost; fingerprint: string; changed: boolean; secret?: { password?: string; passphrase?: string } }
  | null;

export async function connectHost(h: SshHost, secret: { password?: string; passphrase?: string } = {}, trustFingerprint?: string) {
  const res = await api.sshConnect({
    connId: h.id, label: h.label || h.host, host: h.host, port: h.port, user: h.user, auth: h.auth,
    keyPath: h.keyPath || undefined, password: secret.password, passphrase: secret.passphrase, trustFingerprint,
  });
  set((s) => ({ ssh: { ...s.ssh, [h.id]: { label: h.label || h.host, home: res.home } } }));
  return res;
}

export default function RemotePanel() {
  const hosts = useStore((s) => s.settings.sshHosts);
  const live = useStore((s) => s.ssh);
  const [edit, setEdit] = useState<SshHost | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState("");
  const [browse, setBrowse] = useState<{ host: SshHost; path: string } | null>(null);

  useEffect(() => {
    api.sshList().then((l) => set({ ssh: Object.fromEntries(l.map((c) => [c.connId, { label: c.label, home: c.home }])) })).catch(() => {});
  }, []);

  const saveHost = async (h: SshHost) => {
    const s = get().settings;
    const list = s.sshHosts.some((x) => x.id === h.id) ? s.sshHosts.map((x) => (x.id === h.id ? h : x)) : [...s.sshHosts, h];
    await saveSettings({ ...s, sshHosts: list });
  };

  const attempt = async (h: SshHost, sec: { password?: string; passphrase?: string } = {}, trust?: string) => {
    setBusy(h.id);
    try {
      const res = await connectHost(h, sec, trust);
      setPrompt(null);
      setSecret("");
      toast(`Connected to ${h.label || h.host}`);
      setBrowse({ host: h, path: h.lastFolder || res.home });
    } catch (e) {
      const m = errMsg(e);
      if (m === "PASSWORD_REQUIRED") setPrompt({ kind: "password", host: h });
      else if (m.startsWith("KEY_PASSPHRASE")) setPrompt({ kind: "passphrase", host: h, message: m.replace(/^KEY_PASSPHRASE:\s*/, "") });
      else if (m.startsWith("HOSTKEY_UNKNOWN:")) setPrompt({ kind: "hostkey", host: h, fingerprint: m.slice(16), changed: false, secret: sec });
      else if (m.startsWith("HOSTKEY_CHANGED:")) setPrompt({ kind: "hostkey", host: h, fingerprint: m.slice(16), changed: true, secret: sec });
      else toast(m, "error");
    } finally {
      setBusy("");
    }
  };

  const importConfig = async () => {
    const found = await api.sshConfigHosts();
    if (!found.length) return toast("No hosts found in ~/.ssh/config");
    const s = get().settings;
    const existing = new Set(s.sshHosts.map((h) => `${h.user}@${h.host}:${h.port}`));
    const add = found
      .filter((f) => !existing.has(`${f.user}@${f.hostName}:${f.port}`))
      .map((f, i) => ({ ...blank(), id: "h" + Date.now().toString(36) + i, label: f.alias, host: f.hostName, port: f.port || 22, user: f.user, keyPath: f.identityFile, auth: (f.identityFile ? "key" : "auto") as SshHost["auth"] }));
    await saveSettings({ ...s, sshHosts: [...s.sshHosts, ...add] });
    toast(`Imported ${add.length} host${add.length === 1 ? "" : "s"} from ~/.ssh/config`);
  };

  if (browse) return <FolderBrowser host={browse.host} start={browse.path} onClose={() => setBrowse(null)} onOpen={async (p) => {
    await saveHost({ ...browse.host, lastFolder: p });
    setBrowse(null);
    await openFolder(`ssh://${browse.host.id}${p}`);
    set({ sidebar: "explorer" });
  }} />;

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Remote · SSH</span>
        <div className="actions">
          <button title="Import from ~/.ssh/config" onClick={importConfig}><i className="codicon codicon-cloud-download" /></button>
          <button title="Add host" onClick={() => setEdit(blank())}><i className="codicon codicon-add" /></button>
        </div>
      </div>
      <div className="tree">
        {hosts.length === 0 && !edit && (
          <div className="empty-state">
            <p>Code on any machine over SSH — files, terminal, git, search and the AI agent all run on the server.</p>
            <button className="btn primary" onClick={() => setEdit(blank())}>Add SSH host</button>
            <button className="link" onClick={importConfig}>Import from ~/.ssh/config</button>
          </div>
        )}

        {hosts.map((h) => {
          const on = !!live[h.id];
          return (
            <div key={h.id} className={`remote-row ${on ? "on" : ""}`}>
              <i className={`codicon codicon-${on ? "vm-active" : "vm"}`} />
              <div className="remote-info" onClick={() => (on ? setBrowse({ host: h, path: h.lastFolder || live[h.id].home }) : attempt(h))}>
                <div className="ellipsis">{h.label || h.host}</div>
                <div className="muted small ellipsis">{h.user}@{h.host}{h.port !== 22 ? `:${h.port}` : ""}{on ? " · connected" : ""}</div>
              </div>
              <div className="row-actions" style={{ display: "flex" }}>
                {on ? (
                  <>
                    <button title="Open folder" onClick={() => setBrowse({ host: h, path: h.lastFolder || live[h.id].home })}><i className="codicon codicon-folder-opened" /></button>
                    <button title="Disconnect" onClick={async () => { await api.sshDisconnect(h.id); set((s) => { const n = { ...s.ssh }; delete n[h.id]; return { ssh: n }; }); }}><i className="codicon codicon-debug-disconnect" /></button>
                  </>
                ) : (
                  <button title="Connect" disabled={!!busy} onClick={() => attempt(h)}><i className={`codicon codicon-${busy === h.id ? "loading codicon-modifier-spin" : "plug"}`} /></button>
                )}
                <button title="Edit" onClick={() => setEdit(h)}><i className="codicon codicon-edit" /></button>
              </div>
            </div>
          );
        })}

        {prompt && (
          <div className="remote-prompt">
            {prompt.kind === "hostkey" ? (
              <>
                <div className={prompt.changed ? "warn-title" : ""}>
                  {prompt.changed ? "⚠ The host key has CHANGED" : "First connection to this host"}
                </div>
                <p className="muted small">
                  {prompt.changed
                    ? "This can mean the server was reinstalled — or that someone is intercepting the connection. Only continue if you know why it changed."
                    : "Verify that this fingerprint matches the server before trusting it."}
                </p>
                <code className="fp">{prompt.fingerprint}</code>
                <div className="row gap">
                  <button className="btn small" onClick={() => setPrompt(null)}>Cancel</button>
                  <button className="btn small primary" onClick={() => attempt(prompt.host, prompt.secret, prompt.fingerprint)}>Trust &amp; connect</button>
                </div>
              </>
            ) : (
              <>
                <div>{prompt.kind === "password" ? `Password for ${prompt.host.user}@${prompt.host.host}` : prompt.message}</div>
                <input
                  autoFocus
                  type="password"
                  placeholder={prompt.kind === "password" ? "Password" : "Key passphrase"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && attempt(prompt.host, prompt.kind === "password" ? { password: secret } : { passphrase: secret })}
                />
                <div className="row gap">
                  <button className="btn small" onClick={() => { setPrompt(null); setSecret(""); }}>Cancel</button>
                  <button className="btn small primary" disabled={!!busy} onClick={() => attempt(prompt.host, prompt.kind === "password" ? { password: secret } : { passphrase: secret })}>
                    {busy ? "Connecting…" : "Connect"}
                  </button>
                </div>
                <p className="muted small">Not stored — only used for this connection.</p>
              </>
            )}
          </div>
        )}

        {edit && (
          <HostForm
            host={edit}
            onCancel={() => setEdit(null)}
            onDelete={hosts.some((h) => h.id === edit.id) ? async () => {
              const s = get().settings;
              await saveSettings({ ...s, sshHosts: s.sshHosts.filter((h) => h.id !== edit.id) });
              setEdit(null);
            } : undefined}
            onSave={async (h) => { await saveHost(h); setEdit(null); }}
          />
        )}
      </div>
    </div>
  );
}

function HostForm({ host, onSave, onCancel, onDelete }: { host: SshHost; onSave: (h: SshHost) => void; onCancel: () => void; onDelete?: () => void }) {
  const [h, setH] = useState<SshHost>(host);
  const upd = (p: Partial<SshHost>) => setH((x) => ({ ...x, ...p }));
  // Accept "user@host:port" pasted into the host field.
  const parseTarget = (v: string) => {
    const m = v.match(/^(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    if (m) upd({ host: m[2], ...(m[1] ? { user: m[1] } : {}), ...(m[3] ? { port: Number(m[3]) } : {}) });
    else upd({ host: v });
  };
  return (
    <div className="host-form">
      <label>Host</label>
      <input placeholder="user@example.com:22" value={h.host} onChange={(e) => parseTarget(e.target.value)} autoFocus />
      <div className="grid2">
        <div><label>User</label><input value={h.user} onChange={(e) => upd({ user: e.target.value })} /></div>
        <div><label>Port</label><input type="number" value={h.port} onChange={(e) => upd({ port: Number(e.target.value) || 22 })} /></div>
      </div>
      <label>Name</label>
      <input placeholder={h.host || "My server"} value={h.label} onChange={(e) => upd({ label: e.target.value })} />
      <label>Authentication</label>
      <select value={h.auth} onChange={(e) => upd({ auth: e.target.value as SshHost["auth"] })}>
        <option value="auto">Automatic (ssh-agent → ~/.ssh keys → password)</option>
        <option value="key">Private key file</option>
        <option value="agent">ssh-agent only</option>
        <option value="password">Password</option>
      </select>
      {(h.auth === "key" || h.auth === "auto") && (
        <div className="row gap">
          <input className="grow" placeholder="~/.ssh/id_ed25519 (optional)" value={h.keyPath} onChange={(e) => upd({ keyPath: e.target.value })} />
          <button className="btn small" onClick={async () => { const f = await openDialog({ title: "Choose private key" }); if (typeof f === "string") upd({ keyPath: f }); }}>…</button>
        </div>
      )}
      <div className="row gap" style={{ marginTop: 10 }}>
        {onDelete && <button className="btn small" onClick={onDelete}>Delete</button>}
        <span className="spacer" />
        <button className="btn small" onClick={onCancel}>Cancel</button>
        <button className="btn small primary" disabled={!h.host || !h.user} onClick={() => onSave(h)}>Save</button>
      </div>
    </div>
  );
}

function FolderBrowser({ host, start, onOpen, onClose }: { host: SshHost; start: string; onOpen: (p: string) => void; onClose: () => void }) {
  const [path, setPath] = useState(start);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setEntries(null);
    setError("");
    api.readDir(`ssh://${host.id}${path}`).then((l) => setEntries(l.filter((e) => e.isDir))).catch((e) => setError(errMsg(e)));
  }, [path, host.id]);

  const up = () => setPath(path.replace(/\/[^/]+\/?$/, "") || "/");
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Open folder on {host.label || host.host}</span>
        <div className="actions"><button title="Back" onClick={onClose}><i className="codicon codicon-close" /></button></div>
      </div>
      <div className="remote-browser">
        <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setPath((e.target as HTMLInputElement).value)} />
        <button className="btn primary" onClick={() => onOpen(path)}>Open “{path.split("/").filter(Boolean).pop() ?? "/"}”</button>
      </div>
      <div className="tree">
        {path !== "/" && <div className="tree-row" style={{ paddingLeft: 16 }} onClick={up}><i className="codicon codicon-arrow-up" /><span className="name">..</span></div>}
        {error && <div className="note err" style={{ margin: 12 }}>{error}</div>}
        {!entries && !error && <div className="muted small pad">Loading…</div>}
        {entries?.map((e) => (
          <div key={e.path} className="tree-row" style={{ paddingLeft: 16 }} onClick={() => setPath(`${path.replace(/\/$/, "")}/${e.name}`)} onDoubleClick={() => onOpen(`${path.replace(/\/$/, "")}/${e.name}`)}>
            <i className="codicon codicon-folder" />
            <span className="name">{e.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
