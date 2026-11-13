/**
 * NASA lunar terrain around a point, cropped from the PDS files with multi-range HTTP requests (the PDS server sends no
 * CORS headers, so the browser cannot read them directly). Vercel serverless function; also mounted on the Vite
 * dev/preview servers (vite.config.ts).
 *   GET /api/dem?product=ldem_64&lat=-12.5&lon=33   LOLA LDEM_64 (474 m), ±1.6° (S5 pin horizons, METHODS §20)
 *   GET /api/dem?product=hi&lat=..&lon=..&half_km=16  59 m terrain for the 3D view (S5b, METHODS §21): SLDEM2015
 *       (LOLA + SELENE/Kaguya stereo) within ±60°, LOLA LDEM_512 poleward of it
 * -> int16 little-endian, 0.5 m units above 1737.4 km, row-major, in the product's own cylindrical pixel grid:
 *    global line r0.. from 90° N, global sample c0.. from 0° E (wrapping), headers x-crop-{r0,nr,c0,nc,ppd,product}.
 * Crop rule for ldem_64 = pipeline export_globalterrain.near_crop (test: src/engine/v11_pin.test.ts).
 */
const GDR = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/";
const SLDEM = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/";
const HALF_DEG = 1.6; // ldem_64: > the 30 km layer's corner (1.48 deg) + a pixel
export const MAX_LAT = 86; // ldem_64: beyond, the crop spans most longitudes (> 2 MB): the app uses LDEM_16 there
const MAX_BYTES = 3_500_000; // Vercel functions return at most 4.5 MB
const RAD = Math.PI / 180;

/** A global map stored as tiles: lines from `top` (deg N), tiles of tileLines x tileSamples; float32 km or int16 0.5 m. */
interface Product {
  name: string; ppd: number; top: number; bottom: number; tileLines: number; tileSamples: number; float: boolean;
  file: (tileRow: number, tileCol: number) => string;
}
const band = (a: number, b: number) => `${String(Math.abs(a)).padStart(2, "0")}${a < 0 ? "s" : "n"}_${String(Math.abs(b)).padStart(2, "0")}${b < 0 || (b === 0 && a < 0) ? "s" : "n"}`;
const lon3 = (a: number) => String(a).padStart(3, "0");
const PRODUCTS: Record<string, Product> = {
  ldem_64: { name: "LOLA LDEM_64 (474 m)", ppd: 64, top: 90, bottom: -90, tileLines: 11520, tileSamples: 23040, float: false, file: () => GDR + "ldem_64.img" },
  // 45 x 90 deg tiles, e.g. ldem_512_00n_45n_000_090.img, ldem_512_90s_45s_000_090.img
  ldem_512: { name: "LOLA LDEM_512 (59 m)", ppd: 512, top: 90, bottom: -90, tileLines: 45 * 512, tileSamples: 90 * 512, float: false,
    file: (r, c) => { const n = 90 - 45 * r, s = n - 45; return GDR + `ldem_512_${band(s, n)}_${lon3(90 * c)}_${lon3(90 * c + 90)}.img`; } },
  // 30 x 45 deg tiles from 60 N to 60 S, e.g. sldem2015_512_30s_00s_000_045_float.img
  sldem: { name: "SLDEM2015 (LOLA + SELENE, 59 m)", ppd: 512, top: 60, bottom: -60, tileLines: 30 * 512, tileSamples: 45 * 512, float: true,
    file: (r, c) => { const n = 60 - 30 * r, s = n - 30; return SLDEM + `sldem2015_512_${band(s, n)}_${lon3(45 * c)}_${lon3(45 * c + 45)}_float.img`; } },
};

export function nearCrop(lat: number, lon: number) {
  const P = 64, NS = 360 * P, NL = 180 * P;
  const r0 = Math.max(0, Math.floor((90 - (lat + HALF_DEG)) * P));
  const r1 = Math.min(NL, Math.ceil((90 - (lat - HALF_DEG)) * P));
  const dLon = HALF_DEG / Math.cos((Math.abs(lat) + HALF_DEG) * RAD);
  const c0 = ((Math.floor((lon - dLon) * P) % NS) + NS) % NS;
  return { r0, nr: r1 - r0, c0, nc: Math.min(NS, Math.ceil(2 * dLon * P) + 2) };
}

/** A box of ±halfKm around the point (+2 pixels), in the product's global pixel grid. */
export function hiCrop(p: Product, lat: number, lon: number, halfKm: number) {
  const d = halfKm / 1737.4 / RAD, NS = 360 * p.ppd;
  const r0 = Math.max(0, Math.floor((90 - (lat + d)) * p.ppd) - 2), r1 = Math.min(180 * p.ppd, Math.ceil((90 - (lat - d)) * p.ppd) + 2);
  const dLon = d / Math.cos(Math.min(89.9, Math.abs(lat) + d) * RAD);
  const c0 = ((Math.floor((lon - dLon) * p.ppd) - 2) % NS + NS) % NS;
  return { r0, nr: r1 - r0, c0, nc: Math.min(NS, Math.ceil(2 * dLon * p.ppd) + 5) };
}

