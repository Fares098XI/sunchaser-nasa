import { useEffect, useRef, useState } from "react";
import { CHECKS, LIMITATIONS } from "../data/validation";
import { DiscExplorer, DteRule, LatitudeDay, Quiz, RealHorizon, SiteCriteria, TiltExplorer } from "./LearnFigures";

/**
 * The science behind Sunchaser in plain words: four parts, short chapters, figures you can play with (most on the real
 * site data) and a check-yourself quiz. Every number is defined in docs/METHODS.md or checked in docs/VALIDATION.md.
 */
type Go = "explore" | "compare" | "windows" | "replan" | "scenarios" | "stories" | "lightpath" | "astronaut" | "validation" | "home";

interface Chapter { id: string; part: string; title: string; body: string; see?: [string, Go]; figure?: "tilt" | "horizon" | "disc" | "dte" | "sites" | "latitude" }

const CHAPTERS: Chapter[] = [
  { id: "why", part: "The problem", title: "Why the lunar south pole?",
    body: "Some craters near the pole have floors that never see the Sun. They are cold enough to trap water ice, which future crews could turn into water, air and rocket fuel. That is why NASA's Artemis III candidate landing regions are all here. But the light is extreme: within a few kilometres, ridges can be lit most of the time while hollows stay dark.",
    see: ["See the hero region in 3D", "explore"] },
  { id: "skims", part: "The problem", title: "The Sun skims the horizon", figure: "tilt",
    body: "The Moon's spin axis stands almost upright to the plane of Earth's orbit: it leans only about 1.5°. At the pole the Sun therefore never climbs high: it circles once around the sky every month, always within about 1.5° of the flat horizon. A ridge a few hundred metres high, kilometres away, is enough to hide it.",
    see: ["Drag the Sun across the month", "explore"] },
  { id: "horizon", part: "How Sunchaser sees it", title: "A terrain horizon for every spot", figure: "horizon",
    body: "For each spot and each compass direction, Sunchaser finds the highest angle of the terrain, walking outward over NASA's LOLA laser-altimeter elevation maps to 300 km on the curved Moon. Compare that skyline with the Sun's height in the same direction and you know, every 10 minutes, whether the spot is lit. The walk is exact: denser sampling never finds a point higher than 0.00001°.",
    see: ["Stand at a site and look around", "astronaut"] },
  { id: "disc", part: "How Sunchaser sees it", title: "Part of the Sun", figure: "disc",
    body: "The Sun is not a point but a disc about half a degree wide, and at the pole a ridge often cuts across it. Sunchaser computes the visible fraction of the disc, so power changes smoothly from 0 to 100 % instead of switching on and off." },
  { id: "earth", part: "How Sunchaser sees it", title: "Earth bobs up and down",
    body: "Seen from the Moon, Earth hangs in almost the same place, but the Moon's slight wobble (libration) makes it rise and sink by a few degrees over each month. At the pole Earth sits near the horizon, so it often drops behind the terrain: watch the blue disc in the horizon view above. While it is hidden, a lander cannot radio home directly.",
    see: ["Watch Earth in the 3D sky", "explore"] },
  { id: "dte", part: "How Sunchaser sees it", title: "Talking to Earth", figure: "dte",
    body: "Direct-to-Earth communication needs two things at once: Earth above the local terrain, and a Deep Space Network antenna on Earth that sees the Moon at least 6° above its own horizon. Sunchaser gives Earth and comms the same weight as the Sun and power everywhere.",
    see: ["Find windows with enough link time", "windows"] },
  { id: "psr", part: "How Sunchaser sees it", title: "Permanent shadow",
    body: "Permanently shadowed regions (PSRs) are where the ice may be. Sunchaser shows NASA Goddard's permanent-shadow map and, for any point, how far the nearest one is: close enough to reach, far enough to land in sunlight.",
    see: ["Turn on the permanent-shadow layer", "explore"] },
  { id: "land", part: "Deciding", title: "Choosing where to land", figure: "sites",
    body: "NASA picked the Artemis III regions on four criteria: sunlight, Earth communications, gentle slopes over a landing circle about 100 m across, and closeness to permanent shadow. Sunchaser computes all four for every site, the light and comms for any date from 2020 to 2045. Pick a site:" },
  { id: "aim", part: "Deciding", title: "Where exactly you touch down",
    body: "A lander does not come down on a pinpoint: IM-2 came to rest about 250 m from its target. At the pole, 250 m can be the difference between a lit ridge and a shadowed hollow. For every site Sunchaser checks 19 landing points out to 250 m, and in the 3D view paints the sunlight of every spot within 300 m so you can see which way an error would hurt.",
    see: ["See the landing heat map in 3D", "explore"] },
  { id: "slip", part: "Deciding", title: "When the launch slips",
    body: "Launches slip by days or weeks, and the light at a polar site follows a monthly rhythm, so a good date can turn bad overnight. Replan re-checks every site for every day around the plan, finds the next good date at the same site and the best nearby Plan B. The scenario board then puts up to four plans side by side on one mission clock and explains what changed, split between the date and the site.",
    see: ["Try a two-week slip", "replan"] },
  { id: "drive", part: "Deciding", title: "Driving through moving shadows",
    body: "Shadows sweep across the ground as the Sun circles. Light Path plans a rover drive through space, time and battery at once: hour by hour it expands the area the rover can reach while staying on drivable slopes and keeping charge, and may wait for the Sun rather than drive into the dark. A separate checker re-simulates every route.",
    see: ["Plan a traverse", "lightpath"] },
  { id: "anywhere", part: "Beyond the pole", title: "Day and night anywhere on the Moon", figure: "latitude",
    body: "Away from the pole the Sun behaves differently: it rises in the east, climbs as high as 90° minus your latitude, and sets about 14.8 Earth days later, for a night just as long. Near the pole it never climbs more than a degree or two and circles the horizon instead. Slide the latitude and watch one lunar day:" },
  { id: "pin", part: "Beyond the pole", title: "Drop a pin, anywhere",
    body: "Tap the globe (or type coordinates) and your browser computes 109,440 terrain horizons for that point with the same exact method as every catalog site, from NASA's global LOLA maps. Fly there in 3D and it builds 24 km of 59 m terrain (SLDEM2015, LOLA plus Japan's Kaguya stereo cameras) and computes every shadow on your graphics card.",
    see: ["Go to the globe and tap the Moon", "home"] },
  { id: "stories", part: "Beyond the pole", title: "Three landings that explain it",
    body: "Why every Apollo crew landed in the early morning, why IM-2's mission ended in a crater one map pixel wide, and why Chang'e 4 can never see Earth: three short stories built on the same data, each ending with you standing on the spot.",
    see: ["Read the mission stories", "stories"] },
  { id: "data", part: "Trust", title: "The data",
    body: "Terrain: NASA LRO's LOLA laser altimeter, as elevation maps from NASA Goddard's Planetary Geodesy Data Archive and the PDS (global maps, SLDEM2015 with JAXA's SELENE camera). Sun, Earth and DSN geometry: NASA/JPL SPICE, checked against JPL Horizons. Permanent shadow and average-visibility maps: NASA Goddard (Mazarico et al. 2011). Imagery: LROC, NASA SVS. This is the same data behind NASA's QuickMap, Moon Trek and JPL Horizons; Sunchaser puts it on one screen, and every site's panel opens its point in all three. Every dataset, version and checksum is listed in the repository (docs/DATA.md)." },
];

