//! Minimal dependency-free QR Code encoder: byte mode, error correction level M, versions 1–10
//! (up to 213 bytes) — enough for Expo `exp://` URLs. Follows ISO/IEC 18004 (same structure as
//! Nayuki's reference implementation): RS error correction, interleaving, 8 masks scored by penalty.

// [EC codewords per block, blocks in group 1, data codewords per block g1, blocks in group 2 (g1 + 1 data each)]
const M_BLOCKS: [number, number, number, number][] = [
  [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0],
  [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1],
];
const ALIGN: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

export const QR_MAX_BYTES = 213;

// ---------- Reed–Solomon over GF(256), polynomial 0x11D ----------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

/** Error-correction codewords for `data` (exported for tests). */
export function rsRemainder(data: number[], degree: number): number[] {
  const div = rsDivisor(degree);
  const r = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ (r.shift() as number);
    r.push(0);
    div.forEach((c, i) => (r[i] ^= gfMul(c, f)));
  }
  return r;
}

// ---------- BCH codes for format / version info ----------

/** 15-bit format info for level M (bits 00) and a mask (exported for tests). */
export function formatBits(mask: number): number {
  const data = (0 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

// ---------- encoder ----------

export interface QrCode { version: number; size: number; mask: number; modules: boolean[][] }

const textBytes = (s: string) => Array.from(new TextEncoder().encode(s));

function dataCapacity(ver: number): number {
  const [, b1, d1, b2] = M_BLOCKS[ver - 1];
  return b1 * d1 + b2 * (d1 + 1);
}

/** Encodes text (UTF-8, byte mode) at level M; throws when it doesn't fit in version 10. */
export function encodeQr(text: string): QrCode {
  const bytes = textBytes(text);
  let ver = 1;
  for (; ver <= 10; ver++) {
    const bits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (bits <= dataCapacity(ver) * 8) break;
  }
  if (ver > 10) throw new Error(`Text too long for a QR code (${bytes.length} bytes, max ${QR_MAX_BYTES})`);

  // Bit stream: mode 0100, length, data, terminator, pad to bytes, pad codewords 0xEC/0x11.
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = dataCapacity(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // Split into blocks, add EC, interleave.
  const [ec, b1, d1, b2] = M_BLOCKS[ver - 1];
  const blocks: number[][] = [];
  let k = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d1 + 1;
    blocks.push(data.slice(k, k + len));
    k += len;
  }
  const ecBlocks = blocks.map((b) => rsRemainder(b, ec));
  const codewords: number[] = [];
  for (let i = 0; i <= d1; i++) for (const b of blocks) if (i < b.length) codewords.push(b[i]);
  for (let i = 0; i < ec; i++) for (const e of ecBlocks) codewords.push(e[i]);

  const size = ver * 4 + 17;
  const base = new Grid(size);
  base.drawFunctionPatterns(ver);
  base.drawCodewords(codewords);

  let best: Grid | null = null, bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = base.clone();
    g.applyMask(mask);
    g.drawFormat(mask);
    const score = g.penalty();
    if (score < bestScore) { best = g; bestMask = mask; bestScore = score; }
  }
  return { version: ver, size, mask: bestMask, modules: best!.m };
}

class Grid {
  size: number;
  m: boolean[][];
  fn: boolean[][];
  constructor(size: number, m?: boolean[][], fn?: boolean[][]) {
    this.size = size;
    this.m = m ?? Array.from({ length: size }, () => new Array(size).fill(false));
    this.fn = fn ?? Array.from({ length: size }, () => new Array(size).fill(false));
  }
  clone() { return new Grid(this.size, this.m.map((r) => r.slice()), this.fn); }
  set(x: number, y: number, dark: boolean) { this.m[y][x] = dark; this.fn[y][x] = true; }

  drawFunctionPatterns(ver: number) {
    const n = this.size;
    for (let i = 0; i < n; i++) { this.set(6, i, i % 2 === 0); this.set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < n && y >= 0 && y < n) this.set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = ALIGN[ver - 1];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    this.drawFormat(0); // reserve
    if (ver >= 7) {
      const v = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const bit = ((v >>> i) & 1) === 1, a = n - 11 + (i % 3), b = Math.floor(i / 3);
        this.set(a, b, bit);
        this.set(b, a, bit);
      }
    }
  }

  drawFormat(mask: number) {
    const bits = formatBits(mask), n = this.size;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // dark module
  }

  drawCodewords(data: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
        if (!this.fn[y][x] && i < data.length * 8) {
          this.m[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) {
      if (!this.fn[y][x] && maskBit(mask, x, y)) this.m[y][x] = !this.m[y][x];
    }
  }

  penalty(): number {
    const n = this.size, m = this.m;
    let score = 0, dark = 0;
    const lineScore = (get: (i: number) => boolean) => {
      let s = 0, run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && get(i) === get(i - 1)) run++;
        else { if (run >= 5) s += run - 2; run = 1; }
      }
      // Finder-like 1:1:3:1:1 patterns with 4 light modules on one side.
      for (let i = 0; i + 7 <= n; i++) {
        const p = [1, 0, 1, 1, 1, 0, 1].every((v, k) => get(i + k) === (v === 1));
        if (!p) continue;
        const before = [1, 2, 3, 4].every((k) => i - k < 0 || !get(i - k));
        const after = [7, 8, 9, 10].every((k) => i + k >= n || !get(i + k));
        if (before || after) s += 40;
      }
      return s;
    };
    for (let y = 0; y < n; y++) score += lineScore((x) => m[y][x]);
    for (let x = 0; x < n; x++) score += lineScore((y) => m[y][x]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
    for (const row of m) for (const c of row) if (c) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1;
    return score + Math.max(0, k) * 10;
  }
}

/** Mask condition (true = invert) for mask pattern 0–7. */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** SVG path ("M x y h1 v1 h-1z" per dark module) with a 4-module quiet zone. */
export function qrPath(q: QrCode): string {
  let d = "";
  q.modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return d;
}
