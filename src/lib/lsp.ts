//! Minimal Language Server Protocol client: spawns servers through the backend (stdio) and
//! bridges diagnostics, completion, hover, definition, references, rename and formatting
//! into Monaco. One server per (language, workspace).

import { listen } from "@tauri-apps/api/event";
import { monaco } from "./monaco";
import { api } from "./api";
import { get, set, toast, useStore, Problem } from "../store";
import { create } from "zustand";
import { setExternalProblems, clearExternalProblems } from "./problems";
import { initEditorFeatures } from "./editorFeatures";

export interface ServerSpec {
  name: string;
  exe: string;
  command: string;
  /** One-click install command, run in a terminal ("Install Pyright" in the status bar). */
  install?: string;
  /** Sent as `initializationOptions` (servers bundled in extensions, see bridges/). */
  initializationOptions?: any;
  /** Answers to `workspace/configuration` by section (over the built-in defaults). */
  config?: Record<string, any>;
}

/** Well-known servers, tried in order when the user hasn't configured one. */
export const KNOWN_SERVERS: Record<string, ServerSpec[]> = {
  python: [
    { name: "Pyright", exe: "pyright-langserver", command: "pyright-langserver --stdio", install: "npm i -g pyright" },
    { name: "basedpyright", exe: "basedpyright-langserver", command: "basedpyright-langserver --stdio", install: "pip install basedpyright" },
    { name: "pylsp", exe: "pylsp", command: "pylsp", install: "pip install python-lsp-server" },
  ],
  rust: [{ name: "rust-analyzer", exe: "rust-analyzer", command: "rust-analyzer", install: "rustup component add rust-analyzer" }],
  go: [{ name: "gopls", exe: "gopls", command: "gopls", install: "go install golang.org/x/tools/gopls@latest" }],
  c: [{ name: "clangd", exe: "clangd", command: "clangd", install: "winget install -e --id LLVM.LLVM" }],
  cpp: [{ name: "clangd", exe: "clangd", command: "clangd", install: "winget install -e --id LLVM.LLVM" }],
  java: [{ name: "jdtls", exe: "jdtls", command: "jdtls" }],
  php: [{ name: "Intelephense", exe: "intelephense", command: "intelephense --stdio", install: "npm i -g intelephense" }],
  ruby: [{ name: "Solargraph", exe: "solargraph", command: "solargraph stdio", install: "gem install solargraph" }],
  lua: [{ name: "lua-language-server", exe: "lua-language-server", command: "lua-language-server", install: "winget install -e --id LuaLS.lua-language-server" }],
  csharp: [{ name: "csharp-ls", exe: "csharp-ls", command: "csharp-ls", install: "dotnet tool install --global csharp-ls" }],
  shell: [{ name: "bash-language-server", exe: "bash-language-server", command: "bash-language-server start", install: "npm i -g bash-language-server" }],
  yaml: [{ name: "yaml-language-server", exe: "yaml-language-server", command: "yaml-language-server --stdio", install: "npm i -g yaml-language-server" }],
  dockerfile: [{ name: "docker-langserver", exe: "docker-langserver", command: "docker-langserver --stdio", install: "npm i -g dockerfile-language-server-nodejs" }],
};

/** Languages whose known server isn't on PATH (drives the "Install …" status bar action). */
export const useMissingServers = create<Record<string, ServerSpec>>(() => ({}));
const hinted = new Set<string>();
const setMissing = (lang: string, spec: ServerSpec | null) => {
  // One quiet hint per language per session; the status bar keeps the action.
  if (spec?.install && !hinted.has(lang)) {
    hinted.add(lang);
    toast(`${spec.name} (${lang} language server) isn't installed — use "Install ${spec.name}" in the status bar.`);
  }
  return useMissingServers.setState((s) => {
    const next = { ...s };
    if (spec) next[lang] = spec; else delete next[lang];
    return next;
  }, true);
};

