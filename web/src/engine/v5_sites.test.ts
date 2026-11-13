/** V5 for the site catalog: decoded tables, horizons, disc fractions and window metrics == Python (< 1e-6). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeSite, siteHorizon, siteSeries, type SiteData, type SitesManifest } from "./sites";
import { visibleDiscFraction } from "./sky";
import { battery, metrics, prepare } from "./windows";

const dir = new URL("../../public/data/sites/", import.meta.url);
const golden = JSON.parse(readFileSync(new URL("./golden/v5_sites.json", import.meta.url), "utf8"));
const manifest: SitesManifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const dsnBuf = readFileSync(new URL(manifest.dsn.file, dir));
const dsn = new Uint8Array(dsnBuf.buffer, dsnBuf.byteOffset, dsnBuf.byteLength);
const cache = new Map<string, SiteData>();
const site = (id: string) => {
  if (!cache.has(id)) {
    const e = manifest.sites.find((s) => s.id === id)!;
    const b = readFileSync(new URL(e.file, dir));
    cache.set(id, decodeSite(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), e, manifest));
  }
  return cache.get(id)!;
};

describe("V5 golden: site catalog", () => {
  it(`point visibility matches Python on ${golden.cases.length} cases`, () => {
    let worst = 0;
    for (const c of golden.cases) {
      const s = site(c.site);
      for (const body of ["sun", "earth"] as const) {
        const t = s[body], g = c[body];
        const h = siteHorizon(s, c.pt, c.z, t.az[c.i]);
        const f = visibleDiscFraction(t.el[c.i], h, t.r[c.i]);
        worst = Math.max(worst, Math.abs(t.az[c.i] - g.az), Math.abs(t.el[c.i] - g.el), Math.abs(t.r[c.i] - g.r),
          Math.abs(h - g.h), Math.abs(f - g.frac));
      }
    }
    console.log(`V5 sites: worst |diff| over az, el, r, horizon, fraction = ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-6);
  });

  it(`window metrics match Python on ${golden.windows.length} windows`, () => {
    let worst = 0;
    for (const w of golden.windows) {
      const p = prepare(siteSeries(site(w.site), dsn, 0, 0), manifest.step_s);
      const m = metrics(p, w.a, w.b);
      for (const k of ["sunPct", "darkH", "earthPct", "dtePct", "blackoutH"] as const) worst = Math.max(worst, Math.abs(m[k] - w[k]));
      // relative for energy; floor of 1 Wh/m^2/day because some windows are entirely dark (energy 0)
      worst = Math.max(worst, Math.abs(m.energyWhM2Day - w.energyWhM2Day) / Math.max(1, w.energyWhM2Day));
      const pw = w.power;
      const bat = battery(p, w.a, w.b, { panelM2: pw.panel_m2, efficiency: pw.efficiency, loadW: pw.load_w, batteryWh: pw.battery_wh });
      worst = Math.max(worst, Math.abs(bat.minPct - w.batteryMinPct), Math.abs(bat.emptyH - w.batteryEmptyH), Math.abs(bat.endPct - w.batteryEndPct));
    }
    console.log(`V5 windows: worst |diff| = ${worst.toExponential(2)} (energy relative)`);
    expect(worst).toBeLessThan(1e-6);
  });
});
