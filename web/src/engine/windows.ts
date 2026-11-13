/**
 * Mission windows: metrics over [start, start + duration) and the requirement search (Window Finder, Compare).
 * Definitions: docs/METHODS.md §8. Python twin: pipeline/sunchaser/windows.py (V5 golden).
 */
import type { Series } from "./sites";

export const TSI_W_M2 = 1361; // total solar irradiance at 1 au (Kopp & Lean 2011)
export const SUN_RADIUS_KM = 695700;
export const AU_KM = 149597870.7;

export interface Prepared {
  n: number;
  stepH: number;
  cumSun: Float64Array;    // prefix sum of visible solar-disc fraction
  cumEarth: Float64Array;  // prefix sum of Earth-visible flag (disc fraction >= 0.5)
  cumDte: Float64Array;    // prefix sum of DTE flag
  energy: Float64Array;    // incident energy per step on a Sun-tracking panel, Wh/m^2
  cumEnergy: Float64Array; // prefix sum of `energy`
  darkRuns: Int32Array;    // [start, end) pairs of steps with no part of the Sun visible
  blackRuns: Int32Array;   // [start, end) pairs of steps without DTE
}

function runs(flagZero: (i: number) => boolean, n: number): Int32Array {
  const out: number[] = [];
  let s = -1;
  for (let i = 0; i < n; i++) {
    if (flagZero(i)) { if (s < 0) s = i; } else if (s >= 0) { out.push(s, i); s = -1; }
  }
  if (s >= 0) out.push(s, n);
  return Int32Array.from(out);
}

export function prepare(sr: Series, stepS: number): Prepared {
  const n = sr.sun.length, stepH = stepS / 3600;
  const cumSun = new Float64Array(n + 1), cumEarth = new Float64Array(n + 1);
  const cumDte = new Float64Array(n + 1), cumEnergy = new Float64Array(n + 1), energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // irradiance at the true Sun distance d = R_sun / sin(r)
    const auOverD = (Math.sin((sr.sunR[i] * Math.PI) / 180) * AU_KM) / SUN_RADIUS_KM;
    energy[i] = TSI_W_M2 * auOverD * auOverD * sr.sun[i] * stepH;
    cumSun[i + 1] = cumSun[i] + sr.sun[i];
    cumEarth[i + 1] = cumEarth[i] + (sr.earth[i] >= 0.5 ? 1 : 0);
    cumDte[i + 1] = cumDte[i] + sr.dte[i];
    cumEnergy[i + 1] = cumEnergy[i] + energy[i];
  }
  return {
    n, stepH, energy, cumSun, cumEarth, cumDte, cumEnergy,
    darkRuns: runs((i) => sr.sun[i] === 0, n),
    blackRuns: runs((i) => sr.dte[i] === 0, n),
  };
}

/** Longest part of any run inside [a, b), in steps. Runs are sorted, non-overlapping [start, end) pairs. */
export function longestIn(r: Int32Array, a: number, b: number): number {
  let lo = 0, hi = r.length / 2;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (r[2 * mid + 1] <= a) lo = mid + 1; else hi = mid; }
  let best = 0;
  for (let k = lo; k < r.length / 2 && r[2 * k] < b; k++) {
    best = Math.max(best, Math.min(r[2 * k + 1], b) - Math.max(r[2 * k], a));
  }
  return best;
}

export interface Metrics {
  sunPct: number; darkH: number; earthPct: number; dtePct: number; blackoutH: number; energyWhM2Day: number;
  /** battery low point (%) and hours with unmet load; NaN when not computed */
  batteryMinPct: number; batteryEmptyH: number;
}

export function metrics(p: Prepared, a: number, b: number, power?: PowerSystem): Metrics {
  const len = b - a;
  const bat = power ? battery(p, a, b, power) : null;
  return {
    batteryMinPct: bat ? bat.minPct : NaN,
    batteryEmptyH: bat ? bat.emptyH : NaN,
    sunPct: (100 * (p.cumSun[b] - p.cumSun[a])) / len,
    darkH: longestIn(p.darkRuns, a, b) * p.stepH,
    earthPct: (100 * (p.cumEarth[b] - p.cumEarth[a])) / len,
    dtePct: (100 * (p.cumDte[b] - p.cumDte[a])) / len,
    blackoutH: longestIn(p.blackRuns, a, b) * p.stepH,
    energyWhM2Day: (p.cumEnergy[b] - p.cumEnergy[a]) / (len * p.stepH / 24),
  };
}

/** Lander power system (user inputs; the defaults are an example, not a specific lander). */
export interface PowerSystem { panelM2: number; efficiency: number; loadW: number; batteryWh: number }
export const EXAMPLE_POWER: PowerSystem = { panelM2: 2, efficiency: 0.3, loadW: 150, batteryWh: 3000 };

export interface Battery { minPct: number; emptyH: number; endPct: number }

/**
 * Battery over [a, b), starting full: each step adds the panel's solar energy (incident x area x efficiency) and
 * removes the load, clamped to [0, capacity]; a step whose load cannot be fully met counts toward emptyH.
 * Same arithmetic as pipeline windows.battery (V5).
 */
export function battery(p: Prepared, a: number, b: number, s: PowerSystem): Battery {
  const out = s.loadW * p.stepH;
  let soc = s.batteryWh, low = s.batteryWh, empty = 0;
  for (let i = a; i < b; i++) {
    soc = Math.min(s.batteryWh, soc + p.energy[i] * s.panelM2 * s.efficiency - out);
    if (soc < 0) { soc = 0; empty++; }
    if (soc < low) low = soc;
  }
  return { minPct: (100 * low) / s.batteryWh, emptyH: empty * p.stepH, endPct: (100 * soc) / s.batteryWh };
}

