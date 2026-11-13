/**
 * S6 scenario board (docs/METHODS.md §22): one landing scenario run over its stay, and what changed between two.
 * Pure functions on the windows engine's series: the worker runs them, tests pin them down.
 */
import { siteHorizon, type Series, type SiteData } from "./sites";
import { failBits, metrics, type Metrics, type PowerSystem, type Prepared, type Requirements } from "./windows";

export type EventKind = "sunset" | "sunrise" | "linkdown" | "linkup" | "empty" | "recharged";
export interface ScenarioRun {
  /** stay [a, b) in table steps, hours per step */
  a: number; b: number; stepH: number;
  m: Metrics; fails: number;
  /** hourly ribbons over the stay: mean visible Sun fraction, link share, Earth share; battery % at the end of each hour */
  sun: Float32Array; dte: Float32Array; earth: Float32Array; soc: Float32Array;
  /** state changes during the stay, hours after landing */
  events: { h: number; kind: EventKind }[];
  /** at touchdown: is the Sun up, hours since the last sunrise/sunset and until the next (null: beyond the search) */
  landing: { sunUp: boolean; sinceH: number | null; untilH: number | null; sunEl: number; linkUp: boolean };
  /** over the stay: mean terrain horizon under the Sun's path (Sun above -2 deg), the Sun's highest elevation,
   * Earth's mean elevation and mean horizon toward it */
  sky: { sunHorizon: number; sunMax: number; earthEl: number; earthHorizon: number };
}

const LOOK_STEPS = 45 * 144; // search up to 45 days around touchdown for the last and next change

/** z: height index (manifest z_m), as siteHorizon */
export function runScenario(s: SiteData, P: Prepared, sr: Series, a: number, b: number, z: number, power: PowerSystem, req: Requirements): ScenarioRun {
  const stepH = P.stepH, per = Math.round(1 / stepH), hours = Math.ceil((b - a) / per);
  const m = metrics(P, a, b, power);
  const sun = new Float32Array(hours), dte = new Float32Array(hours), earth = new Float32Array(hours), soc = new Float32Array(hours);
  const events: ScenarioRun["events"] = [];
  const out = power.loadW * stepH;
  let charge = power.batteryWh, wasEmpty = false;
  for (let i = a; i < b; i++) {
    const hIdx = Math.floor((i - a) / per);
    sun[hIdx] += sr.sun[i] / per; dte[hIdx] += sr.dte[i] / per; earth[hIdx] += (sr.earth[i] >= 0.5 ? 1 : 0) / per;
    // windows.battery, step by step
    charge = Math.min(power.batteryWh, charge + P.energy[i] * power.panelM2 * power.efficiency - out);
    const empty = charge < 0;
    if (empty) charge = 0;
    soc[hIdx] = (100 * charge) / power.batteryWh;
    const h = (i - a) * stepH;
    if (i > a) {
      if ((sr.sun[i] > 0) !== (sr.sun[i - 1] > 0)) events.push({ h, kind: sr.sun[i] > 0 ? "sunrise" : "sunset" });
      if (sr.dte[i] !== sr.dte[i - 1]) events.push({ h, kind: sr.dte[i] ? "linkup" : "linkdown" });
    }
    if (empty !== wasEmpty) events.push({ h, kind: empty ? "empty" : "recharged" });
    wasEmpty = empty;
  }
  const up = sr.sun[a] > 0;
  let since: number | null = null, until: number | null = null;
  for (let i = a - 1; i >= Math.max(0, a - LOOK_STEPS); i--) if ((sr.sun[i] > 0) !== up) { since = (a - i) * stepH; break; }
  for (let i = a + 1; i < Math.min(sr.sun.length, a + LOOK_STEPS); i++) if ((sr.sun[i] > 0) !== up) { until = (i - a) * stepH; break; }
  let sh = 0, sn = 0, smax = -90, ee = 0, eh = 0;
  for (let i = a; i < b; i++) {
    const el = s.sun.el[i];
    smax = Math.max(smax, el);
    if (el > -2) { sh += siteHorizon(s, 0, z, s.sun.az[i]); sn++; }
    ee += s.earth.el[i]; eh += siteHorizon(s, 0, z, s.earth.az[i]);
  }
  const n = b - a;
  return {
    a, b, stepH, m, fails: failBits(m, req), sun, dte, earth, soc, events,
    landing: { sunUp: up, sinceH: since, untilH: until, sunEl: s.sun.el[a], linkUp: sr.dte[a] > 0 },
    sky: { sunHorizon: sn ? sh / sn : NaN, sunMax: smax, earthEl: ee / n, earthHorizon: eh / n },
  };
}

