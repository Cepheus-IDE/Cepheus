//! Extension bridges: Node language servers shipped inside extension .vsix files (YAML, Prisma,
//! GraphQL, Svelte, Astro, Tailwind). The installer keeps only JSON-ish files, so the server folders
//! are unpacked from the .vsix into <app data>/bridges/<id>@<version> and run with `node … --stdio`.

import { appDataDir } from "@tauri-apps/api/path";
import { api } from "../api";
import { registerExtraServer, ServerSpec } from "../lsp";
import { registryMeta } from "../marketplace";
import { runCommand, shellQuote } from "../procBus";
import { get } from "../../store";
import { substitute, vsixExtractCommand } from "./core";
import { BRIDGES, BridgeDef, bridgeKey } from "./registry";
import { bridgeEnabled, useBridgeRuntime } from "./state";
import { checkTools, isWin, localWorkspace, useTools } from "./tools";

const sepOf = (p: string) => (p.includes("\\") ? "\\" : "/");
let rootP: Promise<string> | null = null;
const bridgesRoot = () => (rootP ??= appDataDir().then((d) => d.replace(/[\\/]+$/, "") + sepOf(d) + "bridges"));

function setState(key: string, v: { state: "downloading" | "ready" | "waiting" | "error"; message?: string } | null) {
  useBridgeRuntime.setState((s) => {
    const servers = { ...s.servers };
    if (v) servers[key] = v; else delete servers[key];
    return { servers };
  });
}

const unpacking = new Map<string, Promise<string>>();
const DONE = ".cepheus-unpacked";
const rmDir = (d: string) => (isWin() ? `if exist ${shellQuote(d)} rmdir /s /q ${shellQuote(d)}` : `rm -rf ${shellQuote(d)}`);

/** Unpacks the server files of a bridge's extension (once per version); returns the folder. */
async function ensureUnpacked(b: BridgeDef): Promise<string> {
  const srv = b.server!;
  const key = bridgeKey(b);
  const installed = get().extensions.find((e) => b.ids.includes(e.id));
  const [ns, ...rest] = (installed?.id ?? key).split(".");
  const name = installed?.name ?? rest.join(".");
  const root = await bridgesRoot();
  const sep = sepOf(root);
  // Reuse any unpacked copy of the installed version (or of any version when not installed).
  const have = await api.readDir(root).catch(() => []);
  const prefix = `${key}@`;
  const wanted = installed?.version;
  const existing = have.filter((e) => e.isDir && e.name.toLowerCase().startsWith(prefix) && (!wanted || e.name.slice(prefix.length) === wanted));
  // A marker is written last, so a half-unpacked folder (network error, path too long) is never used.
  for (const e of existing) if (await api.exists(e.path + sep + DONE).catch(() => false)) return e.path;
  const ver = wanted ?? (await api.openvsxMeta(ns, name))?.version;
  if (!ver) throw new Error("extension version not found on the registry");
  let p = unpacking.get(`${key}@${ver}`);
  if (!p) {
    p = (async () => {
      const meta = await registryMeta(ns, name, ver);
      const url: string | undefined = meta?.files?.download;
      if (!url || !url.startsWith("https://")) throw new Error("no download URL for the .vsix");
      const dir = root + sep + `${key}@${ver}`;
      setState(key, { state: "downloading", message: `Downloading ${srv.name} (${srv.size})…` });
      const r = await runCommand(vsixExtractCommand(url, dir, srv.extract, isWin(), shellQuote), null).done;
      const entry = dir + sep + srv.entry.replace(/\//g, sep);
      if (r.code !== 0 || !(await api.exists(entry).catch(() => false))) {
        await runCommand(rmDir(dir), null).done;
        throw new Error((r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 3).join(" ").slice(0, 300) || "unpacking failed");
      }
      await api.writeFile(dir + sep + DONE, ver);
      // Older unpacked versions of this extension are no longer needed.
      for (const e of have) if (e.isDir && e.name.toLowerCase().startsWith(prefix) && e.name !== `${key}@${ver}`) {
        runCommand(rmDir(e.path), null);
      }
      return dir;
    })();
    unpacking.set(`${key}@${ver}`, p);
    p.catch(() => unpacking.delete(`${key}@${ver}`));
  }
  return p;
}

/** Registers the language servers of enabled bridges with the LSP client (and removes others). */
export async function syncServers() {
  const ws = localWorkspace();
  for (const b of BRIDGES.filter((x) => x.server)) {
    const key = bridgeKey(b);
    const srv = b.server!;
    if (!bridgeEnabled(b)) {
      registerExtraServer(srv.languages, null);
      setState(key, null);
      continue;
    }
    const req = b.requires ?? [];
    await checkTools(req);
    const missing = req.filter((t) => !useTools.getState().status[t]?.ok);
    if (missing.length) {
      registerExtraServer(srv.languages, null);
      setState(key, { state: "waiting", message: `Needs ${missing.join(", ")}` });
      continue;
    }
    try {
      const dir = await ensureUnpacked(b);
      const vars = { dir: dir.replace(/\\/g, "/"), workspace: (ws ?? "").replace(/\\/g, "/") };
      const sep = sepOf(dir);
      const spec: ServerSpec = {
        name: srv.name,
        exe: "node",
        command: `node ${shellQuote(dir + sep + srv.entry.replace(/\//g, sep))} ${srv.args ?? "--stdio"}`,
        initializationOptions: substitute(srv.initializationOptions, vars),
        config: srv.config,
      };
      registerExtraServer(srv.languages, spec);
      setState(key, { state: "ready", message: `${srv.name}: ${srv.languages.join(", ")}` });
    } catch (e) {
      registerExtraServer(srv.languages, null);
      setState(key, { state: "error", message: String((e as Error)?.message ?? e) });
    }
  }
}
