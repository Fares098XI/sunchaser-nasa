/** V5: TypeScript engine == Python engine on golden cases (max |diff| < 1e-6). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeHorizon, horizonAt } from "./horizon";
import { visibleDiscFraction } from "./sky";

const golden = JSON.parse(readFileSync(new URL("./golden/v5_visibility.json", import.meta.url), "utf8"));
const { horizon: h } = JSON.parse(readFileSync(new URL("../../public/data/manifest.json", import.meta.url), "utf8"));
const buf = readFileSync(new URL(`../../public/data/${golden.horizon_file}`, import.meta.url));
// Decoding the shipped file is part of what V5 checks.
const grid = decodeHorizon(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), h.n_az, h.rows, h.cols, h.quantum_deg);

describe("V5 golden: horizon lookup + disc fraction", () => {
  it(`matches Python on ${golden.cases.length} cases`, () => {
    let maxH = 0, maxF = 0;
    for (const c of golden.cases) {
      const h = horizonAt(grid, c.row, c.col, c.az_grid_deg);
      const f = visibleDiscFraction(c.elev_deg, h, golden.radius_deg);
      maxH = Math.max(maxH, Math.abs(h - c.horizon_deg));
      maxF = Math.max(maxF, Math.abs(f - c.frac));
    }
    console.log(`V5 max |dh| ${maxH.toExponential(2)} deg, max |dfrac| ${maxF.toExponential(2)}`);
    expect(maxH).toBeLessThan(1e-6);
    expect(maxF).toBeLessThan(1e-6);
  });
});
