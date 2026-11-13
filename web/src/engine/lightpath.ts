/**
 * Light Path: earliest-arrival rover route through space, time and battery (docs/METHODS.md §12).
 *
 * Grid of square cells; time in hours split into K sub-steps (K = floor(speed / cell size)), so one sub-step is at
 * most one 4-neighbour move. Each sub-step the rover stays (idle load) or moves into a drivable neighbour (drive load);
 * the cell it ends the sub-step in sets its solar input (panel W x visible disc fraction x (1 au / d)^2) for that
 * sub-step. The state per cell is the best (highest) battery charge that can be there at that moment: for the same
 * place and time, more charge can always do whatever less charge can, so keeping the maximum is exact. States below
 * the reserve are dropped. The first sub-step at which the target holds a state is the earliest arrival; the route
 * is traced back through the stored choices. Checked by routecheck.ts (V6), which shares no code with this file.
 */

export interface RoverParams {
  speedMPerH: number;   // drive speed while moving
  maxSlopeDeg: number;  // terrain slope limit
  batteryWh: number;    // capacity
  reserveFrac: number;  // never plan below this share of capacity
  panelW: number;       // solar output with the full Sun at 1 au
  driveW: number;       // load while driving
  idleW: number;        // load while waiting
}

/**
 * VIPER-class defaults (NASA sources in docs/DATA.md): 10 cm/s nominal drive speed, 15 deg slope design limit,
 * 5,420 Wh battery, 450 W solar with the Sun on a corner; loads derived from "9 h ops in a PSR" (5,420/9 = 602 W)
 * and "50 h survival in low-power mode" (5,420/50 = 108 W).
 */
export const VIPER: RoverParams = {
  speedMPerH: 360, maxSlopeDeg: 15, batteryWh: 5420, reserveFrac: 0.2, panelW: 450, driveW: 602, idleW: 108,
};

export interface RouteGrid {
  n: number;            // cells per side (square grid)
  cellM: number;
  x0M: number; y0M: number; // grid coordinates of the top-left corner (row 0 = north)
  drivable: Uint8Array; // n*n
  slopeDeg: Float32Array;
  hours: number;
  sunFrac: Float32Array;   // [hour][cell] visible solar-disc fraction
  earthFrac: Float32Array; // [hour][cell] visible Earth-disc fraction
  sunDistAu: Float64Array; // [hour]
}

export interface Route {
  found: boolean;
  reason?: string;
  k: number;             // sub-steps per hour
  cells: Int32Array;     // cell at the end of each sub-step; cells[0] = start (before the first sub-step)
  socWh: Float64Array;   // battery after each sub-step; socWh[0] = start charge
  arrival: number;       // sub-steps to arrive (= cells.length - 1)
}

export const subSteps = (p: RoverParams, g: RouteGrid) => Math.max(1, Math.floor(p.speedMPerH / g.cellM));

/** Solar input (W) in a cell during an hour. */
const gen = (g: RouteGrid, p: RoverParams, h: number, c: number) =>
  (p.panelW * g.sunFrac[h * g.n * g.n + c]) / (g.sunDistAu[h] * g.sunDistAu[h]);

