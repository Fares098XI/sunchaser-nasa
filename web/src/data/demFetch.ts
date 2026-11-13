/**
 * Terrain downloads shared by the pin workers (no DOM: runs in workers): LDEM_16 web tiles (pipeline
 * export_globalterrain) and crops of NASA PDS maps through the serverless function web/api/dem.ts.
 */
import { LDEM_16, cropRaster, tileRaster, type Raster } from "../engine/pinhorizon";

const BASE = "/data/terrain16/";
let meta: { tile_px: number; cols: number } | null = null;
const tiles = new Map<number, Int16Array>();

async function inflate(r: Response): Promise<Int16Array> {
  const s = r.body!.pipeThrough(new DecompressionStream("deflate"));
  return new Int16Array(await new Response(s).arrayBuffer());
}

/** LDEM_16 with the given tiles loaded (tile keys from engine/pinhorizon tilesFor, 240 px tiles). */
export async function ldem16(keys: number[]): Promise<Raster> {
  meta ??= await (await fetch(BASE + "meta.json")).json();
  const m = meta!;
  await Promise.all(keys.filter((k) => !tiles.has(k)).map(async (k) => {
    const r = await fetch(`${BASE}${Math.floor(k / m.cols)}_${k % m.cols}.i16z`);
    if (!r.ok) throw new Error(`terrain tile ${k}: HTTP ${r.status}`);
    tiles.set(k, await inflate(r));
  }));
  return tileRaster(LDEM_16.name, LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, m.tile_px, tiles);
}

/** A map crop from /api/dem (query: product, lat, lon, ...), or null (offline, local dev without the function, too close to a pole). */
export async function apiCrop(query: string): Promise<Raster | null> {
  try {
    const r = await fetch(`/api/dem?${query}`);
    if (!r.ok) return null;
    const h = (k: string) => Number(r.headers.get(`x-crop-${k}`));
    const [r0, nr, c0, nc, ppd] = [h("r0"), h("nr"), h("c0"), h("nc"), h("ppd")];
    const dn = new Int16Array(await r.arrayBuffer());
    if (![r0, nr, c0, nc, ppd].every(Number.isInteger) || dn.length !== nr * nc) return null;
    return cropRaster(r.headers.get("x-crop-product") ?? "", ppd, 360 * ppd, 180 * ppd, r0, nr, c0, nc, dn);
  } catch {
    return null;
  }
}
