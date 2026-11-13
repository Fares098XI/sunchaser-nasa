/// <reference lib="webworker" />
/**
 * Window search off the main thread. Holds decoded sites and per-(site, point, height) prepared series.
 * Messages: init {manifest, dsn, files} | compare {z, a, b} | search {z, req, every} | robust {site, z, a, b, req}
 *   | clock {z, a} (S1: how long the Sun / link last from step a) | spread {site, z, a, b} (S2: the 19 landing points)
 *   | slip {z, a0, from, to, req, power} (S3: every site, landing at a0 shifted by whole days from..to)
 *   | scenario {site, a, b, z, power, req} (S6: one landing over its stay: ribbons, events, phase, skyline)
 *   | skyat {site, z, i} (copilot: Sun, Earth and DSN at one step)
 *   | add {entry, k} / remove {site} (S5: a pin with horizons computed in the browser; tables derived as for atlas sites)
 */
import { visibleDiscFraction } from "../engine/sky";
import { decodeSite, deriveTable, siteHorizon, siteSeries, SUN_RADIUS_M, EARTH_RADIUS_M, type SiteData, type SitesManifest } from "../engine/sites";
import { stepsUntilChange } from "../engine/clock";
import { runScenario } from "../engine/scenario";
import { NO_DATA } from "../engine/replan";
import {
  PASS_DAY, failBits, metrics, minimalRelaxations, prepare, search, type Prepared, type Requirements, type SearchResult,
} from "../engine/windows";

let manifest: SitesManifest;
let dsn: Uint8Array;
const sites = new Map<string, SiteData>();
const prepared = new Map<string, Prepared>();

function prep(id: string, p: number, z: number): Prepared {
  const key = `${id}|${p}|${z}`;
  let v = prepared.get(key);
  if (!v) {
    v = prepare(siteSeries(sites.get(id)!, dsn, p, z), manifest.step_s);
    prepared.set(key, v);
    if (prepared.size > 64) prepared.delete(prepared.keys().next().value!); // bound memory (dispersion checks)
  }
  return v;
}

/** Per day: 0 = no candidate, PASS_DAY = some landing that day meets everything, else the fail bits of the
 * candidate with the fewest failed requirements that day. */
