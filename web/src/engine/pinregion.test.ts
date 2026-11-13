import { describe, expect, it } from "vitest";
import { R_MOON_M as R } from "./frames";
import { sinElev, stepHorizon } from "./pinregion";
import type { Layer } from "./pinhorizon";

/** horizon._point: grid (x, y) + height -> body-fixed position */
const point = (x: number, y: number, h: number) => {
  const t2 = (x * x + y * y) / (4 * R * R), f = (R + h) / (1 + t2);
  return [(f * y) / R, (f * x) / R, -f * (1 - t2)];
};

describe("pin region geometry", () => {
  it("sinElev equals the exact 3D elevation of horizon._point", () => {
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const ox = (Math.random() - 0.5) * 24e3, oy = (Math.random() - 0.5) * 24e3, oh = (Math.random() - 0.5) * 8e3;
      const s = 30 * 10 ** (Math.random() * 4), a = Math.random() * 2 * Math.PI, h = oh + (Math.random() - 0.5) * 4e3;
      const p = point(ox, oy, oh), q = point(ox + s * Math.sin(a), oy + s * Math.cos(a), h);
      const n = Math.hypot(...p), v = q.map((c, k) => c - p[k]);
      const exact = (v[0] * p[0] + v[1] * p[1] + v[2] * p[2]) / n / Math.hypot(...v);
      worst = Math.max(worst, Math.abs(Math.asin(sinElev(ox, oy, oh, s * Math.sin(a), s * Math.cos(a), h)) - Math.asin(exact)));
    }
    expect(worst).toBeLessThan(1e-9); // radians
  });

  it("stepHorizon over a bare sphere is the geometric dip, -sqrt(2z/R)", () => {
    const n = 101, L: Layer = { dem: new Float32Array(n * n), n, x0: -50e3, y0: 50e3, res: 1000, s0: 0, s1: 0 };
    const dip = -Math.sqrt((2 * 2) / R) * (180 / Math.PI);
    // samples every 500 m on this 1 km layer: the 2.6 km tangent point falls between two, ~1e-4 deg below the dip
    const h = stepHorizon([L], 0, 0, 2, 37);
    expect(Math.abs(h - dip)).toBeLessThan(2e-4);
  });
});