const toPos = (p: monaco.IPosition) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: any) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const pathOf = (uri: string) => monaco.Uri.parse(uri).fsPath.replace(/\\/g, "/");

const CK = monaco.languages.CompletionItemKind;
// LSP CompletionItemKind (1-based) → Monaco
const KIND = [CK.Text, CK.Text, CK.Method, CK.Function, CK.Constructor, CK.Field, CK.Variable, CK.Class, CK.Interface, CK.Module, CK.Property, CK.Unit, CK.Value, CK.Enum, CK.Keyword, CK.Snippet, CK.Color, CK.File, CK.Reference, CK.Folder, CK.EnumMember, CK.Constant, CK.Struct, CK.Event, CK.Operator, CK.TypeParameter];
const SEVERITY = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

function markdown(c: any): monaco.IMarkdownString[] {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(markdown);
  if (typeof c === "string") return [{ value: c }];
  if (c.kind) return [{ value: c.kind === "plaintext" ? c.value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&") : c.value }];
  if (c.language) return [{ value: "```" + c.language + "\n" + c.value + "\n```" }];
  return [];
}

function setStatus(lang: string, v: { name: string; status: "starting" | "ready" | "error"; message?: string } | null) {
  set((s) => {
    const lsp = { ...s.lsp };
    if (v) lsp[lang] = v; else delete lsp[lang];
    return { lsp };
  });
}

class Client {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private procId = 0;
  private unlisten: (() => void)[] = [];
  private opened = new Map<string, monaco.IDisposable>();
  private flushers = new Map<string, () => void>();
  /** Last published diagnostics by lower-cased path. */
  private diags = new Map<string, any[]>();
  caps: any = {};
  ready: Promise<void>;
  dead = false;

  constructor(readonly lang: string, readonly spec: ServerSpec, readonly root: string) {
    this.ready = this.start();
  }

  private async start() {
    setStatus(this.lang, { name: this.spec.name, status: "starting" });
    this.unlisten.push(await listen<{ id: number; msg: string }>("proc-msg", (e) => e.payload.id === this.procId && this.onMessage(e.payload.msg)));
    this.unlisten.push(await listen<{ id: number; stream: string; data: string }>("proc-out", (e) => {
      if (e.payload.id === this.procId) console.debug(`[${this.spec.name}]`, e.payload.data.trimEnd());
    }));
    this.unlisten.push(await listen<{ id: number; code: number | null }>("proc-exit", (e) => {
      if (e.payload.id !== this.procId) return;
      this.dead = true;
      this.pending.forEach((p) => p.reject(new Error("Language server exited")));
      setStatus(this.lang, { name: this.spec.name, status: "error", message: `exited (code ${e.payload.code ?? "?"})` });
    }));
    try {
      this.procId = await api.procSpawn(this.spec.command, this.root, "lsp");
      const rootUri = monaco.Uri.file(this.root).toString();
      const res = await this.request("initialize", {
        processId: null,
        clientInfo: { name: "Cepheus IDE" },
        rootUri,
        rootPath: this.root,
        initializationOptions: this.spec.initializationOptions,
        workspaceFolders: [{ uri: rootUri, name: this.root.split("/").pop() }],
        capabilities: {
          workspace: {
            configuration: true, workspaceFolders: true, applyEdit: true,
            workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
            executeCommand: { dynamicRegistration: false },
          },
          textDocument: {
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] },
              },
              isPreferredSupport: true,
              disabledSupport: true,
              dataSupport: true,
              resolveSupport: { properties: ["edit"] },
            },
            synchronization: { didSave: true, dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], insertReplaceSupport: true } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
            definition: { linkSupport: true },
            references: {},
            rename: { prepareSupport: false },
            formatting: {},
            publishDiagnostics: { relatedInformation: false },
          },
          window: { workDoneProgress: false },
        },
      }, 60000);
      this.caps = res?.capabilities ?? {};
      this.notify("initialized", {});
      this.notify("workspace/didChangeConfiguration", { settings: null });
      setStatus(this.lang, { name: this.spec.name, status: "ready" });
    } catch (e) {
      this.dead = true;
      setStatus(this.lang, { name: this.spec.name, status: "error", message: String((e as any)?.message ?? e) });
      throw e;
    }
  }

  private send(obj: any) {
    if (this.procId) api.procWrite(this.procId, JSON.stringify({ jsonrpc: "2.0", ...obj }), true).catch(() => {});
  }

  request(method: string, params: any, timeout = 15000): Promise<any> {
    const uri = params?.textDocument?.uri;
    if (uri) this.flushers.get(uri)?.();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeout);
    });
  }

  notify(method: string, params: any) {
    this.send({ method, params });
  }

  private onMessage(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method && m.id !== undefined) {
      // Server → client requests: answer the common ones so servers don't stall.
      let result: any = null;
      if (m.method === "workspace/configuration") result = (m.params?.items ?? []).map((it: any) => serverConfig(it?.section, this.spec));
      if (m.method === "workspace/workspaceFolders") result = [{ uri: monaco.Uri.file(this.root).toString(), name: "root" }];
      if (m.method === "workspace/applyEdit") {
        applyWorkspaceEdit(m.params.edit).then((ok) => this.send({ id: m.id, result: { applied: ok } }));
        return;
      }
      this.send({ id: m.id, result });
      return;
    }
    if (m.method === "textDocument/publishDiagnostics") {
      const path = fixCase(pathOf(m.params.uri));
      const list: any[] = m.params.diagnostics ?? [];
      // Raw diagnostics are sent back verbatim in codeAction requests (servers match on code/data).
      if (list.length) this.diags.set(path.toLowerCase(), list); else this.diags.delete(path.toLowerCase());
      const model = monaco.editor.getModels().find((x) => x.uri.scheme === "file" && sameFile(x.uri.fsPath, path));
      if (model) {
        setExternalProblems(this.owner, path, null);
        monaco.editor.setModelMarkers(model, this.owner, list.map((d) => ({
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Info,
          message: d.message,
          source: d.source ?? this.spec.name,
          code: d.code !== undefined ? String(typeof d.code === "object" ? d.code.value : d.code) : undefined,
        })));
        return;
      }
      // Workspace diagnostics: files that aren't open still show up in the Problems panel.
      if (!inRoot(path, this.root)) return;
      setExternalProblems(this.owner, path, list.filter((d) => d.severity !== 4).map((d): Problem => ({
        path,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endCol: d.range.end.character + 1,
        severity: d.severity === 2 ? "warning" : d.severity === 3 || d.severity === 4 ? "info" : "error",
        message: d.message,
        source: d.source ?? this.spec.name,
      })));
    }
  }

  get owner() { return `lsp:${this.lang}`; }

  /** Raw LSP diagnostics of a file that intersect `range` (for codeAction context). */
  diagnosticsIn(path: string, range: monaco.IRange): any[] {
    return (this.diags.get(fixCase(path).toLowerCase()) ?? []).filter((d) =>
      monaco.Range.areIntersectingOrTouching(toRange(d.range), range));
  }

  open(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    if (this.opened.has(uri) || this.dead) return;
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.lang, version: model.getVersionId(), text: model.getValue() } });
    let t = 0;
    let sent = model.getVersionId();
    const flush = () => {
      clearTimeout(t);
      if (model.isDisposed() || model.getVersionId() === sent) return;
      sent = model.getVersionId();
      this.notify("textDocument/didChange", { textDocument: { uri, version: sent }, contentChanges: [{ text: model.getValue() }] });
    };
    // Full-document sync, debounced: simple and works with every server.
    const sub = model.onDidChangeContent(() => {
      clearTimeout(t);
      t = window.setTimeout(flush, 200);
    });
    this.flushers.set(uri, flush);
    this.opened.set(uri, { dispose: () => { clearTimeout(t); sub.dispose(); this.flushers.delete(uri); } });
  }

  close(model: monaco.editor.ITextModel) {
    const uri = model.uri.toString();
    const d = this.opened.get(uri);
    if (!d) return;
    d.dispose();
    this.opened.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  saved(model: monaco.editor.ITextModel) {
    if (this.opened.has(model.uri.toString())) this.notify("textDocument/didSave", { textDocument: { uri: model.uri.toString() } });
  }

  async stop() {
    this.opened.forEach((d) => d.dispose());
    this.opened.clear();
    try {
      if (!this.dead) {
        await this.request("shutdown", null, 2000).catch(() => {});
        this.notify("exit", null);
      }
    } finally {
      setTimeout(() => this.procId && api.procKill(this.procId), 500);
      this.unlisten.forEach((f) => f());
      clearExternalProblems(this.owner);
      setStatus(this.lang, null);
    }
  }
}

