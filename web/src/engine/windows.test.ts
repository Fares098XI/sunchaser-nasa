import { describe, expect, it } from "vitest";
import type { Series } from "./sites";
import { FAIL_BIT, longestIn, metrics, minimalRelaxations, prepare, search, type Requirements } from "./windows";

const R1AU = (Math.asin(695700 / 149597870.7) * 180) / Math.PI;

function series(sun: number[], dte: number[]): Series {
  const n = sun.length;
  return {
    sun: Float64Array.from(sun), earth: Float64Array.from(dte.map((d) => (d ? 1 : 0))), dte: Uint8Array.from(dte),
    dsn: new Uint8Array(n).fill(1), sunR: new Float64Array(n).fill(R1AU),
  };
}

describe("longestIn", () => {
  it("clips runs at the window edges", () => {
    const runs = Int32Array.from([2, 5, 8, 20]); // [2,5) and [8,20)
    expect(longestIn(runs, 0, 10)).toBe(3);
    expect(longestIn(runs, 3, 10)).toBe(2);   // [3,5)=2, [8,10)=2
    expect(longestIn(runs, 9, 30)).toBe(11);  // [9,20)
    expect(longestIn(runs, 5, 8)).toBe(0);
  });
});

describe("metrics + search", () => {
  // 1-hour steps: sun on for 6, off for 3; DTE on except hours 4..9
  const sun = Array.from({ length: 48 }, (_, i) => (i % 9 < 6 ? 1 : 0));
  const dte = Array.from({ length: 48 }, (_, i) => (i >= 4 && i < 10 ? 0 : 1));
  const p = prepare(series(sun, dte), 3600);

  it("computes the definitions", () => {
    const m = metrics(p, 0, 18);
    expect(m.sunPct).toBeCloseTo((12 / 18) * 100, 12);
    expect(m.darkH).toBe(3);
    expect(m.dtePct).toBeCloseTo((12 / 18) * 100, 12);
    expect(m.blackoutH).toBe(6);
    expect(m.energyWhM2Day / (1361 * 12 / 18 * 24)).toBeCloseTo(1, 9);
  });

  it("flags the failing requirement and finds the minimal relaxation", () => {
    const req: Requirements = { days: 0.75, minSunPct: 60, maxDarkH: null, minDtePct: 50, maxBlackoutH: 4, battery: false };
    const res = search(p, req, 1);
    expect(res.starts.length).toBe(48 - 18 + 1);
    expect(res.fails[0] & FAIL_BIT.blackout).toBeTruthy(); // first window holds the 6 h blackout
    expect(res.fails[res.fails.length - 1]).toBe(0);       // later windows are clean
    const strict: Requirements = { ...req, maxBlackoutH: 0 };
    const relax = minimalRelaxations([search(p, strict, 1)], strict);
    const b = relax.find((r) => r.key === "blackout")!;
    expect(b.to).toBe(0); // some window already has no blackout at all
  });
});
