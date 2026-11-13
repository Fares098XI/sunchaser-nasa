/**
 * V6: independent Light Path route checker. Written separately from lightpath.ts and imports nothing from it.
 * Re-simulates a route from the raw inputs and lists every violated rule (docs/VALIDATION.md, V6).
 */
export interface CheckGrid {
  n: number; cellM: number; hours: number;
  drivable: ArrayLike<number>;   // 1 = slope below the limit
  sunFrac: ArrayLike<number>;    // [hour][cell]
  sunDistAu: ArrayLike<number>;  // [hour]
}
export interface CheckRover { speedMPerH: number; batteryWh: number; reserveFrac: number; panelW: number; driveW: number; idleW: number }
export interface CheckRoute { k: number; cells: ArrayLike<number>; socWh: ArrayLike<number> }

export function checkRoute(g: CheckGrid, rv: CheckRover, route: CheckRoute, start: number, target: number): string[] {
  const errors: string[] = [];
  const { cells, socWh, k } = route;
  const steps = cells.length - 1;
  if (!(k >= 1) || Math.floor(k) !== k) errors.push(`sub-steps per hour must be a positive integer, got ${k}`);
  if (cells[0] !== start) errors.push(`starts at cell ${cells[0]}, not the start ${start}`);
  if (cells[steps] !== target) errors.push(`ends at cell ${cells[steps]}, not the target ${target}`);
  if (socWh.length !== cells.length) errors.push("battery series length differs from the route");
  if (Math.ceil(steps / k) > g.hours) errors.push("route runs past the end of the lighting data");
  const N = g.n * g.n;
  let energy = rv.batteryWh;
  const floorWh = rv.reserveFrac * rv.batteryWh;
  let movesThisHour = 0, hour = 0;
  for (let s = 1; s <= steps && errors.length < 20; s++) {
    const h = Math.floor((s - 1) / k);
    if (h !== hour) { hour = h; movesThisHour = 0; }
    const a = cells[s - 1], b = cells[s];
    if (b < 0 || b >= N) { errors.push(`step ${s}: cell ${b} outside the grid`); break; }
    const ra = Math.floor(a / g.n), ca = a - ra * g.n, rb = Math.floor(b / g.n), cb = b - rb * g.n;
    const manhattan = Math.abs(ra - rb) + Math.abs(ca - cb);
    if (manhattan > 1) errors.push(`step ${s}: jumps ${manhattan} cells (only stay or one 4-neighbour move)`);
    const moved = manhattan > 0;
    if (moved) {
      movesThisHour++;
      if (movesThisHour * g.cellM > rv.speedMPerH + 1e-9) errors.push(`hour ${h}: drives ${movesThisHour * g.cellM} m, faster than ${rv.speedMPerH} m/h`);
      if (!g.drivable[b]) errors.push(`step ${s}: enters cell ${b}, steeper than the slope limit`);
    }
    const d = g.sunDistAu[h];
    const solarW = (rv.panelW * g.sunFrac[h * N + b]) / (d * d);
    energy = Math.min(rv.batteryWh, energy + (solarW - (moved ? rv.driveW : rv.idleW)) / k);
    if (energy < floorWh - 1e-9) errors.push(`step ${s}: battery ${energy.toFixed(1)} Wh below the reserve ${floorWh.toFixed(1)} Wh`);
    if (Math.abs(energy - socWh[s]) > 1e-3) errors.push(`step ${s}: reported battery ${Number(socWh[s]).toFixed(3)} Wh, re-simulated ${energy.toFixed(3)} Wh`);
  }
  return errors;
}
