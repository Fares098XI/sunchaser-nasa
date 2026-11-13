/// <reference lib="webworker" />
/**
 * "Drop a pin" horizons (S5, METHODS §20), off the main thread. Messages:
 *   prepare {lat, lon} -> {layers, near}: LOLA terrain around the point on its own oblique stereographic grid —
 *     LDEM_64 near field from /api/dem (a PDS crop), or LDEM_16 when that is unavailable; LDEM_16 tiles far field
 *   march {layers, p0, p1} -> {deg, ground}: the exact ray walk for landing points p0..p1-1 (several workers share one pin)
 */
import { LDEM_16, LDEM_64, dispersionPoints, marchHorizons, pinGrids, pinLayers, tilesFor, type Layer } from "../engine/pinhorizon";
import { apiCrop, ldem16 } from "../data/demFetch";

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "prepare") {
      const t0 = performance.now(), grids = pinGrids(m.lat, m.lon);
      const keys = new Set([...tilesFor(grids[1], LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, 240), ...tilesFor(grids[0], LDEM_16.ppd, LDEM_16.ns, LDEM_16.nl, 240)]);
      const [nearMap, farMap] = await Promise.all([apiCrop(`product=ldem_64&lat=${m.lat.toFixed(5)}&lon=${m.lon.toFixed(5)}`), ldem16([...keys])]);
      let layers: Layer[];
      let nearName = LDEM_64.name;
      try {
        if (!nearMap) throw new Error("no near map");
        layers = pinLayers(m.lat, m.lon, nearMap, farMap, grids);
      } catch {
        nearName = LDEM_16.name; // the coarser map near the point too (stated in the app)
        layers = pinLayers(m.lat, m.lon, farMap, farMap, grids);
      }
      postMessage({ id: m.id, layers, near: nearName, ms: performance.now() - t0 });
    } else if (m.type === "march") {
      const t0 = performance.now(), pts = dispersionPoints().slice(m.p0, m.p1);
      const { deg, ground } = marchHorizons(m.layers, pts, undefined, undefined, (done, total) => postMessage({ id: m.id, progress: done / total }));
      postMessage({ id: m.id, deg, ground, ms: performance.now() - t0 }, [deg.buffer, ground.buffer]);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err) });
  }
};
