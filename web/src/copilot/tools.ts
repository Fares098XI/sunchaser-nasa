/**
 * The copilot's tools, run in the browser on Sunchaser's own engine (the windows worker): the model only chooses
 * which to call; every number it may quote comes back from here. Errors are returned as {error} so the model can
 * correct its call. Definitions the model sees: api/copilot.ts TOOLS.
 */
import { sitesClient } from "../data/sitesClient";
import { explain, phase, type ScenarioRun } from "../engine/scenario";
import type { SiteEntry } from "../engine/sites";
import { candidateMetrics, minRelMargin, REQ_KEYS, FAIL_BIT, type Metrics, type PowerSystem, type Requirements } from "../engine/windows";
import { REQ_LABEL } from "../views/WindowsView";
import { searchKnowledge } from "./knowledge";

export interface ToolCtx { req: Requirements; z: number; power: PowerSystem }
export type View = "globe" | "explore" | "compare" | "windows" | "replan" | "scenarios" | "stories" | "learn" | "validation";
export interface Landing { site_id: string; landing_utc: string; days?: number }
/** a "show me" button: App.tsx opens the view */
export interface Action { view: View; label: string; site_id?: string; landing_utc?: string; days?: number; lat?: number; lon?: number;
  scenarios?: Landing[]; story?: "im2" | "apollo" | "farside"; go_now?: boolean }
type Args = Record<string, unknown>;

const VIEWS: View[] = ["globe", "explore", "compare", "windows", "replan", "scenarios", "stories", "learn", "validation"];
const r1 = (v: number) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
class ToolError extends Error {}

async function client() { const c = sitesClient(); await c.ready; return c; }
const dataEnd = (c: Awaited<ReturnType<typeof client>>) => c.timeAt(c.manifest.n - 1).getTime() + c.manifest.step_s * 1000;

