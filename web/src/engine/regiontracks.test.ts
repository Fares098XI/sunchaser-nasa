/** V5d (b): TS site-track derivation == Python (pipeline export_regions.golden), max |diff| < 1e-6. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveDirection, deriveTracks, frameRotation, regionFrame } from "./regiontracks";

const golden = JSON.parse(readFileSync(new URL("./golden/v5_regions.json", import.meta.url)).toString());
const hero = regionFrame(golden.hero);
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("V5d region tracks", () => {
  for (const c of golden.cases) {
    it(c.region.id, () => {
      const to = regionFrame(c);
      let worst = 0;
      c.az.forEach((az: number, i: number) => {
        const [a, e, d] = deriveDirection(az, c.el[i], c.dist[i], hero, to);
        worst = Math.max(worst, angDiff(a, c.out_az[i]), Math.abs(e - c.out_el[i]), Math.abs(d - c.out_dist[i]) / c.out_dist[i]);
      });
      expect(worst).toBeLessThan(1e-6);
      const pt = deriveTracks({
        start: 0, n: c.q.length, sun: { az_grid_deg: c.az, elev_deg: c.el, dist_km: c.dist }, earth: { az_grid_deg: c.az, elev_deg: c.el, dist_km: c.dist },
        earthQ: Float64Array.from(c.q.flat()), skyQ: Float64Array.from(c.q.flat()),
      }, hero, to);
      c.out_q.forEach((q: number[], i: number) => {
        const r = pt.earthQ.subarray(4 * i, 4 * i + 4), dot = q.reduce((s, v, k) => s + v * r[k], 0);
        q.forEach((v, k) => expect(Math.abs(r[k] - Math.sign(dot) * v)).toBeLessThan(1e-6)); // q and -q are one rotation
      });
      expect(Math.abs(pt.sun.elev_deg[3] - c.out_el[3])).toBeLessThan(1e-6);
    });
  }

  it("identity at the hero region", () => {
    expect(deriveTracks({ start: 0, n: 0, sun: { az_grid_deg: [], elev_deg: [], dist_km: [] }, earth: { az_grid_deg: [], elev_deg: [], dist_km: [] }, earthQ: new Float64Array(), skyQ: new Float64Array() }, hero, hero).n).toBe(0);
    const q = frameRotation(hero, hero);
    expect(Math.abs(q[3])).toBeCloseTo(1, 12);
  });
});
