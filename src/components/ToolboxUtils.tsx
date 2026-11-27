import { ReactNode, useEffect, useMemo, useState } from "react";
import {
  b64decode, b64encode, decodeJwt, formatColor, parseColor, parseJsonWithPos, parseTime, parseToml, parseYaml,
  relativeTime, toToml, toYaml, uuidv4, uuidv7,
} from "../lib/toolbox/devutils";
import { describeCron, nextRuns } from "../lib/toolbox/cron";
import { diffLines } from "../lib/diff";
import { loadLocal, saveLocal } from "../lib/toolbox/state";
import { copy } from "./GitWidgets";

type ToolId = "format" | "jwt" | "encode" | "uuid" | "time" | "regex" | "color" | "hash" | "diff" | "cron";
const TOOLS: { id: ToolId; label: string; icon: string }[] = [
  { id: "format", label: "JSON / YAML / TOML", icon: "json" },
  { id: "jwt", label: "JWT decoder", icon: "key" },
  { id: "encode", label: "Base64 / URL", icon: "symbol-string" },
  { id: "uuid", label: "UUID", icon: "symbol-key" },
  { id: "time", label: "Timestamp", icon: "clock" },
  { id: "regex", label: "Regex tester", icon: "regex" },
  { id: "color", label: "Color", icon: "symbol-color" },
  { id: "hash", label: "Hash", icon: "shield" },
  { id: "diff", label: "Text diff", icon: "diff" },
  { id: "cron", label: "Cron", icon: "watch" },
];

const TOOL_KEY = "cepheus.toolbox.util";

