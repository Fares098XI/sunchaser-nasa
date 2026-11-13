/**
 * Interactive figures of the Learn page. The tilt explorer is textbook spherical astronomy; the disc explorer uses the
 * engine's own visible-disc formula; the horizon and site figures read the real site data through the same worker as
 * Compare (docs/METHODS.md §16).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { sitesClient } from "../data/sitesClient";
import { R_MOON_M } from "../engine/frames";
import { SUN_RADIUS_DEG, visibleDiscFraction } from "../engine/sky";
import { EXAMPLE_POWER, TSI_W_M2, type Metrics } from "../engine/windows";
import { EarthIcon, PauseIcon, PlayIcon, SunIcon } from "../ui/icons";
import { SkyPanorama } from "./SkyPanorama";

const rad = Math.PI / 180;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- 1. Why the Sun skims the horizon ---------- */

const MOON_TILT = 1.54, EARTH_TILT = 23.44; // axis to the ecliptic: IAU WGCCRE lunar pole / IERS obliquity (METHODS §16)
const RIDGE_H_KM = 0.3, RIDGE_D_KM = 10;
/** elevation of a ridge top seen over the curved Moon */
const RIDGE_DEG = Math.atan((RIDGE_H_KM - RIDGE_D_KM ** 2 / (2 * R_MOON_M / 1000)) / RIDGE_D_KM) / rad;

/** Sun elevation (deg) at latitude `lat` (deg toward the summer pole), declination `dec`, hour angle `h` (deg). */
export const sunElevation = (lat: number, dec: number, h: number) =>
  Math.asin(Math.sin(lat * rad) * Math.sin(dec * rad) + Math.cos(lat * rad) * Math.cos(dec * rad) * Math.cos(h * rad)) / rad;

