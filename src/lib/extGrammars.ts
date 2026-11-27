//! Extension languages: `contributes.languages` (ids, extensions, file names, first line, language
//! configuration) and `contributes.grammars` (TextMate) bridged into Monaco with vscode-textmate +
//! vscode-oniguruma. The TextMate engine is loaded lazily, only once a grammar is actually needed.

import { create } from "zustand";
import type { IGrammar, IRawGrammar, Registry, StateStack } from "vscode-textmate";
import onigWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { monaco, languageForPath } from "./monaco";
import { api, ExtInfo } from "./api";
import { parseJsonc } from "./settings";
import { createScopeMatcher } from "./tmScopes";
import { convertLanguageConfiguration } from "./langConfig";
import { registryMeta } from "./marketplace";
import { runCommand, shellQuote } from "./procBus";

/** Languages Monaco ships a tokenizer for (captured before any extension registers its own). */
export const BUILTIN_LANGUAGES = new Set(monaco.languages.getLanguages().map((l) => l.id));

/** Language ids that differ between VS Code and Monaco. */
export const LANG_ALIAS: Record<string, string> = {
  javascriptreact: "javascript",
  typescriptreact: "typescript",
  jsonc: "json",
  shellscript: "shell",
  solidity: "sol",
};
export const monacoLang = (id: string) => LANG_ALIAS[id] ?? id;

export interface InstalledManifest { ext: ExtInfo; dir: string; pkg: any }

interface GrammarDef {
  scopeName: string;
  path: string;
  injectTo: string[];
  /** Where to get the file when it was not extracted (XML .tmLanguage grammars). */
  remote?: { ns: string; name: string; version: string; dir: string };
}

export interface GrammarLanguage { lang: string; extId: string; extName: string; scopeName: string; builtin: boolean; active: boolean }

/** What the UI shows: languages that have an extension grammar, and whether it is in use. */
export const useGrammarLanguages = create<{ list: GrammarLanguage[] }>(() => ({ list: [] }));

let grammars = new Map<string, GrammarDef>();
let langScope = new Map<string, { scope: string; extId: string; extName: string }>();
let providerDisposables: monaco.IDisposable[] = [];
let otherDisposables: monaco.IDisposable[] = [];
let activeLangs: string[] = [];
const encountered = new Set<string>();
let registry: Promise<Registry> | null = null;
let pick = createScopeMatcher([]);

