/**
 * Site catalog engine: decode pipeline/sunchaser/export_sites.py tables and compute per-step visibility.
 * Identical arithmetic to the Python export (V5 golden: v5_sites.json).
 */
import { decodeHorizon, type HorizonGrid } from "./horizon";
import { visibleDiscFraction } from "./sky";
import { R_MOON_M } from "./frames";

export interface SiteEntry {
  /** x_m / y_m: south polar stereographic grid (null for atlas sites anywhere on the Moon) */
  id: string; name: string; x_m: number | null; y_m: number | null; lat_deg: number; lon_deg: number; rule: string; source: string;
  /** atlas sites (S4): horizons only, tables derived from the reference site, true azimuths; mission card fields.
   * "pin" (S5): the user's own point, horizons computed in the browser (data/pin.ts) */
  kind?: "atlas" | "pin"; tables?: "derived"; azimuth?: "true"; agency?: string; country?: string; landed_utc?: string | null;
  status?: "landed" | "planned"; group?: string; note?: string;
  dem5: string | null; artemis_iii_region?: boolean; region?: string; sun_visibility?: number; earth_visibility?: number;
  slope_deg?: number; illum_product?: string; roi_area_m2?: number; ground_m: number; file: string; bytes: number;
  sha256: string; layers: string[];
  /** landing slope over the 100 m circle and nearest permanently shadowed region (pipeline site_terrain.py) */
  terrain?: { slope: { median_deg: number; p95_deg: number; max_deg: number }; psr_km: number | null };
}

export interface SitesManifest {
  start_utc: string; step_s: number; n: number; z_m: number[]; n_az: number; dispersion_m: number[]; n_pts: number;
  horizon: { quantum_deg: number };
  tables: {
    az_unit_deg: number; el_unit_deg: number; sun_r0_deg: number; sun_r_unit_deg: number;
    earth_r0_deg: number; earth_r_unit_deg: number;
  };
  dsn: { file: string; stations: string[]; names: string[]; min_elev_deg: number };
  sites: SiteEntry[];
}

export interface BodyTable { az: Float64Array; el: Float64Array; r: Float64Array }

export interface SiteData {
  entry: SiteEntry;
  /** horizons, layout [az][pt][z] (rows = points, cols = heights) */
  hz: HorizonGrid;
  sun: BodyTable;
  earth: BodyTable;
}

/** Inverse of export_sites.shuffle + delta_u16: cumulative sum mod 2^16 of byte-unshuffled uint16 deltas. */
export function decodeDeltaU16(bytes: Uint8Array, offset: number, n: number): Uint16Array {
  const out = new Uint16Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc + (bytes[offset + i] | (bytes[offset + n + i] << 8))) & 0xffff;
    out[i] = acc;
  }
  return out;
}

const signed16 = (v: number) => (v >= 0x8000 ? v - 0x10000 : v);

export function decodeSite(buf: ArrayBuffer, entry: SiteEntry, m: SitesManifest, ref?: SiteData): SiteData {
  const bytes = new Uint8Array(buf);
  const hzBytes = 2 * m.n_az * m.n_pts * m.z_m.length;
  const derived = entry.tables === "derived";
  if (bytes.length !== hzBytes + (derived ? 0 : 6 * 2 * m.n)) throw new Error(`${entry.id}: size mismatch`);
  const hz = decodeHorizon(bytes.subarray(0, hzBytes), m.n_az, m.n_pts, m.z_m.length, m.horizon.quantum_deg);
  if (derived) {
    if (!ref) throw new Error(`${entry.id}: needs the reference site's tables`);
    return { entry, hz, sun: deriveTable(ref.sun, SUN_RADIUS_M, ref.entry, entry), earth: deriveTable(ref.earth, EARTH_RADIUS_M, ref.entry, entry) };
  }
  const t = m.tables;
  const col = (k: number) => decodeDeltaU16(bytes, hzBytes + k * 2 * m.n, m.n);
  const body = (k: number, r0: number, ru: number): BodyTable => {
    const qa = col(k), qe = col(k + 1), qr = col(k + 2);
    const az = new Float64Array(m.n), el = new Float64Array(m.n), r = new Float64Array(m.n);
    for (let i = 0; i < m.n; i++) {
      az[i] = qa[i] * t.az_unit_deg;
      el[i] = signed16(qe[i]) * t.el_unit_deg;
      r[i] = r0 + qr[i] * ru;
    }
    return { az, el, r };
  };
  return {
    entry, hz,
    sun: body(0, t.sun_r0_deg, t.sun_r_unit_deg),
    earth: body(3, t.earth_r0_deg, t.earth_r_unit_deg),
  };
}

