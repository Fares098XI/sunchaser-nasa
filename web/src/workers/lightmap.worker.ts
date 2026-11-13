/// <reference lib="webworker" />
/** Light painting off the main thread: {id, grid, track, radiusKm, earth, checkpoints} -> {id, progress}..., {id, map}. */
import { lightMap } from "../engine/lightmap";

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  const map = lightMap(m.grid, m.track, m.radiusKm, m.earth, m.checkpoints, (progress) => postMessage({ id: m.id, progress }));
  postMessage({ id: m.id, map }, [map.buffer]);
};
