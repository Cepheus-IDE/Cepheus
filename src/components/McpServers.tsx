// Settings → MCP Servers: global servers (settings `mcpServers`) are editable here; workspace
// servers come from .cepheus/mcp.json. Start/stop and live status talk to the backend MCP client.
import { useEffect, useState } from "react";
import { useStore, toast } from "../store";
import { errMsg } from "../lib/api";
import { mcpApi, McpStatus } from "../lib/agentPlatform";
import type { McpServerConfig } from "../lib/settings";
import { openFile } from "../lib/workspace";
import { join } from "../lib/paths";

type Servers = Record<string, McpServerConfig>;

/** Splits a command line into words, honoring "double" and 'single' quotes. */
function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
const parseKv = (t: string) =>
  Object.fromEntries(t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.search(/[=:]/);
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
const fmtKv = (o?: Record<string, string>) => Object.entries(o ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

interface Draft { orig: string | null; name: string; kind: "stdio" | "http"; cmd: string; url: string; kv: string }

export default function McpServers({ value, onChange }: { value: Servers; onChange: (v: Servers) => void }) {
  const ws = useStore((s) => s.workspace);
  const [status, setStatus] = useState<McpStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = () => mcpApi.status(value).then(setStatus).catch(() => {});
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [JSON.stringify(value), ws]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast(`MCP ${name}: ${errMsg(e)}`, "error");
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const saveDraft = () => {
    if (!edit) return;
    const name = edit.name.trim();
    if (!name) return toast("Give the server a name", "error");
    let cfg: McpServerConfig;
    if (edit.kind === "http") {
      if (!/^https?:\/\//.test(edit.url.trim())) return toast("Enter an http(s) URL", "error");
      cfg = { url: edit.url.trim(), headers: parseKv(edit.kv) };
    } else {
      const words = splitArgs(edit.cmd.trim());
      if (!words.length) return toast("Enter the command that starts the server", "error");
      cfg = { command: words[0], args: words.slice(1), env: parseKv(edit.kv) };
    }
    const next = { ...value };
    if (edit.orig && edit.orig !== name) delete next[edit.orig];
    next[name] = cfg;
    onChange(next);
    setEdit(null);
  };

  const startEdit = (name: string | null) => {
    const c = name ? value[name] : undefined;
    setEdit({
      orig: name,
      name: name ?? "",
      kind: c?.url ? "http" : "stdio",
      cmd: c?.command ? joinArgs([c.command, ...(c.args ?? [])]) : "",
      url: c?.url ?? "",
      kv: fmtKv(c?.url ? c.headers : c?.env),
    });
  };

  // Global servers that are not in the status list yet (e.g. just added) still get a row.
  const rows: McpStatus[] = [
    ...status,
    ...Object.keys(value)
      .filter((n) => !status.some((s) => s.name === n))
      .map((n) => ({ name: n, source: "user" as const, status: "stopped" as const, error: null, tools: [], config: value[n], transport: value[n].url ? ("http" as const) : ("stdio" as const) })),
  ];

  return (
    <section>
      <h3>MCP Servers</h3>
      <div className="muted small">
        Model Context Protocol servers give the agent extra tools (named <code>mcp__server__tool</code>; they need approval unless the mode is Turbo).
        Servers start automatically on the next agent run. Workspace servers come from <code>.cepheus/mcp.json</code>.
      </div>
      <div className="mcp-list">
        {rows.length === 0 && <div className="muted small pad">No MCP servers configured.</div>}
        {rows.map((s) => (
          <div key={`${s.source}:${s.name}`} className={`mcp-row st-${s.status}`}>
            <div className="mcp-main" onClick={() => setOpen(open === s.name ? null : s.name)}>
              <i className={`codicon codicon-${s.status === "running" ? "pass-filled" : s.status === "error" ? "error" : s.status === "starting" ? "loading codicon-modifier-spin" : "circle-large-outline"}`} />
              <b>{s.name}</b>
              <span className="muted small">{s.source === "workspace" ? "workspace" : "user"} · {s.transport} · {s.status}{s.status === "running" ? ` · ${s.tools.length} tools` : ""}</span>
              <div className="spacer" />
              {s.status === "running" || s.status === "starting" ? (
                <button className="btn small" disabled={busy === s.name} onClick={(e) => { e.stopPropagation(); act(s.name, () => mcpApi.stop(s.name)); }}>Stop</button>
              ) : (
                <button className="btn small" disabled={busy === s.name} onClick={(e) => { e.stopPropagation(); act(s.name, () => mcpApi.start(value, s.name)); }}>
                  {busy === s.name ? <i className="codicon codicon-loading codicon-modifier-spin" /> : "Start"}
                </button>
              )}
              {s.source === "user" ? (
                <>
                  <button className="icon-btn small" title="Edit" onClick={(e) => { e.stopPropagation(); startEdit(s.name); }}><i className="codicon codicon-edit" /></button>
                  <button className="icon-btn small" title="Remove" onClick={(e) => {
                    e.stopPropagation();
                    mcpApi.stop(s.name).catch(() => {});
                    const next = { ...value };
                    delete next[s.name];
                    onChange(next);
                  }}><i className="codicon codicon-trash" /></button>
                </>
              ) : (
                <button className="icon-btn small" title="Edit .cepheus/mcp.json" onClick={(e) => { e.stopPropagation(); ws && openFile(join(join(ws, ".cepheus"), "mcp.json")); }}><i className="codicon codicon-go-to-file" /></button>
              )}
            </div>
            {s.error && <div className="note err small">{s.error}</div>}
            {open === s.name && (
              <div className="mcp-detail small">
                <code>{s.config?.url ?? joinArgs([s.config?.command ?? "", ...(s.config?.args ?? [])])}</code>
                {s.tools.map((t) => (
                  <div key={t.name} className="mcp-tool"><b>{t.name}</b> <span className="muted">{t.description.slice(0, 160)}</span></div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {edit ? (
        <div className="mcp-edit">
          <label>Name</label>
          <input value={edit.name} placeholder="github" onChange={(e) => setEdit({ ...edit, name: e.target.value.replace(/\s/g, "-") })} />
          <div className="seg">
            <button className={edit.kind === "stdio" ? "on" : ""} onClick={() => setEdit({ ...edit, kind: "stdio" })}>Command (stdio)</button>
            <button className={edit.kind === "http" ? "on" : ""} onClick={() => setEdit({ ...edit, kind: "http" })}>URL (HTTP)</button>
          </div>
          {edit.kind === "stdio" ? (
            <>
              <label>Command line</label>
              <input value={edit.cmd} placeholder="npx -y @modelcontextprotocol/server-filesystem ." onChange={(e) => setEdit({ ...edit, cmd: e.target.value })} />
              <label>Environment (KEY=value per line)</label>
            </>
          ) : (
            <>
              <label>URL</label>
              <input value={edit.url} placeholder="https://example.com/mcp" onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
              <label>Headers (Name: value per line)</label>
            </>
          )}
          <textarea rows={3} value={edit.kv} onChange={(e) => setEdit({ ...edit, kv: e.target.value })} placeholder={edit.kind === "http" ? "Authorization: Bearer …" : "API_TOKEN=…"} />
          <div className="row gap">
            <button className="btn primary small" onClick={saveDraft}>{edit.orig ? "Update" : "Add"}</button>
            <button className="btn small" onClick={() => setEdit(null)}>Cancel</button>
            <span className="muted small">Click Save at the bottom to keep changes.</span>
          </div>
        </div>
      ) : (
        <button className="btn small" onClick={() => startEdit(null)}><i className="codicon codicon-add" /> Add MCP server</button>
      )}
    </section>
  );
}
