/** Date formatting and timeline ticks (UTC throughout). */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400e3;

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const isoHour = (ms: number) => new Date(ms).toISOString().slice(0, 13);
export const fmtTime = (ms: number) => new Date(ms).toISOString().slice(11, 16);
export function fmtDate(ms: number, weekday = false) {
  const d = new Date(ms);
  return `${weekday ? WDAY[d.getUTCDay()] + " " : ""}${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export const fmtSpan = (days: number) => (days % 365 === 0 ? `${days / 365} yr` : `${days} d`);
export const MONTHS = MON;

/** Evenly readable ticks for a period of n hours from startMs: [fraction 0..1, label]. */
export function ticks(startMs: number, n: number): [number, string][] {
  const endMs = startMs + (n - 1) * 3600e3, days = n / 24, out: [number, string][] = [];
  const at = (ms: number, label: string) => { if (ms >= startMs && ms <= endMs) out.push([(ms - startMs) / (endMs - startMs), label]); };
  if (days <= 2) {
    for (let ms = Math.ceil(startMs / (6 * 3600e3)) * 6 * 3600e3; ms <= endMs; ms += 6 * 3600e3) at(ms, fmtTime(ms));
  } else if (days <= 120) {
    const step = days <= 10 ? 1 : days <= 45 ? 5 : 15;
    for (let ms = Math.ceil(startMs / DAY_MS) * DAY_MS; ms <= endMs; ms += DAY_MS) {
      const d = new Date(ms);
      if (step === 1 || (d.getUTCDate() - 1) % step === 0 && d.getUTCDate() < 30) at(ms, `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`);
    }
  } else {
    const d = new Date(startMs);
    for (let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; ; m++) {
      const ms = Date.UTC(y, m, 1);
      if (ms > endMs) break;
      const md = new Date(ms);
      at(ms, md.getUTCMonth() === 0 ? String(md.getUTCFullYear()) : MON[md.getUTCMonth()]);
    }
  }
  return out;
}
