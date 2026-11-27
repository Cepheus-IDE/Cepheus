//! Pure 5-field cron parser: next run times and a plain-English description. No imports.
//! Supports lists, ranges, steps, month/day names, 7 = Sunday, the @hourly/@daily… macros, and
//! the standard rule that day-of-month and day-of-week are OR-ed when both are restricted.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
  fields: string[];
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *",
};

function parseField(src: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> {
  const out = new Set<number>();
  const val = (s: string): number => {
    const i = names?.indexOf(s.toUpperCase().slice(0, 3)) ?? -1;
    if (names && i >= 0 && /^[a-z]{3}/i.test(s)) return i + nameBase;
    if (!/^\d+$/.test(s)) throw new Error(`Invalid value "${s}"`);
    return Number(s);
  };
  for (const part of src.split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    let lo: number, hi: number;
    if (range === "*" || range === "?") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [val(a), val(b)];
    } else {
      lo = val(range);
      hi = stepS === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const e = MACROS[expr.trim().toLowerCase()] ?? expr.trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error(`Expected 5 fields (minute hour day month weekday), got ${f.length}`);
  const dow = parseField(f[4], 0, 7, DAYS);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31),
    month: parseField(f[3], 1, 12, MONTHS, 1),
    dow,
    domAny: f[2] === "*" || f[2] === "?",
    dowAny: f[4] === "*" || f[4] === "?",
    fields: f,
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

/** The next `count` run times strictly after `from` (local time). */
export function nextRuns(expr: string | Cron, from: Date, count = 5): Date[] {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const out: Date[] = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (out.length < count && d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    out.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1, 0, 0);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function listOf(set: Set<number>, fmt: (n: number) => string): string {
  const v = [...set].sort((a, b) => a - b);
  // Collapse a contiguous run: "Monday through Friday".
  if (v.length > 2 && v[v.length - 1] - v[0] === v.length - 1) return `${fmt(v[0])} through ${fmt(v[v.length - 1])}`;
  if (v.length <= 1) return v.map(fmt).join("");
  return `${v.slice(0, -1).map(fmt).join(", ")} and ${fmt(v[v.length - 1])}`;
}

function stepOf(field: string): number | null {
  const m = field.match(/^\*\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** "At 09:30, Monday through Friday" style description. */
export function describeCron(expr: string): string {
  const c = parseCron(expr);
  const [fm, fh] = c.fields;
  let time: string;
  const ms = stepOf(fm), hs = stepOf(fh);
  if (fm === "*" && fh === "*") time = "Every minute";
  else if (ms && fh === "*") time = `Every ${ms} minutes`;
  else if (fh === "*" && c.minute.size === 1) time = `At minute ${[...c.minute][0]} of every hour`;
  else if (hs && c.minute.size === 1) time = `At minute ${[...c.minute][0]} past every ${hs} hours`;
  else if (c.minute.size === 1 && c.hour.size <= 6) time = `At ${[...c.hour].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad([...c.minute][0])}`).join(", ")}`;
  else {
    const mins = fm === "*" ? "every minute" : ms ? `every ${ms} minutes` : `minute ${listOf(c.minute, String)}`;
    const hrs = fh === "*" ? "" : hs ? ` past every ${hs} hours` : ` past hour ${listOf(c.hour, String)}`;
    time = `At ${mins}${hrs}`;
  }
  const parts = [time];
  if (!c.domAny) parts.push(`on day ${listOf(c.dom, String)} of the month`);
  if (!c.dowAny) parts.push(`${c.domAny ? "on" : "or on"} ${listOf(c.dow, (d) => DAY_NAMES[d])}`);
  if (c.fields[3] !== "*") parts.push(`in ${listOf(c.month, (m) => MONTH_NAMES[m - 1])}`);
  return parts.join(", ");
}
