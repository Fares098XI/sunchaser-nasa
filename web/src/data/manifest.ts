import { decodeHorizon, type HorizonGrid } from "../engine/horizon";
import { decodeHorizonOff } from "./background";
import type { TrackIndex } from "../engine/tracks";

export interface Manifest {
  generated_utc?: string;
  region: {
    id: string; name: string; site_source: string; site_x_m: number; site_y_m: number;
    center_lat_deg: number; center_lon_deg: number; center_h_m: number;
    /** "pin" (S5b): a region built in the browser on the pin's oblique stereographic grid (grid x = east, y = north) */
    frame?: "pin";
  };
  terrain: {
    file: string; rows: number; cols: number; res_m: number; x0_m: number; y0_m: number;
    h_min_m: number; h_max_m: number; units: string; source: string; sha256: string;
  };
  horizon: {
    file: string; quantum_deg: number; n_az: number; rows: number; cols: number; cell_m: number;
    x0_m: number; y0_m: number; z_m: number; layers: string[]; sha256: string;
  };
  psr: { file: string; rows: number; cols: number; source: string; fraction: number; raw_fraction: number; min_patch_cells: number };
  /** 2020-2045 hourly Sun/Earth tracks, one file per year (engine/tracks.ts) */
  tracks: TrackIndex & { frame: string; method: string };
  /** rows: scene axes (x = grid x, y = up, z = -grid y) in MOON_ME at the region centre */
  scene_from_me: number[][];
  /** DSN 70 m antennas (SPICE station kernel), for the Earth close-up */
  dsn_stations: { id: string; name: string; lat_deg: number; lon_deg: number; min_elev_deg: number }[];
}

/** psr: NASA permanent-shadow mask (0/1) on the horizon grid; base: the folder its files are fetched from. */
export interface RegionData {
  manifest: Manifest; heights: Float32Array; psr: Uint8Array; base: string;
  /** built in the browser (S5b pin): far-field rings in memory, and albedo relative to the Moon's mean on an n x n grid */
  farfieldBuf?: ArrayBuffer; albedo?: { data: Float32Array; n: number; far?: Float32Array | null; farHalfKm?: number } | null;
  /** V12 for this build: worst |GPU - CPU| horizon (deg) at the checked cells, and build times (ms) */
  pinCheck?: { v12: number; ms: { terrain: number; shadows: number; total: number } };
}

/** web/public/data/regions/index.json (pipeline export_regions.write_index): every site with an explorable region. */
export interface RegionEntry { id: string; name: string; base: string; extent_km: number }
export const HERO_REGION = "connecting-ridge";

/** Lazy second load: packed horizons (pipeline export.encode_horizon). */
export async function loadHorizon(m: Manifest, base = "/data/"): Promise<HorizonGrid> {
  const { file, n_az, rows, cols, quantum_deg } = m.horizon;
  // decoded in a worker: 22 MB on the main thread froze the page for seconds
  if (typeof Worker !== "undefined") return decodeHorizonOff(new URL(base + file, location.href).href, n_az, rows, cols, quantum_deg);
  const bytes = new Uint8Array(await (await fetch(base + file)).arrayBuffer());
  return decodeHorizon(bytes, n_az, rows, cols, quantum_deg);
}

export async function loadRegion(base = "/data/"): Promise<RegionData> {
  const manifest: Manifest = await (await fetch(base + "manifest.json")).json();
  const [buf, psrBuf] = await Promise.all([
    fetch(base + manifest.terrain.file).then((r) => r.arrayBuffer()),
    fetch(base + manifest.psr.file).then((r) => r.arrayBuffer()),
  ]);
  const heights = new Float32Array(buf);
  const psr = new Uint8Array(psrBuf);
  if (heights.length !== manifest.terrain.rows * manifest.terrain.cols) throw new Error("terrain size mismatch");
  if (psr.length !== manifest.psr.rows * manifest.psr.cols) throw new Error("PSR size mismatch");
  return { manifest, heights, psr, base };
}
