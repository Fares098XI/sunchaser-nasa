import { describe, expect, it } from "vitest";
import { seriesStats } from "./series";

describe("seriesStats", () => {
  it("mean, any-visible share and longest hidden run", () => {
    const s = seriesStats(new Float32Array([1, 0.5, 0, 0, 0, 1, 0, 0]));
    expect(s.meanPct).toBeCloseTo(31.25, 6);
    expect(s.anyPct).toBeCloseTo(37.5, 6);
    expect(s.longestZeroH).toBe(3);
  });
});
