/**
 * Slip planner (S3, docs/METHODS.md §18): every site evaluated for a landing on each day around the planned one, at the
 * planned time of day, against the mission's requirements (engine/windows.ts metrics + failBits).
 */
import type { Requirements } from "./windows";

/** fail bits of a day whose stay runs past the ephemeris table */
export const NO_DATA = 255;

/** First day index >= from that meets every requirement, or null. */
export function nextPass(fails: ArrayLike<number>, from: number): number | null {
  for (let k = Math.max(0, from); k < fails.length; k++) if (fails[k] === 0) return k;
  return null;
}

export interface SitePos { id: string; lat_deg: number; lon_deg: number }

/** Great-circle distance on the 1737.4 km sphere (km). */
export function distKm(a: SitePos, b: SitePos) {
  const r = Math.PI / 180, p1 = a.lat_deg * r, p2 = b.lat_deg * r, dl = (b.lon_deg - a.lon_deg) * r;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 1737.4 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Same region" for Plan B (the 10 polar sites lie within ~250 km of each other). */
export const REGION_KM = 400;

/** Other sites within REGION_KM that meet every requirement on day k, nearest to `home` first. */
export function planB(sites: (SitePos & { fails: ArrayLike<number> })[], home: SitePos, k: number, max = 3) {
  return sites.filter((s) => s.id !== home.id && s.fails[k] === 0 && distKm(s, home) <= REGION_KM)
    .map((s) => ({ id: s.id, km: distKm(s, home) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, max);
}

/** Requirements in a short line, e.g. "14 d · Sun ≥ 70 % · link ≥ 50 % · blackout ≤ 24 h" */
export function reqLine(r: Requirements) {
  return [`${r.days} d`, `Sun ≥ ${r.minSunPct} %`, r.maxDarkH != null ? `dark ≤ ${r.maxDarkH} h` : null, `link ≥ ${r.minDtePct} %`,
    r.maxBlackoutH != null ? `blackout ≤ ${r.maxBlackoutH} h` : null, r.battery ? "battery never empty" : null].filter(Boolean).join(" · ");
}
