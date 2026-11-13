import { describe, expect, it } from "vitest";
import { stereoToLatLon } from "./frames";

describe("stereoToLatLon", () => {
  it("matches the Python pipeline at Connecting Ridge RoI 4", () => {
    // pipeline: stereo_to_latlon(-11287.5, -12167.5) = (-89.4526748505, 222.85134735)
    const p = stereoToLatLon(-11287.5, -12167.5);
    expect(p.lat).toBeCloseTo(-89.4526748505, 9);
    expect(p.lon).toBeCloseTo(222.85134735, 7);
  });
});
