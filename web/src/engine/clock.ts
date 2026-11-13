/**
 * Mission clock (docs/METHODS.md §17): when does each condition next change? A condition is a margin series (degrees)
 * that is positive while it holds, sampled every step:
 *   Sun up        = Sun elevation − terrain horizon + Sun's angular radius   (some of the disc visible)
 *   Earth up      = Earth elevation − terrain horizon                         (centre above the terrain: METHODS §6)
 *   DSN           = highest Moon elevation over the three 70 m antennas − 6°
 *   link to Earth = min(Earth up, DSN);   ops window = min(Sun up, link)
 * Crossings are found by linear interpolation between samples (an hour apart in the 3D view: minutes, not exact).
 */
import { horizonAtPoint, type HorizonGrid } from "./horizon";
import { angularRadiusDeg } from "./sky";
import type { Track } from "./tracks";

/** Margin series of a body at a point: elevation − horizon (+ angular radius when `limb`: any part of the disc). */
export function marginSeries(g: HorizonGrid, fr: number, fc: number, t: Track, bodyRadiusKm: number, limb: boolean): Float64Array {
  const out = new Float64Array(t.elev_deg.length);
  for (let i = 0; i < out.length; i++)
    out[i] = t.elev_deg[i] - horizonAtPoint(g, fr, fc, t.az_grid_deg[i]) + (limb ? angularRadiusDeg(bodyRadiusKm, t.dist_km[i]) : 0);
  return out;
}

/** Element-wise minimum: all conditions hold while the minimum is positive. */
export function allOf(...ms: ArrayLike<number>[]): Float64Array {
  const out = new Float64Array(ms[0].length);
  for (let i = 0; i < out.length; i++) { let v = Infinity; for (const m of ms) v = Math.min(v, m[i]); out[i] = v; }
  return out;
}

/** Value of a margin series at fractional index t (linear between samples, clamped to the ends). */
export function marginAt(m: ArrayLike<number>, t: number): number {
  const i = Math.max(0, Math.min(m.length - 2, Math.floor(t))), f = Math.max(0, Math.min(1, t - i));
  return m[i] * (1 - f) + m[i + 1] * f;
}

export interface Change { up: boolean; at: number | null }

/** Whether the condition holds at fractional index t, and the fractional index of its next change (null: none in the series). */
export function nextChange(m: ArrayLike<number>, t: number): Change {
  const up = marginAt(m, t) > 0;
  for (let i = Math.max(0, Math.floor(t)); i < m.length - 1; i++) {
    const x0 = Math.max(i, t), a = i < t ? marginAt(m, t) : m[i], b = m[i + 1];
    if ((a > 0) !== up) return { up, at: x0 };
    if ((b > 0) !== up) return { up, at: a === b ? i + 1 : x0 + (a / (a - b)) * (i + 1 - x0) };
  }
  return { up, at: null };
}

/** Steps from `a` until a 0/1 (or fraction) series changes between "> 0" and "0"; null if it does not before `end`. */
export function stepsUntilChange(v: ArrayLike<number>, a: number, end = v.length): { up: boolean; steps: number | null } {
  const up = v[a] > 0;
  for (let i = a + 1; i < end; i++) if ((v[i] > 0) !== up) return { up, steps: i - a };
  return { up, steps: null };
}

/** "2 d 4 h", "5 h 10 min", "12 min" */
export function fmtDuration(hours: number): string {
  if (hours >= 48) { const h = Math.round(hours); return `${Math.floor(h / 24)} d ${h % 24} h`; }
  const min = Math.max(1, Math.round(hours * 60));
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
}

/** Compass word for a true azimuth (deg from north, clockwise). */
export const compass = (az: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((az % 360) + 360) % 360) / 45) % 8];
