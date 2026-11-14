import { useEffect, useState } from "react";
import { EarthIcon, SunIcon } from "../ui/icons";
import { fmtDate, fmtTime } from "../ui/time";
import { Status } from "../ui/Status";
import {
  ApolloRelief, ApolloSky, EarthCurves, FAR_SITES, IM2, Im2Map, LockedOrbit, PixelZoom, RelayDiagram, im2At, useApollo, useEarthTracks, useIm2,
} from "./storyFigures";

/**
 * S7 — Mission stories: three short, hands-on stories told with the app's real data, each ending in the 3D view.
 * ?mode=stories&story=im2|apollo|farside&ch=N (shareable).
 */
export type StoryId = "im2" | "apollo" | "farside";
interface Props {
  story: StoryId | null; ch: number; onStory: (s: StoryId | null, ch?: number) => void;
  onExplore: (site: string, landMs: number, days: number) => void;
  onFlyPin: (lat: number, lon: number) => void;
  onCompare: (site: string) => void;
}
interface Chapter { kicker: string; title: string; body: React.ReactNode; figure: React.ReactNode }

const CARDS: { id: StoryId; title: string; tag: string; stat: string; statLabel: string; tint: string }[] = [
  { id: "im2", title: "250 metres", tag: "IM-2 Athena, March 2025: every map said GO.", stat: "1 pixel", statLabel: "the size of the crater that ended the mission", tint: "#f0533f" },
  { id: "apollo", title: "Why Apollo landed at dawn", tag: "Six crews, six landings, one rule about the Sun.", stat: "5–15°", statLabel: "the Sun at every Apollo touchdown, always in the east", tint: "#f5c451" },
  { id: "farside", title: "The side that never sees Earth", tag: "Chang'e 4 and the silence of the far side.", stat: "0 %", statLabel: "of the time Earth is above Chang'e 4's horizon", tint: "#6fe3e1" },
];

export function StoriesView(p: Props) {
  if (!p.story) {
    return (
      <section className="sheet glass stories pick" aria-label="Mission stories">
        <div className="eyebrow">Mission stories</div>
        <h2 className="st-h">Three landings that explain the Moon</h2>
        <p className="dim st-lede">Short stories you can touch: every chart, map and shadow is computed from the same NASA data and the same engine as the
          rest of Sunchaser. Each one ends with you standing on the spot, in 3D.</p>
        <div className="st-cards">
          {CARDS.map((c, i) => (
            <button key={c.id} className="st-card" style={{ "--tint": c.tint, animationDelay: `${i * 90}ms` } as React.CSSProperties} onClick={() => p.onStory(c.id, 0)}>
              <span className="st-num">0{i + 1}</span>
              <b className="st-stat num">{c.stat}</b>
              <span className="st-statl">{c.statLabel}</span>
              <h3>{c.title}</h3>
              <p>{c.tag}</p>
              <span className="st-go">Start the story →</span>
            </button>
          ))}
        </div>
      </section>
    );
  }
  return p.story === "im2" ? <Im2Story key="im2" {...p} /> : p.story === "apollo" ? <ApolloStoryView key="apollo" {...p} /> : <FarSideStory key="farside" {...p} />;
}

/** One story: the chapter's text on the left, its live figure on the right; arrows and dots to move. */
function Shell({ story, ch, onStory, chapters }: Props & { story: StoryId; chapters: Chapter[] }) {
  const n = chapters.length, k = Math.max(0, Math.min(n - 1, ch));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowRight" && k < n - 1) onStory(story, k + 1);
      if (e.key === "ArrowLeft" && k > 0) onStory(story, k - 1);
      if (e.key === "Escape") onStory(null);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [story, k, n]);
  const c = chapters[k], next = CARDS[(CARDS.findIndex((x) => x.id === story) + 1) % CARDS.length];
  return (
    <section className={`sheet glass stories s-${story}`} aria-label={CARDS.find((x) => x.id === story)!.title}>
      <div className="st-text" key={`t${k}`}>
        <button className="link st-back" onClick={() => onStory(null)}>← All stories</button>
        <div className="eyebrow">{c.kicker}</div>
        <h2 className="st-h">{c.title}</h2>
        <div className="st-body">{c.body}</div>
        <nav className="st-nav" aria-label="Chapters">
          <button className="cta ghost" disabled={k === 0} onClick={() => onStory(story, k - 1)} aria-label="Previous chapter">←</button>
          <div className="st-dots">{chapters.map((x, i) => <button key={i} className={i === k ? "on" : i < k ? "done" : ""} onClick={() => onStory(story, i)} aria-label={`Chapter ${i + 1}: ${x.title}`} />)}</div>
          {k < n - 1 ? <button className="cta" onClick={() => onStory(story, k + 1)}>Next →</button>
            : <button className="cta ghost" onClick={() => onStory(next.id, 0)}>Next story: {next.title} →</button>}
        </nav>
      </div>
      <div className="st-fig" key={`f${k}`}>{c.figure}</div>
    </section>
  );
}