/** A site by id, or by a name the model or the user wrote ("apollo 15", "shackleton rim"). */
export function findSite(sites: SiteEntry[], q: unknown): SiteEntry | null {
  if (typeof q !== "string" || !q.trim()) return null;
  const k = q.trim().toLowerCase(), slug = k.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return sites.find((s) => s.id === k || s.id === slug) ?? sites.find((s) => s.name.toLowerCase() === k)
    ?? sites.find((s) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").startsWith(slug) && slug.length >= 3)
    ?? sites.find((s) => s.id.replace(/-/g, "") === slug.replace(/-/g, "")) ?? null; // "apollo15"
}
function site(sites: SiteEntry[], q: unknown) {
  const s = findSite(sites, q);
  if (!s) throw new ToolError(`unknown site "${String(q)}": call list_sites for the ids`);
  return s;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (UTC) inside the site tables; a date alone means 12:00 UTC (the prompt says so too). */
async function time(v: unknown, what: string, stayDays = 0, hm = "12:00") {
  const c = await client();
  const m = typeof v === "string" ? v.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/) : null;
  if (!m) throw new ToolError(`${what}: use 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (UTC)`);
  const ms = Date.parse(`${m[1]}T${m[2] ?? hm}:00Z`), lo = Date.parse(c.manifest.start_utc + "Z"), hi = dataEnd(c);
  if (!Number.isFinite(ms)) throw new ToolError(`${what}: not a date`);
  if (ms < lo || ms + stayDays * 86400e3 > hi)
    throw new ToolError(`${what}: Sunchaser's site tables cover ${iso(lo).slice(0, 10)} to ${iso(hi - 1).slice(0, 10)}${stayDays ? " (the whole stay must fit)" : ""}`);
  return ms;
}
const days = (v: unknown, d = 14) => { const n = Math.round(Number(v ?? d)); if (!(n >= 1 && n <= 60)) throw new ToolError("days: 1 to 60"); return n; };

const metricsOut = (m: Metrics) => ({
  sunlight_pct: r1(m.sunPct), longest_darkness_h: r1(m.darkH), earth_in_view_pct: r1(m.earthPct), link_pct: r1(m.dtePct),
  longest_blackout_h: r1(m.blackoutH), solar_energy_kwh_m2_day: r1(m.energyWhM2Day / 1000),
  ...(Number.isFinite(m.batteryMinPct) ? { battery_low_point_pct: r1(m.batteryMinPct), battery_short_h: r1(m.batteryEmptyH) } : {}),
});
const failed = (bits: number) => REQ_KEYS.filter((k) => bits & FAIL_BIT[k]).map((k) => REQ_LABEL[k]);
export const reqOut = (r: Requirements) => ({
  stay_days: r.days, min_sunlight_pct: r.minSunPct, max_darkness_h: r.maxDarkH, min_link_pct: r.minDtePct, max_blackout_h: r.maxBlackoutH,
  battery_must_not_run_out: r.battery,
});
const siteOut = (s: SiteEntry) => ({ id: s.id, name: s.name, lat: r1(s.lat_deg), lon: r1(s.lon_deg),
  group: s.kind === "pin" ? "your pin" : s.kind === "atlas" ? s.group ?? "atlas" : "south pole (20 m terrain)", ...(s.status ? { status: s.status } : {}) });

async function scenario(l: Landing, ctx: ToolCtx) {
  const c = await client(), s = site(c.manifest.sites, l.site_id), d = days(l.days), ms = await time(l.landing_utc, "landing_utc", d);
  const a = c.stepAt(iso(ms) + ":00Z");
  const r = await c.call({ type: "scenario", site: s.id, a, b: a + Math.round((d * 86400) / c.manifest.step_s), z: ctx.z, power: ctx.power, req: { ...ctx.req, days: d } });
  return { s, d, ms, run: r.run as ScenarioRun };
}
const EVENT: Record<string, string> = { sunset: "Sun lost", sunrise: "Sun back", linkdown: "link to Earth lost", linkup: "link back", empty: "battery empty", recharged: "battery recovering" };

type Tool = (a: Args, ctx: ToolCtx) => Promise<unknown>;
const TOOLS: Record<string, Tool> = {
  async list_sites() {
    const c = await client();
    return { sites: c.manifest.sites.map(siteOut), data_from: c.manifest.start_utc.slice(0, 10), data_to: iso(dataEnd(c) - 1).slice(0, 10) };
  },

  async compare_sites(a, ctx) {
    const c = await client(), d = days(a.days), ms = await time(a.start_date, "start_date", d);
    const i0 = c.stepAt(iso(ms) + ":00Z"), i1 = i0 + Math.round((d * 86400) / c.manifest.step_s);
    const want = Array.isArray(a.site_ids) && a.site_ids.length ? a.site_ids.map((q) => site(c.manifest.sites, q).id) : null;
    const r = await c.call({ type: "compare", z: ctx.z, a: i0, b: i1, power: ctx.power });
    const keys: Record<string, keyof Metrics> = { sunlight: "sunPct", link: "dtePct", darkness: "darkH", blackout: "blackoutH", energy: "energyWhM2Day" };
    const key = keys[String(a.sort_by ?? "sunlight")] ?? "sunPct";
    const low = key === "darkH" || key === "blackoutH";
    const rows = (r.rows as { id: string; m: Metrics }[]).filter((x) => !want || want.includes(x.id))
      .sort((x, y) => (low ? x.m[key] - y.m[key] : y.m[key] - x.m[key]));
    const byId = Object.fromEntries(c.manifest.sites.map((s) => [s.id, s]));
    return { period: `${iso(ms).replace("T", " ")} UTC + ${d} days`, ranked_by: a.sort_by ?? "sunlight", sites_compared: rows.length,
      rows: rows.slice(0, want ? 8 : 12).map((x, k) => ({ rank: k + 1, id: x.id, name: byId[x.id]?.name, ...metricsOut(x.m) })) };
  },

  async check_landing(a, ctx) {
    const { s, d, ms, run } = await scenario(a as unknown as Landing, ctx);
    return {
      site: s.name, site_id: s.id, landing_utc: iso(ms), stay_days: d, verdict: run.fails === 0 ? "GO" : "NO-GO", failed: failed(run.fails),
      requirements: reqOut({ ...ctx.req, days: d }), ...metricsOut(run.m),
      lunar_day: phase(run), sun_elevation_at_landing_deg: r1(run.landing.sunEl), link_at_landing: run.landing.linkUp,
      first_events: run.events.slice(0, 8).map((e) => ({ after_h: r1(e.h), event: EVENT[e.kind] })),
      in_3d: s.kind === "atlas" ? "globe flight (474 m terrain)" : "3D region",
    };
  },

  async find_windows(a, ctx) {
    const c = await client(), sites = c.manifest.sites;
    const only = a.site_id ? site(sites, a.site_id) : null;
    const num = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
    const req: Requirements = { ...ctx.req, days: a.days == null ? ctx.req.days : days(a.days), minSunPct: num(a.min_sunlight_pct, ctx.req.minSunPct),
      minDtePct: num(a.min_link_pct, ctx.req.minDtePct), maxBlackoutH: a.max_blackout_h == null ? ctx.req.maxBlackoutH : num(a.max_blackout_h, 24) };
    const from = a.from_date ? await time(a.from_date, "from_date", 0, "00:00") : -Infinity, to = a.to_date ? await time(a.to_date, "to_date", 0, "00:00") + 86400e3 : Infinity;
    const r = await c.call({ type: "search", req, z: ctx.z, every: 6, power: ctx.power });
    type SR = { id: string; starts: Int32Array; m: Float32Array; fails: Uint8Array };
    const all: { s: SR; c: number; score: number; t: number }[] = [];
    let total = 0;
    for (const s of r.sites as SR[]) {
      if (only && s.id !== only.id) continue;
      for (let k = 0; k < s.fails.length; k++) {
        if (s.fails[k] !== 0) continue;
        const t = c.timeAt(s.starts[k]).getTime();
        if (t < from || t >= to) continue;
        total++;
        all.push({ s, c: k, score: minRelMargin(candidateMetrics(s as never, k), req), t });
      }
    }
    all.sort((x, y) => y.score - x.score);
    // the best landing at each site, then more days (one per site and day), as the Window Finder ranks them
    const out: typeof all = [], seenSite = new Set<string>(), seenDay = new Set<string>(), limit = Math.max(1, Math.min(10, Math.round(num(a.limit, 5))));
    const day = (w: (typeof all)[number]) => `${w.s.id}|${Math.floor(w.t / 86400e3)}`;
    if (!only) for (const w of all) if (!seenSite.has(w.s.id)) { seenSite.add(w.s.id); seenDay.add(day(w)); out.push(w); }
    for (const w of all) { if (out.length >= limit) break; if (!seenDay.has(day(w))) { seenDay.add(day(w)); out.push(w); } }
    const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
    const res = {
      requirements: reqOut(req), searched: `every landing hour ${from > -Infinity ? iso(from).slice(0, 10) : "2026-11-01"} to ${to < Infinity ? iso(to - 86400e3).slice(0, 10) : "2028-12-31"}${only ? ` at ${only.name}` : ", every site"}`,
      passing_landing_hours: total, sites_with_windows: new Set(all.map((w) => w.s.id)).size,
      windows: out.slice(0, limit).map((w) => ({ site: byId[w.s.id]?.name, site_id: w.s.id, landing_utc: iso(w.t), ...metricsOut(candidateMetrics(w.s as never, w.c)) })),
    };
    if (!total) return { ...res, smallest_single_relaxations: (r.relax as { key: string; from: number; to: number; windows: number }[]).map((x) => ({ requirement: REQ_LABEL[x.key as "sun"], from: r1(x.from), to: r1(x.to), opens_windows: x.windows })),
      note: only || from > -Infinity ? "relaxations are computed over every site and the whole period" : undefined };
    return res;
  },

  async explain_change(a, ctx) {
    const A = a.a as Landing, B = a.b as Landing;
    if (!A || !B) throw new ToolError("explain_change needs a and b");
    const [ra, rb] = await Promise.all([scenario(A, ctx), scenario(B, ctx)]);
    const sameSite = ra.s.id === rb.s.id, sameDate = ra.ms === rb.ms && ra.d === rb.d;
    let cross;
    if (!sameSite && !sameDate) {
      const [x, y] = await Promise.all([scenario({ ...A, site_id: rb.s.id }, ctx), scenario({ ...B, site_id: ra.s.id }, ctx)]);
      cross = { bSiteAtADate: x.run.m, aSiteAtBDate: y.run.m };
    }
    const ch = explain({ name: `A · ${ra.s.name}`, lat: ra.s.lat_deg, run: ra.run }, { name: `B · ${rb.s.name}`, lat: rb.s.lat_deg, run: rb.run }, sameSite, sameDate, ctx.power, cross);
    const side = (x: typeof ra) => ({ site: x.s.name, landing_utc: iso(x.ms), stay_days: x.d, verdict: x.run.fails === 0 ? "GO" : "NO-GO", failed: failed(x.run.fails), ...metricsOut(x.run.m) });
    return { a: side(ra), b: side(rb), what_changed: ch.lines,
      split: ch.split && { sunlight_pts: { total: r1(ch.split.sunPct.total), from_date: r1(ch.split.sunPct.date), from_site: r1(ch.split.sunPct.site) },
        link_pts: { total: r1(ch.split.dtePct.total), from_date: r1(ch.split.dtePct.date), from_site: r1(ch.split.dtePct.site) } } };
  },

  async sky_at(a, ctx) {
    const c = await client(), s = site(c.manifest.sites, a.site_id);
    const ms = await time(a.time_utc ?? iso(Date.now()), "time_utc");
    const r = await c.call({ type: "skyat", site: s.id, z: ctx.z, i: c.stepAt(iso(ms) + ":00Z") });
    const dir = (az: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
    const body = (b: { el: number; az: number; horizon: number; visible: number }) => ({ elevation_deg: r1(b.el), compass_deg: Math.round(b.az), direction: dir(b.az),
      terrain_horizon_deg: r1(b.horizon), visible_pct: Math.round(100 * b.visible) });
    const dsn = c.manifest.dsn.names.filter((_, k) => r.dsn & (1 << k));
    return { site: s.name, time_utc: iso(c.timeAt(r.i).getTime()), height_m: c.manifest.z_m[ctx.z], sun: body(r.sun), earth: body(r.earth),
      dsn_dishes_seeing_moon: dsn, link_to_earth: r.earth.visible >= 0.5 && dsn.length > 0 };
  },

  async search_knowledge(a) {
    const hits = searchKnowledge(String(a.query ?? ""));
    return hits.length ? { results: hits } : { results: [], note: "nothing in Sunchaser's documentation matches" };
  },

  async show(a) {
    const view = String(a.view) as View;
    if (!VIEWS.includes(view)) throw new ToolError(`view: one of ${VIEWS.join(", ")}`);
    const c = await client();
    const s = a.site_id ? site(c.manifest.sites, a.site_id) : null;
    if (a.landing_utc) await time(a.landing_utc, "landing_utc");
    if (view === "globe" && a.site_id == null && !(Number.isFinite(Number(a.lat)) && Number.isFinite(Number(a.lon)))) throw new ToolError("globe needs lat and lon, or a site_id");
    return { ok: true, shown: "a button under your answer", ...(s ? { site: s.name, lat: r1(s.lat_deg), lon: Math.round(s.lon_deg * 100) / 100 } : {}) };
  },
};

/** Run one tool call; a "show" call also yields the button it asked for. */
export async function runTool(name: string, args: Args, ctx: ToolCtx): Promise<{ result: unknown; action?: Action }> {
  const f = TOOLS[name];
  if (!f) return { result: { error: `unknown tool ${name}` } };
  try {
    const result = await f(args ?? {}, ctx);
    if (name !== "show") return { result };
    const c = await client(), s = findSite(c.manifest.sites, args.site_id);
    const action: Action = { ...(args as unknown as Action), label: String(args.label ?? "Show me").slice(0, 40), ...(s ? { site_id: s.id } : {}) };
    if (action.view === "globe" && s && action.lat == null) { action.lat = s.lat_deg; action.lon = s.lon_deg; }
    return { result, action };
  } catch (e) {
    return { result: { error: e instanceof ToolError ? e.message : `tool failed: ${String(e)}` } };
  }
}

/** Progress line while a tool runs */
export const STEP: Record<string, [string, string]> = {
  list_sites: ["Reading the site list", "قراءة قائمة المواقع"],
  compare_sites: ["Comparing every site over the period", "مقارنة كل المواقع خلال الفترة"],
  check_landing: ["Running the landing over its stay", "محاكاة الهبوط طوال فترة البقاء"],
  find_windows: ["Searching every landing hour, 2026–2028", "البحث في كل ساعة هبوط 2026–2028"],
  explain_change: ["Splitting the change into date and site", "تقسيم التغيّر بين التاريخ والموقع"],
  sky_at: ["Placing the Sun and Earth over the skyline", "تحديد موضع الشمس والأرض فوق الأفق"],
  search_knowledge: ["Reading Sunchaser's methods and checks", "قراءة طرق Sunchaser وفحوصه"],
  show: ["Preparing the view", "تجهيز العرض"],
};
