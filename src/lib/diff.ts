// Line diff (Myers) and a 3-way merge on top of it. Used by the quick-diff gutter and the merge editor.

/** A changed range: a[aStart, aEnd) was replaced by b[bStart, bEnd). 0-based, end-exclusive. */
export interface Hunk { aStart: number; aEnd: number; bStart: number; bEnd: number }

/**
 * Myers O(ND) diff of two line arrays. Past `maxCost` edits the rest is reported as one big hunk
 * (keeps the gutter responsive on rewrites of huge files).
 */
export function diffLines(a: string[], b: string[], maxCost = 1500): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let ea = a.length, eb = b.length;
  while (ea > pre && eb > pre && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - pre, m = eb - pre;
  if (!n && !m) return [];
  const whole = [{ aStart: pre, aEnd: ea, bStart: pre, bEnd: eb }];
  if (!n || !m) return whole;
  const A = (i: number) => a[pre + i], B = (i: number) => b[pre + i];

  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] = snapshot of v[k] for k in [-d, d] taken before step d (i.e. the result of step d-1).
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    if (d > maxCost) return whole;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A(x) === B(y)) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { done = true; break; }
    }
  }

  // Backtrack: one edit (insert or delete) per d.
  const edits: { del: boolean; x: number; y: number }[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const snap = trace[d];
    const get = (k: number) => snap[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = get(pk), py = px - pk;
    edits.push({ del: !down, x: px, y: py });
    x = px; y = py;
  }
  edits.reverse();

  const out: Hunk[] = [];
  for (const e of edits) {
    let h = out[out.length - 1];
    if (!h || h.aEnd !== e.x || h.bEnd !== e.y) out.push((h = { aStart: e.x, aEnd: e.x, bStart: e.y, bEnd: e.y }));
    if (e.del) h.aEnd++; else h.bEnd++;
  }
  return out.map((h) => ({ aStart: h.aStart + pre, aEnd: h.aEnd + pre, bStart: h.bStart + pre, bEnd: h.bEnd + pre }));
}

/** Splits text into lines, dropping the empty line after a final newline (reported separately). */
export function splitLines(text: string): { lines: string[]; finalEol: boolean; crlf: boolean } {
  const crlf = /\r\n/.test(text);
  const lines = text.split(/\r?\n/);
  const finalEol = lines.length > 1 && lines[lines.length - 1] === "";
  if (finalEol) lines.pop();
  if (lines.length === 1 && lines[0] === "") lines.pop();
  return { lines, finalEol, crlf };
}

export type RegionKind = "stable" | "ours" | "theirs" | "same" | "conflict";
/** One region of a 3-way merge. Ranges are 0-based, end-exclusive line ranges in each version. */
export interface Region { kind: RegionKind; base: [number, number]; ours: [number, number]; theirs: [number, number] }

/**
 * diff3: regions where only one side changed are taken automatically ("ours"/"theirs"/"same"),
 * overlapping or touching changes on both sides become "conflict".
 */
export function merge3(base: string[], ours: string[], theirs: string[]): Region[] {
  const hs = [
    ...diffLines(base, ours, 5000).map((h) => ({ ...h, side: 0 })),
    ...diffLines(base, theirs, 5000).map((h) => ({ ...h, side: 1 })),
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd);
  const out: Region[] = [];
  let pos = 0, offA = 0, offB = 0;
  const stable = (s: number, e: number) => {
    if (e > s) out.push({ kind: "stable", base: [s, e], ours: [s + offA, e + offA], theirs: [s + offB, e + offB] });
  };
  for (let i = 0; i < hs.length; ) {
    const gS = hs[i].aStart;
    let gE = hs[i].aEnd;
    const group = [hs[i++]];
    while (i < hs.length && hs[i].aStart <= gE) { gE = Math.max(gE, hs[i].aEnd); group.push(hs[i++]); }
    stable(pos, gS);
    const range = (side: number, off: number): [number, number] => {
      const g = group.filter((h) => h.side === side);
      if (!g.length) return [gS + off, gE + off];
      const first = g[0], last = g[g.length - 1];
      return [first.bStart - (first.aStart - gS), last.bEnd + (gE - last.aEnd)];
    };
    const o = range(0, offA), t = range(1, offB);
    const hasA = group.some((h) => h.side === 0), hasB = group.some((h) => h.side === 1);
    const same = o[1] - o[0] === t[1] - t[0] && ours.slice(o[0], o[1]).every((l, j) => l === theirs[t[0] + j]);
    out.push({ kind: hasA && hasB ? (same ? "same" : "conflict") : hasA ? "ours" : "theirs", base: [gS, gE], ours: o, theirs: t });
    offA = o[1] - gE;
    offB = t[1] - gE;
    pos = gE;
  }
  stable(pos, base.length);
  return out;
}

/**
 * A zero-context patch that turns hunk `h` of base → modified into a change of `rel` alone
 * (for `git apply --cached --unidiff-zero`). Keeps the base file's line endings.
 */
export function hunkPatch(rel: string, base: ReturnType<typeof splitLines>, mod: ReturnType<typeof splitLines>, h: Hunk): string {
  h = { ...h };
  // Appending after a last line that has no newline also changes that line: include it.
  const aTail = h.aEnd === base.lines.length && !base.finalEol;
  const bTail = h.bEnd === mod.lines.length && !mod.finalEol;
  if ((aTail || bTail) && h.aStart > 0 && h.bStart > 0 && (h.aStart === h.aEnd || h.bStart === h.bEnd)) { h.aStart--; h.bStart--; }
  const eol = base.crlf ? "\r\n" : "\n";
  const oc = h.aEnd - h.aStart, nc = h.bEnd - h.bStart;
  const out = [`diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n@@ -${oc ? h.aStart + 1 : h.aStart},${oc} +${nc ? h.aStart + 1 : h.aStart},${nc} @@\n`];
  const emit = (sign: string, lines: string[], s: number, e: number, noEol: boolean) => {
    for (let i = s; i < e; i++) {
      const last = i === e - 1 && noEol;
      out.push(sign + lines[i] + (last ? "\n\\ No newline at end of file\n" : eol));
    }
  };
  emit("-", base.lines, h.aStart, h.aEnd, h.aEnd === base.lines.length && !base.finalEol);
  emit("+", mod.lines, h.bStart, h.bEnd, h.bEnd === mod.lines.length && !mod.finalEol);
  return out.join("");
}
