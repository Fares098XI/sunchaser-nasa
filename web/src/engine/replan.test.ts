/** Slip planner helpers on cases with known answers. */
import { describe, expect, it } from "vitest";
import { NO_DATA, distKm, nextPass, planB } from "./replan";

describe("slip planner", () => {
  it("finds the next day that meets everything", () => {
    const f = [0, 4, NO_DATA, 1, 0, 0];
    expect(nextPass(f, 0)).toBe(0);
    expect(nextPass(f, 1)).toBe(4);
    expect(nextPass(f, 5)).toBe(5);
    expect(nextPass([1, 2], 0)).toBeNull();
  });
  it("ranks Plan B sites that pass that day by distance, within the region, never the planned site", () => {
    const deg = (km: number) => (km / (2 * Math.PI * 1737.4)) * 360; // along the equator
    const home = { id: "h", lat_deg: 0, lon_deg: 0 };
    const sites = [
      { id: "h", lat_deg: 0, lon_deg: 0, fails: [0, 0] },
      { id: "far", lat_deg: 0, lon_deg: deg(50), fails: [0, 0] },
      { id: "near", lat_deg: 0, lon_deg: deg(5), fails: [0, 1] },     // fails day 1
      { id: "mid", lat_deg: deg(10), lon_deg: 0, fails: [0, 0] },
      { id: "apollo", lat_deg: 0, lon_deg: deg(900), fails: [0, 0] }, // outside the region
    ];
    expect(planB(sites, home, 0).map((s) => [s.id, Math.round(s.km)])).toEqual([["near", 5], ["mid", 10], ["far", 50]]);
    expect(planB(sites, home, 1).map((s) => s.id)).toEqual(["mid", "far"]);
    expect(distKm(home, sites[1])).toBeCloseTo(50, 9);
    expect(distKm({ id: "a", lat_deg: -90, lon_deg: 0 }, { id: "b", lat_deg: 90, lon_deg: 0 })).toBeCloseTo(Math.PI * 1737.4, 6);
  });
});
