import { describe, expect, it } from "vitest";
import { horizonAt, horizonAtPoint, type HorizonGrid } from "./horizon";

// 4 azimuths x 2 rows x 3 cols, value = 100*az + 10*row + col (steps of 1/256 deg)
const k = new Int16Array(24).map((_, i) => 100 * Math.floor(i / 6) + 10 * Math.floor((i % 6) / 3) + (i % 3));
const g: HorizonGrid = { nAz: 4, rows: 2, cols: 3, quantum: 1 / 256, k };

describe("horizonAtPoint", () => {
  it("equals horizonAt at cell centres and is bilinear between them", () => {
    expect(horizonAtPoint(g, 1, 2, 45)).toBe(horizonAt(g, 1, 2, 45));
    expect(horizonAtPoint(g, 0.5, 0.5, 0) * 256).toBeCloseTo(5.5, 12); // mean of 0, 1, 10, 11
  });
  it("clamps outside the grid", () => {
    expect(horizonAtPoint(g, -0.4, 5, 0)).toBe(horizonAt(g, 0, 2, 0));
  });
});