const Wait = ({ what }: { what: string }) => <div className="loading-line">{what}</div>;

// ---------- 01 · IM-2 ----------
function Im2Story(p: Props) {
  const { onExplore } = p;
  const d = useIm2();
  const [at, setAt] = useState(IM2.target);
  const here = d ? im2At(d, at) : null, tgt = d ? im2At(d, IM2.target) : null, ath = d ? im2At(d, IM2.athena) : null;
  const go = (x: ReturnType<typeof im2At> | null) => !!x && x.sunPct > 70 && !!x.slope && x.slope.p95 < 8;
  const t0 = Date.parse(IM2.touchdownUtc);
  const readout = (x: ReturnType<typeof im2At> | null, label: string) => x && (
    <div className={`st-readout ${go(x) ? "go" : "nogo"}`}>
      <span className="dim">{label}</span>
      <div><SunIcon size={13} /> <b className="num">{x.sunPct.toFixed(0)} %</b> <small>sunlight, first 12 days</small></div>
      <div><b className="num">{x.slope ? `${x.slope.median.toFixed(1)}°` : "–"}</b> <small>median slope over 100 m{x.slope ? ` (steepest 5 %: ${x.slope.p95.toFixed(1)}°)` : ""}</small></div>
      <div className="st-verdict"><Status kind={go(x) ? "go" : "nogo"} size="sm" /></div>
    </div>
  );
  const map = (o: { drag?: boolean; athena?: boolean; ring?: boolean }) => d
    ? <Im2Map d={d} at={at} onAt={o.drag ? setAt : undefined} showAthena={!!o.athena} showRing={!!o.ring} />
    : <Wait what="Loading the landing zone: NASA LOLA 20 m terrain and its horizons…" />;
  return <Shell {...p} story="im2" chapters={[
    { kicker: "01 · 250 metres · the plan", title: "A flat, sunny plateau near the south pole",
      body: <>
        <p>On {fmtDate(t0)} at {fmtTime(t0)} UTC, Intuitive Machines' <b>Athena</b> lander came down toward Mons Mouton, 84.8° south. The target (the star)
          was chosen for what every lander needs: <b>sunlight for power</b> and ground flat enough to stand on.</p>
        <p>This is the real terrain there, NASA LOLA at 20 m, lit from the direction the Sun stood at touchdown: just {d ? d.pt.sun.elev_deg[0].toFixed(1) : "2"}° above the horizon.
          At the pole the Sun never climbs higher than a few degrees.</p>
      </>, figure: map({ ring: true }) },
    { kicker: "02 · 250 metres · your turn", title: "Drag the lander. Find the danger.",
      body: <>
        <p>Move the lander anywhere on the map. For every spot, Sunchaser computes the sunlight over Athena's first 12 days (the real Sun, the real horizon in
          180 directions out to 300 km) and the slope of the ground inside a 100 m landing circle.</p>
        {readout(here, "Where you put it")}
        <p className="dim">GO here means the app's default checks: sunlight at least 70 % and the steepest 5 % of the circle under 8°. Try hard: almost
          everywhere the maps say the same thing.</p>
      </>, figure: map({ drag: true, ring: true }) },
    { kicker: "03 · 250 metres · what happened", title: "It came down about 250 metres off target. Still GO.",
      body: <>
        <p>Intuitive Machines reported a touchdown about 250 m from the target. On NASA's LRO image Athena lies about 370 m from the published target, which is only given to 2 decimals (±150 m). On our maps that spot is as good as the target:</p>
        <div className="st-pair">{readout(tgt, "Target")}{readout(ath, "Where Athena stopped")}</div>
        <p>Same sunlight, gentle slope. By every number a planner had, this was a safe place to be.</p>
      </>, figure: map({ athena: true, ring: true }) },
    { kicker: "04 · 250 metres · smaller than a pixel", title: "The crater fits inside one map cell",
      body: <>
        <p>LROC's images show Athena <b>on its side in a crater about 20 m across</b>. That is one cell of the best map of the south pole. A lander lying on its side
          could not point its solar panels at a Sun 2° above the horizon: its power ran out the next day, 7 March.</p>
        <p>The Sun was there all along. What decided the mission was <b>where exactly it touched down</b>, and things <b>smaller than the maps can see</b>.</p>
        <p className="st-lesson">That is why Sunchaser shows a landing ring (19 points out to 250 m) at every site, and says out loud what its maps cannot see.</p>
      </>, figure: d ? <PixelZoom d={d} /> : <Wait what="Loading…" /> },
    { kicker: "05 · 250 metres · go there", title: "Stand where Athena landed",
      body: <>
        <p>Fly into the landing zone at the hour Athena touched down. The shadows are computed from the same horizons you just used.</p>
        <button className="cta st-fly" onClick={() => onExplore("im2-athena", t0, 12)}>Fly to Athena's crater, {fmtDate(t0)} →</button>
        <p className="dim">In the 3D view, open "Landing accuracy" to see the 250 m ring, or "Stand here and look around" for the lander's view of the horizon.</p>
      </>, figure: map({ athena: true }) },
  ]} />;
}