// ---------- what changed ----------

export interface Side { name: string; lat: number; run: ScenarioRun }
export interface Change {
  /** e.g. "B: NO-GO (was GO)" pieces for the UI */
  verdict: { from: boolean; to: boolean };
  /** total change and its split between the landing date and the site (Shapley values of the two factors) */
  split: Record<"sunPct" | "dtePct", { total: number; date: number; site: number }> | null;
  lines: string[];
}

const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} h`);
const deg = (v: number) => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}°`;
const pts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(0)} pts`;

/** Where in the lunar day a landing falls, in words. */
export function phase(r: ScenarioRun): string {
  const l = r.landing, stayH = (r.b - r.a) * r.stepH;
  if (l.sunUp) {
    if (l.untilH == null) return "the Sun does not set for weeks: polar summer light";
    if (l.untilH >= stayH) return `lands in sunlight that lasts the whole stay (sunset ${fmtH(l.untilH)} after landing)`;
    if (l.sinceH == null || l.sinceH > l.untilH) return `lands ${fmtH(l.untilH)} before sunset`;
    return `lands ${fmtH(l.sinceH)} after sunrise, ${fmtH(l.untilH)} before sunset`;
  }
  if (l.untilH == null) return "lands in a night that lasts weeks";
  if (l.untilH >= stayH) return `lands in a night that outlasts the stay (sunrise ${fmtH(l.untilH)} after landing)`;
  return `lands in the dark: the Sun rises ${fmtH(l.untilH)} later`;
}

/**
 * B against A. `cross`: metrics of B's site at A's date and A's site at B's date (needed when both changed), so the
 * change splits exactly into a date part and a site part: date = ½[(A@dB − A) + (B − B@dA)], site = total − date.
 */
export function explain(A: Side, B: Side, sameSite: boolean, sameDate: boolean, power: PowerSystem,
  cross?: { bSiteAtADate: Metrics; aSiteAtBDate: Metrics }): Change {
  const a = A.run, b = B.run, lines: string[] = [];
  const split = (["sunPct", "dtePct"] as const).reduce((o, k) => {
    const total = b.m[k] - a.m[k];
    const date = sameSite ? total : sameDate ? 0 : cross ? ((cross.aSiteAtBDate[k] - a.m[k]) + (b.m[k] - cross.bSiteAtADate[k])) / 2 : NaN;
    o[k] = { total, date, site: total - date };
    return o;
  }, {} as Record<"sunPct" | "dtePct", { total: number; date: number; site: number }>);

  const dSun = split.sunPct, dDte = split.dtePct;
  if (Math.abs(dSun.total) >= 1) {
    const why = sameSite ? "all from the date" : sameDate ? "all from the site" : Number.isFinite(dSun.date)
      ? `${pts(dSun.date)} from the date, ${pts(dSun.site)} from the site` : "";
    lines.push(`Sunlight ${a.m.sunPct.toFixed(0)} → ${b.m.sunPct.toFixed(0)} % (${pts(dSun.total)}${why ? `: ${why}` : ""}).`);
  }
  if (!sameDate) {
    lines.push(`${A.name.split(" · ")[0]}: ${phase(a)}. ${B.name.split(" · ")[0]}: ${phase(b)}.`);
    const polar = Math.abs(A.lat) > 80 || Math.abs(B.lat) > 80;
    if (polar && Math.abs(b.sky.sunMax - a.sky.sunMax) > 0.5)
      lines.push(`The Sun climbs to ${b.sky.sunMax.toFixed(1)}° at most during this stay, against ${a.sky.sunMax.toFixed(1)}°: near the pole a few degrees of season decide which ridges stay lit.`);
  }
  if (!sameSite) {
    const dh = b.sky.sunHorizon - a.sky.sunHorizon, pa = Math.abs(A.lat) > 75, pb = Math.abs(B.lat) > 75;
    // away from the poles the lunar day itself decides (about 14.8 days of night every 29.5); near them, the terrain
    const full = (x: Side) => { const [l, n] = x.name.split(" · "); return n ? `${n} (${l})` : l; };
    if (pa !== pb) lines.push(`${full(pb ? A : B)} is at ${Math.abs((pb ? A : B).lat).toFixed(0)}° latitude, where the Sun rises and sets once a lunar month: about 14.8 days of every 29.5 are night, whatever the terrain. Near the pole the Sun circles the horizon instead, and high ground can stay lit for weeks.`);
    else if (pa && pb && Number.isFinite(dh) && Math.abs(dh) > 0.2)
      lines.push(`The skyline under the Sun's path averages ${deg(b.sky.sunHorizon)} here, against ${deg(a.sky.sunHorizon)}: ${dh > 0 ? "higher terrain hides the Sun for longer" : "a lower skyline keeps the Sun in view longer"}.`);
  }
  if (Math.abs(b.m.darkH - a.m.darkH) >= 1) lines.push(`Longest darkness ${fmtH(a.m.darkH)} → ${fmtH(b.m.darkH)}.`);
  if (b.m.batteryEmptyH > 0) {
    const lasts = power.batteryWh / power.loadW;
    lines.push(`The battery (${power.batteryWh} Wh at ${power.loadW} W) carries ${fmtH(lasts)} of darkness; the longest night here is ${fmtH(b.m.darkH)}, so the load goes unmet for ${fmtH(b.m.batteryEmptyH)}.`);
  } else if (a.m.batteryEmptyH > 0) lines.push(`The battery no longer runs out (it was short for ${fmtH(a.m.batteryEmptyH)}).`);
  if (Math.abs(dDte.total) >= 1) {
    const why = sameSite ? "the date" : sameDate ? "the site" : Number.isFinite(dDte.date) ? `${pts(dDte.date)} date, ${pts(dDte.site)} site` : "";
    lines.push(`Link to Earth ${a.m.dtePct.toFixed(0)} → ${b.m.dtePct.toFixed(0)} % (${pts(dDte.total)}${why ? `, ${why}` : ""}).`);
    const ga = a.sky.earthEl - a.sky.earthHorizon, gb = b.sky.earthEl - b.sky.earthHorizon;
    const clear = (g: number) => (g >= 0 ? `clears the terrain by ${g.toFixed(1)}°` : `sits ${(-g).toFixed(1)}° below the terrain`);
    if (b.sky.earthEl < -10) lines.push("This is the far side: Earth never rises, so no direct link is possible at all (missions there talk through a relay satellite, as Chang'e 4 does through Queqiao).");
    else if (Math.abs(gb - ga) > 0.3) lines.push(`On average Earth ${clear(gb)}, against ${ga >= 0 ? "clearing it by " + ga.toFixed(1) + "°" : (-ga).toFixed(1) + "° below"}${
      b.sky.earthEl < 0 ? ": Earth is below the level horizon here this stay — the Moon's monthly libration rocks it by about ±7°" : ""}.`);
  }
  if (Math.abs(b.m.blackoutH - a.m.blackoutH) >= 1) lines.push(`Longest blackout ${fmtH(a.m.blackoutH)} → ${fmtH(b.m.blackoutH)}.`);
  if (!lines.length) lines.push("Practically the same conditions.");
  return { verdict: { from: a.fails === 0, to: b.fails === 0 }, split: sameSite && sameDate ? null : split, lines };
}
