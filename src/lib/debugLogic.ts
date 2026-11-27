//! Pure debugger helpers (no imports, so scratchpad scripts can load them with Node directly):
//! breakpoint conditions for the V8 inspector and inline-value extraction.

export interface BreakpointSpec { line: number; enabled: boolean; condition?: string; hitCondition?: string; logMessage?: string }
interface FrameLike { scopes: { objectId: string }[] }
interface VarLike { name: string; value: string }

/** Hit condition (`5`, `>= 5`, `% 3`) → JS test on a per-breakpoint counter. Plain N = from the Nth hit on. */
export function hitExpr(hit: string, key: string): string | null {
  const m = hit.trim().match(/^(>=|<=|==|=|>|<|%)?\s*(\d+)$/);
  if (!m) return null;
  const op = m[1] === "=" ? "==" : m[1] ?? ">=";
  const k = JSON.stringify(key);
  const count = `((globalThis.__cepheusHits ||= {})[${k}] = (globalThis.__cepheusHits[${k}] || 0) + 1)`;
  return op === "%" ? `(${count} % ${m[2]} === 0)` : `(${count} ${op === "==" ? "===" : op} ${m[2]})`;
}

/** Logpoint message `x is {x}` → a template literal. */
export const logTemplate = (msg: string) => "`" + msg.replace(/[`\\]/g, "\\$&").replace(/\$\{/g, "\\${").replace(/\{([^}]+)\}/g, "${$1}") + "`";

/** CDP condition implementing condition + hit count + logpoint (logpoints never pause). */
export function cdpCondition(b: BreakpointSpec, key: string): string | undefined {
  const parts: string[] = [];
  if (b.condition?.trim()) parts.push(`(${b.condition})`);
  if (b.hitCondition?.trim()) { const h = hitExpr(b.hitCondition, key); if (h) parts.push(h); }
  if (b.logMessage?.trim()) parts.push(`(console.log(${logTemplate(b.logMessage)}), false)`);
  return parts.length ? parts.join(" && ") : undefined;
}


/** `name = value` hints for lines from the function start to the paused line. */
export function inlineValues(lines: string[], first: number, frame: FrameLike, vars: Record<string, VarLike[]>, python: boolean): Map<number, string> {
  const values = new Map<string, string>();
  for (const s of frame.scopes) for (const v of vars[s.objectId] ?? []) if (!values.has(v.name)) values.set(v.name, v.value);
  const out = new Map<number, string>();
  if (!values.size) return out;
  lines.forEach((raw, i) => {
    const code = raw.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(python ? /#.*$/ : /\/\/.*$/, "");
    const seen: string[] = [];
    for (const m of code.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) if (values.has(m[0]) && !seen.includes(m[0])) seen.push(m[0]);
    if (!seen.length) return;
    const text = seen.map((n) => { const v = values.get(n)!; return `${n} = ${v.length > 40 ? v.slice(0, 39) + "…" : v}`; }).join(", ");
    out.set(first + i, text.length > 140 ? text.slice(0, 139) + "…" : text);
  });
  return out;
}

