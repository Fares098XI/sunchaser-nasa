/// <reference lib="webworker" />
/**
 * Light Path off the main thread. init: terrain + horizons; plan: window tracks + rover + start/target ->
 * route, plain-language summary and the independent V6 check of that very route.
 */
import type { HorizonGrid } from "../engine/horizon";
import { describe, plan, type RouteGrid } from "../engine/lightpath";
import { checkRoute } from "../engine/routecheck";
import { buildRouteGrid, cellOf, withSlopeLimit, type GridGeom } from "../engine/routegrid";

let terrain: { hg: HorizonGrid; hm: GridGeom & { cell_m: number }; heights: Float32Array; tm: GridGeom & { res_m: number } } | null = null;
let cache: { key: string; grid: RouteGrid } | null = null;

/** Nearest drivable cell to `c` within `maxRing` cells (ring by ring, closest centre first), or -1. */
function nearestDrivable(g: RouteGrid, c: number, maxRing = 6) {
  if (c < 0 || g.drivable[c]) return c;
  const n = g.n, r0 = Math.floor(c / n), c0 = c % n;
  for (let ring = 1; ring <= maxRing; ring++) {
    let best = -1, bd = Infinity;
    for (let r = r0 - ring; r <= r0 + ring; r++) for (let q = c0 - ring; q <= c0 + ring; q++) {
      if (Math.max(Math.abs(r - r0), Math.abs(q - c0)) !== ring || r < 0 || q < 0 || r >= n || q >= n) continue;
      const k = r * n + q, d = (r - r0) ** 2 + (q - c0) ** 2;
      if (g.drivable[k] && d < bd) { bd = d; best = k; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "init") { terrain = { hg: m.hg, hm: m.hm, heights: m.heights, tm: m.tm }; cache = null; postMessage({ id: m.id, ok: true }); return; }
    if (m.type !== "plan" || !terrain) throw new Error("not initialised");
    const t0 = performance.now();
    const key = `${m.windowStart}`;
    if (!cache || cache.key !== key) {
      cache = { key, grid: buildRouteGrid(terrain.hg, terrain.hm, terrain.heights, terrain.tm, m.sun, m.earth, 90) };
    }
    const g = withSlopeLimit(cache.grid, m.rover.maxSlopeDeg);
    const start0 = cellOf(g, m.start.x_m, m.start.y_m), target0 = cellOf(g, m.target.x_m, m.target.y_m);
    if (start0 < 0 || target0 < 0) throw new Error("start or target outside the 3D region");
    // a click on ground too steep for the rover moves to the nearest drivable cell (within ~0.5 km), and says so
    const start = nearestDrivable(g, start0), target = nearestDrivable(g, target0);
    const moved = (a: number, b: number) => (a < 0 || a === b ? 0 : Math.hypot((a % g.n) - (b % g.n), Math.floor(a / g.n) - Math.floor(b / g.n)) * g.cellM);
    const snapped = { start: moved(start, start0), target: moved(target, target0) };
    const route = plan(g, m.rover, start < 0 ? start0 : start, target < 0 ? target0 : target);
    const errors = route.found ? checkRoute(g, m.rover, route, route.cells[0], route.cells[route.cells.length - 1]) : [];
    const summary = route.found ? describe(g, m.rover, route) : null;
    // per sub-step lighting along the route, for the timeline
    const steps = route.cells.length - 1, N = g.n * g.n;
    const sunAlong = new Float32Array(steps), earthAlong = new Float32Array(steps);
    for (let s = 0; s < steps; s++) {
      const h = Math.floor(s / route.k), c = route.cells[s + 1];
      sunAlong[s] = g.sunFrac[h * N + c];
      earthAlong[s] = g.earthFrac[h * N + c];
    }
    // the steep mask for the map overlay
    const steep = new Uint8Array(N);
    for (let i = 0; i < N; i++) steep[i] = g.drivable[i] ? 0 : 1;
    postMessage({
      id: m.id, ok: true, ms: performance.now() - t0,
      route: { found: route.found, reason: route.reason, k: route.k, cells: route.cells, socWh: route.socWh, arrival: route.arrival },
      summary, snapped, checkErrors: errors, sunAlong, earthAlong, steep, grid: { n: g.n, cellM: g.cellM, x0M: g.x0M, y0M: g.y0M },
    });
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String(err) });
  }
};