// ---------- 02 · Apollo ----------
function ApolloStoryView(p: Props) {
  const { onFlyPin } = p;
  const a = useApollo();
  const [pick, setPick] = useState("apollo-15");
  const [h, setH] = useState(0);
  const m = a?.find((x) => x.id === pick), a15 = a?.find((x) => x.id === "apollo-15");
  const lo = a ? Math.min(...a.map((x) => x.sun.el)) : 0, hi = a ? Math.max(...a.map((x) => x.sun.el)) : 0;
  const sky = a ? <ApolloSky a={a} pick={pick} onPick={setPick} /> : <Wait what="Loading the Apollo touchdowns (SPICE)…" />;
  const relief = a15 ? <ApolloRelief m={a15} h={h} setH={setH} /> : <Wait what="Loading…" />;
  return <Shell {...p} story="apollo" chapters={[
    { kicker: "02 · dawn · six landings", title: "Every Apollo crew landed in the early morning",
      body: <>
        <p>A lunar day lasts 29.5 Earth days: two weeks of light, two weeks of night. Apollo could have landed at any hour of it. All six crews landed within
          a day or so of sunrise, with the Sun <b>{lo.toFixed(1)}° to {hi.toFixed(1)}°</b> up, always <b>in the east</b>.</p>
        <p>Click a mission. Each Sun is where it stood at that crew's touchdown, looking east, computed with NASA/JPL SPICE (the same code we checked against
          JPL Horizons to 0.0002°).</p>
        {m && <div className="st-readout go"><span className="dim">{m.name} · {m.touchdown_utc.slice(0, 16).replace("T", " ")} UTC</span>
          <div><SunIcon size={13} /> <b className="num">{m.sun.el.toFixed(1)}°</b> <small>up, azimuth {m.sun.az.toFixed(0)}° (east)</small></div>
          <div><EarthIcon size={13} /> <b className="num">{m.earth.el.toFixed(0)}°</b> <small>Earth's height: it hangs in the sky and barely moves</small></div></div>}
      </>, figure: sky },
    { kicker: "02 · dawn · light and shadow", title: "Low Sun, long shadows: the ground shows its shape",
      body: <>
        <p>This is Apollo 15's landing site, Hadley Rille, from NASA's 59 m terrain, lit by the Sun exactly as it moved that lunar day. Drag through the day.</p>
        <p>Near sunrise every crater and the rille throw long shadows: a pilot can read the slopes. At midday the shadows shrink to nothing and the ground turns flat
          and featureless, exactly when you need to judge it.</p>
        <p className="dim">The diamond marks Apollo 15's real touchdown.</p>
      </>, figure: relief },
    { kicker: "02 · dawn · the Sun behind them", title: "Flying west, with the Sun at their backs",
      body: <>
        <p>The Lunar Modules came down heading west with a Sun in the east behind them: no glare in the windows, and every rock casting its shadow toward the crew,
          where they could see it.</p>
        <p>Too low and the long shadows swallow the landing site itself; too high and the relief disappears. All six touchdowns sit in one narrow band:
          the shaded band in the eastern sky.</p>
        <p className="st-lesson">At the south pole, the Sun is always that low. That is why Sunchaser matters there: the shadows never shrink.</p>
      </>, figure: sky },
    { kicker: "02 · dawn · go there", title: "Stand at Hadley Rille",
      body: <>
        <p>Fly to Apollo 15's site in 3D: the browser builds 24 km of NASA terrain around it and computes every shadow on your graphics card. Then drag the Sun
          low in the east, the way the crew saw it.</p>
        <button className="cta st-fly" onClick={() => onFlyPin(26.13239, 3.6333)}>Fly to Apollo 15 in 3D →</button>
      </>, figure: relief },
  ]} />;
}