export default function DevUtils() {
  const [tool, setTool] = useState<ToolId>(() => loadLocal<ToolId>(TOOL_KEY, "format"));
  useEffect(() => saveLocal(TOOL_KEY, tool), [tool]);
  return (
    <div className="tb-section tb-utils">
      <div className="tb-util-picker">
        {TOOLS.map((t) => (
          <button key={t.id} className={`tb-chip ${tool === t.id ? "on" : ""}`} title={t.label} onClick={() => setTool(t.id)}>
            <i className={`codicon codicon-${t.icon}`} /> {t.label}
          </button>
        ))}
      </div>
      <div className="tb-scroll tb-util">
        {tool === "format" && <FormatTool />}
        {tool === "jwt" && <JwtTool />}
        {tool === "encode" && <EncodeTool />}
        {tool === "uuid" && <UuidTool />}
        {tool === "time" && <TimeTool />}
        {tool === "regex" && <RegexTool />}
        {tool === "color" && <ColorTool />}
        {tool === "hash" && <HashTool />}
        {tool === "diff" && <DiffTool />}
        {tool === "cron" && <CronTool />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shared bits

function Out({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="tb-out">
      <span className="tb-out-label">{label}</span>
      <span className={`tb-out-value ${mono ? "mono" : ""}`}>{value}</span>
      <button className="icon-btn small" title="Copy" onClick={() => copy(value)}><i className="codicon codicon-copy" /></button>
    </div>
  );
}

function Status({ error, ok }: { error?: string | null; ok?: ReactNode }) {
  if (error) return <div className="tb-error">{error}</div>;
  return ok ? <div className="tb-ok">{ok}</div> : null;
}

function Area({ value, onChange, placeholder, rows = 6 }: { value: string; onChange: (v: string) => void; placeholder: string; rows?: number }) {
  return <textarea className="tb-area" spellCheck={false} rows={rows} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />;
}

function attempt<T>(fn: () => T): { value?: T; error?: string } {
  try { return { value: fn() }; } catch (e: any) { return { error: String(e?.message ?? e) }; }
}

// ------------------------------------------------------------------ JSON / YAML / TOML

type Fmt = "json" | "yaml" | "toml";
function detectFormat(s: string): Fmt {
  const t = s.trim();
  if (/^[[{]/.test(t)) return "json";
  if (/^\s*\[[\w."' -]+\]\s*$/m.test(t) || /^[\w."-]+\s*=\s*/m.test(t)) return "toml";
  return "yaml";
}

function FormatTool() {
  const [input, setInput] = useState("");
  const [from, setFrom] = useState<Fmt | "auto">("auto");
  const [to, setTo] = useState<Fmt>("json");
  const [indent, setIndent] = useState(2);
  const src = from === "auto" ? detectFormat(input) : from;
  const r = useMemo(() => {
    if (!input.trim()) return {};
    return attempt(() => {
      const v = src === "json" ? parseJsonWithPos(input) : src === "yaml" ? parseYaml(input) : parseToml(input);
      return to === "json" ? JSON.stringify(v, null, indent) : to === "yaml" ? toYaml(v) : toToml(v);
    });
  }, [input, src, to, indent]);
  return (
    <>
      <div className="tb-row-ctl">
        <select value={from} onChange={(e) => setFrom(e.target.value as Fmt | "auto")}>
          <option value="auto">Auto ({src.toUpperCase()})</option>
          <option value="json">JSON</option><option value="yaml">YAML</option><option value="toml">TOML</option>
        </select>
        <i className="codicon codicon-arrow-right muted" />
        <select value={to} onChange={(e) => setTo(e.target.value as Fmt)}>
          <option value="json">JSON</option><option value="yaml">YAML</option><option value="toml">TOML</option>
        </select>
        {to === "json" && (
          <select value={indent} onChange={(e) => setIndent(Number(e.target.value))} title="Indent">
            <option value={2}>2 spaces</option><option value={4}>4 spaces</option><option value={0}>minified</option>
          </select>
        )}
      </div>
      <Area value={input} onChange={setInput} placeholder="Paste JSON, YAML or TOML…" rows={8} />
      <Status error={r.error} ok={r.value !== undefined && <><i className="codicon codicon-check" /> Valid {src.toUpperCase()}</>} />
      {r.value !== undefined && (
        <div className="tb-result">
          <button className="icon-btn small tb-copy" title="Copy" onClick={() => copy(r.value!)}><i className="codicon codicon-copy" /></button>
          <pre>{r.value}</pre>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ JWT

function JwtTool() {
  const [token, setToken] = useState("");
  const r = useMemo(() => (token.trim() ? attempt(() => decodeJwt(token)) : {}), [token]);
  const j = r.value;
  return (
    <>
      <Area value={token} onChange={setToken} placeholder="Paste a JWT (header.payload.signature)…" rows={4} />
      <div className="tb-note">Decoded locally; the signature is not verified.</div>
      <Status error={r.error} />
      {j && (
        <>
          {j.expired !== null && (
            <div className={j.expired ? "tb-error" : "tb-ok"}>
              <i className={`codicon codicon-${j.expired ? "error" : "check"}`} /> {j.expired ? "Expired" : "Not expired"}
              {j.notYetValid && " · not valid yet (nbf)"}
            </div>
          )}
          {j.header?.alg === "none" && <div className="tb-error">alg is "none": this token is unsigned.</div>}
          {j.times.map((t) => <Out key={t.claim} label={t.claim} value={`${t.date.toLocaleString()} (${relativeTime(t.date.getTime())})`} mono={false} />)}
          <div className="tb-result"><span className="tb-out-label">Header</span><pre>{JSON.stringify(j.header, null, 2)}</pre></div>
          <div className="tb-result">
            <span className="tb-out-label">Payload</span>
            <button className="icon-btn small tb-copy" title="Copy" onClick={() => copy(JSON.stringify(j.payload, null, 2))}><i className="codicon codicon-copy" /></button>
            <pre>{JSON.stringify(j.payload, null, 2)}</pre>
          </div>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Base64 / URL

type EncMode = "b64e" | "b64d" | "b64ue" | "urle" | "urld" | "urlce";
function EncodeTool() {
  const [mode, setMode] = useState<EncMode>("b64e");
  const [input, setInput] = useState("");
  const r = useMemo(() => {
    if (!input) return {};
    return attempt(() => {
      switch (mode) {
        case "b64e": return b64encode(input);
        case "b64ue": return b64encode(input, true);
        case "b64d": return b64decode(input);
        case "urle": return encodeURIComponent(input);
        case "urlce": return encodeURI(input);
        case "urld": return decodeURIComponent(input.replace(/\+/g, " "));
      }
    });
  }, [mode, input]);
  return (
    <>
      <div className="tb-row-ctl">
        <select value={mode} onChange={(e) => setMode(e.target.value as EncMode)}>
          <option value="b64e">Base64 encode</option>
          <option value="b64ue">Base64url encode</option>
          <option value="b64d">Base64 / Base64url decode</option>
          <option value="urle">URL encode (component)</option>
          <option value="urlce">URL encode (full URL)</option>
          <option value="urld">URL decode</option>
        </select>
        {r.value !== undefined && <button className="btn small" title="Use the output as input" onClick={() => { setInput(r.value!); setMode(mode === "b64e" || mode === "b64ue" ? "b64d" : mode === "b64d" ? "b64e" : mode === "urld" ? "urle" : "urld"); }}><i className="codicon codicon-arrow-swap" /> Swap</button>}
      </div>
      <Area value={input} onChange={setInput} placeholder="Text…" rows={5} />
      <Status error={r.error} />
      {r.value !== undefined && (
        <div className="tb-result">
          <button className="icon-btn small tb-copy" title="Copy" onClick={() => copy(r.value!)}><i className="codicon codicon-copy" /></button>
          <pre>{r.value}</pre>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ UUID

function UuidTool() {
  const [version, setVersion] = useState<4 | 7>(7);
  const [count, setCount] = useState(5);
  const [upper, setUpper] = useState(false);
  const gen = () => Array.from({ length: count }, () => (version === 4 ? uuidv4() : uuidv7()));
  const [ids, setIds] = useState<string[]>(gen);
  useEffect(() => setIds(gen()), [version, count]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = ids.map((x) => (upper ? x.toUpperCase() : x));
  return (
    <>
      <div className="tb-row-ctl">
        <select value={version} onChange={(e) => setVersion(Number(e.target.value) as 4 | 7)}>
          <option value={7}>v7 (time-ordered)</option><option value={4}>v4 (random)</option>
        </select>
        <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
          {[1, 5, 10, 25].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} /> UPPER</label>
        <button className="btn small" onClick={() => setIds(gen())}><i className="codicon codicon-refresh" /> New</button>
      </div>
      {shown.map((id) => <Out key={id} label="" value={id} />)}
      {shown.length > 1 && <button className="btn small" onClick={() => copy(shown.join("\n"), `Copied ${shown.length} UUIDs`)}>Copy all</button>}
    </>
  );
}

// ------------------------------------------------------------------ Timestamp

function TimeTool() {
  const [input, setInput] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const r = useMemo(() => attempt(() => parseTime(input)), [input, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = r.value;
  return (
    <>
      <input className="tb-input" placeholder="Unix seconds / milliseconds or a date (empty = now)" value={input} onChange={(e) => setInput(e.target.value)} />
      <Status error={r.error} />
      {t && (
        <>
          <Out label="Unix s" value={String(t.unixS)} />
          <Out label="Unix ms" value={String(t.unixMs)} />
          <Out label="ISO 8601" value={t.iso} />
          <Out label="UTC" value={t.utc} mono={false} />
          <Out label="Local" value={t.local} mono={false} />
          <Out label="Relative" value={t.relative} mono={false} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Regex

function RegexTool() {
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("g");
  const [text, setText] = useState("");
  const r = useMemo(() => {
    if (!pattern) return {};
    return attempt(() => {
      const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
      const matches: RegExpExecArray[] = [];
      for (let m: RegExpExecArray | null; (m = re.exec(text)) && matches.length < 1000; ) {
        matches.push(m);
        if (m[0] === "") re.lastIndex++; // zero-length match: step forward
        if (!flags.includes("g")) break;
      }
      return matches;
    });
  }, [pattern, flags, text]);
  const segs: ReactNode[] = [];
  if (r.value) {
    let last = 0;
    r.value.forEach((m, i) => {
      if (m.index > last) segs.push(text.slice(last, m.index));
      segs.push(<mark key={i} className={i % 2 ? "alt" : ""}>{m[0] || "​"}</mark>);
      last = m.index + m[0].length;
    });
    segs.push(text.slice(last));
  }
  return (
    <>
      <div className="tb-row-ctl">
        <span className="muted mono">/</span>
        <input className="tb-input grow mono" placeholder="pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} spellCheck={false} />
        <span className="muted mono">/</span>
        <input className="tb-input tb-flags mono" value={flags} onChange={(e) => setFlags(e.target.value.replace(/[^dgimsuyv]/g, ""))} title="Flags: g i m s u y d v" />
      </div>
      <Area value={text} onChange={setText} placeholder="Test text…" rows={5} />
      <Status error={r.error} ok={r.value && `${r.value.length}${r.value.length >= 1000 ? "+" : ""} match${r.value.length === 1 ? "" : "es"}`} />
      {r.value && r.value.length > 0 && <pre className="tb-highlight">{segs}</pre>}
      {r.value?.slice(0, 50).map((m, i) => (m.length > 1 || m.groups) && (
        <div key={i} className="tb-groups">
          <span className="tb-out-label">#{i + 1} @{m.index}</span>
          {m.slice(1).map((g, gi) => <span key={gi} className="tb-group-val" title={`Group ${gi + 1}`}>{gi + 1}: {g === undefined ? <em>undefined</em> : JSON.stringify(g)}</span>)}
          {m.groups && Object.entries(m.groups).map(([k, v]) => <span key={k} className="tb-group-val">{k}: {JSON.stringify(v)}</span>)}
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ Color

function ColorTool() {
  const [input, setInput] = useState("#c8a464");
  const r = useMemo(() => attempt(() => { const c = parseColor(input); return { c, f: formatColor(c) }; }), [input]);
  const v = r.value;
  return (
    <>
      <div className="tb-row-ctl">
        <input className="tb-input grow mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="#hex, rgb(), hsl() or oklch()" spellCheck={false} />
        <input type="color" className="tb-colorpick" value={v ? v.f.hex.slice(0, 7) : "#000000"} onChange={(e) => setInput(e.target.value)} title="Pick" />
      </div>
      <Status error={r.error} />
      {v && (
        <>
          <div className="tb-swatch" style={{ background: v.f.rgb }}><span style={{ color: v.c.r * 0.299 + v.c.g * 0.587 + v.c.b * 0.114 > 0.6 ? "#000" : "#fff" }}>{v.f.hex}</span></div>
          <Out label="HEX" value={v.f.hex} />
          <Out label="RGB" value={v.f.rgb} />
          <Out label="HSL" value={v.f.hsl} />
          <Out label="OKLCH" value={v.f.oklch} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Hash

const ALGOS = ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as const;
function HashTool() {
  const [input, setInput] = useState("");
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [b64, setB64] = useState(false);
  useEffect(() => {
    let alive = true;
    const data = new TextEncoder().encode(input);
    Promise.all(ALGOS.map(async (a) => {
      const buf = new Uint8Array(await crypto.subtle.digest(a, data));
      return [a, b64 ? btoa(String.fromCharCode(...buf)) : [...buf].map((x) => x.toString(16).padStart(2, "0")).join("")] as const;
    })).then((list) => alive && setHashes(Object.fromEntries(list)));
    return () => { alive = false; };
  }, [input, b64]);
  return (
    <>
      <Area value={input} onChange={setInput} placeholder="Text to hash (UTF-8)…" rows={4} />
      <label className="check small"><input type="checkbox" checked={b64} onChange={(e) => setB64(e.target.checked)} /> Base64 output</label>
      {ALGOS.map((a) => hashes[a] && <Out key={a} label={a} value={hashes[a]} />)}
    </>
  );
}

// ------------------------------------------------------------------ Diff

function DiffTool() {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const rows = useMemo(() => {
    const al = a.split(/\r?\n/), bl = b.split(/\r?\n/);
    const out: { kind: " " | "-" | "+" | "…"; text: string }[] = [];
    const ctx = (from: number, to: number) => {
      const n = to - from;
      if (n > 6) {
        for (let i = from; i < from + 2; i++) out.push({ kind: " ", text: al[i] });
        out.push({ kind: "…", text: `${n - 4} unchanged lines` });
        for (let i = to - 2; i < to; i++) out.push({ kind: " ", text: al[i] });
      } else for (let i = from; i < to; i++) out.push({ kind: " ", text: al[i] });
    };
    let pa = 0;
    for (const h of diffLines(al, bl, 5000)) {
      ctx(pa, h.aStart);
      for (let i = h.aStart; i < h.aEnd; i++) out.push({ kind: "-", text: al[i] });
      for (let i = h.bStart; i < h.bEnd; i++) out.push({ kind: "+", text: bl[i] });
      pa = h.aEnd;
    }
    ctx(pa, al.length);
    return out;
  }, [a, b]);
  const changes = rows.filter((r) => r.kind === "-" || r.kind === "+").length;
  return (
    <>
      <div className="tb-diff-inputs">
        <Area value={a} onChange={setA} placeholder="Original…" rows={5} />
        <Area value={b} onChange={setB} placeholder="Changed…" rows={5} />
      </div>
      {(a || b) && <div className={changes ? "tb-note" : "tb-ok"}>{changes ? `${rows.filter((r) => r.kind === "-").length} removed · ${rows.filter((r) => r.kind === "+").length} added` : "Identical"}</div>}
      {changes > 0 && (
        <pre className="tb-diff">
          {rows.map((r, i) => <div key={i} className={`tb-diff-line k${r.kind === " " ? "ctx" : r.kind === "-" ? "del" : r.kind === "+" ? "add" : "gap"}`}>{r.kind === "…" ? `  ⋯ ${r.text}` : `${r.kind} ${r.text}`}</div>)}
        </pre>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Cron

function CronTool() {
  const [expr, setExpr] = useState("*/15 9-17 * * 1-5");
  const r = useMemo(() => attempt(() => ({ text: describeCron(expr), next: nextRuns(expr, new Date(), 5) })), [expr]);
  return (
    <>
      <input className="tb-input mono" value={expr} onChange={(e) => setExpr(e.target.value)} placeholder="minute hour day month weekday" spellCheck={false} />
      <div className="tb-note mono">min · hour · day · month · weekday — or @hourly, @daily, @weekly …</div>
      <Status error={r.error} ok={r.value?.text} />
      {r.value && (
        <>
          <span className="tb-out-label">Next runs (local time)</span>
          {r.value.next.map((d) => <Out key={d.getTime()} label={relativeTime(d.getTime())} value={d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} mono={false} />)}
          {!r.value.next.length && <div className="tb-note">No run in the next five years.</div>}
        </>
      )}
    </>
  );
}
