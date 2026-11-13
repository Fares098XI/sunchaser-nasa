/**
 * Landing safety and science access at any point of a region (docs/METHODS.md §15), the same formulas as
 * pipeline/sunchaser/site_terrain.py: slope of every 20 m DEM cell (central differences, one-sided at the edges, as
 * numpy.gradient), statistics over the 100 m landing circle, and the nearest permanently shadowed cell.
 */
export interface Grid { rows: number; cols: number; res_m: number; x0_m: number; y0_m: number }

export function slopeMap(h: ArrayLike<number>, g: Grid): Float32Array {
  const { rows, cols, res_m: r } = g, out = new Float32Array(rows * cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const k = i * cols + j;
    const gx = j === 0 ? (h[k + 1] - h[k]) / r : j === cols - 1 ? (h[k] - h[k - 1]) / r : (h[k + 1] - h[k - 1]) / (2 * r);
    const gy = i === 0 ? (h[k + cols] - h[k]) / r : i === rows - 1 ? (h[k] - h[k - cols]) / r : (h[k + cols] - h[k - cols]) / (2 * r);
    out[k] = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
  }
  return out;
}

/** numpy.percentile (linear interpolation) of sorted values */
const pct = (s: Float64Array, q: number) => {
  const p = (q / 100) * (s.length - 1), i = Math.floor(p);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (p - i) : s[i];
};

export interface LandingCircle { median: number; p95: number; max: number; cells: number; shareBelow: (deg: number) => number }

/** Slopes of every cell whose centre lies within `radius` m of (x, y) (grid metres). */
export function landingCircle(slope: Float32Array, g: Grid, x: number, y: number, radius = 100): LandingCircle | null {
  const v: number[] = [];
  const c0 = Math.floor((x - radius - g.x0_m) / g.res_m), c1 = Math.ceil((x + radius - g.x0_m) / g.res_m);
  const r0 = Math.floor((g.y0_m - (y + radius)) / g.res_m), r1 = Math.ceil((g.y0_m - (y - radius)) / g.res_m);
  for (let i = Math.max(0, r0); i <= Math.min(g.rows - 1, r1); i++) for (let j = Math.max(0, c0); j <= Math.min(g.cols - 1, c1); j++) {
    const cx = g.x0_m + (j + 0.5) * g.res_m, cy = g.y0_m - (i + 0.5) * g.res_m;
    if (Math.hypot(cx - x, cy - y) <= radius) v.push(slope[i * g.cols + j]);
  }
  if (!v.length) return null;
  const s = Float64Array.from(v).sort();
  return { median: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1], cells: s.length, shareBelow: (d) => v.filter((a) => a < d).length / v.length };
}

/** Distance (m) and grid bearing (deg clockwise from grid +y) to the nearest flagged cell centre, or null. */
export function nearestFlagged(mask: ArrayLike<number>, g: Grid, x: number, y: number): { m: number; bearing: number } | null {
  let best = Infinity, bx = 0, by = 0;
  for (let i = 0; i < g.rows; i++) for (let j = 0; j < g.cols; j++) {
    if (!mask[i * g.cols + j]) continue;
    const cx = g.x0_m + (j + 0.5) * g.res_m, cy = g.y0_m - (i + 0.5) * g.res_m, d = Math.hypot(cx - x, cy - y);
    if (d < best) { best = d; bx = cx; by = cy; }
  }
  return Number.isFinite(best) ? { m: best, bearing: ((Math.atan2(bx - x, by - y) * 180) / Math.PI + 360) % 360 } : null;
}
