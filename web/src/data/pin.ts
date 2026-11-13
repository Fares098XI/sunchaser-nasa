import { useSyncExternalStore } from "react";
import { N_AZ, Z_M, dispersionPoints, type Layer } from "../engine/pinhorizon";
import type { SiteEntry } from "../engine/sites";
import { sitesClient } from "./sitesClient";

/** "Drop a pin anywhere" (S5): horizons for a point on several workers, then the point joins the site catalog. */
export interface PinProgress { stage: "terrain" | "horizon" | "sky" | "done"; near?: string }
/** ms: wall time; steps: terrain (download + resampling), horizons (the slowest worker), Sun and Earth */
export interface PinResult { entry: SiteEntry; ms: number; steps: { terrain: number; horizon: number; sky: number } }

const POOL = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1)); // one thread left for the page
let pool: Worker[] = [];
let seq = 0;

function ask(w: Worker, msg: Record<string, unknown>, onProgress?: (f: number) => void): Promise<any> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data.id !== id) return;
      if (e.data.progress != null) { onProgress?.(e.data.progress); return; }
      w.removeEventListener("message", on);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data);
    };
    w.addEventListener("message", on);
    w.postMessage({ ...msg, id });
  });
}

/** 12.50° S · 33.00° E (east longitudes above 180° as west) */
export function fmtLatLon(lat: number, lon: number, dp = 2) {
  const l = ((lon + 540) % 360) - 180;
  return `${Math.abs(lat).toFixed(dp)}° ${lat < 0 ? "S" : "N"} · ${Math.abs(l).toFixed(dp)}° ${l < 0 ? "W" : "E"}`;
}

/** "12.5 S, 33 E", "-12.5, 33", "12.5°S 326.9°E" -> {lat, lon (0..360 east)} or null */
export function parseLatLon(s: string): { lat: number; lon: number } | null {
  const m = s.trim().toUpperCase().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/);
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[3]);
  if (m[2] === "S") lat = -Math.abs(lat);
  if (m[4] === "W") lon = -Math.abs(lon);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 360)) return null;
  return { lat, lon: ((lon % 360) + 360) % 360 };
}

let current: AbortController | null = null;

// horizon progress (0..1) outside React state: a tick re-renders only its readers, not the whole app (~60 ms each)
let fracNow = 0;
const fracSubs = new Set<() => void>();
const setFrac = (f: number) => { fracNow = f; fracSubs.forEach((s) => s()); };
export const usePinFrac = () => useSyncExternalStore((f) => { fracSubs.add(f); return () => { fracSubs.delete(f); }; }, () => fracNow);

export async function dropPin(lat: number, lon: number, onProgress: (p: PinProgress) => void): Promise<PinResult> {
  lat = Math.round(lat * 1e5) / 1e5; lon = Math.round(lon * 1e5) / 1e5; // ~0.3 m: what the link and the terrain request carry
  current?.abort();
  const ctl = (current = new AbortController());
  const t0 = performance.now();
  if (pool.length < POOL) pool = Array.from({ length: POOL }, (_, i) => pool[i] ?? new Worker(new URL("../workers/pin.worker.ts", import.meta.url), { type: "module" }));
  const client = sitesClient();
  setFrac(0);
  onProgress({ stage: "terrain" });
  const [prep] = await Promise.all([ask(pool[0], { type: "prepare", lat, lon }), client.ready]);
  if (ctl.signal.aborted) throw new DOMException("replaced", "AbortError");
  const layers: Layer[] = prep.layers, nP = dispersionPoints().length, nZ = Z_M.length, t1 = performance.now();
  onProgress({ stage: "horizon", near: prep.near });
  // landing points split across the pool; progress = the slowest share
  const shares = pool.map((_, i) => [Math.round((i * nP) / POOL), Math.round(((i + 1) * nP) / POOL)]);
  const frac = shares.map(() => 0);
  const parts = await Promise.all(shares.map(([p0, p1], i) => ask(pool[i], { type: "march", layers, p0, p1 }, (f) => {
    frac[i] = f;
    if (!ctl.signal.aborted) setFrac(Math.min(...frac));
  })));
  if (ctl.signal.aborted) throw new DOMException("replaced", "AbortError");
  const q = client.manifest.horizon.quantum_deg, k = new Int16Array(N_AZ * nP * nZ);
  parts.forEach(({ deg }, i) => {
    const [p0, p1] = shares[i], n = p1 - p0;
    for (let a = 0; a < N_AZ; a++) for (let p = 0; p < n; p++) for (let z = 0; z < nZ; z++)
      k[(a * nP + p0 + p) * nZ + z] = Math.round(deg[(a * n + p) * nZ + z] / q);
  });
  onProgress({ stage: "sky", near: prep.near });
  const t2 = performance.now();
  const entry: SiteEntry = {
    id: "pin", name: "Your pin", lat_deg: lat, lon_deg: lon, x_m: null, y_m: null, rule: "your own point",
    source: `NASA LOLA global maps: ${prep.near} to 30 km, LOLA LDEM_16 (1895 m) to 300 km; horizons computed in your browser`,
    dem5: null, kind: "pin", tables: "derived", azimuth: "true", ground_m: parts[0].ground[0], file: "", bytes: 0, sha256: "",
    layers: [`${prep.near}:0-30000`, "LOLA LDEM_16 (1895 m):30000-300000"],
  };
  await client.addSite(entry, k);
  const t3 = performance.now();
  onProgress({ stage: "done", near: prep.near });
  return { entry, ms: t3 - t0, steps: { terrain: t1 - t0, horizon: t2 - t1, sky: t3 - t2 } };
}

export function removePin() {
  current?.abort();
  return sitesClient().removeSite("pin");
}

/** The app's pin: where, how far the computation is, and how it went. */
export interface PinState { lat: number; lon: number; stage: PinProgress["stage"] | "error"; near?: string; ms?: number; steps?: PinResult["steps"]; error?: string }

/** ?pin=lat,lon (deg, east longitude) */
export function readPin(): { lat: number; lon: number } | null {
  const v = new URLSearchParams(location.search).get("pin")?.split(",").map(Number);
  return v && v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 ? { lat: v[0], lon: ((v[1] % 360) + 360) % 360 } : null;
}