const sameFile = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
const inRoot = (p: string, root: string) => p.toLowerCase().startsWith(root.replace(/\\/g, "/").toLowerCase().replace(/\/?$/, "/"));
/** Servers report "c:/x" (lower-case drive); keep the workspace's spelling so paths group and compare cleanly. */
function fixCase(p: string) {
  const root = get().workspace?.replace(/\\/g, "/");
  return root && p.toLowerCase().startsWith(root.toLowerCase()) ? root + p.slice(root.length) : p;
}

/** Answers `workspace/configuration`. Only a few well-known knobs; null = server default. */
function serverConfig(section: string | undefined, spec?: ServerSpec): any {
  if (section && spec?.config && section in spec.config) return spec.config[section];
  const wsDiag = get().settings.lspWorkspaceDiagnostics !== false;
  const analysis = { diagnosticMode: wsDiag ? "workspace" : "openFilesOnly", autoImportCompletions: true };
  if (section === "python.analysis" || section === "basedpyright.analysis") return analysis;
  if (section === "python" || section === "basedpyright") return { analysis };
  return null;
}

const clients = new Map<string, Client>();
const providersFor = new Set<string>();
let detected: Promise<Set<string>> | null = null;

function detect(): Promise<Set<string>> {
  if (!detected) {
    const exes = [...new Set(Object.values(KNOWN_SERVERS).flat().map((s) => s.exe))];
    detected = api.which(exes).then((found) => new Set(found)).catch(() => new Set());
  }
  return detected;
}

