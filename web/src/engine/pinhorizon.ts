/**
 * Horizons at any point on the Moon, in the browser (S5 "drop a pin", docs/METHODS.md §20). A line-by-line port of
 * the pipeline's atlas build (pipeline/sunchaser/atlas.py: oblique stereographic grid centred on the point, LOLA
 * global maps resampled onto it) and its exact ray walk (horizon.py _march_dda). V11: equals the pipeline's atlas
 * horizons. The four observer heights share each ray's terrain samples; the arithmetic per height is the pipeline's.
 */
import { R_MOON_M as R } from "./frames";

export const N_AZ = 1440;
export const Z_M = [1, 2, 5, 10];
export const DISPERSION_M = [125, 250];
export const NEAR_M = 30_000, FAR_M = 300_000;
const MARGIN_M = 250 + 1500; // dispersion radius + a cell (atlas.MARGIN_M)
const DEG = 180 / Math.PI, RAD = Math.PI / 180;

/** A global LOLA GDR map: height (m above 1737.4 km) at pixel (line, sample); NaN where not loaded. */
export interface Raster { name: string; ppd: number; ns: number; nl: number; get(r: number, c: number): number }

/** Rows N, E, −U of the site's frame (atlas.rotation): the site at the grid's pole, north on +y, east on +x. */
export function rotation(latDeg: number, lonDeg: number): number[][] {
  const la = latDeg * RAD, lo = lonDeg * RAD;
  const N = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const E = [-Math.sin(lo), Math.cos(lo), 0];
  const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  return [N, E, U.map((u) => -u)];
}

export interface Grid { x0: number; y0: number; res: number; n: number; lat: Float64Array; lon: Float64Array }

/** Cell centres of a square layer around the site and their lat / east lon (atlas.layer + grid_to_latlon). */
export function layerGrid(latDeg: number, lonDeg: number, res: number, s1: number): Grid {
  return squareGrid(latDeg, lonDeg, res, Math.ceil((2 * (s1 + MARGIN_M)) / res));
}

/** n x n cells of res metres centred on the point, on its oblique stereographic grid. */
export function squareGrid(latDeg: number, lonDeg: number, res: number, n: number): Grid {
  const rot = rotation(latDeg, lonDeg);
  const x0 = (-n * res) / 2, y0 = -x0, lat = new Float64Array(n * n), lon = new Float64Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ll = rotGridToLatLon(rot, x0 + (c + 0.5) * res, y0 - (r + 0.5) * res);
      lat[r * n + c] = ll[0];
      lon[r * n + c] = ll[1];
    }
  }
  return { x0, y0, res, n, lat, lon };
}

/** Grid (x east, y north, m) on the point's oblique stereographic grid -> [lat, east lon] (atlas.grid_to_latlon). */
export const gridToLatLon = (latDeg: number, lonDeg: number, x: number, y: number) => rotGridToLatLon(rotation(latDeg, lonDeg), x, y);

function rotGridToLatLon(rot: number[][], x: number, y: number): [number, number] {
  const t2 = (x * x + y * y) / (4.0 * R * R);
  const v0 = y / R / (1 + t2), v1 = x / R / (1 + t2), v2 = -(1 - t2) / (1 + t2);
  const m0 = v0 * rot[0][0] + v1 * rot[1][0] + v2 * rot[2][0];
  const m1 = v0 * rot[0][1] + v1 * rot[1][1] + v2 * rot[2][1];
  const m2 = v0 * rot[0][2] + v1 * rot[1][2] + v2 * rot[2][2];
  return [Math.asin(Math.min(1, Math.max(-1, m2))) * DEG, (((Math.atan2(m1, m0) * DEG) % 360) + 360) % 360];
}

/** Pixel (line, sample) pairs a grid's bilinear lookups read, as [line, sample] of each pixel's top-left. */
function pixel(ppd: number, nl: number, lat: number, lon: number) {
  const fr = (90.0 - lat) * ppd - 0.5, fc = (lon % 360) * ppd - 0.5;
  const r = Math.min(Math.max(Math.floor(fr), 0), nl - 2);
  return { fr, fc, r, c: Math.floor(fc) };
}

