/** Learn's tilt explorer: textbook solar elevation, checked on cases with known answers. */
import { describe, expect, it } from "vitest";
import { sunElevation } from "./LearnFigures";

describe("sunElevation", () => {
  it("at the pole the Sun's height equals its declination all day", () => {
    for (const h of [0, 90, 200, 359]) expect(sunElevation(90, 1.54, h)).toBeCloseTo(1.54, 9);
  });
  it("at the equator on an equinox noon the Sun is overhead and sets 90° later", () => {
    expect(sunElevation(0, 0, 0)).toBeCloseTo(90, 9);
    expect(sunElevation(0, 0, 90)).toBeCloseTo(0, 9);
  });
  it("near the pole it swings by the co-latitude around the declination", () => {
    expect(sunElevation(89.45, 1.54, 0)).toBeCloseTo(1.54 + 0.55, 3);
    expect(sunElevation(89.45, 1.54, 180)).toBeCloseTo(1.54 - 0.55, 3);
  });
});
