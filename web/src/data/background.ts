/**
 * Background work that must never get in the user's way:
 *  - `decodeOff`: the decode worker (horizons, packed height PNGs, raycast trees), one shared instance;
 *  - `whenIdle`: resolves once the user has not touched the page for `quietMs` and the browser reports idle time,
 *    so warm-ups (GPU uploads, first draws) happen between interactions, never during a drag or zoom.
 */
import type { HorizonGrid } from "../engine/horizon";

let worker: Worker | null = null, seq = 0;
const pending = new Map<number, (d: any) => void>();
function call<T>(msg: Record<string, unknown>): Promise<T> {
  worker ??= new Worker(new URL("../workers/decode.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => { const f = pending.get(e.data.id); pending.delete(e.data.id); f?.(e.data); };
  const id = ++seq;
  return new Promise((res, rej) => { pending.set(id, (d) => (d.ok ? res(d) : rej(new Error(d.error)))); worker!.postMessage({ ...msg, id }); });
}

export const decodeHorizonOff = (url: string, nAz: number, rows: number, cols: number, quantum: number) =>
  call<{ grid: HorizonGrid }>({ type: "horizon", url, nAz, rows, cols, quantum }).then((d) => d.grid);

export const decodeHeightsOff = (url: string) => call<{ n: number; data: Uint16Array }>({ type: "heights", url });

/** serialized three-mesh-bvh tree (indirect) of a mesh, for MeshBVH.deserialize */
export const buildBvhOff = (position: Float32Array, index: Uint32Array) =>
  call<{ roots: ArrayBuffer[]; indirectBuffer: Uint32Array }>({ type: "bvh", position, index });

let lastInput = 0;
if (typeof window !== "undefined")
  for (const t of ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"])
    addEventListener(t, (e) => { if (t !== "pointermove" || (e as PointerEvent).buttons) lastInput = performance.now(); }, { passive: true, capture: true });

/** counts as user activity: when the page has just become interactive, the user is about to act */
export const deferIdle = () => { lastInput = performance.now(); };

/** ms since the user last pressed, dragged, scrolled or typed */
export const sinceInput = () => performance.now() - lastInput;

export function whenIdle(quietMs = 1200): Promise<void> {
  return new Promise((res) => {
    const check = () => {
      if (performance.now() - lastInput < quietMs) { setTimeout(check, 250); return; }
      const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (ric) ric(() => (performance.now() - lastInput < quietMs ? setTimeout(check, 250) : res()), { timeout: 1000 });
      else setTimeout(res, 50);
    };
    check();
  });
}