/** Keys (line_tile * cols + sample_tile) of the tiles of `tilePx` pixels a grid needs from a map. */
export function tilesFor(g: Grid, ppd: number, ns: number, nl: number, tilePx: number): number[] {
  const keys = new Set<number>(), cols = ns / tilePx;
  for (let i = 0; i < g.lat.length; i++) {
    const { r, c } = pixel(ppd, nl, g.lat[i], g.lon[i]);
    for (const rr of [r, r + 1]) for (const cc of [c, c + 1]) keys.add(Math.floor(rr / tilePx) * cols + Math.floor((((cc % ns) + ns) % ns) / tilePx));
  }
  return [...keys];
}

/** Bilinear map heights at the grid's cells (atlas.sample), float32 like the pipeline. Throws on missing data. */
export function sampleGrid(g: Grid, m: Raster): Float32Array {
  const out = new Float32Array(g.lat.length);
  for (let i = 0; i < out.length; i++) {
    const { fr, fc, r, c } = pixel(m.ppd, m.nl, g.lat[i], g.lon[i]);
    const b = Math.min(Math.max(fr - r, 0), 1), f = fc - c;
    const c0 = ((c % m.ns) + m.ns) % m.ns, c1 = (((c + 1) % m.ns) + m.ns) % m.ns;
    const top = m.get(r, c0) * (1 - f) + m.get(r, c1) * f, bot = m.get(r + 1, c0) * (1 - f) + m.get(r + 1, c1) * f;
    out[i] = top * (1 - b) + bot * b;
    if (out[i] !== out[i]) throw new Error(`${m.name}: no data at ${g.lat[i].toFixed(3)}, ${g.lon[i].toFixed(3)}`);
  }
  return out;
}

export interface Layer { dem: Float32Array; n: number; x0: number; y0: number; res: number; s0: number; s1: number }

export function bil(L: Layer, x: number, y: number): number {
  const fc = (x - L.x0) / L.res - 0.5, fr = (L.y0 - y) / L.res - 0.5, c = Math.floor(fc), r = Math.floor(fr);
  if (r < 0 || c < 0 || r >= L.n - 1 || c >= L.n - 1) return NaN;
  const a = fc - c, b = fr - r, i = r * L.n + c, d = L.dem;
  return (d[i] * (1 - a) + d[i + 1] * a) * (1 - b) + (d[i + L.n] * (1 - a) + d[i + L.n + 1] * a) * b;
}

/** dispersion_points(0, 0): centre, 6 at 125 m, 12 at 250 m (build_sites.dispersion_points) */
export function dispersionPoints(): [number, number][] {
  const pts: [number, number][] = [[0, 0]];
  DISPERSION_M.forEach((r, k) => {
    const n = k === 0 ? 6 : 12;
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push([r * Math.sin(a), r * Math.cos(a)]); }
  });
  return pts;
}

/**
 * Horizon elevation (deg) for every azimuth, point and height, layout [az][pt][z] (horizon.compute over
 * Z_M, stacked as atlas.build). `onProgress(done, total)` after each point of each layer.
 */