export interface Requirements {
  days: number;
  minSunPct: number;
  maxDarkH: number | null;
  minDtePct: number;
  maxBlackoutH: number | null;
  /** battery must never run out (needs a PowerSystem) */
  battery: boolean;
}

export const REQ_KEYS = ["sun", "dark", "dte", "blackout", "battery"] as const;
export type ReqKey = (typeof REQ_KEYS)[number];
export const FAIL_BIT: Record<ReqKey, number> = { sun: 1, dark: 2, dte: 4, blackout: 8, battery: 16 };
export const ALL_FAILS = 31;
/** calendar value for a day on which some landing meets every requirement (above all fail bits) */
export const PASS_DAY = 128;

/** Signed margins (positive = requirement met with room to spare), in each requirement's own unit. */
export function margins(m: Metrics, r: Requirements): Record<ReqKey, number> {
  return {
    sun: m.sunPct - r.minSunPct,
    dark: r.maxDarkH == null ? Infinity : r.maxDarkH - m.darkH,
    dte: m.dtePct - r.minDtePct,
    blackout: r.maxBlackoutH == null ? Infinity : r.maxBlackoutH - m.blackoutH,
    // battery: hours short of power (negative) or, if never empty, the charge left at the low point (%)
    battery: !r.battery || Number.isNaN(m.batteryEmptyH) ? Infinity : m.batteryEmptyH > 0 ? -m.batteryEmptyH : m.batteryMinPct,
  };
}

/** Smallest margin relative to its requirement value (dimensionless); ranks passing windows. */
export function minRelMargin(m: Metrics, r: Requirements) {
  const g = margins(m, r);
  const rel = [g.sun / Math.max(r.minSunPct, 1), g.dte / Math.max(r.minDtePct, 1)];
  if (r.maxDarkH != null) rel.push(g.dark / Math.max(r.maxDarkH, 1));
  if (r.maxBlackoutH != null) rel.push(g.blackout / Math.max(r.maxBlackoutH, 1));
  if (r.battery && Number.isFinite(g.battery)) rel.push(g.battery / 100);
  return Math.min(...rel);
}

export function failBits(m: Metrics, r: Requirements): number {
  const g = margins(m, r);
  let bits = 0;
  for (const k of REQ_KEYS) if (g[k] < 0) bits |= FAIL_BIT[k];
  return bits;
}

export interface SearchResult {
  /** landing step index of each candidate (every `every` steps) */
  starts: Int32Array;
  m: Float32Array; // per candidate: sunPct, darkH, earthPct, dtePct, blackoutH, energy, batteryMin, batteryEmptyH (8)
  fails: Uint8Array;
}

/** Evaluate every landing time (every `every` steps) whose full stay fits in the table. */
export const STRIDE = 8;

export function search(p: Prepared, r: Requirements, every: number, power?: PowerSystem): SearchResult {
  const len = Math.round((r.days * 24) / p.stepH);
  const count = Math.max(0, Math.floor((p.n - len) / every) + 1);
  const starts = new Int32Array(count), m = new Float32Array(count * STRIDE), fails = new Uint8Array(count);
  for (let c = 0; c < count; c++) {
    const a = c * every;
    const x = metrics(p, a, a + len, r.battery ? power : undefined);
    starts[c] = a;
    m.set([x.sunPct, x.darkH, x.earthPct, x.dtePct, x.blackoutH, x.energyWhM2Day, x.batteryMinPct, x.batteryEmptyH], c * STRIDE);
    fails[c] = failBits(x, r);
  }
  return { starts, m, fails };
}

const unpack = (res: SearchResult, c: number): Metrics => {
  const o = c * STRIDE, m = res.m;
  return { sunPct: m[o], darkH: m[o + 1], earthPct: m[o + 2], dtePct: m[o + 3], blackoutH: m[o + 4], energyWhM2Day: m[o + 5],
    batteryMinPct: m[o + 6], batteryEmptyH: m[o + 7] };
};
export { unpack as candidateMetrics };

export interface Relaxation { key: ReqKey; to: number; from: number; windows: number }

/**
 * Smallest single-requirement change that makes at least one landing feasible: for each requirement, the best
 * value reached by candidates that already meet every other requirement (exact, over all given results).
 */
export function minimalRelaxations(results: SearchResult[], r: Requirements): Relaxation[] {
  const out: Relaxation[] = [];
  for (const key of REQ_KEYS) {
    if (key === "battery") continue; // not a single threshold: suggest power-system changes in the UI instead
    const others = ALL_FAILS & ~FAIL_BIT[key];
    let best = -Infinity, count = 0;
    for (const res of results) {
      for (let c = 0; c < res.fails.length; c++) {
        if (res.fails[c] & others) continue;
        const x = unpack(res, c);
        const v = key === "sun" ? x.sunPct : key === "dark" ? -x.darkH : key === "dte" ? x.dtePct : -x.blackoutH;
        if (v > best) { best = v; count = 0; }
        if (v === best) count++;
      }
    }
    if (best === -Infinity) continue;
    const from = key === "sun" ? r.minSunPct : key === "dark" ? r.maxDarkH : key === "dte" ? r.minDtePct : r.maxBlackoutH;
    if (from == null) continue;
    const to = key === "dark" || key === "blackout" ? -best : best;
    out.push({ key, from, to, windows: count });
  }
  return out;
}
