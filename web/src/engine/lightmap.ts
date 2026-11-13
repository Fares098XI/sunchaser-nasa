import type { HorizonGrid } from "./horizon";
import { angularRadiusDeg, visibleDiscFraction } from "./sky";

export interface TrackIn { az_grid_deg: ArrayLike<number>; elev_deg: ArrayLike<number>; dist_km: ArrayLike<number> }

/**
 * Light painting: per horizon cell, the running average over the track of (Sun) the visible solar-disc fraction or
 * (Earth) the share of hours with Earth's centre above the terrain — the same quantities as the panel stats —
 * at `checkpoints` evenly spaced moments, as uint8 (0-255 = 0-100 %). Layout [checkpoint][row][col].
 */
export function lightMap(g: HorizonGrid, t: TrackIn, bodyRadiusKm: number, earthRule: boolean, checkpoints: number,
  onProgress?: (fraction: number) => void): Uint8Array {
  const plane = g.rows * g.cols, n = t.elev_deg.length;
  const sum = new Float64Array(plane);
  const out = new Uint8Array(checkpoints * plane);
  let next = 0;
  for (let h = 0; h < n; h++) {
    const u = (((t.az_grid_deg[h] % 360) + 360) % 360) * g.nAz / 360;
    const i = Math.floor(u) % g.nAz, f = u - Math.floor(u), j = (i + 1) % g.nAz;
    const el = t.elev_deg[h], r = angularRadiusDeg(bodyRadiusKm, t.dist_km[h]);
    const bi = i * plane, bj = j * plane;
    for (let p = 0; p < plane; p++) {
      const hz = (g.k[bi + p] * (1 - f) + g.k[bj + p] * f) * g.quantum;
      const v = visibleDiscFraction(el, hz, r);
      sum[p] += earthRule ? (v >= 0.5 ? 1 : 0) : v;
    }
    while (next < checkpoints && h + 1 >= Math.round(((next + 1) * n) / checkpoints)) {
      const o = next * plane, cnt = h + 1;
      for (let p = 0; p < plane; p++) out[o + p] = Math.round((255 * sum[p]) / cnt);
      next++;
      onProgress?.(next / checkpoints);
    }
  }
  return out;
}