export function TiltExplorer() {
  const [tilt, setTilt] = useState(MOON_TILT);
  const [lat, setLat] = useState(89.45); // Connecting Ridge
  const [season, setSeason] = useState(0.25); // fraction of a year; 0.25 = southern midsummer
  const [h, setH] = useState(150);
  const [playing, setPlaying] = useState(!reduced());

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => { setH((v) => (v + (now - last) * 0.04) % 360); last = now; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const dec = tilt * Math.sin(2 * Math.PI * season);
  const curve = useMemo(() => Array.from({ length: 181 }, (_, i) => sunElevation(lat, dec, i * 2)), [lat, dec]);
  const hi = Math.max(...curve), lo = Math.min(...curve);
  const lit = curve.filter((e) => e > RIDGE_DEG).length / curve.length;
  const now = sunElevation(lat, dec, h);

  const W = 640, H = 230, top = Math.max(hi, RIDGE_DEG, 0) + 1, bot = Math.min(lo, 0) - 1;
  const X = (hd: number) => (hd / 360) * W, Y = (e: number) => 12 + ((top - e) / (top - bot)) * (H - 40);
  const step = top - bot > 40 ? 10 : top - bot > 12 ? 5 : top - bot > 5 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let e = Math.ceil(bot / step) * step; e <= top; e += step) ticks.push(+e.toFixed(2));
  const path = curve.map((e, i) => `${i ? "L" : "M"}${X(i * 2).toFixed(1)},${Y(e).toFixed(1)}`).join("");
  const litPath = curve.map((e, i) => `${i && curve[i - 1] > RIDGE_DEG && e > RIDGE_DEG ? "L" : "M"}${X(i * 2).toFixed(1)},${Y(e).toFixed(1)}`).join("");

  return (
    <figure className="fig">
      <div className="fig-controls">
        <div className="seg" role="group" aria-label="Axis tilt">
          <button className={tilt === MOON_TILT ? "on" : ""} onClick={() => setTilt(MOON_TILT)}>Moon's real tilt {MOON_TILT}°</button>
          <button className={tilt === EARTH_TILT ? "on" : ""} onClick={() => setTilt(EARTH_TILT)}>Earth-like tilt {EARTH_TILT}°</button>
        </div>
        <label>Latitude <input type="range" min={0} max={90} step={0.05} value={lat} onChange={(e) => setLat(+e.target.value)} />
          <span className="num">{lat.toFixed(2)}° S</span></label>
        <label>Season <input type="range" min={0} max={1} step={0.005} value={season} onChange={(e) => setSeason(+e.target.value)} />
          <span className="num">{dec >= 0 ? "summer" : "winter"} {Math.abs(dec).toFixed(2)}°</span></label>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="fig-svg" role="img"
        aria-label={`Sun height over one turn of the Moon: between ${lo.toFixed(1)} and ${hi.toFixed(1)} degrees; above the ridge ${Math.round(lit * 100)} percent of the time`}>
        <defs>
          <linearGradient id="lf-sky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#04060b" /><stop offset="1" stopColor="#0d1526" /></linearGradient>
          <radialGradient id="lf-glow"><stop offset="0" stopColor="rgba(255,230,170,0.7)" /><stop offset="1" stopColor="rgba(255,170,60,0)" /></radialGradient>
        </defs>
        <rect width={W} height={H - 28} fill="url(#lf-sky)" rx={8} />
        <rect x={0} y={Y(RIDGE_DEG)} width={W} height={Math.max(0, H - 28 - Y(RIDGE_DEG))} className="lf-ridge" />
        {ticks.map((e) => <g key={e}>
          <line x1={0} x2={W} y1={Y(e)} y2={Y(e)} className={e === 0 ? "lf-zero" : "lf-grid"} />
          <text x={6} y={Y(e) - 3} className="lf-tick">{e === 0 ? "0° flat horizon" : `${e}°`}</text>
        </g>)}
        <text x={W - 6} y={Y(RIDGE_DEG) + 14} textAnchor="end" className="lf-tick">a 300 m ridge 10 km away · {RIDGE_DEG.toFixed(2)}°</text>
        <path d={path} className="lf-path" />
        <path d={litPath} className="lf-lit" />
        <circle cx={X(h)} cy={Y(now)} r={26} fill="url(#lf-glow)" />
        <circle cx={X(h)} cy={Y(now)} r={6} className={now > RIDGE_DEG ? "lf-sun" : "lf-sun hidden"} />
        <text x={0} y={H - 8} className="lf-tick">one turn of the Moon (29.5 Earth days) →</text>
      </svg>
      <div className="fig-read">
        <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
        </button>
        <span><SunIcon size={13} /> now <b className="num">{now.toFixed(2)}°</b></span>
        <span>highest <b className="num">{hi.toFixed(2)}°</b></span>
        <span>lowest <b className="num">{lo.toFixed(2)}°</b></span>
        <span className={lit > 0.5 ? "ok" : lit > 0 ? "warn" : "bad"}>above the ridge <b className="num">{Math.round(lit * 100)} %</b> of the time</span>
      </div>
      <figcaption>Try the Earth-like tilt: the Sun climbs far above any ridge. With the Moon's real tilt it never rises more
        than about {(MOON_TILT + (90 - lat)).toFixed(1)}° here, so a modest ridge decides between day and night. Move the latitude toward the
        equator to see why the poles are special.</figcaption>
    </figure>
  );
}

/* ---------- 2. Part of the Sun ---------- */

