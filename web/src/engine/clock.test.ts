/** Mission clock: crossings of margin series, step counting and formatting on cases with known answers. */
import { describe, expect, it } from "vitest";
import { allOf, fmtDuration, marginAt, nextChange, stepsUntilChange } from "./clock";

describe("mission clock", () => {
  it("finds a linear crossing between samples", () => {
    const m = [2, 1, -1, -3, 1];                    // down at 1.5, up again at 3.75
    expect(nextChange(m, 0)).toEqual({ up: true, at: 1.5 });
    expect(nextChange(m, 1.25)).toEqual({ up: true, at: 1.5 });
    expect(nextChange(m, 2)).toEqual({ up: false, at: 3.75 });
    expect(nextChange(m, 3.9)).toEqual({ up: true, at: null });
  });
  it("starts mid-interval from the interpolated value", () => {
    expect(marginAt([0, 4], 0.25)).toBe(1);
    expect(nextChange([-1, 3], 0.5)).toEqual({ up: true, at: null });
    expect(nextChange([-1, 3], 0.1)).toEqual({ up: false, at: 0.25 });
  });
  it("combines conditions with the minimum", () => {
    expect(Array.from(allOf([1, 2, -1], [3, -2, 4]))).toEqual([1, -2, -1]);
  });
  it("counts steps until a 0/1 series changes", () => {
    expect(stepsUntilChange([1, 1, 0, 0], 0)).toEqual({ up: true, steps: 2 });
    expect(stepsUntilChange([0, 0, 0.3], 1)).toEqual({ up: false, steps: 1 });
    expect(stepsUntilChange([1, 1, 1], 0)).toEqual({ up: true, steps: null });
  });
  it("formats durations without 60-minute or 24-hour remainders", () => {
    expect(fmtDuration(0.99)).toBe("59 min");
    expect(fmtDuration(0.999)).toBe("1 h 00 min");
    expect(fmtDuration(5 + 10 / 60)).toBe("5 h 10 min");
    expect(fmtDuration(52)).toBe("2 d 4 h");
    expect(fmtDuration(71.8)).toBe("3 d 0 h");
  });
});
