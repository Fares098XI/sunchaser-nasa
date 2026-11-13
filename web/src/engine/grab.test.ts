import { describe, expect, it } from "vitest";
import { hourForAzimuth } from "./grab";

describe("hourForAzimuth", () => {
  const az = Array.from({ length: 200 }, (_, h) => (350 + 0.5 * h) % 360); // 0.5 deg/h, wraps through 0
  it("finds the matching hour and interpolates between hours", () => {
    expect(hourForAzimuth(az, 10, 0)).toBeCloseTo(20, 9);     // 350 + 0.5*20 = 360 = 0
    expect(hourForAzimuth(az, 30, 1.25)).toBeCloseTo(22.5, 9); // between hours 22 and 23
  });
  it("stays near the current hour (local search)", () => {
    // 30 deg is at hour 80, outside 150 +- 48: the closest reachable hour is the window's lower edge
    expect(hourForAzimuth(az, 150, 30)).toBe(102);
  });
});