export function DiscExplorer() {
  const r = SUN_RADIUS_DEG;
  const [off, setOff] = useState(0.08); // disc centre above the ridge, deg
  const f = visibleDiscFraction(off, 0, r);
  const k = 56 / r, cx = 120, y0 = 132, cy = y0 - off * k;
  const svg = useRef<SVGSVGElement>(null);
  const drag = (e: React.PointerEvent) => {
    if (!(e.buttons & 1) || !svg.current) return;
    const b = svg.current.getBoundingClientRect(), y = ((e.clientY - b.top) / b.height) * 230;
    setOff(Math.max(-0.42, Math.min(0.42, (y0 - y) / k)));
  };
  // the fraction as a function of the disc centre's height: the soft step a penumbra makes
  const curve = Array.from({ length: 85 }, (_, i) => { const o = -0.42 + i * 0.01; return `${i ? "L" : "M"}${300 + i * 3.6},${200 - visibleDiscFraction(o, 0, r) * 150}`; }).join("");
  return (
    <figure className="fig">
      <svg ref={svg} viewBox="0 0 640 230" className="fig-svg drag" role="img" onPointerDown={(e) => { svg.current?.setPointerCapture(e.pointerId); drag(e); }} onPointerMove={drag}
        aria-label={`The Sun's disc against a ridge: ${Math.round(f * 100)} percent visible`}>
        <defs>
          <clipPath id="lf-above"><rect x={0} y={0} width={260} height={y0} /></clipPath>
          <radialGradient id="lf-disc"><stop offset="0" stopColor="#fffaf0" /><stop offset="0.75" stopColor="#ffe9b8" /><stop offset="1" stopColor="#ffbe5c" /></radialGradient>
        </defs>
        <rect width={260} height={230} rx={8} fill="#05080f" />
        <circle cx={cx} cy={cy} r={r * k} className="lf-disc-hidden" />
        <circle cx={cx} cy={cy} r={r * k} fill="url(#lf-disc)" clipPath="url(#lf-above)" />
        <rect x={0} y={y0} width={260} height={230 - y0} className="lf-ground" />
        <line x1={0} x2={260} y1={y0} y2={y0} className="lf-skyline" />
        <text x={10} y={222} className="lf-tick">drag the Sun up and down</text>
        <text x={300} y={30} className="lf-big">{(f * 100).toFixed(0)} %</text>
        <text x={300} y={48} className="lf-tick">of the disc visible</text>
        <text x={300} y={63} className="lf-tick">{Math.round(TSI_W_M2 * f)} W/m² on a Sun-facing panel at 1 au</text>
        <path d={curve} className="lf-path solid" />
        <line x1={300} x2={606} y1={200} y2={200} className="lf-grid" />
        <circle cx={300 + (off + 0.42) * 360} cy={200 - f * 150} r={5} className="lf-sun" />
        <text x={300} y={218} className="lf-tick">hidden</text>
        <text x={606} y={218} textAnchor="end" className="lf-tick">clear of the ridge</text>
      </svg>
      <div className="fig-read">
        <label className="grow">Sun centre vs ridge <input type="range" min={-0.42} max={0.42} step={0.005} value={off} onChange={(e) => setOff(+e.target.value)} />
          <span className="num">{off >= 0 ? "+" : ""}{off.toFixed(3)}°</span></label>
      </div>
      <figcaption>The Sun is {(2 * r).toFixed(2)}° wide. Sunchaser uses exactly this formula, the same one that shades the 3D
        terrain: power fades over about half a degree instead of switching off, and that fade is the penumbra.</figcaption>
    </figure>
  );
}

/* ---------- shared: the catalog sites over one month ---------- */

const START = "2027-01-01T00:00:00Z", DAYS = 30;

function useSites() {
  const client = sitesClient();
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { client.ready.then(() => setReady(true), (e) => setErr(String(e))); }, []);
  if (!ready) return { err, client, sites: [], a: 0, b: 0, z: 0 };
  const a = client.stepAt(START), b = Math.min(client.manifest.n, a + Math.round((DAYS * 86400) / client.manifest.step_s));
  const z = Math.max(0, client.manifest.z_m.indexOf(2));
  return { err, client, sites: client.manifest.sites, a, b, z };
}

