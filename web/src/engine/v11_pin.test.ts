/** V11: horizons computed in the browser for any point == the pipeline's atlas horizons (docs/VALIDATION.md V11). */
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { nearCrop } from "../../api/dem";
import { decodeHorizon } from "./horizon";
import type { SitesManifest } from "./sites";
import {
  LDEM_16, LDEM_64, N_AZ, Z_M, cropRaster, dispersionPoints, marchHorizons, pinGrids, pinLayers, tileRaster, tilesFor,
} from "./pinhorizon";

const pub = new URL("../../public/data/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("./golden/v11_pin.json", import.meta.url), "utf8"));
const manifest: SitesManifest = JSON.parse(readFileSync(new URL("sites/manifest.json", pub), "utf8"));
const meta = JSON.parse(readFileSync(new URL("terrain16/meta.json", pub), "utf8"));
const i16 = (b: Buffer) => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

describe("V11: drop-a-pin horizons", () => {
  for (const g of golden.sites) {
    it(`${g.id}: browser == pipeline atlas build`, () => {
      expect(nearCrop(g.lat, g.lon)).toEqual({ r0: g.r0, nr: g.nr, c0: g.c0, nc: g.nc }); // the API's crop = the pipeline's
      const grids = pinGrids(g.lat, g.lon);
      const tiles = new Map<number, Int16Array>();
      for (const k of tilesFor(grids[1], LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, meta.tile_px)) {
        const i = Math.floor(k / meta.cols), j = k % meta.cols;
        tiles.set(k, i16(inflateSync(readFileSync(new URL(`terrain16/${i}_${j}.i16z`, pub)))));
      }
      const near = cropRaster(LDEM_64.name, LDEM_64.ppd, LDEM_64.ns, LDEM_64.nl, g.r0, g.nr, g.c0, g.nc,
        i16(inflateSync(readFileSync(new URL(`./golden/v11_${g.id}.i16z`, import.meta.url)))));
      const far = tileRaster(LDEM_16.name, LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, meta.tile_px, tiles);
      const t0 = performance.now();
      const { deg, ground } = marchHorizons(pinLayers(g.lat, g.lon, near, far, grids), dispersionPoints());
      const ms = performance.now() - t0;
      const nP = 19, nZ = Z_M.length;
      let worst = 0;
      for (let p = 0; p < nP; p++) for (let z = 0; z < nZ; z++) g.hz[p][z].forEach((v: number, j: number) => {
        worst = Math.max(worst, Math.abs(deg[((j * golden.az_every) * nP + p) * nZ + z] - v));
      });
      // every azimuth: our quantized horizon vs the shipped atlas file (1/256 deg steps)
      const e = manifest.sites.find((s) => s.id === g.id)!;
      const b = readFileSync(new URL(`sites/${e.file}`, pub));
      const shipped = decodeHorizon(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), N_AZ, nP, nZ, manifest.horizon.quantum_deg);
      let off = 0;
      for (let i = 0; i < deg.length; i++) if (Math.round(deg[i] / manifest.horizon.quantum_deg) !== shipped.k[i]) off++;
      console.log(`V11 ${g.id}: ${ms.toFixed(0)} ms, worst ${worst.toExponential(2)} deg, ground ${(ground[0] - g.ground_m).toExponential(1)} m, quantized mismatches ${off}/${deg.length}`);
      expect(Math.abs(ground[0] - g.ground_m)).toBeLessThan(1e-3);
      expect(worst).toBeLessThan(1e-6); // the pipeline stores float32
      expect(off).toBeLessThan(deg.length * 1e-3);
    }, 60_000);
  }
});
