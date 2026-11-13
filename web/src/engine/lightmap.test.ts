import { describe, expect, it } from "vitest";
import { horizonAt, type HorizonGrid } from "./horizon";
import { lightMap } from "./lightmap";
import { angularRadiusDeg, visibleDiscFraction } from "./sky";

describe("lightMap", () => {
  it("equals the mean of per-hour fractions from the same engine", () => {
    // 4 azimuth bins x 1 x 2 cells: cell 0 horizon 0 deg everywhere, cell 1 horizon 2 deg toward bins 0-1
    const k = Int16Array.from([0, 512, 0, 512, 0, 0, 0, 0]); // [az][cell], steps of 1/256 deg
    const g: HorizonGrid = { nAz: 4, rows: 1, cols: 2, quantum: 1 / 256, k };
    const t = { az_grid_deg: [10, 100, 190, 280], elev_deg: [1, 0.1, -0.1, 1], dist_km: [149.6e6, 149.6e6, 149.6e6, 149.6e6] };
    const map = lightMap(g, t, 695700, false, 2);
    for (const cell of [0, 1]) {
      const v = t.elev_deg.map((el, h) =>
        visibleDiscFraction(el, horizonAt(g, 0, cell, t.az_grid_deg[h]), angularRadiusDeg(695700, t.dist_km[h])));
      expect(map[2 + cell]).toBe(Math.round((255 * v.reduce((a, b) => a + b)) / 4)); // final checkpoint
      expect(map[cell]).toBe(Math.round((255 * (v[0] + v[1])) / 2));                  // halfway checkpoint
    }
  });
});
