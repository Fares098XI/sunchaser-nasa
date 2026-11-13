/// <reference lib="webworker" />
/**
 * The 3D region around a pin (S5b, METHODS §21), built off the main thread:
 *   build {lat, lon, quantum} -> progress {stage, frac} ... then {heights, hz, rings, farfield, albedo, ...}
 * Terrain: 59 m (SLDEM2015 within ±60°, LOLA LDEM_512 beyond, /api/dem) for the 24 km mesh and 4 km around it,
 * LDEM_64 to ±32 km and LDEM_16 to 300 km (as the pin's own horizons). Horizon grid on this worker's own WebGL2
 * context (scene/horizonGpu.ts); V12 compares it with the same march on the CPU at a few cells.
 */
import { LDEM_16, gridToLatLon, pinGrids, pinLayers, sampleGrid, tilesFor, type Layer } from "../engine/pinhorizon";
import { HALF_M, PIN_REGION, farRings, hiGrid, meshHeights, stepHorizon } from "../engine/pinregion";
import { apiCrop, ldem16 } from "../data/demFetch";
import { gpuHorizonGrid } from "../scene/horizonGpu";

const ALBEDO_N = 48, FAR_ALBEDO_M = 150_000;
type Lum = { w: number; h: number; lum: Float32Array; mean: number; lon0: number; latTop: number; deg: number };
const maps = new Map<string, Promise<Lum>>();

/** An LRO WAC colour image as linear luminance: the globe's 4k map (360 x 180 deg from lon -180) or one 45 x 45 deg
 * 16k tile (textures/moon_tiles/c_<i>_<j>.jpg); `mean` is the whole globe's area-weighted mean, so tiles share it. */
function luminance(url: string, lon0: number, latTop: number, deg: number): Promise<Lum> {
  let m = maps.get(url);
  if (!m) maps.set(url, (m = (async () => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data, lum = new Float32Array(bmp.width * bmp.height);
    let sum = 0, wsum = 0;
    for (let i = 0; i < lum.length; i++) {
      const v = (k: number) => (px[4 * i + k] / 255) ** 2.2;
      lum[i] = 0.2126 * v(0) + 0.7152 * v(1) + 0.0722 * v(2);
      const w = Math.cos(((Math.floor(i / bmp.width) + 0.5) / bmp.height - 0.5) * Math.PI); // area weight (whole globe)
      sum += lum[i] * w; wsum += w;
    }
    const mean = deg === 360 ? sum / wsum : (await luminance(GLOBE, -180, 90, 360)).mean;
    return { w: bmp.width, h: bmp.height, lum, mean, lon0, latTop, deg };
  })()));
  return m;
}
const GLOBE = "/textures/moon_color_4k.jpg";

/** Bilinear luminance at (lat, lon east), relative to the Moon's mean; clamped at a tile's edges. */
function sample(G: Lum, la: number, lo: number) {
  const span = G.deg === 360 ? 180 : G.deg;
  const x = ((((lo - G.lon0) % 360) + 360) % 360 / G.deg) * G.w - 0.5, y = ((G.latTop - la) / span) * G.h - 0.5;
  const wrap = G.deg === 360;
  const xc = wrap ? x : Math.max(0, Math.min(G.w - 1.001, x));
  const x0 = Math.floor(xc), y0 = Math.max(0, Math.min(G.h - 2, Math.floor(y))), fx = xc - x0, fy = Math.min(1, Math.max(0, y - y0));
  const at = (yy: number, xx: number) => G.lum[yy * G.w + (wrap ? ((xx % G.w) + G.w) % G.w : Math.min(G.w - 1, xx))];
  return ((at(y0, x0) * (1 - fx) + at(y0, x0 + 1) * fx) * (1 - fy) + (at(y0 + 1, x0) * (1 - fx) + at(y0 + 1, x0 + 1) * fx) * fy) / G.mean;
}

/** Albedo relative to the Moon's mean (mare < 1 < highlands) on an N x N grid of half-width halfM: near the pin from
 * its 16k colour tile (~2 km), farther from the globe's 4k map. */