export function marchHorizons(layers: Layer[], pts: [number, number][], zs = Z_M, nAz = N_AZ,
  onProgress?: (done: number, total: number) => void): { deg: Float64Array; ground: Float64Array } {
  const nP = pts.length, nZ = zs.length, inv2r = 1.0 / (2.0 * R);
  const best = new Float64Array(nAz * nP * nZ).fill(-1.0);
  const sinA = new Float64Array(nAz), cosA = new Float64Array(nAz);
  for (let a = 0; a < nAz; a++) { const t = ((a * 360.0) / nAz) * RAD; sinA[a] = Math.sin(t); cosA[a] = Math.cos(t); }
  const ground = Float64Array.from(pts, ([x, y]) => bil(layers[0], x, y));
  if (!ground.every(Number.isFinite)) throw new Error("observer outside the first layer");
  const P = new Float64Array(3 * nZ), U = new Float64Array(3 * nZ), oh = new Float64Array(nZ), A0 = new Float64Array(nZ);
  const point = (x: number, y: number, h: number, o: Float64Array, k: number) => {
    const t2 = (x * x + y * y) / (4.0 * R * R), f = (R + h) / (1.0 + t2);
    o[k] = (f * y) / R; o[k + 1] = (f * x) / R; o[k + 2] = -f * (1.0 - t2);
  };
  const q = new Float64Array(3);
  let done = 0;
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li], F = layers[li + 1], { res, s0, s1 } = L;
    for (let n = 0; n < nP; n++) {
      const [ox, oy] = pts[n];
      for (let z = 0; z < nZ; z++) {
        oh[z] = ground[n] + zs[z];
        point(ox, oy, oh[z], P, 3 * z);
        const nr = Math.sqrt(P[3 * z] ** 2 + P[3 * z + 1] ** 2 + P[3 * z + 2] ** 2);
        U[3 * z] = P[3 * z] / nr; U[3 * z + 1] = P[3 * z + 1] / nr; U[3 * z + 2] = P[3 * z + 2] / nr;
      }
      const fc0 = (ox - L.x0) / res - 0.5, fr0 = (L.y0 - oy) / res - 0.5;
      for (let a = 0; a < nAz; a++) {
        const sa = sinA[a], ca = cosA[a], base = (a * nP + n) * nZ;
        // sin(elevation) of the terrain point at distance s, height h, for each observer height
        const elev = (s: number, h: number) => {
          point(ox + s * sa, oy + s * ca, h, q, 0);
          for (let z = 0; z < nZ; z++) {
            const vx = q[0] - P[3 * z], vy = q[1] - P[3 * z + 1], vz = q[2] - P[3 * z + 2];
            const v = (vx * U[3 * z] + vy * U[3 * z + 1] + vz * U[3 * z + 2]) / Math.sqrt(vx * vx + vy * vy + vz * vz);
            if (v > best[base + z]) best[base + z] = v;
          }
        };
        // height from this layer, else from the next (coarser) one; fp/f = it came from the fallback
        let sp = s0, hp = bil(L, ox + s0 * sa, oy + s0 * ca), fp = false;
        if (hp !== hp) { hp = F ? bil(F, ox + s0 * sa, oy + s0 * ca) : NaN; fp = true; }
        const dc = sa / res, dr = -ca / res;
        let tc = 1e30, sc = 1e30, tr = 1e30, sr = 1e30;
        if (Math.abs(dc) > 1e-12) {
          tc = 1.0 / Math.abs(dc);
          const f = fc0 + dc * s0, k = dc > 0 ? Math.floor(f) + 1.0 : Math.ceil(f) - 1.0;
          sc = s0 + (k - f) / dc;
        }
        if (Math.abs(dr) > 1e-12) {
          tr = 1.0 / Math.abs(dr);
          const f = fr0 + dr * s0, k = dr > 0 ? Math.floor(f) + 1.0 : Math.ceil(f) - 1.0;
          sr = s0 + (k - f) / dr;
        }
        if (s0 > 0.0 && hp === hp) elev(s0, hp);
        let fin = false;
        while (!fin) {
          let s: number;
          if (sc <= sr) { s = sc; sc += tc; } else { s = sr; sr += tr; }
          if (s >= s1) { s = s1; fin = true; }
          let h = bil(L, ox + s * sa, oy + s * ca), f = false;
          if (h !== h) { h = F ? bil(F, ox + s * sa, oy + s * ca) : NaN; f = true; }
          if (h === h) {
            elev(s, h);
            // in-cell maximum of the bilinear twist (see horizon._march_dda)
            if (hp === hp && !f && !fp && s - sp > 1e-9) {
              const sm = 0.5 * (sp + s), hm = bil(L, ox + sm * sa, oy + sm * ca);
              if (hm === hm) {
                const ln = s - sp, c = (2.0 * (h - 2.0 * hm + hp)) / (ln * ln), bb = (h - hp) / ln - c * ln;
                const cc = c - inv2r;
                let any = false;
                for (let z = 0; z < nZ; z++) { A0[z] = hp - bb * sp + c * sp * sp - oh[z]; any ||= A0[z] < 0.0; }
                if (any && cc < 0.0) {
                  for (let z = 0; z < nZ; z++) {
                    if (!(A0[z] < 0.0)) continue;
                    const st = Math.sqrt(A0[z] / cc);
                    if (sp < st && st < s) {
                      const ht = hp + bb * (st - sp) + c * (st - sp) * (st - sp);
                      point(ox + st * sa, oy + st * ca, ht, q, 0);
                      const vx = q[0] - P[3 * z], vy = q[1] - P[3 * z + 1], vz = q[2] - P[3 * z + 2];
                      const v = (vx * U[3 * z] + vy * U[3 * z + 1] + vz * U[3 * z + 2]) / Math.sqrt(vx * vx + vy * vy + vz * vz);
                      if (v > best[base + z]) best[base + z] = v;
                    }
                  }
                }
              }
            }
          }
          sp = s; hp = h; fp = f;
        }
      }
      onProgress?.(++done, nP * layers.length);
    }
  }
  for (let i = 0; i < best.length; i++) best[i] = Math.asin(best[i]) * DEG;
  return { deg: best, ground };
}