export function plan(g: RouteGrid, p: RoverParams, start: number, target: number, maxHours = g.hours): Route {
  const n = g.n, N = n * n, K = subSteps(p, g), dt = 1 / K, cap = p.batteryWh, reserve = p.reserveFrac * cap;
  const empty: Route = { found: false, k: K, cells: new Int32Array([start]), socWh: new Float64Array([cap]), arrival: 0 };
  if (start === target) return { ...empty, found: true };
  if (!g.drivable[target]) return { ...empty, reason: `the target is steeper than ${p.maxSlopeDeg}°` };
  const H = Math.min(maxHours, g.hours);
  let soc = new Float64Array(N).fill(-1);
  let next = new Float64Array(N);
  soc[start] = cap;
  const pred = new Uint8Array(H * K * N); // 0 stay, 1 from north, 2 from south, 3 from west, 4 from east
  // bounding box of reachable cells, grown by one each sub-step (keeps early hours cheap)
  let r0 = Math.floor(start / n), r1 = r0, c0 = start % n, c1 = c0;
  const genH = new Float64Array(N);
  const dv = g.drivable;
  const src = Uint8Array.from(dv);
  src[start] = 1; // the rover may always drive off the lander
  next.fill(-1);
  for (let h = 0; h < H; h++) {
    const d2 = g.sunDistAu[h] * g.sunDistAu[h], base = h * N;
    for (let c = 0; c < N; c++) genH[c] = (p.panelW * g.sunFrac[base + c]) / d2;
    for (let k = 0; k < K; k++) {
      const s = h * K + k, row = s * N;
      r0 = Math.max(0, r0 - 1); r1 = Math.min(n - 1, r1 + 1); c0 = Math.max(0, c0 - 1); c1 = Math.min(n - 1, c1 + 1);
      let live = false;
      for (let r = r0; r <= r1; r++) {
        for (let cc = c0; cc <= c1; cc++) {
          const c = r * n + cc;
          let best = -1, dir = 0;
          if (soc[c] >= 0) best = Math.min(cap, soc[c] + (genH[c] - p.idleW) * dt);
          if (dv[c]) {
            // the best neighbour that may drive out (drivable, or the lander's own cell)
            let v = -1, d = 0, nb: number;
            if (r > 0 && (nb = c - n, src[nb]) && soc[nb] > v) { v = soc[nb]; d = 1; }
            if (r < n - 1 && (nb = c + n, src[nb]) && soc[nb] > v) { v = soc[nb]; d = 2; }
            if (cc > 0 && (nb = c - 1, src[nb]) && soc[nb] > v) { v = soc[nb]; d = 3; }
            if (cc < n - 1 && (nb = c + 1, src[nb]) && soc[nb] > v) { v = soc[nb]; d = 4; }
            if (v >= 0) {
              const w = Math.min(cap, v + (genH[c] - p.driveW) * dt);
              if (w > best) { best = w; dir = d; }
            }
          }
          if (best >= reserve) { next[c] = best; pred[row + c] = dir; live = true; } else next[c] = -1;
        }
      }
      if (!live) return { ...empty, reason: `the battery cannot stay above ${Math.round(p.reserveFrac * 100)}% even when waiting` };
      [soc, next] = [next, soc];
      if (soc[target] >= 0) return trace(g, p, pred, start, target, s, K);
    }
  }
  return { ...empty, reason: `no route keeps the battery above ${Math.round(p.reserveFrac * 100)}% within ${H} h` };
}

function trace(g: RouteGrid, p: RoverParams, pred: Uint8Array, start: number, target: number, last: number, K: number): Route {
  const n = g.n, N = n * n;
  const cells = new Int32Array(last + 2);
  cells[last + 1] = target;
  let c = target;
  for (let s = last; s >= 0; s--) {
    const d = pred[s * N + c];
    c = d === 0 ? c : d === 1 ? c - n : d === 2 ? c + n : d === 3 ? c - 1 : c + 1;
    cells[s] = c;
  }
  if (cells[0] !== start) throw new Error("trace did not return to the start");
  // battery along the route, same arithmetic as the search
  const socWh = new Float64Array(last + 2);
  socWh[0] = p.batteryWh;
  for (let s = 0; s <= last; s++) {
    const h = Math.floor(s / K), moved = cells[s + 1] !== cells[s];
    socWh[s + 1] = Math.min(p.batteryWh, socWh[s] + (gen(g, p, h, cells[s + 1]) - (moved ? p.driveW : p.idleW)) / K);
  }
  return { found: true, k: K, cells, socWh, arrival: last + 1 };
}

/** Plain-language summary of a route (for "Why this route?"). */
export function describe(g: RouteGrid, p: RoverParams, r: Route) {
  const K = r.k, steps = r.cells.length - 1;
  let moves = 0, waitStart = 0, darkSub = 0, longestDark = 0, run = 0, earthSub = 0, minSoc = Infinity;
  let firstMove = -1;
  for (let s = 0; s < steps; s++) {
    const h = Math.floor(s / K), c = r.cells[s + 1], moved = c !== r.cells[s];
    if (moved) { moves++; if (firstMove < 0) firstMove = s; }
    const lit = g.sunFrac[h * g.n * g.n + c] > 0;
    if (!lit) { darkSub++; run++; longestDark = Math.max(longestDark, run); } else run = 0;
    if (g.earthFrac[h * g.n * g.n + c] > 0) earthSub++;
    minSoc = Math.min(minSoc, r.socWh[s + 1]);
  }
  waitStart = firstMove < 0 ? steps : firstMove;
  const n = g.n, a = r.cells[0], b = r.cells[steps];
  const straightM = Math.hypot((a % n) - (b % n), Math.floor(a / n) - Math.floor(b / n)) * g.cellM;
  return {
    hours: steps / K, driveKm: (moves * g.cellM) / 1000, straightKm: straightM / 1000,
    waitAtStartH: waitStart / K, waitTotalH: (steps - moves) / K,
    darkH: darkSub / K, longestDarkH: longestDark / K, earthPct: steps ? (100 * earthSub) / steps : 100,
    minSocPct: steps ? (100 * minSoc) / p.batteryWh : 100,
  };
}
