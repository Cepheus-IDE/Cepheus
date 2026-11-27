/** Small line diff (LCS on the changed middle, after trimming the common prefix/suffix). */

export type DiffOp = { kind: "same" | "add" | "del"; text: string; oldLine?: number; newLine?: number };

export function splitLines(s: string | null | undefined): string[] {
  if (s == null || s === "") return [];
  const lines = s.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const MAX_CELLS = 4_000_000;

export function diffLines(before: string | null | undefined, after: string | null | undefined): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "same", text: a[i], oldLine: i + 1, newLine: i + 1 });
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  const n = ma.length;
  const m = mb.length;
  if (n * m > MAX_CELLS) {
    // Too big for the DP table: show the middle as a block replacement.
    ma.forEach((t, i) => ops.push({ kind: "del", text: t, oldLine: start + i + 1 }));
    mb.forEach((t, j) => ops.push({ kind: "add", text: t, newLine: start + j + 1 }));
  } else {
    // lcs[i][j] = LCS length of ma[i..] and mb[j..], stored flat.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) {
        ops.push({ kind: "same", text: ma[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        // deletions before additions, like `diff -u`
        ops.push({ kind: "del", text: ma[i], oldLine: start + i + 1 });
        i++;
      } else {
        ops.push({ kind: "add", text: mb[j], newLine: start + j + 1 });
        j++;
      }
    }
  }
  const shift = endB - endA;
  for (let k = endA; k < a.length; k++) ops.push({ kind: "same", text: a[k], oldLine: k + 1, newLine: k + 1 + shift });
  return ops;
}

export function diffStats(before: string | null | undefined, after: string | null | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of diffLines(before, after)) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffOp[];
}

/** Groups the diff into hunks with `context` unchanged lines around each change. */
export function hunks(before: string | null | undefined, after: string | null | undefined, context = 2): Hunk[] {
  const ops = diffLines(before, after);
  const out: Hunk[] = [];
  let cur: Hunk | null = null;
  let lastChange = -Infinity;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind !== "same") {
      if (!cur || k - lastChange > context * 2) {
        const from = Math.max(0, k - context);
        if (cur) {
          // close the previous hunk with trailing context
          for (let t = lastChange + 1; t <= Math.min(lastChange + context, ops.length - 1); t++) cur.lines.push(ops[t]);
        }
        cur = { oldStart: ops[from].oldLine ?? 0, newStart: ops[from].newLine ?? 0, lines: ops.slice(from, k) };
        out.push(cur);
      } else {
        for (let t = lastChange + 1; t < k; t++) cur.lines.push(ops[t]);
      }
      cur.lines.push(op);
      lastChange = k;
    }
  }
  if (cur) for (let t = lastChange + 1; t <= Math.min(lastChange + context, ops.length - 1); t++) cur.lines.push(ops[t]);
  return out;
}
