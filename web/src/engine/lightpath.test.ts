/** V6: Light Path routes vs the independent checker; earliest arrival vs exhaustive search (docs/VALIDATION.md). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeHorizon } from "./horizon";
import { VIPER, plan, type RouteGrid, type RoverParams } from "./lightpath";
import { checkRoute } from "./routecheck";
import { buildRouteGrid, withSlopeLimit } from "./routegrid";
import { cutPeriod, decodeTrackYear, type TrackIndex } from "./tracks";

let seed = 20261026;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function synthetic(n: number, hours: number, litP: number, drivP: number): RouteGrid {
  const N = n * n;
  const sunFrac = new Float32Array(hours * N);
  for (let i = 0; i < sunFrac.length; i++) sunFrac[i] = rnd() < litP ? (rnd() < 0.2 ? rnd() : 1) : 0;
  const drivable = new Uint8Array(N).map(() => (rnd() < drivP ? 1 : 0));
  return { n, cellM: 80, x0M: 0, y0M: 0, drivable, slopeDeg: new Float32Array(N), hours, sunFrac, earthFrac: new Float32Array(hours * N), sunDistAu: new Float64Array(hours).fill(1) };
}

/** Earliest arrival by brute force: every distinct (cell, charge) state, no dominance pruning. */
function exhaustive(g: RouteGrid, p: RoverParams, start: number, target: number): number {
  const n = g.n, K = Math.max(1, Math.floor(p.speedMPerH / g.cellM)), cap = p.batteryWh, res = p.reserveFrac * cap;
  let states = new Map<string, [number, number]>([[`${start}`, [start, cap]]]);
  for (let s = 0; s < g.hours * K; s++) {
    const h = Math.floor(s / K), next = new Map<string, [number, number]>();
    for (const [c, e] of states.values()) {
      const r = Math.floor(c / n), cc = c % n;
      const cand: [number, boolean][] = [[c, false]];
      if (r > 0) cand.push([c - n, true]);
      if (r < n - 1) cand.push([c + n, true]);
      if (cc > 0) cand.push([c - 1, true]);
      if (cc < n - 1) cand.push([c + 1, true]);
      for (const [d, moved] of cand) {
        if (moved && (!g.drivable[d] || (!g.drivable[c] && c !== start))) continue;
        const w = Math.min(cap, e + (p.panelW * g.sunFrac[h * n * n + d] - (moved ? p.driveW : p.idleW)) / K);
        if (w < res) continue;
        const key = `${d}:${w.toFixed(6)}`;
        if (!next.has(key)) next.set(key, [d, w]);
      }
    }
    for (const [d] of next.values()) if (d === target) return s + 1;
    states = next;
  }
  return -1;
}

describe("Light Path planner (synthetic)", () => {
  it("drives straight across an always-lit flat grid", () => {
    const g = synthetic(10, 10, 1, 1);
    g.sunFrac.fill(1);
    const r = plan(g, VIPER, 0, 9 * 10 + 9);
    expect(r.found).toBe(true);
    expect(r.arrival).toBe(18); // Manhattan distance, one move per sub-step
    expect(checkRoute(g, VIPER, r, 0, 99)).toEqual([]);
  });

  it("waits for the Sun rather than die in the dark", () => {
    // waiting 6 dark hours costs 648 Wh (survivable above a 300 Wh reserve); driving 5 cells in the dark costs ~752 Wh
    const p: RoverParams = { ...VIPER, batteryWh: 1000, reserveFrac: 0.3 };
    const g = synthetic(6, 12, 1, 1);
    g.sunFrac.fill(0);
    for (let h = 6; h < 12; h++) g.sunFrac.fill(1, h * 36, (h + 1) * 36);
    const r = plan(g, p, 0, 5);
    expect(r.found).toBe(true);
    expect(checkRoute(g, p, r, 0, 5)).toEqual([]);
    // 5 moves in the dark at 602 W would cost 5 x 150 Wh; waiting at 108 W first is the only survivable plan
    expect(r.cells[1]).toBe(0);
  });

  it("matches an exhaustive search for the earliest arrival on 40 small grids", () => {
    let agree = 0, found = 0;
    for (let t = 0; t < 40; t++) {
      const p: RoverParams = { ...VIPER, speedMPerH: 160, batteryWh: 400 + 800 * rnd(), reserveFrac: 0.1 + 0.4 * rnd() };
      const g = synthetic(5, 5, 0.5, 0.8);
      const start = Math.floor(rnd() * 25);
      let target = Math.floor(rnd() * 25);
      if (target === start) target = (target + 7) % 25;
      const r = plan(g, p, start, target);
      const best = exhaustive(g, p, start, target);
      if ((r.found ? r.arrival : -1) === best) agree++;
      if (r.found) { found++; expect(checkRoute(g, p, r, start, target)).toEqual([]); }
    }
    console.log(`V6 optimality: ${agree}/40 equal to exhaustive search (${found} reachable)`);
    expect(agree).toBe(40);
  });
});

