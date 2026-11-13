import type { Track } from "./tracks";
import { horizonAtPoint, type HorizonGrid } from "./horizon";
import { angularRadiusDeg, visibleDiscFraction } from "./sky";

/** Visible disc fraction of a body at a point (fractional horizon-grid coords), for every hour of its track. */
export function siteSeries(g: HorizonGrid, fr: number, fc: number, t: Track, bodyRadiusKm: number): Float64Array {
  const out = new Float64Array(t.elev_deg.length);
  for (let i = 0; i < out.length; i++) {
    const h = horizonAtPoint(g, fr, fc, t.az_grid_deg[i]);
    out[i] = visibleDiscFraction(t.elev_deg[i], h, angularRadiusDeg(bodyRadiusKm, t.dist_km[i]));
  }
  return out;
}

export interface SeriesStats { meanPct: number; anyPct: number; longestZeroH: number }

/** Mean visible fraction (%), share of hours with any part visible (%), longest run of fully hidden hours. */
export function seriesStats(s: ArrayLike<number>): SeriesStats {
  let sum = 0, any = 0, run = 0, longest = 0;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    sum += v;
    if (v > 0) { any++; run = 0; } else { run++; longest = Math.max(longest, run); }
  }
  return { meanPct: (100 * sum) / s.length, anyPct: (100 * any) / s.length, longestZeroH: longest };
}
