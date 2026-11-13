/**
 * Offline mode: when no AI service answers, a keyword router (English and Arabic) picks one of the same tools and
 * fills a written template from its result. Narrower than the AI, but every number still comes from the engine.
 */
import { parseLatLon } from "../data/pin";
import { LIMITATIONS } from "../data/validation";
import { sitesClient } from "../data/sitesClient";
import type { SiteEntry } from "../engine/sites";
import { isArabic } from "./agent";
import { findSite, runTool, type Action, type ToolCtx } from "./tools";

export interface OfflineAnswer { text: string; actions: Action[]; results: unknown[]; tools: string[] }
type R = Record<string, any>; // tool results, shapes from copilot/tools.ts

const MONTHS_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_AR = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const AR_DIGITS = (s: string) => s.replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)));
const pad = (n: number) => String(n).padStart(2, "0");

/** A date in the question: 2027-03-15[T12:00], "15 March 2027", "March 2027", "١٥ مارس ٢٠٢٧". */
export function findDate(q: string): string | null {
  const s = AR_DIGITS(q).toLowerCase();
  const isoM = s.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/);
  if (isoM) return `${isoM[1]}-${isoM[2]}-${isoM[3]}T${isoM[4] ?? "12"}:${isoM[5] ?? "00"}`;
  const month = (w: string) => { const i = MONTHS_EN.findIndex((m) => w.startsWith(m)); return i >= 0 ? i : MONTHS_AR.findIndex((m) => w.includes(m)); };
  const m = s.match(/(?:(\d{1,2})\s+)?([a-z]{3,}|[؀-ۿ]{3,})\.?\s+(20\d{2})/);
  if (m && month(m[2]) >= 0) return `${m[3]}-${pad(month(m[2]) + 1)}-${pad(Number(m[1] ?? 1))}T12:00`;
  const m2 = s.match(/([a-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/);
  if (m2 && month(m2[1]) >= 0) return `${m2[3]}-${pad(month(m2[1]) + 1)}-${pad(Number(m2[2]))}T12:00`;
  return null;
}

const ALIASES: [RegExp, string][] = [
  [/athena|أثينا/i, "im2-athena"], [/im-?2 target/i, "im2-target"], [/odysseus|im-?1\b/i, "im-1"], [/blue ghost/i, "blue-ghost-1"],
  [/reiner|im-?3/i, "im-3-target"], [/chandrayaan|تشاندرايان/i, "chandrayaan-3"], [/connecting ridge|الحافة الواصلة/i, "connecting-ridge"],
  [/shackleton rim|حافة شاكلتون/i, "shackleton-rim"], [/peak near shackleton/i, "peak-near-shackleton"], [/shackleton|شاكلتون/i, "shackleton-rim"],
  [/malapert|مالابير/i, "malapert-massif"], [/gerlache/i, "de-gerlache-rim"], [/nobile 2|nobile rim 2/i, "nobile-rim-2"], [/nobile|نوبيل/i, "nobile-rim-1"],
  [/haworth/i, "haworth"], [/\bslim\b/i, "slim"], [/my pin|the pin|دبوسي|الدبوس/i, "pin"],
];
/** Sites named in the question, in order of appearance. */
export function findSites(q: string, sites: SiteEntry[]): SiteEntry[] {
  const s = AR_DIGITS(q), hits: [number, SiteEntry][] = [];
  const add = (i: number, e: SiteEntry | null | undefined) => { if (e && i >= 0 && !hits.some((h) => h[1].id === e.id)) hits.push([i, e]); };
  for (const m of s.matchAll(/apollo\s*(\d{2})|أبولو\s*(\d{2})/gi)) add(m.index!, findSite(sites, `apollo-${m[1] ?? m[2]}`));
  for (const m of s.matchAll(/chang'?e[\s-]*(\d)|تشانغ\s*إي?\s*(\d)/gi)) add(m.index!, findSite(sites, `change-${m[1] ?? m[2]}`));
  for (const [re, id] of ALIASES) { const m = s.match(re); if (m) add(m.index!, sites.find((x) => x.id === id)); }
  for (const e of sites) { const i = s.toLowerCase().indexOf(e.name.toLowerCase()); add(i, e); }
  return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
}

const has = (q: string, ...words: string[]) => words.some((w) => q.includes(w));
const f1 = (v: number | null | undefined) => (v == null ? "–" : String(v));
const hrs = (h: number, ar: boolean) => (h >= 48 ? `${(h / 24).toFixed(1)} ${ar ? "يوم" : "days"}` : `${Math.round(h)} ${ar ? "ساعة" : "h"}`);

export async function answerOffline(question: string, ctx: ToolCtx, state: Record<string, unknown>): Promise<OfflineAnswer> {
  const c = sitesClient(); await c.ready;
  const ar = isArabic(question), q = AR_DIGITS(question).toLowerCase(), results: unknown[] = [], actions: Action[] = [], tools: string[] = [];
  const call = async (name: string, args: Record<string, unknown>): Promise<R> => {
    tools.push(name);
    const r = await runTool(name, args, ctx);
    results.push(r.result);
    if (r.action) actions.push(r.action);
    return r.result as R;
  };
  const sites = findSites(question, c.manifest.sites), date = findDate(question);
  const sm = q.match(/(?:for|لمدة)\s*(\d{1,2})\s*(?:days?|يوم|أيام)|(\d{1,2})[- ]days?\b/);
  const stay = Number(sm?.[1] ?? sm?.[2]) || undefined;
  const pct = (re: RegExp) => { const m = q.match(re); return m ? Number(m[1]) : undefined; };
  const slip = q.match(/(\d{1,2}|a|one|two|three|four)\s*(weeks?|days?|أسبوع|أسابيع|يوم|أيام)/);
  const here = typeof state.site_id === "string" ? findSite(c.manifest.sites, state.site_id) : null;
  const start = String(state.compare_start ?? "2027-01-01");
  const done = (text: string) => ({ text, actions, results, tools });

  // coordinates: fly there on the globe
  const ll = parseLatLon(question.replace(/^.*?(-?\d+(?:\.\d+)?\s*°?\s*[NSns]?\s*[,; ]\s*-?\d+(?:\.\d+)?\s*°?\s*[EWew]?).*$/s, "$1"));
  if (ll && /\d+(\.\d+)?\s*°?\s*[nNsS]?\s*[,;]/.test(question)) {
    await call("show", { view: "globe", label: ar ? "اذهب إلى هناك" : "Fly there", lat: ll.lat, lon: ll.lon, go_now: true });
    return done(ar ? `**جارٍ الانتقال إلى ${ll.lat.toFixed(2)}°، ${ll.lon.toFixed(2)}°** على الكرة القمرية. يحسب Sunchaser أفق الدبوس وضوء الشمس ورابط الأرض هناك.`
      : `**Flying to ${ll.lat.toFixed(2)}°, ${ll.lon.toFixed(2)}°** on the globe. Sunchaser drops a pin there and computes its horizon, sunlight and link to Earth.`);
  }

  const year = Number(q.match(/\b(20\d{2})\b/)?.[1]);
  if (year && (year < 2026 || year > 2028) && !has(q, "accura", "valid", "دقة"))
    return done(ar ? `**بيانات مواقع Sunchaser تغطي من 2026-11-01 إلى 2028-12-31،** لذلك لا أستطيع الإجابة عن ${year}.`
      : `**Sunchaser's site tables cover 2026-11-01 to 2028-12-31,** so I can't answer for ${year}. Try a date in that range.`);

  // a launch slip: the same site, the date moved
  if (slip && (sites[0] ?? here) && has(q, "slip", "delay", "late", "postpone", "تأخ", "تأجيل")) {
    const n = /^\d+$/.test(slip[1]) ? Number(slip[1]) : ({ a: 1, one: 1, two: 2, three: 3, four: 4 } as Record<string, number>)[slip[1]] ?? 1;
    const dd = /week|أسبوع|أسابيع/.test(slip[2]) ? n * 7 : n, s0 = (sites[0] ?? here)!, t0 = date ?? `${start}T12:00`;
    const t1 = new Date(Date.parse(t0 + ":00Z") + dd * 86400e3).toISOString().slice(0, 16);
    const r = await call("explain_change", { a: { site_id: s0.id, landing_utc: t0, days: stay }, b: { site_id: s0.id, landing_utc: t1, days: stay } });
    if (r.error) return done(r.error);
    await call("show", { view: "replan", label: ar ? "افتح إعادة التخطيط" : "Open Replan", site_id: s0.id, landing_utc: t0 });
    return done(`**${r.a.site}: ${r.a.verdict} → ${r.b.verdict}** (${t0.replace("T", " ")} → ${t1.replace("T", " ")} UTC)\n`
      + `- ${ar ? "ضوء الشمس" : "Sunlight"}: ${r.a.sunlight_pct} % → ${r.b.sunlight_pct} %\n- ${ar ? "الاتصال بالأرض" : "Link to Earth"}: ${r.a.link_pct} % → ${r.b.link_pct} %\n`
      + r.what_changed.map((l: string) => `- ${l}`).join("\n"));
  }

  // what it does not model: the app's own limitations list
  if (has(q, "not model", "don't model", "doesn't model", "limitation", "limits", "حدود", "قيود", "لا يحسب")) {
    results.push(LIMITATIONS);
    await call("show", { view: "validation", label: ar ? "كل الفحوص والحدود" : "All checks and limits" });
    return done((ar ? "**ما لا يحسبه Sunchaser** (بالإنجليزية):\n" : "**What Sunchaser does not model:**\n") + LIMITATIONS.map((l) => `- **${l.short}**: ${l.text.split(". ")[0].replace(/\.$/, "")}.`).join("\n"));
  }

  // how / why / accuracy: the documentation
  if (/\bv\d+[a-d]?\b/.test(q) || has(q, "accura", "trust", "valid", "method", "data", "limit", "source", "not model", "don't model", "doesn't model", "دقة", "دقيق", "بيانات", "حدود", "تحقق", "مصدر")
    || (!sites.length && !date && has(q, "how ", "why", "what is", "كيف", "لماذا", "ما هو", "ما هي"))) {
    const r = await call("search_knowledge", { query: question });
    if (r.results?.length) {
      await call("show", { view: "validation", label: ar ? "كل الفحوص والحدود" : "All checks and limits" });
      return done((ar ? "**من توثيق Sunchaser** (بالإنجليزية):\n" : "**From Sunchaser's documentation:**\n")
        + r.results.slice(0, 2).map((d: R) => `- **${d.title}**: ${d.text}`).join("\n"));
    }
  }

  // when to land: the Window Finder
  if (/\b(best|find|good)\b.*\blanding\b/.test(q) || has(q, "window", "when should", "when can", "when to", "best time", "best date", "best day", "متى", "نافذة", "نوافذ", "أفضل وقت", "أفضل موعد")) {
    const r = await call("find_windows", { site_id: sites[0]?.id, days: stay, limit: 3,
      min_sunlight_pct: pct(/(\d{1,3})\s*%\s*(?:of\s*)?(?:sun|ضوء)/), min_link_pct: pct(/(\d{1,3})\s*%\s*(?:of\s*)?(?:link|comm|اتصال)/),
      ...(year ? { from_date: `${Math.max(year, 2026)}-${year === 2026 ? "11" : "01"}-01`, to_date: `${year}-12-31` } : {}) });
    if (r.error) return done(r.error);
    await call("show", { view: "windows", label: ar ? "افتح مكتشف النوافذ" : "Open the Window Finder" });
    if (!r.windows.length) return done(ar ? `**لا توجد نافذة تحقق كل المتطلبات** (${r.searched}).` + (r.smallest_single_relaxations?.length ? " أصغر تخفيف واحد:\n" + r.smallest_single_relaxations.map((x: R) => `- ${x.requirement}: ${x.from} ← ${x.to}`).join("\n") : "")
      : `**No landing meets every requirement** (${r.searched}).` + (r.smallest_single_relaxations?.length ? " The smallest single change that opens one:\n" + r.smallest_single_relaxations.map((x: R) => `- ${x.requirement}: ${x.from} → ${x.to} (${x.opens_windows} landing hours)`).join("\n") : ""));
    const w = r.windows[0];
    return done((ar ? `**أفضل هبوط: ${w.site}، ${w.landing_utc.replace("T", " ")} UTC** — ضوء الشمس ${w.sunlight_pct}٪، الاتصال بالأرض ${w.link_pct}٪، أطول انقطاع ${hrs(w.longest_blackout_h, ar)}.\n`
      : `**Best landing: ${w.site}, ${w.landing_utc.replace("T", " ")} UTC** — sunlight ${w.sunlight_pct} %, link to Earth ${w.link_pct} %, longest blackout ${hrs(w.longest_blackout_h, ar)}.\n`)
      + r.windows.slice(1).map((x: R) => `- ${x.site}, ${x.landing_utc.replace("T", " ")}: ${x.sunlight_pct} % / ${x.link_pct} %`).join("\n")
      + (ar ? `\n${r.passing_landing_hours} ساعة هبوط تحقق المتطلبات.` : `\n${r.passing_landing_hours} landing hours meet the requirements.`));
  }

  // two landings: what changed
  if ((sites.length >= 2 || (sites.length === 1 && here && sites[0].id !== here.id)) && has(q, "vs", "versus", "differ", "change", "compare", " or ", "مقابل", "الفرق", "قارن", "أم ")) {
    const A = sites.length >= 2 ? sites[0] : here!, B = sites.length >= 2 ? sites[1] : sites[0], t = date ?? `${start}T12:00`;
    const r = await call("explain_change", { a: { site_id: A.id, landing_utc: t, days: stay }, b: { site_id: B.id, landing_utc: t, days: stay } });
    if (r.error) return done(r.error);
    await call("show", { view: "scenarios", label: ar ? "قارنهما على لوحة السيناريوهات" : "Compare on the scenario board",
      scenarios: [{ site_id: A.id, landing_utc: t, days: stay }, { site_id: B.id, landing_utc: t, days: stay }] });
    return done(`**${r.a.site}: ${r.a.verdict} · ${r.b.site}: ${r.b.verdict}** (${t.replace("T", " ")} UTC)\n`
      + `- ${ar ? "ضوء الشمس" : "Sunlight"}: ${r.a.sunlight_pct} % → ${r.b.sunlight_pct} %\n- ${ar ? "الاتصال بالأرض" : "Link to Earth"}: ${r.a.link_pct} % → ${r.b.link_pct} %\n`
      + r.what_changed.map((l: string) => `- ${l}`).join("\n"));
  }

  // which site is best: rank them
  if (sites.length === 0 && has(q, "best", "compare", "rank", "which site", "most sun", "brightest", "أفضل", "قارن", "ترتيب", "أي موقع")) {
    const by = has(q, "link", "earth", "comm", "اتصال", "الأرض") ? "link" : has(q, "energy", "power", "طاقة") ? "energy" : "sunlight";
    const d0 = date?.slice(0, 10) ?? start, r = await call("compare_sites", { start_date: d0, days: stay ?? 14, sort_by: by });
    if (r.error) return done(r.error);
    await call("show", { view: "compare", label: ar ? "افتح المقارنة" : "Open Compare" });
    const top = r.rows.slice(0, 3);
    return done((ar ? `**الأفضل في ${by === "link" ? "الاتصال بالأرض" : by === "energy" ? "الطاقة" : "ضوء الشمس"}: ${top[0].name}** (${r.period}).\n`
      : `**Best for ${by === "link" ? "the link to Earth" : by}: ${top[0].name}** (${r.period}).\n`)
      + top.map((x: R) => `- ${x.rank}. ${x.name}: ${ar ? "شمس" : "sunlight"} ${x.sunlight_pct} %, ${ar ? "اتصال" : "link"} ${x.link_pct} %, ${ar ? "أطول ظلام" : "longest darkness"} ${hrs(x.longest_darkness_h, ar)}`).join("\n"));
  }

  // "take me to Apollo 11": fly there (atlas sites on the globe, south-pole sites into 3D)
  const s = sites[0] ?? here;
  if (sites[0] && has(q, "take me", "show me", "fly", "go to", "open", "خذني", "اعرض", "اذهب", "افتح")) {
    const atlas = s!.kind === "atlas" || has(q, "globe", "الكرة");
    await call("show", { view: atlas ? "globe" : "explore", label: ar ? "اذهب إلى هناك" : atlas ? "Fly there" : "See it in 3D", site_id: s!.id, go_now: true });
    return done(ar ? `**جارٍ الانتقال إلى ${s!.name}** (${s!.lat_deg.toFixed(2)}°، ${s!.lon_deg.toFixed(2)}°).` : `**Taking you to ${s!.name}** (${s!.lat_deg.toFixed(2)}°, ${s!.lon_deg.toFixed(2)}°).`);
  }

  // the sky right now (or at a time)
  if (s && (/\bnow\b/.test(q) || has(q, "sky", "where is the sun", "where is earth", "elevation", "الآن", "السماء", "أين الشمس", "أين الأرض"))) {
    const r = await call("sky_at", { site_id: s.id, time_utc: date ?? undefined });
    if (r.error) return done(r.error);
    await call("show", { view: "explore", label: ar ? "شاهده ثلاثي الأبعاد" : "See it in 3D", site_id: s.id, landing_utc: r.time_utc });
    return done(ar ? `**${r.site}، ${r.time_utc.replace("T", " ")} UTC:** الشمس على ارتفاع ${r.sun.elevation_deg}° نحو ${r.sun.direction} (الأفق ${r.sun.terrain_horizon_deg}°، المرئي ${r.sun.visible_pct}٪). الأرض على ${r.earth.elevation_deg}°، المرئي ${r.earth.visible_pct}٪. الاتصال: ${r.link_to_earth ? "متاح" : "غير متاح"}.`
      : `**${r.site}, ${r.time_utc.replace("T", " ")} UTC:** the Sun is ${r.sun.elevation_deg}° up toward the ${r.sun.direction} (terrain ${r.sun.terrain_horizon_deg}° there, ${r.sun.visible_pct} % of the disc visible). Earth is at ${r.earth.elevation_deg}°, ${r.earth.visible_pct} % visible. Link to Earth: ${r.link_to_earth ? `up (${r.dsn_dishes_seeing_moon.join(", ")})` : "down"}.`);
  }

  // a named site: check a landing there
  if (s) {
    const t = date ?? `${start}T12:00`, r = await call("check_landing", { site_id: s.id, landing_utc: t, days: stay });
    if (r.error) return done(r.error);
    await call("show", { view: s.kind === "atlas" ? "globe" : "explore", label: ar ? "شاهده" : s.kind === "atlas" ? "Fly there" : "See it in 3D", site_id: s.id, landing_utc: r.landing_utc, days: r.stay_days });
    return done((ar ? `**${r.site}، هبوط ${r.landing_utc.replace("T", " ")} UTC لمدة ${r.stay_days} يومًا: ${r.verdict}**${r.failed.length ? ` (يفشل في: ${r.failed.join("، ")})` : ""}\n`
      : `**${r.site}, landing ${r.landing_utc.replace("T", " ")} UTC for ${r.stay_days} days: ${r.verdict}**${r.failed.length ? ` (fails: ${r.failed.join(", ")})` : ""}\n`)
      + `- ${ar ? "ضوء الشمس" : "Sunlight"} ${f1(r.sunlight_pct)} %, ${ar ? "أطول ظلام" : "longest darkness"} ${hrs(r.longest_darkness_h, ar)}\n`
      + `- ${ar ? "الاتصال بالأرض" : "Link to Earth"} ${f1(r.link_pct)} %, ${ar ? "أطول انقطاع" : "longest blackout"} ${hrs(r.longest_blackout_h, ar)}\n`
      + (ar ? "" : `- ${r.lunar_day.startsWith("lands") ? "It " + r.lunar_day : r.lunar_day[0].toUpperCase() + r.lunar_day.slice(1)}.`));
  }

  // a view by name
  const VIEW_WORDS: [string[], Action["view"], string, string][] = [
    [["stories", "apollo", "قصص"], "stories", "Open Mission stories", "افتح قصص المهمات"], [["learn", "teach", "explain", "تعلم", "اشرح"], "learn", "Open Learn", "افتح صفحة التعلم"],
    [["scenario", "brief", "سيناريو"], "scenarios", "Open the scenario board", "افتح لوحة السيناريوهات"], [["slip", "delay", "late", "تأخير"], "replan", "Open Replan", "افتح إعادة التخطيط"],
  ];
  for (const [w, view, en, arL] of VIEW_WORDS) if (has(q, ...w)) {
    await call("show", { view, label: ar ? arL : en, go_now: has(q, "show", "open", "take me", "go to", "اعرض", "افتح", "خذني") });
    return done(ar ? "**هذا القسم يجيب عن ذلك.** اضغط الزر أدناه." : "**That part of Sunchaser covers it.** Use the button below.");
  }

  results.push("-89.45, 222.7"); // the coordinate example below
  return done(ar
    ? "**الوضع دون اتصال يفهم أسئلة محددة.** جرّب:\n- ما أفضل موقع في مارس 2027؟\n- متى أهبط في Shackleton Rim؟\n- Apollo 15 في 2027-03-15\n- أين الشمس الآن في Connecting Ridge؟\n- ما مدى دقة Sunchaser؟\n- -89.45, 222.7"
    : "**Offline mode understands specific questions.** Try:\n- Which site is best in March 2027?\n- When should I land at Shackleton Rim?\n- Apollo 15 on 2027-03-15\n- Where is the Sun now at Connecting Ridge?\n- How accurate is Sunchaser?\n- -89.45, 222.7");
}
