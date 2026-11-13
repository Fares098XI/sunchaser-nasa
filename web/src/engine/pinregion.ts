/**
 * A 3D region around any pin (S5b, docs/METHODS.md §21): 24 x 24 km of 59 m terrain (SLDEM2015 / LOLA LDEM_512) on
 * the pin's oblique stereographic grid, a horizon grid for its shading (200 x 200 cells of 120 m, 180 azimuths, 2 m),
 * and rings of surrounding terrain to 150 km. The horizon grid is marched on the GPU (scene/horizonGpu.ts) with the
 * stepping rule below; `stepHorizon` is the same rule on the CPU in double precision (V12).
 */
import { R_MOON_M as R } from "./frames";
import { bil, squareGrid, type Grid, type Layer } from "./pinhorizon";

export const PIN_REGION = {
  /** mesh: n x n vertices of res metres */ meshN: 400, res: 60,
  /** 59 m layer: the mesh plus 4 km on every side, so edge cells see their near terrain at full resolution */ l0N: 534,
  /** horizon grid */ cellN: 200, cell: 120, nAz: 180, z: 2,
  /** step = clamp(frac * s, res / 2, res) of the layer the sample falls in */ frac: 0.005, reach: 300_000,
};
export const HALF_M = (PIN_REGION.meshN * PIN_REGION.res) / 2; // 12 km
const DEG = 180 / Math.PI;

/** The 59 m layer's grid (the mesh is its central meshN x meshN). */
export const hiGrid = (latDeg: number, lonDeg: number): Grid => squareGrid(latDeg, lonDeg, PIN_REGION.res, PIN_REGION.l0N);

/** Mesh heights (row 0 = north) cut from the 59 m layer. */
export function meshHeights(L0: Layer): Float32Array {
  const { meshN } = PIN_REGION, off = (L0.n - meshN) / 2, out = new Float32Array(meshN * meshN);
  for (let r = 0; r < meshN; r++) out.set(L0.dem.subarray((r + off) * L0.n + off, (r + off) * L0.n + off + meshN), r * meshN);
  return out;
}

/**
 * sin(elevation) of the terrain point at grid distance s (dx, dy) and height h, seen from (ox, oy) at height oh:
 * the exact inverse-stereographic geometry of horizon._point, written as differences of small numbers so that it
 * keeps its precision in the GPU's 32-bit floats (the GLSL in horizonGpu.ts is this function line by line).
 */
export function sinElev(ox: number, oy: number, oh: number, dx: number, dy: number, h: number): number {
  const k = 1 / (4 * R * R), t2p = (ox * ox + oy * oy) * k, dt = (2 * ox * dx + dx * dx + 2 * oy * dy + dy * dy) * k;
  const t2q = t2p + dt, fp = (R + oh) / (1 + t2p);
  const df = ((h - oh) * (1 + t2p) - dt * (R + oh)) / ((1 + t2q) * (1 + t2p));
  const vx = (fp * dy + df * (oy + dy)) / R, vy = (fp * dx + df * (ox + dx)) / R, vz = fp * dt - df * (1 - t2q);
  const ux = oy / R / (1 + t2p), uy = ox / R / (1 + t2p), uz = -(1 - t2p) / (1 + t2p);
  return (vx * ux + vy * uy + vz * uz) / Math.sqrt(vx * vx + vy * vy + vz * vz);
}

/** Height from the first layer that has data at (x, y), and that layer's cell size. */
function sample(layers: Layer[], x: number, y: number): [number, number] {
  for (const L of layers) { const h = bil(L, x, y); if (h === h) return [h, L.res]; }
  return [NaN, 0];
}

/** Horizon (deg) toward grid azimuth azDeg from (ox, oy), z m above the first layer's ground: the GPU's stepping rule. */
export function stepHorizon(layers: Layer[], ox: number, oy: number, z: number, azDeg: number): number {
  const { frac, reach } = PIN_REGION, a = azDeg / DEG, sa = Math.sin(a), ca = Math.cos(a), oh = bil(layers[0], ox, oy) + z;
  let best = -1, s = layers[0].res / 2;
  while (s <= reach) {
    const [h, res] = sample(layers, ox + s * sa, oy + s * ca);
    if (!(h === h)) break;
    best = Math.max(best, sinElev(ox, oy, oh, s * sa, s * ca, h));
    s += Math.min(Math.max(frac * s, res / 2), res);
  }
  return Math.asin(best) * DEG;
}

export interface Ring { half_km: number; step_m: number; hole_km: number; n: number; h_min_m: number; h_max_m: number }

/**
 * Surrounding terrain for scene/FarField: square rings centred on the pin (row 0 = north), int16 metres, each from the
 * finest layer that covers it. Visual context only, like the polar regions' far field.
 */
export function farRings(layers: Layer[]): { rings: Ring[]; data: Int16Array } {
  const spec = [[16, 160, 12], [31, 310, 16], [150, 1000, 31]];
  const rings: Ring[] = [], parts: Int16Array[] = [];
  for (const [half, step, hole] of spec) {
    const n = Math.round((2 * half * 1000) / step) + 1, h = new Int16Array(n * n);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = -half * 1000 + j * step, y = half * 1000 - i * step, [v] = sample(layers, x, y);
      h[i * n + j] = Math.round(v === v ? v : 0);
      lo = Math.min(lo, h[i * n + j]); hi = Math.max(hi, h[i * n + j]);
    }
    rings.push({ half_km: half, step_m: step, hole_km: hole, n, h_min_m: lo, h_max_m: hi });
    parts.push(h);
  }
  const data = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { data.set(p, o); o += p.length; }
  return { rings, data };
}
