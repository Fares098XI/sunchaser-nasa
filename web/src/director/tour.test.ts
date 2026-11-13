/** Director tour timeline: well-formed and continuous (the tour must play the same way every time). */
import { describe, expect, it } from "vitest";
import { CAPTIONS, CUES, DIPS, ORBITS, TOUR, tourCurtain, tourGaze, tourHour } from "./tour";

describe("Director tour", () => {
  it("cues are in order and inside the tour", () => {
    CUES.forEach(([at], i) => { expect(at).toBeGreaterThanOrEqual(0); expect(at).toBeLessThan(TOUR.length); if (i) expect(at).toBeGreaterThan(CUES[i - 1][0]); });
  });
  it("captions and orbits never overlap and end by the tour's end", () => {
    for (const list of [CAPTIONS, ORBITS]) list.forEach((c, i) => {
      expect(c.to).toBeGreaterThan(c.from);
      expect(c.to).toBeLessThanOrEqual(TOUR.length);
      if (i) expect(c.from).toBeGreaterThanOrEqual(list[i - 1].to);
    });
  });
  it("the clock sweep has no jumps", () => {
    const route = { dep: 1000, hours: 5.25 };
    for (const [a, b] of [[0, 28], [49.5, 61.4]]) {
      let prev = tourHour(a, 1000, route)!;
      for (let t = a; t <= b; t += 0.05) {
        const h = tourHour(t, 1000, route)!;
        expect(Math.abs(h - prev)).toBeLessThan(0.5);
        prev = h;
      }
    }
    expect(tourHour(27.99, 1000, route)).toBeCloseTo(1000 + TOUR.sweepHours, 1);
    expect(tourHour(61.4, 1000, route)).toBeCloseTo(1005.25, 3);
  });
  it("each dip is black exactly at its cut and clear around it", () => {
    for (const d of DIPS) {
      expect(tourCurtain(d.at)).toBeCloseTo(1);
      expect(tourCurtain(d.at - d.fadeIn - 0.01)).toBe(0);
      expect(tourCurtain(d.at + d.fadeOut + 0.01)).toBe(0);
      expect(CUES.some(([at]) => at === d.at)).toBe(true); // the scene changes behind the curtain
    }
  });
  it("the gaze turns the short way from the Sun to Earth", () => {
    expect(tourGaze(70.6, 350, 20)!.yaw).toBeCloseTo(350);
    expect(tourGaze(85, 350, 20)!.yaw).toBeCloseTo(380); // = 20 deg, through north
    expect(tourGaze(89, 350, 20)!.fov).toBeCloseTo(26);
  });
});
