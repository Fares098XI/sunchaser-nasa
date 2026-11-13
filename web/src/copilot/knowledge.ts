/**
 * What the copilot may say about how Sunchaser works: short method notes (docs/METHODS.md, in brief) plus the app's own
 * validation record and limitations (data/validation.ts). search_knowledge ranks these by shared words.
 */
import { CHECKS, LIMITATIONS } from "../data/validation";

export interface Doc { id: string; title: string; text: string }

const METHOD: Doc[] = [
  { id: "M-sun", title: "Sun and Earth positions", text: "NASA/JPL SPICE ephemerides (DE440 with the DE421 mean-Earth Moon frame used by LOLA maps), light time and aberration included. Checked against JPL Horizons: V1, V1c (max error 0.0000015 degrees)." },
  { id: "M-horizon", title: "Terrain horizon", text: "For each site, the highest terrain elevation angle in every direction (1,440 directions, every 0.25 degrees), computed by an exact ray walk over nested NASA LOLA elevation maps: 5 m and 20 m near the site, 80 m and 240 m out to 300 km, on a true sphere. Checked: V4, V4c." },
  { id: "M-sunlight", title: "Sunlight percent", text: "Sunlight % is the average visible share of the solar disc above the terrain horizon over the stay, every 10 minutes (the same quantity as NASA Goddard's 'average illumination', Barker et al. 2021). Longest darkness is the longest run with no part of the Sun visible. Checked against NASA Goddard: V2 (88.53 % vs their 85.1-94.1 % range at Connecting Ridge)." },
  { id: "M-link", title: "Link to Earth (direct-to-Earth)", text: "A link counts when Earth's centre is above the terrain horizon and at least one Deep Space Network 70 m dish (Goldstone, Canberra, Madrid) sees the Moon at least 6 degrees above its horizon. Geometric only: no scheduling or link budget. Longest blackout is the longest run without a link. Checked: V1b." },
  { id: "M-energy", title: "Solar energy and battery", text: "Energy uses 1361 W/m2 at 1 au scaled by the true Sun distance and the visible disc share, on a Sun-tracking panel. The battery starts full, gains panel area x efficiency x energy and loses the load every 10 minutes; hours short count when the load cannot be met. Panel, efficiency, load and battery size are the user's inputs (example 2 m2, 30 %, 150 W, 3000 Wh)." },
  { id: "M-windows", title: "Window Finder", text: "Every landing hour from November 2026 to December 2028 whose whole stay fits is checked against the requirements (sunlight, longest darkness, link, longest blackout, battery). Minimal relaxation: the smallest single change of one requirement that opens at least one window. Robustness: the same landing at 19 points within 250 m (IM-2's miss distance)." },
  { id: "M-sites", title: "Landing sites", text: "Ten south-pole sites chosen by a written rule from NASA Goddard regions, illumination maps and LROC, with 5-20 m terrain; an atlas of Apollo, commercial CLPS and other nations' sites with 474 m and 1.9 km terrain; and the user's own pin anywhere on the Moon." },
  { id: "M-pin", title: "Drop a pin anywhere", text: "A pin's horizon is computed in the browser from NASA's global LOLA terrain (474 m near the point, 1.9 km to 300 km); its Sun and Earth tables are derived from a reference site. Checked against the Python pipeline: V11. Its 3D view casts shadows on the graphics card, checked against the processor: V12." },
  { id: "M-python", title: "Browser equals Python", text: "The browser engine reproduces the Python pipeline on golden files to better than 1e-6: V5, V5c, V5d." },
  { id: "M-scenario", title: "Scenario board and what changed", text: "Up to four landings on one mission clock. When both the site and the date change, the change in sunlight and link is split exactly into a date part and a site part (the average of the two orders, a Shapley split)." },
  { id: "M-pole", title: "Why the south pole", text: "Near the pole the Sun circles the horizon at a few degrees elevation, so high ridges can stay lit for weeks and craters stay permanently dark (water ice). Away from the poles every place has about 14.8 days of night every 29.5 days. Earth stays low in the sky and rocks with libration by about 7 degrees, so terrain can hide it." },
  { id: "M-ai", title: "This assistant", text: "Ask Sunchaser runs on free AI models (Google Gemini, then Groq) and an offline mode. It does not compute numbers itself: every number comes from Sunchaser's own engine through tools. It can still misread a question; check important answers in the views it opens." },
];

export const DOCS: Doc[] = [
  ...METHOD,
  ...CHECKS.map((c) => ({ id: c.id, title: `${c.id} ${c.title} (${c.status})`, text: `Reference: ${c.reference}. Pass criterion: ${c.criterion}. Result: ${c.result}.${c.note ? " " + c.note : ""}` })),
  ...LIMITATIONS.map((l) => ({ id: `limit-${l.id}`, title: `Limitation: ${l.short}`, text: l.text })),
];

// Arabic and common words mapped to the English vocabulary of the corpus
const ALIAS: Record<string, string> = {
  دقة: "accuracy validated checked", دقيق: "accuracy validated", تحقق: "validated checked", بيانات: "data maps", تضاريس: "terrain horizon",
  شمس: "sun sunlight", الشمس: "sun sunlight", ضوء: "sunlight", الأرض: "earth link", اتصال: "link earth", بطارية: "battery energy",
  طاقة: "energy", حدود: "limitation", قيود: "limitation", صخور: "boulders terrain", القطب: "pole", نافذة: "window", نوافذ: "windows",
  دبوس: "pin", ذكاء: "assistant ai", accurate: "accuracy validated", trust: "validated limitation", reliable: "validated",
  comms: "link", communication: "link", radio: "link", dsn: "link", power: "energy battery", shadow: "darkness horizon terrain",
  shadows: "darkness horizon terrain", dem: "terrain maps", lola: "terrain maps", spice: "sun earth positions", ai: "assistant",
};
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)
  .flatMap((w) => [w, ...(ALIAS[w]?.split(" ") ?? [])]);
const STOP = new Set(["the", "is", "how", "what", "why", "does", "do", "of", "and", "to", "in", "a", "it", "its", "for", "on", "are", "you", "your", "this", "with", "can", "about"]);

/** The best few documents for a query: shared words, title words count double, an exact check id (V2) wins. */
export function searchKnowledge(query: string, k = 4): Doc[] {
  const q = words(query).filter((w) => !STOP.has(w));
  const id = query.match(/\bV\d+[a-d]?\b/i)?.[0].toUpperCase();
  return DOCS.map((d) => {
    const t = new Set(words(d.title)), b = new Set(words(d.text));
    const s = q.reduce((n, w) => n + (t.has(w) ? 2 : 0) + (b.has(w) ? 1 : 0), 0) + (id && d.id.toUpperCase() === id ? 50 : 0);
    return { d, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.d);
}
