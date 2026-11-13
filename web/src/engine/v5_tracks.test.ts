/** V5c: TS track decoding and period statistics == Python (pipeline export_tracks.golden), max |diff| < 1e-6. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeHorizon } from "./horizon";
import { seriesStats, siteSeries } from "./series";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM } from "./sky";
import { cutPeriod, decodeTrackYear, type TrackIndex } from "./tracks";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const golden = JSON.parse(read("./golden/v5_tracks.json").toString());
const m = JSON.parse(read("../../public/data/manifest.json").toString());
const idx: TrackIndex = m.tracks;
const quanta = idx.channels.map((c) => c.quantum);
const decoded = new Map<number, Float64Array[]>();
for (const y of idx.years) {
  const b = read(`../../public/data/${y.file}`);
  decoded.set(y.year, decodeTrackYear(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), y, quanta));
}
const hb = read(`../../public/data/${m.horizon.file}`);
const grid = decodeHorizon(new Uint8Array(hb.buffer, hb.byteOffset, hb.byteLength), m.horizon.n_az, m.horizon.rows,
  m.horizon.cols, m.horizon.quantum_deg);

describe("V5c golden: 2020-2045 tracks", () => {
  it(`decodes ${golden.cases.length} random hours like Python`, () => {
    let max = 0;
    for (const c of golden.cases) {
      const p = cutPeriod(idx, decoded, c.hour, 1);
      const got = [p.sun.az_grid_deg[0], p.sun.elev_deg[0], p.sun.dist_km[0], p.earth.az_grid_deg[0], p.earth.elev_deg[0],
        p.earth.dist_km[0], ...p.earthQ, ...p.skyQ];
      got.forEach((v, i) => { max = Math.max(max, Math.abs(v - c.values[i])); });
    }
    console.log(`V5c tracks max |diff| ${max.toExponential(2)}`);
    expect(max).toBeLessThan(1e-6);
  });

  it(`reproduces period statistics on ${golden.periods.length} periods`, () => {
    let max = 0;
    for (const p of golden.periods) {
      const t = cutPeriod(idx, decoded, p.start, p.hours);
      for (const [body, r] of [["sun", SUN_RADIUS_KM], ["earth", EARTH_RADIUS_KM]] as const) {
        const s = seriesStats(siteSeries(grid, golden.row, golden.col, t[body], r));
        const g = p[body];
        max = Math.max(max, Math.abs(s.meanPct - g.mean_pct), Math.abs(s.anyPct - g.any_pct), Math.abs(s.longestZeroH - g.longest_zero_h));
      }
    }
    console.log(`V5c period stats max |diff| ${max.toExponential(2)}`);
    expect(max).toBeLessThan(1e-6);
  });
});