const join = (dir: string, rel: string) => {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir + sep + rel.replace(/^\.\//, "").replace(/[\\/]/g, sep);
};

// ---------------------------------------------------------------------------------------------
// TextMate engine
// ---------------------------------------------------------------------------------------------

let onigReady: Promise<any> | null = null;
async function loadOnig() {
  onigReady ??= (async () => {
    const mod: any = await import("vscode-oniguruma");
    const onig = mod.default ?? mod;
    await onig.loadWASM(await (await fetch(onigWasmUrl)).arrayBuffer());
    return onig;
  })();
  return onigReady;
}

const extracted = new Map<string, Promise<void>>();

/**
 * The backend extracts only JSON-ish files, so XML (.tmLanguage / .plist) grammars are missing after
 * install. Download the .vsix once and unpack just those files next to the others (shell tools; no
 * code from the extension is ever run).
 */
function extractXmlGrammars(r: NonNullable<GrammarDef["remote"]>): Promise<void> {
  let p = extracted.get(r.dir);
  if (!p) {
    p = (async () => {
      const meta = await registryMeta(r.ns, r.name, r.version);
      const url: string | undefined = meta?.files?.download;
      if (!url || !url.startsWith("https://")) throw new Error("no download URL");
      const win = navigator.userAgent.includes("Windows");
      const q = (s: string) => s.replace(/'/g, "''");
      const cmd = win
        ? `powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $t=[IO.Path]::GetTempFileName(); Invoke-WebRequest -UseBasicParsing -Uri '${q(url)}' -OutFile $t; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($t); foreach($e in $z.Entries){ if($e.FullName -match '^extension/[^:]+\.(tmLanguage|plist|tmGrammar|xml)$' -and $e.FullName -notmatch '\.\.'){ $o=Join-Path '${q(r.dir)}' $e.FullName.Substring(10); New-Item -ItemType Directory -Force (Split-Path $o) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$o,$true) } }; $z.Dispose(); Remove-Item $t"`
        : `d=$(mktemp -d) && curl -fsSL ${shellQuote(url)} -o "$d/x.vsix" && unzip -q -o "$d/x.vsix" 'extension/*.tmLanguage' 'extension/*.plist' 'extension/*.tmGrammar' -d "$d/x"; [ -d "$d/x/extension" ] && cp -R "$d/x/extension/." ${shellQuote(r.dir)}; rm -rf "$d"`;
      const res = await runCommand(cmd, null).done;
      if (res.code !== 0) throw new Error(res.stderr || "extraction failed");
    })();
    p.catch(() => extracted.delete(r.dir));
    extracted.set(r.dir, p);
  }
  return p;
}

async function readGrammarText(g: GrammarDef): Promise<string> {
  try {
    return await api.readFile(g.path);
  } catch (e) {
    if (!g.remote) throw e;
  }
  await extractXmlGrammars(g.remote!);
  return api.readFile(g.path);
}

function getRegistry(): Promise<Registry> {
  registry ??= (async () => {
    const mod: any = await import("vscode-textmate");
    const tm = mod.default ?? mod;
    const onig = await loadOnig();
    return new tm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns: string[]) => onig.createOnigScanner(patterns),
        createOnigString: (s: string) => onig.createOnigString(s),
      }),
      loadGrammar: async (scopeName: string): Promise<IRawGrammar | null> => {
        const g = grammars.get(scopeName);
        if (!g) return null; // embedded language nobody provides: that part stays plain
        const text = await readGrammarText(g);
        return tm.parseRawGrammar(text, g.path);
      },
      getInjections: (scopeName: string) => [...grammars.values()].filter((g) => g.injectTo.includes(scopeName)).map((g) => g.scopeName),
    }) as Registry;
  })();
  return registry;
}

class TMState implements monaco.languages.IState {
  readonly stack: StateStack;
  constructor(stack: StateStack) { this.stack = stack; }
  clone() { return this; } // StateStack is immutable
  equals(o: monaco.languages.IState) { return o instanceof TMState && (o.stack === this.stack || o.stack.equals(this.stack)); }
}

function tokensProvider(grammar: IGrammar, initial: StateStack): monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TMState(initial),
    tokenize(line, state) {
      const r = grammar.tokenizeLine(line, (state as TMState).stack, 500);
      const tokens: monaco.languages.IToken[] = [];
      for (const t of r.tokens) {
        const scopes = pick(t.scopes);
        if (tokens.length && tokens[tokens.length - 1].scopes === scopes) continue; // merge equal neighbours
        tokens.push({ startIndex: t.startIndex, scopes });
      }
      return { tokens, endState: new TMState(r.ruleStack) };
    },
  };
}

let generation = 0;
async function registerProvider(lang: string) {
  const gen = generation;
  const entry = langScope.get(lang);
  if (!entry) return;
  try {
    const reg = await getRegistry();
    const grammar = await reg.loadGrammar(entry.scope);
    if (!grammar || gen !== generation || !activeLangs.includes(lang)) return;
    const { INITIAL } = ((m: any) => m.default ?? m)(await import("vscode-textmate"));
    providerDisposables.push(monaco.languages.setTokensProvider(lang, tokensProvider(grammar, INITIAL)));
  } catch (e) {
    console.warn(`grammar ${entry.scope} failed`, e);
  }
}

