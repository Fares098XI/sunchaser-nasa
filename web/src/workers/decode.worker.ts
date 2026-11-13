/// <reference lib="webworker" />
/**
 * Heavy decoding off the main thread, so the page stays responsive while data arrives:
 *  - horizon: fetch + engine/horizon.ts decodeHorizon (22 MB for the hero region) -> transferred Int16Array;
 *  - heights: a 16-bit packed PNG (pipeline export_assets.save_heights) -> half-float km, rows flipped (north = v 1);
 *  - bvh: the bounding-volume tree for raycasts on a terrain mesh (~1.3 s for 500k triangles on a laptop CPU).
 */
import { BufferAttribute, BufferGeometry, DataUtils } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { decodeHorizon } from "../engine/horizon";

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === "horizon") {
      const r = await fetch(m.url);
      if (!r.ok) throw new Error(`${m.url}: HTTP ${r.status}`);
      const g = decodeHorizon(new Uint8Array(await r.arrayBuffer()), m.nAz, m.rows, m.cols, m.quantum);
      postMessage({ id: m.id, ok: true, grid: g }, [g.k.buffer]);
    } else if (m.type === "heights") {
      const bmp = await createImageBitmap(await (await fetch(m.url)).blob());
      const n = bmp.width, c = new OffscreenCanvas(n, n), g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, n, n).data, data = new Uint16Array(n * n);
      for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) {
        const o = 4 * (r * n + k), h = ((px[o] << 8) | px[o + 1]) / 4 - 8192;
        data[(n - 1 - r) * n + k] = DataUtils.toHalfFloat(h / 1000);
      }
      postMessage({ id: m.id, ok: true, n, data }, [data.buffer]);
    } else if (m.type === "bvh") {
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(m.position, 3));
      geo.setIndex(new BufferAttribute(m.index, 1));
      // indirect: the triangle order stays as it is, so the main thread's index buffer needs no re-upload
      // (the `indirect` option and field exist in three-mesh-bvh 0.8 but not yet in its type declarations)
      const bvh = new MeshBVH(geo, { indirect: true } as ConstructorParameters<typeof MeshBVH>[1]);
      const d = MeshBVH.serialize(bvh, { cloneBuffers: false }) as unknown as { roots: ArrayBuffer[]; indirectBuffer: Uint32Array };
      postMessage({ id: m.id, ok: true, roots: d.roots, indirectBuffer: d.indirectBuffer }, [...d.roots, d.indirectBuffer.buffer] as Transferable[]);
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String(err) });
  }
};