function calendar(res: SearchResult, stepsPerDay: number, days: number): Uint8Array {
  const out = new Uint8Array(days);
  const best = new Uint8Array(days).fill(255);
  for (let c = 0; c < res.starts.length; c++) {
    const d = Math.floor(res.starts[c] / stepsPerDay);
    const f = res.fails[c];
    if (f === 0) { out[d] = PASS_DAY; best[d] = 0; continue; }
    const k = popcount(f);
    if (best[d] !== 0 && k < best[d]) { best[d] = k; out[d] = f; }
  }
  return out;
}
const popcount = (x: number) => { let k = 0; while (x) { k += x & 1; x >>= 1; } return k; };

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  const t0 = performance.now();
  try {
    if (msg.type === "init") {
      manifest = msg.manifest;
      dsn = new Uint8Array(msg.dsn);
      // catalog sites first: atlas sites derive their Sun/Earth tables from the reference site (METHODS §19)
      for (const s of manifest.sites) if (s.tables !== "derived") sites.set(s.id, decodeSite(msg.files[s.id], s, manifest));
      const ref = sites.get((manifest as SitesManifest & { atlas?: { reference_site: string } }).atlas?.reference_site ?? "");
      for (const s of manifest.sites) if (s.tables === "derived") sites.set(s.id, decodeSite(msg.files[s.id], s, manifest, ref));
      postMessage({ id: msg.id, ok: true, ms: performance.now() - t0 });
    } else if (msg.type === "add" || msg.type === "remove") {
      const id = msg.type === "add" ? msg.entry.id : msg.site;
      for (const k of [...prepared.keys()]) if (k.startsWith(id + "|")) prepared.delete(k);
      manifest.sites = manifest.sites.filter((s) => s.id !== id);
      sites.delete(id);
      if (msg.type === "add") {
        const ref = sites.get((manifest as SitesManifest & { atlas?: { reference_site: string } }).atlas?.reference_site ?? "")!;
        const hz = { nAz: manifest.n_az, rows: manifest.n_pts, cols: manifest.z_m.length, quantum: manifest.horizon.quantum_deg, k: msg.k };
        sites.set(id, { entry: msg.entry, hz, sun: deriveTable(ref.sun, SUN_RADIUS_M, ref.entry, msg.entry), earth: deriveTable(ref.earth, EARTH_RADIUS_M, ref.entry, msg.entry) });
        manifest.sites.push(msg.entry);
      }
      postMessage({ id: msg.id, ok: true, ms: performance.now() - t0 });
    } else if (msg.type === "scenario") {
      const s = sites.get(msg.site);
      if (!s) throw new Error(`unknown site ${msg.site}`);
      const a = Math.max(0, Math.min(manifest.n - 2, msg.a)), b = Math.max(a + 1, Math.min(manifest.n, msg.b));
      const r = runScenario(s, prep(msg.site, 0, msg.z), siteSeries(s, dsn, 0, msg.z), a, b, msg.z, msg.power, msg.req);
      postMessage({ id: msg.id, run: r, ms: performance.now() - t0 }, [r.sun.buffer, r.dte.buffer, r.earth.buffer, r.soc.buffer]);
    } else if (msg.type === "compare") {
      const rows = manifest.sites.map((s) => ({ id: s.id, m: metrics(prep(s.id, 0, msg.z), msg.a, msg.b, msg.power) }));
      postMessage({ id: msg.id, rows, ms: performance.now() - t0 });
    } else if (msg.type === "strips") {
      // per-step series for the timeline strips of the compare table (downsampled to `width` buckets)
      const out = manifest.sites.map((s) => {
        const sr = siteSeries(sites.get(s.id)!, dsn, 0, msg.z);
        const w = msg.width, n = msg.b - msg.a;
        const sun = new Float32Array(w), earth = new Float32Array(w), dte = new Float32Array(w);
        for (let x = 0; x < w; x++) {
          const i0 = msg.a + Math.floor((x * n) / w), i1 = Math.max(i0 + 1, msg.a + Math.floor(((x + 1) * n) / w));
          let a = 0, b = 0, c = 0;
          for (let i = i0; i < i1; i++) { a += sr.sun[i]; b += sr.earth[i] >= 0.5 ? 1 : 0; c += sr.dte[i]; }
          sun[x] = a / (i1 - i0); earth[x] = b / (i1 - i0); dte[x] = c / (i1 - i0);
        }
        return { id: s.id, sun, earth, dte };
      });
      postMessage({ id: msg.id, strips: out, ms: performance.now() - t0 });
    } else if (msg.type === "search") {
      const req: Requirements = msg.req;
      const stepsPerDay = Math.round(86400 / manifest.step_s);
      const days = Math.ceil(manifest.n / stepsPerDay);
      const results = manifest.sites.map((s) => search(prep(s.id, 0, msg.z), req, msg.every, msg.power));
      const out = manifest.sites.map((s, k) => {
        const res = results[k];
        let pass = 0;
        for (const f of res.fails) if (f === 0) pass++;
        return { id: s.id, starts: res.starts, m: res.m, fails: res.fails, pass, cal: calendar(res, stepsPerDay, days) };
      });
      postMessage({ id: msg.id, sites: out, relax: minimalRelaxations(results, req), ms: performance.now() - t0 });
    } else if (msg.type === "sky") {
      // one site's skyline (centre point, height z) and its Sun/Earth/DSN track over [a, b) for the panorama
      const s = sites.get(msg.site)!;
      const g = s.hz, plane = g.rows * g.cols, cell = msg.z;
      const horizon = new Float64Array(g.nAz);
      for (let k = 0; k < g.nAz; k++) horizon[k] = g.k[k * plane + cell] * g.quantum;
      const sl = (x: Float64Array) => x.slice(msg.a, msg.b);
      const out = {
        horizon, lon: s.entry.azimuth === "true" ? 0 : s.entry.lon_deg, // panorama azimuth = table azimuth − lon
        sun: { az: sl(s.sun.az), el: sl(s.sun.el), r: sl(s.sun.r) },
        earth: { az: sl(s.earth.az), el: sl(s.earth.el), r: sl(s.earth.r) },
        dsn: dsn.slice(msg.a, msg.b),
      };
      postMessage({ id: msg.id, ...out, ms: performance.now() - t0 });
    } else if (msg.type === "skyat") {
      const s = sites.get(msg.site);
      if (!s) throw new Error(`unknown site ${msg.site}`);
      const i = Math.max(0, Math.min(manifest.n - 1, msg.i)), lon = s.entry.azimuth === "true" ? 0 : s.entry.lon_deg;
      const body = (t: { az: Float64Array; el: Float64Array; r: Float64Array }) => {
        const h = siteHorizon(s, 0, msg.z, t.az[i]);
        return { el: t.el[i], az: (((t.az[i] - lon) % 360) + 360) % 360, horizon: h, visible: visibleDiscFraction(t.el[i], h, t.r[i]) };
      };
      postMessage({ id: msg.id, i, sun: body(s.sun), earth: body(s.earth), dsn: dsn[i], ms: performance.now() - t0 });
    } else if (msg.type === "clock") {
      // mission clock at landing, every site: is the Sun / link up at step a, and how many steps until that changes
      const limit = Math.min(manifest.n, msg.a + Math.round((90 * 86400) / manifest.step_s));
      const rows = manifest.sites.map((s) => {
        const sr = siteSeries(sites.get(s.id)!, dsn, 0, msg.z);
        return { id: s.id, sun: stepsUntilChange(sr.sun, msg.a, limit), dte: stepsUntilChange(sr.dte, msg.a, limit) };
      });
      postMessage({ id: msg.id, rows, stepH: manifest.step_s / 3600, ms: performance.now() - t0 });
    } else if (msg.type === "slip") {
      // per site and day: fail bits and the numbers behind them (sun %, dark h, link %, blackout h, battery min %, empty h)
      const day = Math.round(86400 / manifest.step_s), stay = Math.round((msg.req.days * 86400) / manifest.step_s), D = msg.to - msg.from + 1;
      const rows = manifest.sites.map((s) => {
        const P = prep(s.id, 0, msg.z), fails = new Uint8Array(D), m = new Float32Array(D * 6);
        for (let k = 0; k < D; k++) {
          const a = msg.a0 + (msg.from + k) * day;
          if (a < 0 || a + stay > manifest.n) { fails[k] = NO_DATA; continue; }
          const x = metrics(P, a, a + stay, msg.req.battery ? msg.power : undefined);
          fails[k] = failBits(x, msg.req);
          m.set([x.sunPct, x.darkH, x.dtePct, x.blackoutH, x.batteryMinPct, x.batteryEmptyH], k * 6);
        }
        return { id: s.id, fails, m };
      });
      postMessage({ id: msg.id, rows, ms: performance.now() - t0 });
    } else if (msg.type === "spread") {
      const pts = [];
      for (let p = 0; p < manifest.n_pts; p++) { const m = metrics(prep(msg.site, p, msg.z), msg.a, msg.b); pts.push({ p, sunPct: m.sunPct, dtePct: m.dtePct }); }
      postMessage({ id: msg.id, pts, ms: performance.now() - t0 });
    } else if (msg.type === "robust") {
      // same window at all landing-dispersion points
      const req: Requirements = msg.req;
      const pts = [];
      for (let p = 0; p < manifest.n_pts; p++) {
        const m = metrics(prep(msg.site, p, msg.z), msg.a, msg.b, req.battery ? msg.power : undefined);
        pts.push({ p, m, fails: failBits(m, req) });
      }
      postMessage({ id: msg.id, pts, ms: performance.now() - t0 });
    }
  } catch (err) {
    postMessage({ id: msg.id, error: String(err) });
  }
};