/** Servers registered at runtime (language servers bundled in extensions, see bridges/). */
const extraServers = new Map<string, ServerSpec>();

/**
 * Registers (or with null removes) a runtime server for languages. The user's own command in
 * Settings → Language Servers still wins; a running client for the language is restarted.
 */
export function registerExtraServer(langs: string[], spec: ServerSpec | null) {
  for (const lang of langs) {
    const cur = extraServers.get(lang);
    if (spec ? JSON.stringify(cur) === JSON.stringify(spec) : !cur) continue;
    if (spec) extraServers.set(lang, spec); else extraServers.delete(lang);
    const c = clients.get(lang);
    if (c) { clients.delete(lang); c.stop(); }
    if (spec) setMissing(lang, null);
    monaco.editor.getModels().filter((m) => m.getLanguageId() === lang).forEach(attachModel);
  }
}

async function specFor(lang: string): Promise<ServerSpec | null> {
  const custom = get().settings.languageServers[lang]?.trim();
  if (!custom && extraServers.has(lang)) return extraServers.get(lang)!;
  if (custom) {
    const parts = custom.match(/"[^"]+"|\S+/g) ?? [custom];
    const runner = /^(node|npx|python3?|py|uv|uvx|java|dotnet)(\.exe)?$/i.test(parts[0]) && parts[1] ? parts[1] : parts[0];
    const base = runner.replace(/"/g, "").split(/[\\/]/).pop()!.replace(/\.(cmd|exe|js|py)$/i, "");
    // ".../pyright/langserver.index.js" → "pyright"
    const name = /^(langserver|index|server|main)(\.index)?$/i.test(base) ? runner.replace(/"/g, "").split(/[\\/]/).slice(-2, -1)[0] ?? base : base;
    return { name, exe: "", command: custom };
  }
  const known = KNOWN_SERVERS[lang];
  if (!known) return null;
  const found = await detect();
  return known.find((s) => found.has(s.exe)) ?? null;
}

async function clientFor(lang: string): Promise<Client | null> {
  const root = get().workspace;
  if (!root || root.startsWith("ssh://")) return null;
  const existing = clients.get(lang);
  if (existing && !existing.dead) return existing;
  const spec = await specFor(lang);
  if (!spec) {
    const known = KNOWN_SERVERS[lang];
    if (known && !get().settings.languageServers[lang]?.trim()) setMissing(lang, known.find((s) => s.install) ?? known[0]);
    return null;
  }
  setMissing(lang, null);
  if (clients.get(lang) && !clients.get(lang)!.dead) return clients.get(lang)!;
  const c = new Client(lang, spec, root);
  clients.set(lang, c);
  registerProviders(lang);
  try { await c.ready; } catch { return null; }
  return c;
}

async function ready(lang: string): Promise<Client | null> {
  const c = clients.get(lang);
  if (!c || c.dead) return null;
  try { await c.ready; return c; } catch { return null; }
}

function inWorkspace(model: monaco.editor.ITextModel) {
  const root = get().workspace;
  return !!root && model.uri.scheme === "file" && model.uri.fsPath.replace(/\\/g, "/").toLowerCase().startsWith(root.toLowerCase());
}

async function attachModel(model: monaco.editor.ITextModel) {
  if (!inWorkspace(model)) return;
  const c = await clientFor(model.getLanguageId());
  if (c && !model.isDisposed()) c.open(model);
}

/**
 * Applies an LSP WorkspaceEdit: text edits go through the models (undoable); create/rename/delete
 * resource operations hit the disk. Files without an open tab are saved right away so edits
 * aren't left in invisible buffers.
 */
export async function applyWorkspaceEdit(edit: any): Promise<boolean> {
  const w = await import("./workspace");
  const touched = new Set<string>();
  const applyText = async (uri: string, edits: any[]) => {
    const path = fixCase(pathOf(uri));
    const entry = await w.preloadModel(path).catch(() => null);
    if (!entry) return false;
    entry.model.pushStackElement();
    entry.model.pushEditOperations([], edits.map((e: any) => ({ range: toRange(e.range), text: e.newText })), () => null);
    entry.model.pushStackElement();
    touched.add(path);
    return true;
  };
  for (const [uri, edits] of Object.entries<any[]>(edit?.changes ?? {})) if (!(await applyText(uri, edits))) return false;
  for (const dc of edit?.documentChanges ?? []) {
    try {
      if (dc.textDocument) { if (!(await applyText(dc.textDocument.uri, dc.edits ?? []))) return false; }
      else if (dc.kind === "create") {
        const p = pathOf(dc.uri);
        if (!(await api.exists(p)) || dc.options?.overwrite) await api.writeFile(p, "");
      } else if (dc.kind === "rename") await api.rename(pathOf(dc.oldUri), pathOf(dc.newUri));
      else if (dc.kind === "delete") await api.remove(pathOf(dc.uri));
    } catch {
      return false;
    }
  }
  const tabs = get().tabs;
  for (const p of touched) if (!tabs.some((t) => t.kind === "file" && sameFile(t.path, p))) await w.saveFile(p);
  return true;
}

/** Runs a server command (`workspace/executeCommand`); edits come back as `workspace/applyEdit`. */
export async function executeServerCommand(lang: string, command: { command: string; arguments?: any[] }) {
  const c = await ready(lang);
  if (!c) throw new Error("Language server is not running");
  return c.request("workspace/executeCommand", { command: command.command, arguments: command.arguments ?? [] }, 30000);
}

const APPLY_ACTION = "cepheus.lsp.applyCodeAction";
let applyCmdRegistered = false;
function registerApplyCommand() {
  if (applyCmdRegistered) return;
  applyCmdRegistered = true;
  monaco.editor.registerCommand(APPLY_ACTION, (_accessor, lang: string, action: any) => {
    applyCodeAction(lang, action).catch((e) => toast(String(e?.message ?? e), "error"));
  });
}

/** Applies a CodeAction (resolving it first if needed) or runs a plain Command. */
export async function applyCodeAction(lang: string, action: any) {
  const c = await ready(lang);
  if (!c) return;
  if (typeof action.command === "string") return void (await executeServerCommand(lang, action));
  let a = action;
  if (!a.edit && !a.command && c.caps.codeActionProvider?.resolveProvider) a = (await c.request("codeAction/resolve", a).catch(() => null)) ?? a;
  if (a.edit && !(await applyWorkspaceEdit(a.edit))) throw new Error(`Could not apply "${a.title}"`);
  if (a.command) await executeServerCommand(lang, a.command);
}

const toLspRange = (r: monaco.IRange) => ({ start: toPos({ lineNumber: r.startLineNumber, column: r.startColumn }), end: toPos({ lineNumber: r.endLineNumber, column: r.endColumn }) });

/** LSP code actions for a model range (also used by "Organize Imports" on LSP languages). */
export async function lspCodeActions(model: monaco.editor.ITextModel, range: monaco.IRange, only?: string, trigger: 1 | 2 = 1): Promise<any[]> {
  const c = await ready(model.getLanguageId());
  if (!c?.caps.codeActionProvider) return [];
  const res = await c.request("textDocument/codeAction", {
    textDocument: { uri: model.uri.toString() },
    range: toLspRange(range),
    context: { diagnostics: c.diagnosticsIn(model.uri.fsPath.replace(/\\/g, "/"), range), only: only ? [only] : undefined, triggerKind: trigger },
  }).catch(() => null);
  return (Array.isArray(res) ? res : []).filter((a) => a && a.title && (!only || typeof a.command === "string" || !a.kind || a.kind === only || a.kind.startsWith(only + ".")));
}

export const hasLspClient = (lang: string) => !!clients.get(lang) && !clients.get(lang)!.dead;

async function toLocations(res: any): Promise<monaco.languages.Location[]> {
  const { preloadModel } = await import("./workspace");
  const list = !res ? [] : Array.isArray(res) ? res : [res];
  const locs = list.map((l: any) => ({ uri: l.targetUri ?? l.uri, range: l.targetSelectionRange ?? l.range }));
  // Peek/goto need the target models to exist.
  await Promise.all(locs.map((l) => preloadModel(pathOf(l.uri)).catch(() => null)));
  return locs.map((l) => ({ uri: monaco.Uri.file(pathOf(l.uri)), range: toRange(l.range) }));
}

function registerProviders(lang: string) {
  if (providersFor.has(lang)) return;
  providersFor.add(lang);
  const L = monaco.languages;
  const doc = (m: monaco.editor.ITextModel) => ({ uri: m.uri.toString() });

  L.registerCompletionItemProvider(lang, {
    triggerCharacters: [".", ":", "<", '"', "'", "/", "@", "("],
    async provideCompletionItems(model, position, ctx) {
      const c = await ready(lang);
      if (!c?.caps.completionProvider) return { suggestions: [] };
      const res = await c.request("textDocument/completion", {
        textDocument: doc(model), position: toPos(position),
        context: ctx.triggerCharacter ? { triggerKind: 2, triggerCharacter: ctx.triggerCharacter } : { triggerKind: 1 },
      }).catch(() => null);
      const items: any[] = Array.isArray(res) ? res : res?.items ?? [];
      const w = model.getWordUntilPosition(position);
      const def = new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn);
      return {
        incomplete: !!res?.isIncomplete,
        suggestions: items.slice(0, 500).map((it) => {
          const te = it.textEdit;
          return {
            label: it.label,
            kind: KIND[it.kind ?? 1] ?? CK.Text,
            detail: it.detail,
            documentation: it.documentation ? markdown(it.documentation)[0] : undefined,
            sortText: it.sortText,
            filterText: it.filterText,
            insertText: te?.newText ?? it.insertText ?? it.label,
            insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range: te ? toRange(te.range ?? te.insert) : def,
            additionalTextEdits: it.additionalTextEdits?.map((e: any) => ({ range: toRange(e.range), text: e.newText })),
          };
        }),
      };
    },
  });

  L.registerHoverProvider(lang, {
    async provideHover(model, position) {
      const c = await ready(lang);
      if (!c?.caps.hoverProvider) return null;
      const res = await c.request("textDocument/hover", { textDocument: doc(model), position: toPos(position) }).catch(() => null);
      if (!res?.contents) return null;
      return { contents: markdown(res.contents), range: res.range ? toRange(res.range) : undefined };
    },
  });

  L.registerSignatureHelpProvider(lang, {
    signatureHelpTriggerCharacters: ["(", ","],
    async provideSignatureHelp(model, position) {
      const c = await ready(lang);
      if (!c?.caps.signatureHelpProvider) return null;
      const res = await c.request("textDocument/signatureHelp", { textDocument: doc(model), position: toPos(position) }).catch(() => null);
      if (!res?.signatures?.length) return null;
      return {
        value: {
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
          signatures: res.signatures.map((s: any) => ({
            label: s.label,
            documentation: s.documentation ? markdown(s.documentation)[0] : undefined,
            parameters: (s.parameters ?? []).map((p: any) => ({ label: p.label, documentation: p.documentation ? markdown(p.documentation)[0] : undefined })),
          })),
        },
        dispose() {},
      };
    },
  });

  L.registerDefinitionProvider(lang, {
    async provideDefinition(model, position) {
      const c = await ready(lang);
      if (!c?.caps.definitionProvider) return null;
      return toLocations(await c.request("textDocument/definition", { textDocument: doc(model), position: toPos(position) }).catch(() => null));
    },
  });

  L.registerReferenceProvider(lang, {
    async provideReferences(model, position) {
      const c = await ready(lang);
      if (!c?.caps.referencesProvider) return null;
      return toLocations(await c.request("textDocument/references", { textDocument: doc(model), position: toPos(position), context: { includeDeclaration: true } }).catch(() => null));
    },
  });

  L.registerRenameProvider(lang, {
    async provideRenameEdits(model, position, newName) {
      const c = await ready(lang);
      if (!c?.caps.renameProvider) return { edits: [], rejectReason: "Rename is not supported by this language server" };
      const res = await c.request("textDocument/rename", { textDocument: doc(model), position: toPos(position), newName });
      const { preloadModel } = await import("./workspace");
      const edits: monaco.languages.IWorkspaceTextEdit[] = [];
      const byUri: Record<string, any[]> = { ...(res?.changes ?? {}) };
      for (const dc of res?.documentChanges ?? []) if (dc.textDocument) byUri[dc.textDocument.uri] = [...(byUri[dc.textDocument.uri] ?? []), ...dc.edits];
      for (const [uri, list] of Object.entries(byUri)) {
        await preloadModel(pathOf(uri)).catch(() => null);
        for (const e of list) edits.push({ resource: monaco.Uri.file(pathOf(uri)), textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
      }
      return { edits };
    },
  });

  // Quick fixes / refactorings / source actions (lightbulb, Ctrl+.). Actions are applied through a
  // command so resolve + edit + executeCommand happen in one place, in order.
  registerApplyCommand();
  L.registerCodeActionProvider(lang, {
    async provideCodeActions(model, range, context) {
      const list = await lspCodeActions(model, range, context.only, context.trigger === L.CodeActionTriggerType.Invoke ? 1 : 2);
      return {
        actions: list.map((a): monaco.languages.CodeAction => ({
          title: a.title,
          kind: typeof a.command === "string" ? undefined : a.kind,
          isPreferred: !!a.isPreferred,
          disabled: a.disabled?.reason,
          diagnostics: context.markers.filter((m) => (a.diagnostics ?? []).some((d: any) => d.message === m.message)),
          command: { id: APPLY_ACTION, title: a.title, arguments: [lang, a] },
        })),
        dispose() {},
      };
    },
  });

  L.registerDocumentFormattingEditProvider(lang, {
    async provideDocumentFormattingEdits(model, options) {
      const c = await ready(lang);
      if (!c?.caps.documentFormattingProvider) return [];
      const res = await c.request("textDocument/formatting", { textDocument: doc(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } }).catch(() => null);
      return (res ?? []).map((e: any) => ({ range: toRange(e.range), text: e.newText }));
    },
  });
}

/** Restart every server (after changing settings, or from the command palette). */
export async function restartLanguageServers() {
  const old = [...clients.values()];
  clients.clear();
  detected = null;
  useMissingServers.setState({}, true);
  await Promise.all(old.map((c) => c.stop()));
  monaco.editor.getModels().forEach(attachModel);
}

export function notifySaved(path: string) {
  const model = monaco.editor.getModels().find((m) => m.uri.scheme === "file" && sameFile(m.uri.fsPath, path));
  if (model) clients.get(model.getLanguageId())?.saved(model);
  // settings.json / snippet files apply live on save.
  import("./settingsLevels").then((m) => m.onFileSaved(path)).catch(() => {});
  import("./snippets").then((m) => m.onFileSaved(path)).catch(() => {});
  import("./bridges").then((m) => m.onFileSaved(path)).catch(() => {});
}

/** One-click install of the known server for `lang`, in a terminal; servers restart afterwards. */
export async function installLanguageServer(lang: string) {
  const spec = useMissingServers.getState()[lang] ?? KNOWN_SERVERS[lang]?.find((s) => s.install);
  if (!spec?.install) {
    toast(`No one-click installer for ${spec?.name ?? lang}. Set its command in Settings → Language Servers.`);
    return;
  }
  const { runInTerminal } = await import("./terminalBus");
  runInTerminal({
    title: `Install ${spec.name}`,
    command: spec.install,
    onExit: (code) => {
      if (code === 0) {
        toast(`${spec.name} installed — starting it.`);
        setMissing(lang, null);
        restartLanguageServers();
      } else {
        toast(`Installing ${spec.name} failed (exit code ${code}). See the terminal for details.`, "error");
      }
    },
  });
}

/** Start once at app boot. */
export function initLsp() {
  const stopFeatures = initEditorFeatures();
  // Extension bridges: formatters, linters, bundled language servers, editor extras.
  const bridges = import("./bridges").then((m) => m.initBridges()).catch((e) => { console.warn("bridges", e); return () => {}; });
  const subs = [
    monaco.editor.onDidCreateModel((m) => attachModel(m)),
    monaco.editor.onWillDisposeModel((m) => clients.get(m.getLanguageId())?.close(m)),
  ];
  // Jumping to another file (definition, references) opens it in a tab.
  subs.push(monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const p: any = selectionOrPosition;
      const line = p?.startLineNumber ?? p?.lineNumber;
      const col = p?.startColumn ?? p?.column;
      import("./workspace").then((w) => w.openFile(resource.fsPath.replace(/\\/g, "/"), line, col));
      return true;
    },
  }));
  // New folder → new servers rooted there.
  let ws = get().workspace;
  const unsub = useStore.subscribe((s) => {
    if (s.workspace === ws) return;
    ws = s.workspace;
    useMissingServers.setState({}, true);
    const old = [...clients.values()];
    clients.clear();
    old.forEach((c) => c.stop());
  });
  return () => { subs.forEach((s) => s.dispose()); unsub(); stopFeatures(); bridges.then((f) => f()); };
}