/** The atlas layers for a point: `near` map at 400 m to 30 km, `far` map at 1500 m to 300 km. */
export function pinLayers(latDeg: number, lonDeg: number, near: Raster, far: Raster, grids?: [Grid, Grid]): Layer[] {
  const [g0, g1] = grids ?? pinGrids(latDeg, lonDeg);
  return [
    { dem: sampleGrid(g0, near), n: g0.n, x0: g0.x0, y0: g0.y0, res: g0.res, s0: 0, s1: NEAR_M },
    { dem: sampleGrid(g1, far), n: g1.n, x0: g1.x0, y0: g1.y0, res: g1.res, s0: NEAR_M, s1: FAR_M },
  ];
}

export const pinGrids = (latDeg: number, lonDeg: number): [Grid, Grid] =>
  [layerGrid(latDeg, lonDeg, 400, NEAR_M), layerGrid(latDeg, lonDeg, 1500, FAR_M)];

/** A map held as tiles of tilePx x tilePx int16 (0.5 m units), keyed as in tilesFor. */
export function tileRaster(name: string, ppd: number, ns: number, nl: number, tilePx: number, tiles: Map<number, Int16Array>): Raster {
  const cols = ns / tilePx;
  return {
    name, ppd, ns, nl,
    get(r, c) {
      const t = tiles.get(Math.floor(r / tilePx) * cols + Math.floor(c / tilePx));
      return t ? t[(r % tilePx) * tilePx + (c % tilePx)] * 0.5 : NaN;
    },
  };
}

/** A map crop: lines r0.. (nr), samples c0.. (nc, wrapping at 360 deg), int16 0.5 m units, row-major. */
export function cropRaster(name: string, ppd: number, ns: number, nl: number, r0: number, nr: number, c0: number, nc: number, dn: Int16Array): Raster {
  return {
    name, ppd, ns, nl,
    get(r, c) {
      const rr = r - r0, cc = (c - c0 + ns) % ns;
      return rr >= 0 && rr < nr && cc < nc ? dn[rr * nc + cc] * 0.5 : NaN;
    },
  };
}

/** The two LOLA products (PDS labels): pixels per degree, samples, lines. */
export const LDEM_64 = { name: "LOLA LDEM_64 (474 m)", ppd: 64, ns: 23040, nl: 11520 };
export const LDEM_16 = { name: "LOLA LDEM_16 (1895 m)", ppd: 16, ns: 5760, nl: 2880 };