/** Registers tokenizers for active languages — now if a model already uses them, else on first use. */
function registerProviders() {
  // Old providers go only after the new ones are in, so re-registering doesn't flash plain text.
  const old = providerDisposables;
  providerDisposables = [];
  generation++;
  const inUse = new Set(monaco.editor.getModels().map((m) => m.getLanguageId()));
  const pending: Promise<void>[] = [];
  for (const lang of activeLangs) {
    if (inUse.has(lang) || encountered.has(lang)) {
      encountered.add(lang);
      pending.push(registerProvider(lang));
    } else {
      providerDisposables.push(monaco.languages.onLanguage(lang, () => { encountered.add(lang); registerProvider(lang); }));
    }
  }
  Promise.all(pending).finally(() => old.forEach((d) => d.dispose()));
}

/** Re-picks token names for a new color theme (`selectors` = its rule tokens) and re-tokenizes. */
export function setGrammarThemeSelectors(selectors: string[]) {
  pick = createScopeMatcher(selectors);
  if (activeLangs.length) registerProviders();
}

// ---------------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------------

export async function activateLanguages(manifests: InstalledManifest[], prefs: Record<string, boolean>) {
  otherDisposables.forEach((d) => d.dispose());
  otherDisposables = [];
  grammars = new Map();
  langScope = new Map();
  registry = null; // grammar set changed
  const configs = new Map<string, string>();

  for (const { ext, dir, pkg } of manifests) {
    const c = pkg?.contributes ?? {};
    for (const l of Array.isArray(c.languages) ? c.languages : []) {
      if (typeof l?.id !== "string") continue;
      const id = monacoLang(l.id);
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
      // Monaco merges repeated registrations of an id, so built-in languages just gain extensions.
      monaco.languages.register({
        id,
        extensions: strs(l.extensions),
        filenames: strs(l.filenames),
        aliases: strs(l.aliases),
        mimetypes: strs(l.mimetypes),
        ...(typeof l.firstLine === "string" ? { firstLine: l.firstLine } : {}),
      });
      if (typeof l.configuration === "string" && !configs.has(id)) configs.set(id, join(dir, l.configuration));
    }
    for (const g of Array.isArray(c.grammars) ? c.grammars : []) {
      if (typeof g?.scopeName !== "string" || typeof g?.path !== "string") continue;
      if (!grammars.has(g.scopeName)) {
        grammars.set(g.scopeName, {
          scopeName: g.scopeName,
          path: join(dir, g.path),
          injectTo: Array.isArray(g.injectTo) ? g.injectTo : [],
          remote: ext.source === "openvsx" ? { ns: ext.publisher || ext.id.split(".")[0], name: ext.name, version: ext.version, dir } : undefined,
        });
      }
      if (typeof g.language === "string") {
        const lang = monacoLang(g.language);
        if (!langScope.has(lang)) langScope.set(lang, { scope: g.scopeName, extId: ext.id, extName: ext.displayName });
      }
    }
  }

  const useGrammar = (lang: string) => prefs[lang] ?? !BUILTIN_LANGUAGES.has(lang);
  activeLangs = [...langScope.keys()].filter(useGrammar);
  useGrammarLanguages.setState({
    list: [...langScope.entries()].map(([lang, e]) => ({ lang, extId: e.extId, extName: e.extName, scopeName: e.scope, builtin: BUILTIN_LANGUAGES.has(lang), active: useGrammar(lang) })),
  });
  registerProviders();

  // Language configuration: always for new languages, for built-in ones only with the grammar on.
  await Promise.all([...configs].map(async ([lang, path]) => {
    if (BUILTIN_LANGUAGES.has(lang) && prefs[lang] !== true) return;
    try {
      const cfg = convertLanguageConfiguration(parseJsonc(await api.readFile(path)));
      otherDisposables.push(monaco.languages.setLanguageConfiguration(lang, cfg));
    } catch (e) {
      console.warn(`language configuration for ${lang} failed`, e);
    }
  }));

  // Files opened before their language was known were created as plain text.
  for (const m of monaco.editor.getModels()) {
    if (m.getLanguageId() !== "plaintext" || m.uri.scheme === "inmemory") continue;
    const lang = languageForPath(m.uri.path);
    if (lang !== "plaintext") monaco.editor.setModelLanguage(m, lang);
  }
}