async function albedo(lat: number, lon: number, halfM: number, N: number): Promise<Float32Array> {
  const l180 = ((lon + 180) % 360 + 360) % 360 - 180, i = Math.min(7, Math.floor((l180 + 180) / 45)), j = Math.min(3, Math.floor((90 - lat) / 45));
  const G = halfM <= 50_000
    ? await luminance(`/textures/moon_tiles/c_${i}_${j}.jpg`, -180 + 45 * i, 90 - 45 * j, 45).catch(() => luminance(GLOBE, -180, 90, 360))
    : await luminance(GLOBE, -180, 90, 360);
  const out = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const [la, lo] = gridToLatLon(lat, lon, -halfM + ((c + 0.5) * 2 * halfM) / N, halfM - ((r + 0.5) * 2 * halfM) / N);
    out[r * N + c] = sample(G, la, lo);
  }
  return out;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data, t0 = performance.now();
  const progress = (stage: string, frac = 0) => postMessage({ id: m.id, progress: { stage, frac } });
  try {
    progress("terrain");
    const g0 = hiGrid(m.lat, m.lon), grids = pinGrids(m.lat, m.lon);
    const keys = new Set(tilesFor(grids[1], LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, 240));
    const q = `lat=${m.lat.toFixed(5)}&lon=${m.lon.toFixed(5)}`;
    const [hi, mid, far, alb] = await Promise.all([apiCrop(`product=hi&half_km=16.6&${q}`), apiCrop(`product=ldem_64&${q}`),
      ldem16([...keys]), albedo(m.lat, m.lon, HALF_M, ALBEDO_N).catch(() => null)]);
    const albFar = alb && await albedo(m.lat, m.lon, FAR_ALBEDO_M, ALBEDO_N).catch(() => null);
    const t1 = performance.now();
    let L1: Layer, L2: Layer;
    try { [L1, L2] = pinLayers(m.lat, m.lon, mid ?? far, far, grids); } catch { [L1, L2] = pinLayers(m.lat, m.lon, far, far, grids); }
    let L0: Layer, hiName: string;
    try {
      if (!hi) throw new Error("no 59 m map");
      L0 = { dem: sampleGrid(g0, hi), n: g0.n, x0: g0.x0, y0: g0.y0, res: g0.res, s0: 0, s1: 0 };
      hiName = hi.name;
    } catch {
      // no 59 m map (offline, very close to a pole): the coarser map at 60 m spacing, said so in the app
      const src = mid ?? far;
      L0 = { dem: sampleGrid(g0, src), n: g0.n, x0: g0.x0, y0: g0.y0, res: g0.res, s0: 0, s1: 0 };
      hiName = src.name;
    }
    progress("shadows", 0);
    const gl = new OffscreenCanvas(1, 1).getContext("webgl2", { antialias: false, depth: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("this browser has no WebGL2 in workers");
    const layers = [L0, L1, L2];
    const hz = await gpuHorizonGrid(gl, layers, m.quantum, (f) => progress("shadows", f));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const t2 = performance.now();
    // V12: the GPU grid vs the same march in double precision on the CPU, centre + 4 cells, 12 azimuths each
    const { cellN, cell, nAz } = PIN_REGION;
    let v12 = 0;
    for (const [r, c] of [[cellN / 2, cellN / 2], [7, 11], [cellN - 9, 23], [41, cellN - 5], [cellN - 3, cellN - 30]]) {
      const ox = -HALF_M + (c + 0.5) * cell, oy = HALF_M - (r + 0.5) * cell;
      for (let a = 0; a < nAz; a += 15) {
        const cpu = stepHorizon(layers, ox, oy, PIN_REGION.z, (a * 360) / nAz);
        v12 = Math.max(v12, Math.abs(hz[(a * cellN + r) * cellN + c] * m.quantum - cpu));
      }
    }
    const heights = meshHeights(L0), ff = farRings(layers);
    postMessage({
      id: m.id, heights, hz, rings: ff.rings, farfield: ff.data.buffer, albedo: alb, albedoFar: albFar, albedoN: ALBEDO_N, hiName, midName: mid?.name ?? LDEM_16.name,
      v12, ms: { terrain: t1 - t0, shadows: t2 - t1, total: performance.now() - t0 },
    }, [heights.buffer, hz.buffer, ff.data.buffer, ...(alb ? [alb.buffer] : []), ...(albFar ? [albFar.buffer] : [])]);
  } catch (err) {
    postMessage({ id: m.id, error: String(err) });
  }
};
