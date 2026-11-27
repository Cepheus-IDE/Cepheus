// New / edit database connection dialog: kind-specific fields, SQLite file picker, SSL mode,
// SSH tunnel through a saved Remote host, test button, read-only / production flags, color.
import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { errMsg } from "../../lib/api";
import { toast, useStore } from "../../store";
import { dbApi } from "../../lib/db/api";
import { saveConnection } from "../../lib/db/store";
import { DEFAULT_PORT, KIND_LABEL, type DbConnection, type DbKind, type SslMode } from "../../lib/db/types";
import { Modal } from "./DbDialogs";

export const DB_COLORS = ["", "#e5534b", "#e0823d", "#c69026", "#57ab5a", "#39c5cf", "#539bf5", "#986ee2", "#e275ad"];

export function blankConnection(kind: DbKind = "postgres"): DbConnection {
  return {
    id: "db" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: "",
    kind,
    host: kind === "sqlite" ? "" : "localhost",
    port: DEFAULT_PORT[kind],
    database: kind === "postgres" ? "postgres" : "",
    user: kind === "postgres" ? "postgres" : kind === "mssql" ? "sa" : kind === "sqlite" ? "" : "root",
    file: "",
    sslMode: "prefer",
    color: "",
    production: false,
    readOnly: false,
    ssh: null,
    timeoutSecs: 15,
    trustServerCert: false,
    savePassword: true,
  };
}