const FIG = { tilt: TiltExplorer, horizon: RealHorizon, disc: DiscExplorer, dte: DteRule, latitude: LatitudeDay } as const;

export function LearnView({ onGo }: { onGo: (m: Go) => void }) {
  const pass = CHECKS.filter((c) => c.status === "pass").length, fail = CHECKS.filter((c) => c.status === "fail").length;
  const resolved = CHECKS.filter((c) => c.status === "resolved").length;
  const sheet = useRef<HTMLElement>(null);
  const [active, setActive] = useState("why");
  const [progress, setProgress] = useState(0);
  const toc = [...CHAPTERS.map((c) => ({ id: c.id, title: c.title })), { id: "trust", title: "How we know it's right" },
    { id: "limits", title: "What it can't tell you" }, { id: "quiz", title: "Check yourself" }];

  // chapters fade in as they arrive; the index marks the last chapter whose title has reached the top third
  useEffect(() => {
    const root = sheet.current!, chapters = [...root.querySelectorAll<HTMLElement>(".chapter")];
    const seen = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && e.target.classList.add("in")), { root, threshold: 0.08 });
    chapters.forEach((el) => seen.observe(el));
    const onScroll = () => {
      setProgress(root.scrollTop / Math.max(1, root.scrollHeight - root.clientHeight));
      const line = root.getBoundingClientRect().top + root.clientHeight / 3;
      setActive((chapters.filter((el) => el.getBoundingClientRect().top <= line).pop() ?? chapters[0]).id);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { seen.disconnect(); root.removeEventListener("scroll", onScroll); };
  }, []);
  const jump = (id: string) => sheet.current?.querySelector(`#${id}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });

  let lastPart = "";
  return (
    <section ref={sheet} className="sheet glass learn" aria-label="Learn">
      <div className="learn-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden />
      <header className="learn-hero">
        <div className="eyebrow">Learn · about 10 minutes · interactive</div>
        <h2>Light and shadow on the Moon</h2>
        <p>Why a few hundred metres of ridge decide whether a lander has power and a radio link, how Sunchaser computes it,
          and how we know the numbers are right. Most figures run on the same real data as the rest of the app: play with them.</p>
        <div className="learn-stats">
          <div><b className="num">~1.5°</b><span>the Moon's axis tilt: the Sun never rises high</span></div>
          <div><b className="num">25</b><span>landing sites, from the south pole to Apollo, Chang'e and CLPS</span></div>
          <div><b className="num">{CHECKS.length}</b><span>independent checks: {pass} pass{resolved ? `, ${resolved} failed first and were explained` : ""}</span></div>
        </div>
      </header>

      <div className="learn-body">
        <nav className="learn-toc" aria-label="Chapters">
          {toc.map((t, i) => (
            <button key={t.id} className={active === t.id ? "on" : ""} aria-current={active === t.id ? "true" : undefined} onClick={() => jump(t.id)}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span>{t.title}
            </button>
          ))}
        </nav>

        <div className="learn-main">
          {CHAPTERS.map((c, i) => {
            const F = c.figure && c.figure !== "sites" ? FIG[c.figure] : null;
            const head = c.part !== lastPart ? (lastPart = c.part) : null;
            return (
              <div key={c.id}>
                {head && <div className="learn-part">{head}</div>}
                <article id={c.id} className="chapter">
                  <span className="chapter-n num">{String(i + 1).padStart(2, "0")}</span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                  {F && <F />}
                  {c.figure === "sites" && <SiteCriteria onCompare={() => onGo("compare")} />}
                  {c.see && <button className="cta ghost small" onClick={() => onGo(c.see![1])}>{c.see[0]} →</button>}
                </article>
              </div>
            );
          })}

          <article id="trust" className="chapter">
            <span className="chapter-n num">{String(CHAPTERS.length + 1).padStart(2, "0")}</span>
            <h3>How we know it's right</h3>
            <p>Each check has its pass rule written down before it runs, against JPL Horizons, NASA Goddard's published
              sunlight figures and maps, and our own exactness tests.</p>
            <div className="trust-row">
              {CHECKS.map((c) => <span key={c.id} className={`trust-dot ${c.status}`} title={`${c.id} ${c.title}: ${c.status}`}>{c.id}</span>)}
            </div>
            <p className="dim">{pass} pass{resolved ? `; ${resolved} failed and were then explained by a follow-up check, and stay listed with what we learned` : ""}{fail ? `; ${fail} fails and stays listed with what we learned from it` : ""}.</p>
            <button className="cta ghost small" onClick={() => onGo("validation")}>See every check →</button>
          </article>

          <article id="limits" className="chapter">
            <span className="chapter-n num">{String(CHAPTERS.length + 2).padStart(2, "0")}</span>
            <h3>What Sunchaser can't tell you</h3>
            <p>Honest limits matter as much as the numbers. Each view shows the ones that apply to it.</p>
            <div className="limit-grid">
              {LIMITATIONS.map((l) => <details key={l.id}><summary>{l.short}</summary><p>{l.text}</p></details>)}
            </div>
          </article>

          <article id="quiz" className="chapter">
            <span className="chapter-n num">{String(CHAPTERS.length + 3).padStart(2, "0")}</span>
            <h3>Check yourself</h3>
            <p>Six questions a judge, a teacher or a mission planner might ask.</p>
            <Quiz />
          </article>
        </div>
      </div>
    </section>
  );
}