export const SUN_RADIUS_M = 695_700_000; // IAU 2015 nominal (pipeline visibility.SUN_RADIUS_M)
export const EARTH_RADIUS_M = 6_371_008.8; // IUGG mean (pipeline export_sites.EARTH_RADIUS_M)
const RAD = Math.PI / 180;

/** east, north, up unit vectors and the position (m, observer 2 m above ground) of a site in MOON_ME */
function siteFrame(e: SiteEntry) {
  const la = e.lat_deg * RAD, lo = e.lon_deg * RAD, r = R_MOON_M + e.ground_m + 2;
  const E = [-Math.sin(lo), Math.cos(lo), 0], N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  return { E, N, U, P: U.map((u) => u * r) };
}

/**
 * A body's direction from an atlas site, from its direction at the reference site (METHODS §19; mirrors pipeline
 * export_atlas.derive, V9: within 0.003 deg of SPICE computed at the site). Reference azimuths are grid bearings
 * (true = grid − longitude); the result is in true azimuths.
 */
export function deriveTable(t: BodyTable, radiusM: number, refEntry: SiteEntry, site: SiteEntry): BodyTable {
  const a0 = siteFrame(refEntry), a1 = siteFrame(site), n = t.az.length;
  const out = { az: new Float64Array(n), el: new Float64Array(n), r: new Float64Array(n) };
  const w = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const az = (t.az[i] - refEntry.lon_deg) * RAD, el = t.el[i] * RAD, dist = radiusM / Math.sin(t.r[i] * RAD);
    const ce = Math.cos(el), ve = Math.sin(az) * ce * dist, vn = Math.cos(az) * ce * dist, vu = Math.sin(el) * dist;
    for (let k = 0; k < 3; k++) w[k] = a0.E[k] * ve + a0.N[k] * vn + a0.U[k] * vu + a0.P[k] - a1.P[k];
    const x = w[0] * a1.E[0] + w[1] * a1.E[1] + w[2] * a1.E[2], y = w[0] * a1.N[0] + w[1] * a1.N[1] + w[2] * a1.N[2];
    const z = w[0] * a1.U[0] + w[1] * a1.U[1] + w[2] * a1.U[2], d = Math.hypot(x, y, z);
    out.az[i] = ((Math.atan2(x, y) / RAD) % 360 + 360) % 360;
    out.el[i] = Math.asin(z / d) / RAD;
    out.r[i] = Math.asin(radiusM / d) / RAD;
  }
  return out;
}

/** Horizon (deg) of dispersion point p at height index z, toward grid azimuth az (linear between bins). */
export function siteHorizon(s: SiteData, p: number, z: number, azDeg: number): number {
  const g = s.hz;
  const u = (((azDeg % 360) + 360) % 360) * g.nAz / 360;
  const i = Math.floor(u) % g.nAz;
  const f = u - Math.floor(u);
  const j = (i + 1) % g.nAz;
  const plane = g.rows * g.cols, cell = p * g.cols + z;
  return (g.k[i * plane + cell] * (1 - f) + g.k[j * plane + cell] * f) * g.quantum;
}

/** Visible disc fraction per step for one body at point p, height index z. */
export function bodySeries(s: SiteData, body: BodyTable, p: number, z: number): Float64Array {
  const out = new Float64Array(body.az.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = visibleDiscFraction(body.el[i], siteHorizon(s, p, z, body.az[i]), body.r[i]);
  }
  return out;
}

export interface Series {
  sun: Float64Array;   // visible solar-disc fraction
  earth: Float64Array; // visible Earth-disc fraction
  dte: Uint8Array;     // 1 = Earth centre above the terrain horizon AND a DSN antenna sees the Moon >= 6 deg
  dsn: Uint8Array;     // station bit mask
  sunR: Float64Array;  // solar angular radius (deg), for irradiance
}

export function siteSeries(s: SiteData, dsn: Uint8Array, p = 0, z = 0): Series {
  const sun = bodySeries(s, s.sun, p, z);
  const earth = bodySeries(s, s.earth, p, z);
  const dte = new Uint8Array(sun.length);
  for (let i = 0; i < dte.length; i++) dte[i] = earth[i] >= 0.5 && dsn[i] !== 0 ? 1 : 0;
  return { sun, earth, dte, dsn, sunR: s.sun.r };
}