export default function ConnectionDialog({ initial, onClose }: { initial: DbConnection; onClose: () => void }) {
  const [c, setC] = useState<DbConnection>(initial);
  const [password, setPassword] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const sshHosts = useStore((s) => s.settings.sshHosts);
  const isNew = !initial.name;
  const sqlite = c.kind === "sqlite";
  const up = (p: Partial<DbConnection>) => setC((x) => ({ ...x, ...p }));

  useEffect(() => {
    if (!isNew) dbApi.hasPassword(initial.id).then(setHasSaved).catch(() => {});
  }, [initial.id, isNew]);

  const setKind = (k: DbKind) => {
    const b = blankConnection(k);
    setC((x) => ({ ...x, kind: k, port: b.port, user: x.user && x.kind !== "sqlite" && k !== "sqlite" ? x.user : b.user, database: k === "postgres" && !x.database ? "postgres" : k === "sqlite" ? "" : x.database, host: k === "sqlite" ? "" : x.host || "localhost" }));
  };

  const pickFile = async (create: boolean) => {
    const p = create
      ? await saveDialog({ defaultPath: "database.db", filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }] })
      : await openDialog({ multiple: false, filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof p === "string") up({ file: p, name: c.name || p.split(/[\\/]/).pop() || "" });
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const { savePassword: _s, ...cfg } = c;
      const v = await dbApi.test(cfg as DbConnection, password || (hasSaved ? null : ""));
      setResult({ ok: true, text: `Connected · ${v}` });
    } catch (e) {
      setResult({ ok: false, text: errMsg(e).replace(/^PASSWORD_REQUIRED:\s*/, "") });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (sqlite && !c.file.trim()) return setResult({ ok: false, text: "Choose a database file." });
    if (!sqlite && !c.host.trim()) return setResult({ ok: false, text: "Host is required." });
    const name = c.name.trim() || (sqlite ? c.file.split(/[\\/]/).pop() ?? "SQLite" : `${c.user ? c.user + "@" : ""}${c.host}`);
    await saveConnection({ ...c, name }, password ? password : !c.savePassword && hasSaved ? "" : null);
    toast(`${isNew ? "Added" : "Saved"} ${name}`);
    onClose();
  };

  return (
    <Modal
      wide
      title={<><i className="codicon codicon-database" /> {isNew ? "New connection" : `Edit ${initial.name}`}</>}
      onClose={onClose}
      footer={
        <>
          <button className="btn small" onClick={test} disabled={testing}>{testing ? "Testing…" : "Test connection"}</button>
          <span className="grow" />
          <button className="btn small" onClick={onClose}>Cancel</button>
          <button className="btn small primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="db-kind-row" role="radiogroup" aria-label="Database engine">
        {(Object.keys(KIND_LABEL) as DbKind[]).map((k) => (
          <button key={k} role="radio" aria-checked={c.kind === k} className={`btn small ${c.kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <div className="db-form-grid">
        <label className="db-field span2"><span>Name</span><input value={c.name} placeholder={sqlite ? "e.g. app.db" : "e.g. Local Postgres"} onChange={(e) => up({ name: e.target.value })} /></label>
        {sqlite ? (
          <label className="db-field span2">
            <span>Database file</span>
            <div className="db-inline-row">
              <input className="grow mono" value={c.file} placeholder="/path/to/database.db" onChange={(e) => up({ file: e.target.value })} />
              <button className="btn small" onClick={() => pickFile(false)}>Open…</button>
              <button className="btn small" onClick={() => pickFile(true)} title="Create a new SQLite file">New…</button>
            </div>
          </label>
        ) : (
          <>
            <label className="db-field"><span>Host</span><input value={c.host} onChange={(e) => up({ host: e.target.value })} spellCheck={false} /></label>
            <label className="db-field"><span>Port</span><input type="number" value={c.port || ""} onChange={(e) => up({ port: Number(e.target.value) || 0 })} /></label>
            <label className="db-field"><span>User</span><input value={c.user} onChange={(e) => up({ user: e.target.value })} spellCheck={false} autoComplete="off" /></label>
            <label className="db-field">
              <span>Password {hasSaved && !password && <em className="muted small">(saved in keychain)</em>}</span>
              <input type="password" value={password} placeholder={hasSaved ? "•••••• unchanged" : ""} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label className="db-field"><span>Database{c.kind === "mysql" || c.kind === "mariadb" ? " (optional)" : ""}</span><input value={c.database} onChange={(e) => up({ database: e.target.value })} spellCheck={false} /></label>
            <label className="db-field">
              <span>SSL / TLS</span>
              <select value={c.sslMode} onChange={(e) => up({ sslMode: e.target.value as SslMode })}>
                <option value="disable">Disable</option>
                <option value="prefer">Prefer</option>
                <option value="require">Require (no verification)</option>
                <option value="verify-ca">Verify CA</option>
                <option value="verify-full">Verify full (CA + host name)</option>
              </select>
            </label>
            <label className="db-field">
              <span>SSH tunnel</span>
              <select value={c.ssh ?? ""} onChange={(e) => up({ ssh: e.target.value || null })}>
                <option value="">None (direct)</option>
                {sshHosts.map((h) => <option key={h.id} value={h.id}>{h.label || h.host} ({h.user ? h.user + "@" : ""}{h.host})</option>)}
              </select>
              {!sshHosts.length && <em className="muted small">Add SSH hosts in the Remote panel to tunnel through them.</em>}
            </label>
            <label className="db-field"><span>Connect timeout (s)</span><input type="number" min={1} max={300} value={c.timeoutSecs ?? 15} onChange={(e) => up({ timeoutSecs: Number(e.target.value) || 15 })} /></label>
            <label className="check small span2"><input type="checkbox" checked={c.savePassword ?? true} onChange={(e) => up({ savePassword: e.target.checked })} /> Save password in the system keychain (Windows Credential Manager / macOS Keychain / Secret Service) — never in settings.json</label>
            {c.kind === "mssql" && <label className="check small span2"><input type="checkbox" checked={!!c.trustServerCert} onChange={(e) => up({ trustServerCert: e.target.checked })} /> Trust the server certificate (self-signed)</label>}
          </>
        )}
      </div>
      <div className="db-flags">
        <label className="check small" title="Non-SELECT statements need an explicit confirmation"><input type="checkbox" checked={c.readOnly} onChange={(e) => up({ readOnly: e.target.checked })} /> Read-only</label>
        <label className="check small" title="Shows a red badge; writes need confirmation; the agent always asks before running SQL"><input type="checkbox" checked={c.production} onChange={(e) => up({ production: e.target.checked })} /> Production</label>
        <span className="db-colors" role="radiogroup" aria-label="Color">
          {DB_COLORS.map((col) => (
            <button key={col || "none"} role="radio" aria-checked={c.color === col} title={col || "No color"} className={`db-swatch ${c.color === col ? "on" : ""}`} style={{ background: col || "transparent" }} onClick={() => up({ color: col })} />
          ))}
        </span>
      </div>
      {result && <pre className={result.ok ? "db-ok" : "tb-error"}>{result.text}</pre>}
    </Modal>
  );
}