// ---------- 03 · the far side ----------
function FarSideStory(p: Props) {
  const { onFlyPin, onCompare } = p;
  const tr = useEarthTracks(60);
  const [cur, setCur] = useState(24 * 10);
  const col = Object.fromEntries(FAR_SITES);
  const curves = tr ? <EarthCurves tracks={tr} cur={cur} onCur={setCur} /> : <Wait what="Reading Earth's path from four landing sites (2027)…" />;
  const read = tr && <div className="st-legend">{tr.map((t) => (
    <div key={t.id}><i style={{ background: col[t.id] }} /><span><b>{t.name}</b> <span className="dim">{Math.abs(((t.lon + 540) % 360) - 180).toFixed(0)}° {((t.lon + 540) % 360) - 180 < 0 ? "W" : "E"}</span></span>
      <span className="num">{t.el[cur] >= 0 ? <><EarthIcon size={11} /> {t.el[cur].toFixed(1)}° up</> : <span className="red">{(-t.el[cur]).toFixed(1)}° below the horizon</span>}</span></div>))}
    <div className="dim num st-when">{fmtDate(tr[0].t0 + cur * 3600e3)} {fmtTime(tr[0].t0 + cur * 3600e3)} UTC · drag the chart</div></div>;
  return <Shell {...p} story="farside" chapters={[
    { kicker: "03 · far side · a sky that never changes", title: "From the Moon, Earth does not rise or set",
      body: <>
        <p>On Earth the Moon rises and sets every day. On the Moon, Earth stays put. These are Earth's real heights over two months of 2027, from four landing
          sites, from the middle of the near side to the far side.</p>
        {read}
        <p>Apollo 11's Earth barely wobbles. Chang'e 4 and Chang'e 6 never see it at all.</p>
      </>, figure: curves },
    { kicker: "03 · far side · why", title: "One face, always turned toward us",
      body: <>
        <p>The Moon turns once on its axis in exactly the time it takes to go once around Earth (27.3 days). So the same face, the <b>near side</b>, always
          looks at us, and the <b>far side</b> always looks away.</p>
        <p>A small rocking motion (libration, about ±7°) lets places near the edge see Earth rise and set over a month. Deep on the far side, nothing helps:
          the whole Moon is in the way.</p>
      </>, figure: <LockedOrbit /> },
    { kicker: "03 · far side · how to call home", title: "Chang'e 4 talks to Earth through a relay",
      body: <>
        <p>With no direct line to Earth, China's Chang'e 4 (landed 3 January 2019, the first far-side landing) talks through <b>Queqiao</b>, a relay satellite
          circling the Earth–Moon L2 point beyond the Moon, where it can see both the lander and Earth.</p>
        <p className="st-lesson">Sunchaser's link-to-Earth numbers are direct-to-Earth only. Where they say 0 %, a mission needs a relay, and the app tells you so.</p>
      </>, figure: <RelayDiagram /> },
    { kicker: "03 · far side · go there", title: "Look for Earth from Chang'e 4",
      body: <>
        <p>Open Chang'e 4 in Compare and look around its horizon: the Sun comes and goes, Earth never appears. Or fly there in 3D.</p>
        <div className="st-ctas"><button className="cta st-fly" onClick={() => onFlyPin(-45.457, 177.589)}>Fly to Chang'e 4 in 3D →</button>
          <button className="cta ghost" onClick={() => onCompare("change-4")}>Its horizon in Compare</button></div>
      </>, figure: curves },
  ]} />;
}