function SitePicker({ sites, value, onChange }: { sites: { id: string; name: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="site-pick">Site
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

/* ---------- 3. A real horizon ---------- */

export function RealHorizon() {
  const { err, sites, a, b, z } = useSites();
  const [id, setId] = useState("connecting-ridge");
  const site = sites.find((s) => s.id === id) ?? sites[0];
  if (err) return <p className="fig-err">Site data could not load: {err}</p>;
  if (!site) return <div className="fig loading-line">Loading the real site horizons…</div>;
  return (
    <figure className="fig">
      <div className="fig-controls"><SitePicker sites={sites} value={site.id} onChange={setId} />
        <span className="dim">1–30 Jan 2027 · press play, or drag the time</span></div>
      <SkyPanorama siteId={site.id} siteName={site.name} z={z} a={a} b={b} />
      <figcaption>Real data, not a sketch. Switch to Haworth or Nobile Rim 2 and watch how much more of the month the
        terrain hides the Sun than at a crest like Connecting Ridge.</figcaption>
    </figure>
  );
}

/* ---------- 4. Direct-to-Earth: both conditions at once ---------- */

export function DteRule() {
  const [earth, setEarth] = useState(true);
  const [dish, setDish] = useState(false);
  const ok = earth && dish;
  return (
    <figure className="fig">
      <div className="dte" role="group" aria-label="Direct-to-Earth rule">
        <button className={`dte-c ${earth ? "on" : ""}`} aria-pressed={earth} onClick={() => setEarth((v) => !v)}>
          <EarthIcon size={16} /> Earth above the terrain horizon
        </button>
        <span className="dte-op">and</span>
        <button className={`dte-c ${dish ? "on" : ""}`} aria-pressed={dish} onClick={() => setDish((v) => !v)}>
          <span className="dte-tag">DSN</span> a 70 m dish sees the Moon ≥ 6°
        </button>
        <span className="dte-op">=</span>
        <span className={`dte-r ${ok ? "ok" : "bad"}`} role="status">{ok ? "Link to Earth" : "No direct link"}</span>
      </div>
      <figcaption>Tap the conditions. Earth must clear the local terrain, and one of the three 70 m Deep Space Network dishes
        (Goldstone, Canberra, Madrid) must see the Moon at least 6° above its own horizon. The horizon view above shows both
        live: the Earth disc and the list of DSN dishes in view.</figcaption>
    </figure>
  );
}

/* ---------- 5. NASA's four site criteria, for any of the 10 south-pole sites ---------- */

const SlopeIcon = () => <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden><path d="M1 14h14L15 4z" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" /></svg>;
const ShadowIcon = () => <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden><path d="M1 9q7 7 14 0" fill="var(--psr)" stroke="currentColor" strokeWidth={1.5} /><path d="M1 9h14" stroke="currentColor" strokeWidth={1.5} /></svg>;
const fmtH = (h: number) => (h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);

export function SiteCriteria({ onCompare }: { onCompare: () => void }) {
  const { err, client, sites: all, a, b, z } = useSites();
  const sites = all.filter((s) => s.kind !== "atlas"); // the slope and permanent-shadow criteria need the polar terrain
  const [rows, setRows] = useState<Record<string, Metrics> | null>(null);
  const [id, setId] = useState("connecting-ridge");
  useEffect(() => {
    if (!sites.length) return;
    client.call({ type: "compare", z, a, b, power: EXAMPLE_POWER })
      .then((r) => setRows(Object.fromEntries(r.rows.map((x: { id: string; m: Metrics }) => [x.id, x.m]))), () => setRows({}));
  }, [sites.length]);
  if (err) return <p className="fig-err">Site data could not load: {err}</p>;
  const site = sites.find((s) => s.id === id) ?? sites[0];
  if (!site || !rows) return <div className="fig loading-line">Computing all 10 sites…</div>;

  type Crit = { key: string; icon: React.ReactNode; title: string; val: (s: typeof site) => number | null; fmt: (v: number) => string;
    sub: (s: typeof site) => string; better: "high" | "low" };
  const crits: Crit[] = [
    { key: "sun", icon: <SunIcon size={14} />, title: "Sunlight", val: (s) => rows[s.id]?.sunPct ?? null, fmt: (v) => `${v.toFixed(1)} %`,
      sub: (s) => `longest darkness ${fmtH(rows[s.id]?.darkH ?? 0)}`, better: "high" },
    { key: "dte", icon: <EarthIcon size={14} />, title: "Link to Earth", val: (s) => rows[s.id]?.dtePct ?? null, fmt: (v) => `${v.toFixed(1)} %`,
      sub: (s) => `longest blackout ${fmtH(rows[s.id]?.blackoutH ?? 0)}`, better: "high" },
    { key: "slope", icon: <SlopeIcon />, title: "Landing slope", val: (s) => s.terrain?.slope.p95_deg ?? null, fmt: (v) => `${v.toFixed(1)}°`,
      sub: (s) => `steepest 5 % of the 100 m circle${(s.terrain?.slope.p95_deg ?? 99) < 10 ? " · safe for a 10° lander" : " · too steep for a 10° lander"}`, better: "low" },
    { key: "psr", icon: <ShadowIcon />, title: "Nearest permanent shadow", val: (s) => s.terrain?.psr_km ?? null, fmt: (v) => `${v.toFixed(1)} km`,
      sub: () => "where water ice may be", better: "low" },
  ];

  return (
    <figure className="fig">
      <div className="fig-controls"><SitePicker sites={sites} value={site.id} onChange={setId} />
        <span className="dim">1–30 Jan 2027 · 2 m above ground · real horizons and NASA terrain</span></div>
      <div className="crit">
        {crits.map((c) => {
          const all = sites.map((s) => c.val(s)).filter((v): v is number => v != null);
          const v = c.val(site), lo = Math.min(...all), hi = Math.max(...all);
          const pos = (x: number) => `${((x - lo) / (hi - lo || 1)) * 100}%`;
          return (
            <div key={c.key} className="crit-card">
              <div className="crit-head">{c.icon} {c.title}</div>
              <div className="crit-val num">{v == null ? "—" : c.fmt(v)}</div>
              <div className="crit-sub">{c.sub(site)}</div>
              <div className="crit-range" aria-label={`${c.title} across the 10 sites, ${c.better === "high" ? "higher" : "lower"} is better`}>
                {all.map((x, i) => <i key={i} style={{ left: pos(x) }} />)}
                {v != null && <b style={{ left: pos(v) }} />}
              </div>
              <div className="crit-ends num"><span>{c.fmt(lo)}</span><span>{c.better === "high" ? "higher is better" : "lower is better"}</span><span>{c.fmt(hi)}</span></div>
            </div>
          );
        })}
      </div>
      <figcaption>Each strip shows all 10 sites; the bright mark is the one you picked. No site wins everything: that is why
        Sunchaser shows each requirement on its own instead of one blended score.{" "}
        <button className="link inline-link" onClick={onCompare}>Open the full comparison →</button></figcaption>
    </figure>
  );
}

/* ---------- check yourself ---------- */

const QUIZ: { q: string; options: string[]; answer: number; why: string }[] = [
  { q: "Why does the Sun stay so low at the lunar south pole?", answer: 1,
    options: ["The Moon is too far from the Sun", "The Moon's spin axis is tilted only about 1.5°", "The pole always faces away from the Sun"],
    why: "With almost no tilt, the Sun circles the polar sky within about 1.5° of the horizon all year." },
  { q: "What is a terrain horizon?", answer: 0,
    options: ["The highest angle of the terrain in each direction", "The line where the Moon's surface meets space in photos", "The edge of the 3D map"],
    why: "For every direction, Sunchaser finds how high the terrain rises; the Sun must be above it to light the spot." },
  { q: "A ridge hides the lower half of the Sun's disc. How much solar power is left?", answer: 2,
    options: ["None", "All of it", "About half"],
    why: "Power follows the visible fraction of the disc, so it fades smoothly instead of switching off." },
  { q: "A lander can talk directly to Earth when…", answer: 1,
    options: ["Earth is above the flat horizon", "Earth is above the terrain AND a DSN 70 m dish sees the Moon ≥ 6°", "Any radio dish on Earth is pointed at it"],
    why: "Both conditions must hold at the same time; Sunchaser checks them every 10 minutes." },
  { q: "Why land near permanently shadowed regions?", answer: 0,
    options: ["They may hold water ice", "Electronics run cooler there", "Radio works better in shadow"],
    why: "Ice can become water, air and fuel, and it holds a record of the Solar System's history." },
  { q: "How do we know Sunchaser's numbers are right?", answer: 2,
    options: ["The software is new", "An AI predicted them", "They match JPL Horizons and NASA Goddard, with pass rules written before each check"],
    why: "Every check is listed on the Validation page, including the one that failed." },
];

export function Quiz() {
  const [picks, setPicks] = useState<(number | null)[]>(QUIZ.map(() => null));
  const done = picks.every((p) => p != null), score = picks.filter((p, i) => p === QUIZ[i].answer).length;
  return (
    <div className="quiz">
      {QUIZ.map((q, i) => {
        const p = picks[i];
        return (
          <fieldset key={i} className="quiz-q">
            <legend><span className="num">{i + 1}</span> {q.q}</legend>
            <div className="quiz-opts">
              {q.options.map((o, j) => (
                <button key={j} disabled={p != null} onClick={() => setPicks((v) => v.map((x, k) => (k === i ? j : x)))}
                  className={p == null ? "" : j === q.answer ? "right" : j === p ? "wrong" : "dim"}>{o}</button>
              ))}
            </div>
            {p != null && <p className={`quiz-why ${p === q.answer ? "right" : "wrong"}`} role="status">{p === q.answer ? "Right. " : "Not quite. "}{q.why}</p>}
          </fieldset>
        );
      })}
      <div className="quiz-foot" role="status">
        {done ? <><b className="num">{score} / {QUIZ.length}</b> {score === QUIZ.length ? "— ready for the judges." : score >= 4 ? "— nearly there." : "— read the chapters again."}</>
          : <span className="dim">{picks.filter((p) => p != null).length} of {QUIZ.length} answered</span>}
        {done && <button className="link inline-link" onClick={() => setPicks(QUIZ.map(() => null))}>Try again</button>}
      </div>
    </div>
  );
}

/** One lunar day at any latitude (Sun on the Moon's equator plane, dec 0): how high it climbs and how long it stays. */
const LAT_PRESETS: [string, number][] = [["Apollo 11", 0.67], ["Apollo 15", 26.13], ["Chang'e 4", -45.46], ["Chandrayaan-3", -69.37], ["South pole sites", -89.45]];
export function LatitudeDay() {
  const [lat, setLat] = useState(26.13);
  const W = 640, H = 220, top = 12, bot = 30, lo = -95, hi = 95, DAY = 29.53;
  const curve = useMemo(() => Array.from({ length: 361 }, (_, i) => sunElevation(Math.abs(lat), 0, i - 180)), [lat]);
  const X = (i: number) => (i / 360) * W, Y = (e: number) => top + ((hi - e) / (hi - lo)) * (H - top - bot);
  const up = curve.filter((e) => e > 0).length / curve.length, max = Math.max(...curve);
  return (
    <figure className="fig lat-day">
      <svg viewBox={`0 0 ${W} ${H}`} className="fig-svg" role="img" aria-label={`The Sun over one lunar day at ${Math.abs(lat).toFixed(1)} degrees latitude`}>
        <rect x={0} y={Y(0)} width={W} height={H - bot - Y(0)} className="ld-ground" />
        <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} className="ld-hz" />
        {[30, 60, 90].map((e) => <g key={e}><line x1={0} x2={W} y1={Y(e)} y2={Y(e)} className="ld-grid" /><text x={4} y={Y(e) - 3} className="ld-t">{e}°</text></g>)}
        <path d={curve.map((e, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(e).toFixed(1)}`).join("")} className="ld-sun" />
        {[0, 7.4, 14.8, 22.1, 29.5].map((d) => <text key={d} x={X((d / DAY) * 360)} y={H - 10} textAnchor="middle" className="ld-t">{d === 0 ? "midnight" : d === 14.8 ? "noon" : `${d} d`}</text>)}
      </svg>
      <label className="fig-ctl">Latitude <input type="range" min={0} max={89.5} step={0.1} value={Math.abs(lat)} onChange={(e) => setLat(Number(e.target.value) * (lat < 0 ? -1 : 1))} />
        <b className="num">{Math.abs(lat).toFixed(1)}°</b></label>
      <div className="fig-presets">{LAT_PRESETS.map(([n, v]) => <button key={n} className={Math.abs(lat - v) < 0.05 ? "on" : ""} onClick={() => setLat(v)}>{n}</button>)}</div>
      <p className="fig-read">The Sun climbs to <b className="num">{max.toFixed(1)}°</b> and is up <b className="num">{(up * DAY).toFixed(1)} days</b> of the {DAY}-day lunar day
        {Math.abs(lat) > 85 ? ": it never gets far from the horizon, so any ridge can hide it, and the ±1.5° tilt of the seasons decides which spots stay lit." : "."}</p>
    </figure>
  );
}
