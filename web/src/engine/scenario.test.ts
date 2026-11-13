import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explain, phase, runScenario, type ScenarioRun } from "./scenario";
import { decodeSite, siteSeries, type SitesManifest } from "./sites";
import { EXAMPLE_POWER, battery, metrics, prepare, type Metrics, type Requirements } from "./windows";

const dir = new URL("../../public/data/sites/", import.meta.url);
const manifest: SitesManifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8"));
const dsnBuf = readFileSync(new URL(manifest.dsn.file, dir));
const dsn = new Uint8Array(dsnBuf.buffer, dsnBuf.byteOffset, dsnBuf.byteLength);
const REQ: Requirements = { days: 14, minSunPct: 70, maxDarkH: null, minDtePct: 50, maxBlackoutH: 24, battery: true };

describe("scenario run", () => {
  it("agrees with the window metrics and battery model it summarises", () => {
    const e = manifest.sites.find((s) => s.id === "nobile-rim-1")!, b = readFileSync(new URL(e.file, dir));
    const s = decodeSite(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), e, manifest);
    const sr = siteSeries(s, dsn, 0, 1), P = prepare(sr, manifest.step_s);
    for (const a of [1000, 9000, 33333]) {
      const end = a + 14 * 144, r = runScenario(s, P, sr, a, end, 1, EXAMPLE_POWER, REQ);
      expect(r.m).toEqual(metrics(P, a, end, EXAMPLE_POWER));
      const mean = (x: Float32Array) => x.reduce((u, v) => u + v, 0) / x.length;
      expect(mean(r.sun) * 100).toBeCloseTo(r.m.sunPct, 3);
      expect(mean(r.dte) * 100).toBeCloseTo(r.m.dtePct, 3);
      // hourly battery samples never go below the step-by-step low point
      expect(Math.min(...r.soc)).toBeGreaterThanOrEqual(battery(P, a, end, EXAMPLE_POWER).minPct - 1e-4);
      // sun events alternate, and their count matches the series
      let flips = 0;
      for (let i = a + 1; i < end; i++) if ((sr.sun[i] > 0) !== (sr.sun[i - 1] > 0)) flips++;
      expect(r.events.filter((x) => x.kind === "sunset" || x.kind === "sunrise").length).toBe(flips);
      expect(r.landing.sunUp).toBe(sr.sun[a] > 0);
    }
  });
});

const fake = (m: Partial<Metrics>, l: Partial<ScenarioRun["landing"]> = {}, sky: Partial<ScenarioRun["sky"]> = {}): ScenarioRun => ({
  a: 0, b: 14 * 144, stepH: 1 / 6, fails: (m.sunPct ?? 0) >= 70 ? 0 : 1, sun: new Float32Array(), dte: new Float32Array(), earth: new Float32Array(),
  soc: new Float32Array(), events: [],
  m: { sunPct: 90, darkH: 0, earthPct: 80, dtePct: 80, blackoutH: 0, energyWhM2Day: 0, batteryMinPct: 80, batteryEmptyH: 0, ...m },
  landing: { sunUp: true, sinceH: 20, untilH: 300, sunEl: 1, linkUp: true, ...l },
  sky: { sunHorizon: 0.3, sunMax: 3, earthEl: 5, earthHorizon: 1, ...sky },
});

describe("what changed", () => {
  it("splits a change exactly between date and site (two-factor Shapley)", () => {
    const A = fake({ sunPct: 90, dtePct: 80 }), B = fake({ sunPct: 40, dtePct: 60 });
    const cross = { bSiteAtADate: fake({ sunPct: 70, dtePct: 75 }).m, aSiteAtBDate: fake({ sunPct: 55, dtePct: 70 }).m };
    const c = explain({ name: "A", lat: -85, run: A }, { name: "B", lat: -85, run: B }, false, false, EXAMPLE_POWER, cross);
    // date = ½[(55 − 90) + (40 − 70)] = −32.5; site = −50 − (−32.5) = −17.5
    expect(c.split!.sunPct.date).toBeCloseTo(-32.5);
    expect(c.split!.sunPct.site).toBeCloseTo(-17.5);
    expect(c.split!.sunPct.date + c.split!.sunPct.site).toBeCloseTo(-50);
    expect(c.verdict).toEqual({ from: true, to: false });
  });

  it("names the cause: same site means the date, and explains an empty battery", () => {
    const A = fake({ sunPct: 94 }), B = fake({ sunPct: 51, darkH: 82, batteryEmptyH: 41 }, { sinceH: 250, untilH: 100 });
    const c = explain({ name: "A", lat: -85, run: A }, { name: "B", lat: -85, run: B }, true, false, EXAMPLE_POWER);
    expect(c.lines[0]).toContain("all from the date");
    expect(c.lines.join(" ")).toContain("carries 20 h of darkness");
    expect(phase(B)).toBe("lands 4.2 days before sunset");
  });
});
