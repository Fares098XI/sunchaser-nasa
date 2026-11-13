/** Landing slope (browser) == pipeline site_terrain.py on the real Connecting Ridge terrain; nearest PSR vs brute force. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { landingCircle, nearestFlagged, slopeMap } from "./terrainmetrics";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const m = JSON.parse(read("../../public/data/manifest.json").toString());
const sites = JSON.parse(read("../../public/data/sites/manifest.json").toString()).sites;
const tb = read(`../../public/data/${m.terrain.file}`);
const heights = new Float32Array(tb.buffer.slice(tb.byteOffset, tb.byteOffset + tb.byteLength));

describe("landing safety", () => {
  it("reproduces the pipeline's 100 m landing-circle slopes at Connecting Ridge", () => {
    const s = sites.find((x: { id: string }) => x.id === "connecting-ridge");
    const slope = slopeMap(heights, m.terrain);
    const c = landingCircle(slope, m.terrain, s.x_m, s.y_m)!;
    const ref = s.terrain.slope;
    expect(c.cells).toBe(ref.cells);
    expect(Math.abs(c.median - ref.median_deg)).toBeLessThan(0.006);
    expect(Math.abs(c.p95 - ref.p95_deg)).toBeLessThan(0.006);
    expect(Math.abs(c.max - ref.max_deg)).toBeLessThan(0.006);
    expect(Math.abs(c.shareBelow(5) - ref.share_below["5"])).toBeLessThan(0.0006);
  });
  it("finds the nearest flagged cell like a brute-force search", () => {
    const g = { rows: 30, cols: 40, res_m: 40, x0_m: -800, y0_m: 600 };
    const mask = new Uint8Array(1200);
    mask[5 * 40 + 7] = 1; mask[22 * 40 + 31] = 1;
    const r = nearestFlagged(mask, g, -800 + 7.5 * 40 + 100, 600 - 5.5 * 40)!;
    expect(r.m).toBeCloseTo(100, 9);
    expect(r.bearing).toBeCloseTo(270, 9);
    expect(nearestFlagged(new Uint8Array(1200), g, 0, 0)).toBeNull();
  });
});
