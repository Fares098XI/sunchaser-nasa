/** Astronaut ground micro-relief (visual only): bounded, repeatable, continuous, and gone where it must fade out. */
import { describe, expect, it } from "vitest";
import { microM } from "./micro";

describe("micro-relief", () => {
  it("stays within a few metres and is the same on every call", () => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const x = (i * 37.3) % 900 - 450, y = (i * 91.7) % 900 - 450, h = microM(x, y);
      lo = Math.min(lo, h); hi = Math.max(hi, h);
      expect(microM(x, y)).toBe(h);
    }
    expect(lo).toBeGreaterThan(-3);
    expect(hi).toBeLessThan(1.5);
  });
  it("has no steps: 1 cm apart never differs by more than 3 cm", () => {
    for (let i = 0; i < 4000; i++) {
      const x = (i * 13.1) % 300 - 150, y = (i * 7.7) % 300 - 150;
      expect(Math.abs(microM(x + 0.01, y) - microM(x, y))).toBeLessThan(0.03);
    }
  });
  it("fades out with distance from the camera", () => {
    for (let i = 0; i < 200; i++) expect(microM(i * 3.7, -i * 1.3, 300)).toBe(0);
  });
});