/** Byte ranges of one file in one multi-range request -> parts {at, data} (the server may merge ranges). */
async function fetchRanges(url: string, ranges: [number, number][]): Promise<{ at: number; data: Uint8Array }[] | null> {
  const r = await fetch(url, { headers: { Range: "bytes=" + ranges.map(([a, b]) => `${a}-${b}`).join(",") } });
  if (r.status !== 206) return null;
  const body = new Uint8Array(await r.arrayBuffer()), parts: { at: number; data: Uint8Array }[] = [];
  if (!/multipart\/byteranges/i.test(r.headers.get("content-type") ?? "")) {
    const m = r.headers.get("content-range")?.match(/bytes (\d+)-(\d+)/);
    return m ? [{ at: Number(m[1]), data: body }] : null;
  }
  // multipart/byteranges: headers (with Content-Range) + blank line + exactly (b - a + 1) bytes per part
  const text = new TextDecoder("latin1");
  let i = 0;
  while (true) {
    let h = i;
    while (h + 3 < body.length && !(body[h] === 13 && body[h + 1] === 10 && body[h + 2] === 13 && body[h + 3] === 10)) h++;
    if (h + 3 >= body.length) break;
    const m = text.decode(body.subarray(i, h)).match(/content-range:\s*bytes (\d+)-(\d+)/i);
    if (!m) break;
    const a = Number(m[1]), len = Number(m[2]) - a + 1;
    parts.push({ at: a, data: body.subarray(h + 4, h + 4 + len) });
    i = h + 4 + len;
  }
  return parts.sort((p, q) => p.at - q.at);
}

/** The crop as int16 0.5 m DN, from every tile it touches (one request per tile, run in parallel). */
async function fetchCrop(p: Product, r0: number, nr: number, c0: number, nc: number): Promise<Int16Array | null> {
  const NS = 360 * p.ppd, l0 = (90 - p.top) * p.ppd, bpp = p.float ? 4 : 2, out = new Int16Array(nr * nc);
  if (r0 < l0 || r0 + nr > (90 - p.bottom) * p.ppd) return null;
  // global samples c0..c0+nc (mod NS) as contiguous segments [start, end) that do not wrap
  const segs = c0 + nc <= NS ? [[c0, c0 + nc]] : [[c0, NS], [0, c0 + nc - NS]];
  const jobs: Promise<boolean>[] = [];
  for (let tr = Math.floor((r0 - l0) / p.tileLines); tr <= Math.floor((r0 + nr - 1 - l0) / p.tileLines); tr++) {
    const ta = Math.max(r0, l0 + tr * p.tileLines), tb = Math.min(r0 + nr, l0 + (tr + 1) * p.tileLines);
    for (const [sa, sb] of segs) for (let tc = Math.floor(sa / p.tileSamples); tc <= Math.floor((sb - 1) / p.tileSamples); tc++) {
      const ca = Math.max(sa, tc * p.tileSamples), cb = Math.min(sb, (tc + 1) * p.tileSamples);
      const lineOff = (g: number) => (g - l0 - tr * p.tileLines) * p.tileSamples, colOff = ca - tc * p.tileSamples;
      const ranges: [number, number][] = [];
      for (let g = ta; g < tb; g++) ranges.push([(lineOff(g) + colOff) * bpp, (lineOff(g) + colOff + cb - ca) * bpp - 1]);
      jobs.push(fetchRanges(p.file(tr, tc), ranges).then((parts) => {
        if (!parts) return false;
        let k = 0;
        for (let g = ta; g < tb; g++) for (let s = ca; s < cb; s++) {
          const off = (lineOff(g) + s - tc * p.tileSamples) * bpp;
          while (k > 0 && parts[k].at > off) k--;
          while (k + 1 < parts.length && parts[k + 1].at <= off) k++;
          const q = parts[k];
          if (!q || off < q.at || off - q.at + bpp > q.data.length) return false;
          const o = q.data.byteOffset + off - q.at, v = new DataView(q.data.buffer);
          out[(g - r0) * nc + ((s - c0 + NS) % NS)] = p.float ? Math.round(v.getFloat32(o, true) * 2000) : v.getInt16(o, true);
        }
        return true;
      }));
    }
  }
  return (await Promise.all(jobs)).every(Boolean) ? out : null;
}

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams, lat = Number(q.get("lat")), lon = ((Number(q.get("lon")) % 360) + 360) % 360;
  const product = q.get("product") ?? "ldem_64", half = Number(q.get("half_km") ?? 16);
  if (!q.get("lat") || !q.get("lon") || !Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon))
    return new Response("lat in degrees north, lon in degrees east", { status: 400 });
  let p: Product, crop: { r0: number; nr: number; c0: number; nc: number };
  if (product === "ldem_64") {
    if (Math.abs(lat) > MAX_LAT) return new Response(`ldem_64: lat within ±${MAX_LAT}°`, { status: 400 });
    p = PRODUCTS.ldem_64; crop = nearCrop(lat, lon);
  } else if (product === "hi" && half > 0 && half <= 20) {
    p = Math.abs(lat) + half / 1737.4 / RAD + 0.01 <= 60 ? PRODUCTS.sldem : PRODUCTS.ldem_512;
    crop = hiCrop(p, lat, lon, half);
  } else return new Response("product=ldem_64, or product=hi with half_km ≤ 20", { status: 400 });
  if (crop.nr * crop.nc * (p.float ? 4 : 2) > MAX_BYTES) return new Response("crop too large this close to a pole", { status: 413 });
  const out = await fetchCrop(p, crop.r0, crop.nr, crop.c0, crop.nc).catch(() => null);
  if (!out) return new Response("NASA PDS unavailable", { status: 502 });
  return new Response(out.buffer as ArrayBuffer, {
    headers: {
      "content-type": "application/octet-stream", "cache-control": "public, max-age=86400, s-maxage=31536000, immutable",
      "x-crop-r0": String(crop.r0), "x-crop-nr": String(crop.nr), "x-crop-c0": String(crop.c0), "x-crop-nc": String(crop.nc),
      "x-crop-ppd": String(p.ppd), "x-crop-product": p.name,
    },
  });
}
