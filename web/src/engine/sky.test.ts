import { describe, expect, it } from "vitest";
import { SUN_RADIUS_DEG, sampleTrack, skyDirection, visibleDiscFraction } from "./sky";

describe("visibleDiscFraction", () => {
  it("is 0 below, 1/2 at the edge, 1 above, and monotonic", () => {
    expect(visibleDiscFraction(-1, 0)).toBe(0);
    expect(visibleDiscFraction(0, 0)).toBeCloseTo(0.5, 12);
    expect(visibleDiscFraction(1, 0)).toBe(1);
    let prev = -1;
    for (let e = -0.3; e <= 0.3; e += 0.01) {
      const f = visibleDiscFraction(e, 0);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
    expect(SUN_RADIUS_DEG).toBeCloseTo(0.2665, 3);
  });
});

describe("skyDirection", () => {
  it("maps grid north on the horizon to -z, east to +x, zenith to +y", () => {
    const n = skyDirection(0, 0), e = skyDirection(90, 0), z = skyDirection(123, 90);
    expect(n[2]).toBeCloseTo(-1, 12);
    expect(e[0]).toBeCloseTo(1, 12);
    expect(z[1]).toBeCloseTo(1, 12);
  });
});

describe("sampleTrack", () => {
  it("interpolates azimuth across the 360/0 wrap", () => {
    const s = sampleTrack({ az_grid_deg: [359, 1], elev_deg: [1, 2], dist_km: [10, 20] }, 0.5);
    expect(s.az).toBeCloseTo(0, 12);
    expect(s.el).toBeCloseTo(1.5, 12);
    expect(s.dist).toBeCloseTo(15, 12);
  });
});