// ---------- the real Connecting Ridge region ----------
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const m = JSON.parse(read("../../public/data/manifest.json").toString());
const hb = read(`../../public/data/${m.horizon.file}`);
const hg = decodeHorizon(new Uint8Array(hb.buffer, hb.byteOffset, hb.byteLength), m.horizon.n_az, m.horizon.rows, m.horizon.cols, m.horizon.quantum_deg);
const tb = read(`../../public/data/${m.terrain.file}`);
const heights = new Float32Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength));
const idx: TrackIndex = m.tracks;
const year = idx.years.find((y) => y.year === 2027)!;
const yb = read(`../../public/data/${year.file}`);
const decoded = new Map([[2027, decodeTrackYear(new Uint8Array(yb.buffer, yb.byteOffset, yb.byteLength), year, idx.channels.map((c) => c.quantum))]]);

describe("V6: Light Path on the real Connecting Ridge region", () => {
  it("every found route passes the independent checker (>= 300 routes)", () => {
    let total = 0, ok = 0, foundN = 0, ms = 0;
    for (let w = 0; w < 10; w++) {
      const startHour = year.first_hour + Math.floor(rnd() * (year.n - 200));
      const pt = cutPeriod(idx, decoded, startHour, 168, false);
      const base = buildRouteGrid(hg, m.horizon, heights, m.terrain, pt.sun, pt.earth, 15);
      for (let i = 0; i < 31; i++) {
        const p: RoverParams = {
          ...VIPER, speedMPerH: 90 + 630 * rnd(), maxSlopeDeg: 10 + 15 * rnd(), batteryWh: 1500 + 6000 * rnd(),
          reserveFrac: 0.05 + 0.4 * rnd(), driveW: 300 + 500 * rnd(), idleW: 60 + 120 * rnd(),
        };
        const g = withSlopeLimit(base, p.maxSlopeDeg);
        const pick = () => { for (;;) { const c = Math.floor(rnd() * g.n * g.n); if (g.drivable[c]) return c; } };
        const start = pick(), target = pick();
        const t0 = performance.now();
        const r = plan(g, p, start, target);
        ms = Math.max(ms, performance.now() - t0);
        total++;
        if (!r.found) continue;
        foundN++;
        const errs = checkRoute(g, p, r, start, target);
        if (errs.length === 0) ok++;
        else console.log(`route ${total} failed:`, errs.slice(0, 3));
      }
    }
    console.log(`V6: ${ok}/${foundN} found routes verified (${total} planned, slowest ${ms.toFixed(0)} ms)`);
    expect(total).toBeGreaterThanOrEqual(300);
    expect(foundN).toBeGreaterThan(100);
    expect(ok).toBe(foundN);
  }, 300_000);

  it("the checker rejects every deliberately broken route", () => {
    const pt = cutPeriod(idx, decoded, year.first_hour + 300, 168, false);
    const g = buildRouteGrid(hg, m.horizon, heights, m.terrain, pt.sun, pt.earth, 15);
    let broken = 0, caught = 0;
    for (let i = 0; i < 40; i++) {
      const pick = () => { for (;;) { const c = Math.floor(rnd() * g.n * g.n); if (g.drivable[c]) return c; } };
      const start = pick(), target = pick();
      const r = plan(g, VIPER, start, target);
      if (!r.found || r.cells.length < 6) continue;
      const mid = Math.floor(r.cells.length / 2);
      const mutants: [string, () => string[]][] = [
        ["teleport", () => { const c = Int32Array.from(r.cells); c[mid] = (c[mid] + 7 * g.n) % (g.n * g.n); return checkRoute(g, VIPER, { ...r, cells: c }, start, target); }],
        ["steep", () => {
          const moveAt = [...r.cells].findIndex((c, s) => s > 0 && c !== r.cells[s - 1]);
          const d = Uint8Array.from(g.drivable); d[r.cells[moveAt]] = 0;
          return checkRoute({ ...g, drivable: d }, VIPER, r, start, target);
        }],
        ["overdraw", () => checkRoute(g, { ...VIPER, driveW: VIPER.driveW * 3, idleW: VIPER.idleW * 3 }, r, start, target)],
        ["too fast", () => checkRoute(g, { ...VIPER, speedMPerH: g.cellM - 1 }, r, start, target)],
        ["wrong end", () => checkRoute(g, VIPER, r, start, (target + 1) % (g.n * g.n))],
      ];
      for (const [, f] of mutants) { broken++; if (f().length > 0) caught++; }
    }
    console.log(`V6 mutations: ${caught}/${broken} broken routes rejected`);
    expect(broken).toBeGreaterThan(50);
    expect(caught).toBe(broken);
  }, 120_000);
});
