import { horizonAtPoint, type HorizonGrid } from "./horizon";
import type { RouteGrid } from "./lightpath";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, angularRadiusDeg, visibleDiscFraction } from "./sky";
import type { Track } from "./tracks";

const AU_KM = 149597870.7;

export interface GridGeom { x0_m: number; y0_m: number; rows: number; cols: number }

/**
 * Routing grid for Light Path over the analysed region (docs/METHODS.md §12):
 * - cells of `cellM` (80 m) covering the terrain window;
 * - slope: LOLA heights averaged to 2 x 2 blocks, central differences, the steepest of the cell's blocks;
 * - per hour, the visible Sun and Earth disc fractions at each cell centre from the same horizons and formula as
 *   every other number in Sunchaser.
 */
export function buildRouteGrid(
  hg: HorizonGrid, hm: GridGeom & { cell_m: number }, heights: Float32Array, tm: GridGeom & { res_m: number },
  sun: Track, earth: Track, maxSlopeDeg: number, cellM = 80,
): RouteGrid {
  const n = Math.floor((tm.cols * tm.res_m) / cellM);
  const N = n * n, H = sun.elev_deg.length;
  // slope on blocks of 2 x 2 DEM cells
  const bn = Math.floor(tm.cols / 2), bres = tm.res_m * 2;
  const bh = new Float64Array(bn * bn);
  for (let r = 0; r < bn; r++) for (let c = 0; c < bn; c++) {
    const i = 2 * r * tm.cols + 2 * c;
    bh[r * bn + c] = (heights[i] + heights[i + 1] + heights[i + tm.cols] + heights[i + tm.cols + 1]) / 4;
  }
  const bslope = new Float64Array(bn * bn);
  for (let r = 0; r < bn; r++) for (let c = 0; c < bn; c++) {
    const at = (rr: number, cc: number) => bh[Math.min(bn - 1, Math.max(0, rr)) * bn + Math.min(bn - 1, Math.max(0, cc))];
    const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * bres), dy = (at(r - 1, c) - at(r + 1, c)) / (2 * bres);
    bslope[r * bn + c] = (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  }
  const per = Math.round(cellM / bres);
  const slopeDeg = new Float32Array(N), drivable = new Uint8Array(N);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let m = 0;
    for (let i = 0; i < per; i++) for (let j = 0; j < per; j++) m = Math.max(m, bslope[(r * per + i) * bn + c * per + j]);
    slopeDeg[r * n + c] = m;
    drivable[r * n + c] = m < maxSlopeDeg ? 1 : 0;
  }
  // lighting at cell centres
  const sunFrac = new Float32Array(H * N), earthFrac = new Float32Array(H * N), sunDistAu = new Float64Array(H);
  const fr = new Float64Array(N), fc = new Float64Array(N);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const x = tm.x0_m + (c + 0.5) * cellM, y = tm.y0_m - (r + 0.5) * cellM;
    fr[r * n + c] = (hm.y0_m - y) / hm.cell_m - 0.5;
    fc[r * n + c] = (x - hm.x0_m) / hm.cell_m - 0.5;
  }
  for (let h = 0; h < H; h++) {
    sunDistAu[h] = sun.dist_km[h] / AU_KM;
    const rs = angularRadiusDeg(SUN_RADIUS_KM, sun.dist_km[h]), re = angularRadiusDeg(EARTH_RADIUS_KM, earth.dist_km[h]);
    for (let i = 0; i < N; i++) {
      sunFrac[h * N + i] = visibleDiscFraction(sun.elev_deg[h], horizonAtPoint(hg, fr[i], fc[i], sun.az_grid_deg[h]), rs);
      earthFrac[h * N + i] = visibleDiscFraction(earth.elev_deg[h], horizonAtPoint(hg, fr[i], fc[i], earth.az_grid_deg[h]), re);
    }
  }
  return { n, cellM, x0M: tm.x0_m, y0M: tm.y0_m, drivable, slopeDeg, hours: H, sunFrac, earthFrac, sunDistAu };
}

/** Re-derive the drivable mask for another slope limit without rebuilding the lighting. */
export function withSlopeLimit(g: RouteGrid, maxSlopeDeg: number): RouteGrid {
  const drivable = new Uint8Array(g.slopeDeg.length);
  for (let i = 0; i < drivable.length; i++) drivable[i] = g.slopeDeg[i] < maxSlopeDeg ? 1 : 0;
  return { ...g, drivable };
}

export const cellOf = (g: RouteGrid, x_m: number, y_m: number) => {
  const c = Math.floor((x_m - g.x0M) / g.cellM), r = Math.floor((g.y0M - y_m) / g.cellM);
  return r >= 0 && c >= 0 && r < g.n && c < g.n ? r * g.n + c : -1;
};
export const cellCentre = (g: RouteGrid, cell: number) => ({
  x_m: g.x0M + ((cell % g.n) + 0.5) * g.cellM, y_m: g.y0M - (Math.floor(cell / g.n) + 0.5) * g.cellM,
});
