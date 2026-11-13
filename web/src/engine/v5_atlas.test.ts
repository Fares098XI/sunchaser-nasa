/** V5 for atlas sites: Sun/Earth tables derived in the browser == the pipeline's derivation (< 1e-6 deg). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSite, type SiteData, type SitesManifest } from "./sites";

const dir = new URL("../../public/data/sites/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("./golden/v5_atlas.json", import.meta.url), "utf8"));
const manifest: SitesManifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const load = (id: string, ref?: SiteData) => {
  const e = manifest.sites.find((s) => s.id === id)!, b = readFileSync(new URL(e.file, dir));
  return decodeSite(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), e, manifest, ref);
};

describe("V5 golden: atlas sites", () => {
  it(`derived tables match Python on ${golden.cases.length} cases`, () => {
    const ref = load(golden.ref), cache = new Map<string, SiteData>();
    let worst = 0;
    for (const c of golden.cases) {
      if (!cache.has(c.site)) cache.set(c.site, load(c.site, ref));
      const t = cache.get(c.site)![c.body as "sun" | "earth"];
      worst = Math.max(worst, Math.abs(((t.az[c.i] - c.az + 540) % 360) - 180), Math.abs(t.el[c.i] - c.el), Math.abs(t.r[c.i] - c.r));
    }
    console.log(`V5 atlas: worst |diff| = ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-6);
  }, 20_000); // decodes 15 atlas sites: ~5 s when the machine is busy
});
