import type { HorizonGrid } from "../engine/horizon";
import { HALF_M, PIN_REGION } from "../engine/pinregion";
import type { Manifest, RegionData } from "./manifest";

/** S5b: the 3D region around a pin, built by workers/pinregion.worker.ts, as the RegionData every 3D view reads. */
export interface PinRegionProgress { stage: "terrain" | "shadows"; frac: number }
export interface PinRegion { data: RegionData; horizon: HorizonGrid; v12: number; ms: { terrain: number; shadows: number; total: number }; hiName: string }

const QUANTUM = 1 / 256; // as every shipped horizon (pipeline export.HORIZON_QUANTUM_DEG)
const RAD = Math.PI / 180;

export function buildPinRegion(lat: number, lon: number, hero: RegionData, onProgress?: (p: PinRegionProgress) => void): Promise<PinRegion> {
  const w = new Worker(new URL("../workers/pinregion.worker.ts", import.meta.url), { type: "module" });
  return new Promise<PinRegion>((resolve, reject) => {
    w.onmessage = (e) => {
      const d = e.data;
      if (d.progress) { onProgress?.(d.progress); return; }
      w.terminate();
      if (d.error) { reject(new Error(d.error)); return; }
      const { meshN, res, cellN, cell, nAz, z } = PIN_REGION, heights: Float32Array = d.heights;
      const c = meshN / 2, hc = (heights[(c - 1) * meshN + c - 1] + heights[(c - 1) * meshN + c] + heights[c * meshN + c - 1] + heights[c * meshN + c]) / 4;
      let lo = Infinity, hi = -Infinity;
      for (const h of heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
      // scene axes (x = east, y = up, z = south at the pin) in MOON_ME
      const la = lat * RAD, lo_ = lon * RAD;
      const E = [-Math.sin(lo_), Math.cos(lo_), 0], N = [-Math.sin(la) * Math.cos(lo_), -Math.sin(la) * Math.sin(lo_), Math.cos(la)];
      const U = [Math.cos(la) * Math.cos(lo_), Math.cos(la) * Math.sin(lo_), Math.sin(la)];
      const manifest = {
        generated_utc: new Date().toISOString(),
        region: { id: "pin", name: "Your pin", site_source: `your pin; terrain ${d.hiName}`, site_x_m: 0, site_y_m: 0,
          center_lat_deg: lat, center_lon_deg: lon, center_h_m: hc, frame: "pin" },
        terrain: { file: "", rows: meshN, cols: meshN, res_m: res, x0_m: -HALF_M, y0_m: HALF_M, h_min_m: lo, h_max_m: hi,
          units: "m above 1737.4 km sphere", source: d.hiName, sha256: "" },
        horizon: { file: "", quantum_deg: QUANTUM, n_az: nAz, rows: cellN, cols: cellN, cell_m: cell, x0_m: -HALF_M, y0_m: HALF_M, z_m: z,
          layers: [`${d.hiName}:near`, `${d.midName}:to 32 km`, "LOLA LDEM_16 (1895 m):to 300 km"], sha256: "" },
        psr: { file: "", rows: cellN, cols: cellN, source: "none (permanent-shadow maps cover the poles only)", fraction: 0, raw_fraction: 0, min_patch_cells: 0 },
        tracks: hero.manifest.tracks, dsn_stations: hero.manifest.dsn_stations,
        scene_from_me: [E, U, N.map((v) => -v)],
        farfield: { file: "", centre_x_m: 0, centre_y_m: 0, rings: d.rings },
      } as unknown as Manifest;
      resolve({
        data: { manifest, heights, psr: new Uint8Array(cellN * cellN), base: "", farfieldBuf: d.farfield, albedo: d.albedo && { data: d.albedo, n: d.albedoN, far: d.albedoFar, farHalfKm: 150 },
          pinCheck: { v12: d.v12, ms: d.ms } },
        horizon: { nAz, rows: cellN, cols: cellN, quantum: QUANTUM, k: d.hz },
        v12: d.v12, ms: d.ms, hiName: d.hiName,
      });
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ id: 1, lat, lon, quantum: QUANTUM });
  });
}
