import { createRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HERO_REGION, loadHorizon, loadRegion, type RegionData, type RegionEntry } from "./data/manifest";
import { loadAll, loadPeriod } from "./data/tracks";
import { heightAt, horizonCell, regionCenter, type GridPoint } from "./data/region";
import { stereoToLatLon } from "./engine/frames";
import { horizonAtPoint, type HorizonGrid } from "./engine/horizon";
import { seriesStats, siteSeries } from "./engine/series";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, angularRadiusDeg, sampleTrack, visibleDiscFraction } from "./engine/sky";
import { deriveTracks, regionFrame } from "./engine/regiontracks";
import { hourToMs, msToHour, type PeriodTracks, type TrackIndex } from "./engine/tracks";
import { EXAMPLE_POWER, type PowerSystem, type Requirements } from "./engine/windows";
import { EarthInset } from "./scene/EarthInset";
import { FocusView, dsnElevations, type Station } from "./scene/FocusView";
import { MissionClock, sunsetPoint, useMargins } from "./ui/MissionClock";
import { LandingSpread, useHeat, useSpread } from "./ui/LandingSpread";
import { fmtDuration } from "./engine/clock";
import { justUnlocked, type Look, type Stick } from "./scene/Astronaut";
import { Joystick } from "./ui/Joystick";
import { Minimap } from "./ui/Minimap";
import { AstroMap } from "./ui/AstroMap";
import { AstronautHud } from "./ui/AstronautHud";
import { GlobeView, type GlobeSite, type GlobeViewState } from "./scene/GlobeView";
import { quatAt } from "./scene/SceneRoot";
import { SceneRoot } from "./scene/SceneRoot";
import type { PaintMode } from "./scene/Terrain";
import { CompareView } from "./views/CompareView";
import { LightPathPanel, useLightPath } from "./views/LightPath";
import { VIPER, type RoverParams } from "./engine/lightpath";
import { routeWaits } from "./scene/RouteView";
import { ValidationView } from "./views/ValidationView";
import { LearnView } from "./views/LearnView";
import { ReplanView, type Plan } from "./views/ReplanView";
import { ScenarioBoard, readBoard, writeBoard, type Scenario } from "./views/ScenarioBoard";
import { StoriesView, type StoryId } from "./views/StoriesView";
import { LimitsStrip } from "./ui/LimitsStrip";
import { NasaLinks } from "./ui/NasaLinks";
import { WindowsView } from "./views/WindowsView";
import { sitesClient } from "./data/sitesClient";
import { dropPin, fmtLatLon, parseLatLon, readPin, removePin, type PinState } from "./data/pin";
import { buildPinRegion, type PinRegionProgress } from "./data/pinRegion";
import { gridToLatLon } from "./engine/pinhorizon";
import { PinCard, PinPct } from "./ui/PinCard";
import { deferIdle, whenIdle } from "./data/background";
import { CUES, TOUR, tourCurtain, tourGaze, tourHour, type TourApi } from "./director/tour";
import { TourOverlay } from "./director/TourOverlay";
import { EarthIcon, PinIcon, SunIcon } from "./ui/icons";
import { landingCircle, nearestFlagged, slopeMap } from "./engine/terrainmetrics";
import { TimeDock, defaultSpeed } from "./ui/TimeDock";
import { TimeMachine, type Almanac } from "./ui/TimeMachine";
import { fmtDate, fmtSpan, isoDay, isoHour } from "./ui/time";
import { CopilotPanel } from "./copilot/CopilotPanel";
import { reqOut, type Action } from "./copilot/tools";

const MODES: [string, string][] = [["Explore", "explore"], ["Compare", "compare"], ["Landing windows", "windows"], ["Replan a slip", "replan"], ["Scenarios", "scenarios"],
  ["Light Path", "lightpath"], ["Astronaut", "astronaut"], ["Stories", "stories"], ["Validation", "validation"], ["Learn", "learn"]];
const LIVE_MODES = ["explore", "compare", "windows", "replan", "scenarios", "lightpath", "astronaut", "stories", "validation", "learn"];
type Mode = "home" | "explore" | "compare" | "windows" | "replan" | "scenarios" | "lightpath" | "astronaut" | "stories" | "validation" | "learn";
/** the globe's altitude, re-rendered on its own: a full App render per zoom step made dragging the globe stutter */
function AltReadout({ hook, init }: { hook: React.RefObject<((km: number) => void) | null>; init: number }) {
  const [km, setKm] = useState(init);
  useEffect(() => { hook.current = setKm; return () => { hook.current = null; }; }, [hook]);
  return <span className="num">{km >= 1000 ? `${(km / 1000).toFixed(1)} thousand km` : `${Math.round(km)} km`} above the surface</span>;
}

/** `v`, but changing at most every `ms` (0: at once); the last value always lands. */
function useThrottled<T>(v: T, ms: number): T {
  const shown = useRef(v), last = useRef(0), [, redraw] = useState(0);
  if (!ms) shown.current = v; // not throttling: follow at once, so throttling starts from the live value
  useEffect(() => {
    if (!ms || shown.current === v) return;
    const t = setTimeout(() => { last.current = performance.now(); shown.current = v; redraw((k) => k + 1); }, Math.max(0, last.current + ms - performance.now()));
    return () => clearTimeout(t);
  }, [v, ms]);
  return shown.current;
}

const PAINT_LAYERS = 24;
const NO_STATIONS: Station[] = []; // light-painting checkpoints across the period

const qs = () => new URLSearchParams(location.search);
/** No mode in the URL (a fresh visit) opens on the whole Moon; shared links keep their view. */
const readMode = (): Mode => {
  const m = qs().get("mode") ?? "home";
  return LIVE_MODES.includes(m) ? (m as Mode) : m === "home" ? "home" : "explore";
};

/** Compare/Windows parameters in the URL: c=YYYY-MM-DD,days ; w=days,sun,dark|-,dte,blackout|- ; z=height index */
function readCompare() {
  const [start, days] = (qs().get("c") ?? "").split(",");
  return { start: /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : "2027-01-01", days: Number(days) > 0 ? Number(days) : 14 };
}
function readReq(): Requirements {
  const v = (qs().get("w") ?? "").split(",");
  const num = (s: string | undefined, d: number) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
  const opt = (s: string | undefined, d: number | null) => (s === "-" ? null : s ? num(s, d ?? 0) : d);
  return { days: num(v[0], 14), minSunPct: num(v[1], 70), maxDarkH: opt(v[2], null), minDtePct: num(v[3], 50), maxBlackoutH: opt(v[4], 24),
    battery: v[5] === "b" };
}
/** Replan: r=site,YYYY-MM-DDTHH:MM,slip_days (UTC) */
function readPlan(): Plan {
  const [site, iso, slip] = (qs().get("r") ?? "").split(",");
  return { site: /^[a-z0-9-]+$/.test(site ?? "") ? site : "nobile-rim-1", iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(iso ?? "") ? iso : "2027-01-09T12:00",
    slip: Number.isInteger(Number(slip)) && slip ? Math.max(-30, Math.min(150, Number(slip))) : 0 };
}
/** power=panel_m2,efficiency,load_w,battery_wh */
function readPower(): PowerSystem {
  const v = (qs().get("power") ?? "").split(",").map(Number);
  return v.length === 4 && v.every((x) => Number.isFinite(x) && x > 0)
    ? { panelM2: v[0], efficiency: v[1], loadW: v[2], batteryWh: v[3] } : EXAMPLE_POWER;
}
const readZ = () => { const v = qs().get("z"); const z = Number(v); return v !== null && Number.isInteger(z) && z >= 0 && z < 4 ? z : 1; };

interface Period { start: number; days: number } // start: hours since the track index start (2020-01-01T00Z)

/** ?per=YYYY-MM-DD,days&t=YYYY-MM-DDTHH (UTC). Old links (t = hours since 2027-01-01) still open. Default: now. */
function readTime(idx: TrackIndex): { per: Period; hour: number } {
  const per = (qs().get("per") ?? "").split(","), t = qs().get("t") ?? "";
  const day = (ms: number) => Math.floor(msToHour(idx, ms) / 24) * 24;
  let days = Math.round(Number(per[1]));
  if (!(days >= 1 && days <= 366)) days = 30;
  const old = /^\d+(\.\d+)?$/.test(t);
  const now = msToHour(idx, Date.now());
  let start = /^\d{4}-\d{2}-\d{2}$/.test(per[0]) ? day(Date.parse(per[0] + "T00:00:00Z"))
    : old ? day(Date.parse("2027-01-01T00:00:00Z")) : day(Date.now());
  start = Math.max(0, Math.min(idx.n - days * 24, Number.isFinite(start) ? start : 0));
  let hour = /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(t) ? msToHour(idx, Date.parse(t + ":00:00Z"))
    : old ? start + Number(t) : per[0] ? start : now;
  hour = Math.max(start, Math.min(start + days * 24 - 1, Number.isFinite(hour) ? hour : start));
  return { per: { start, days }, hour };
}

/** ?p=x,y (grid metres) selects a point; absent = the region's catalogued site. */
function readPoint(): GridPoint | null {
  const p = new URLSearchParams(location.search).get("p")?.split(",").map(Number);
  return p && p.length === 2 && p.every(Number.isFinite) ? { x_m: p[0], y_m: p[1] } : null;
}

const fmtDur = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h} h`);

const PERF = typeof location !== "undefined" && location.search.includes("perf");
const perfLog = (k: string, ms: number) => { if (ms > 30) ((window as unknown as { __perf?: string[] }).__perf ??= []).push(`${(performance.now() / 1000).toFixed(2)} ${k} ${ms.toFixed(0)}ms`); };

export default function App() {
  const renderT0 = PERF ? performance.now() : 0;
  useLayoutEffect(() => { if (PERF) perfLog("app-render+commit", performance.now() - renderT0); });
  // hero: the 10 km Connecting Ridge region, which also carries the SPICE tracks and DSN stations for every site;
  // data: the region on screen (?region=<site id>), with Sun/Earth derived from the hero tracks (engine/regiontracks)
  const [hero, setHero] = useState<RegionData | null>(null);
  const [regions, setRegions] = useState<RegionEntry[] | null>(null);
  const [regionId, setRegionId] = useState(() => qs().get("region") ?? HERO_REGION);
  const [data, setData] = useState<RegionData | null>(null);
  const [dataId, setDataId] = useState("");
  const [horizon, setHorizon] = useState<HorizonGrid | null>(null);
  // a landing picked in the Window Finder, shown in Explore: global hour of touchdown, stay in days
  const [trip, setTrip] = useState<{ region: string; land: number; days: number; from: Mode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Time: global hours since the track index start; the period is what stats, timeline and painting cover.
  const [per, setPer] = useState<Period | null>(null);
  const [hour, setHour] = useState(0);
  const [ptHero, setPtHero] = useState<PeriodTracks | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(12);
  const [machine, setMachine] = useState(false);
  const [allHero, setAllHero] = useState<PeriodTracks | null>(null);
  const [yearsIn, setYearsIn] = useState(0);
  const [penumbra, setPenumbra] = useState(false);
  const [point, setPoint] = useState<GridPoint | null>(readPoint);
  const [mode, setMode] = useState<Mode>(readMode);
  const [cmp, setCmp] = useState(readCompare);
  const [req, setReq] = useState<Requirements>(readReq);
  const [z, setZ] = useState(readZ);
  const [power, setPower] = useState<PowerSystem>(readPower);
  const [plan, setPlan] = useState<Plan>(readPlan);
  // S6 scenario board: ?sc=site,iso,days;... and ?bt=title. Default story: the planned landing, the same site two
  // weeks late (the Replan NO-GO), and another south-pole site on the planned day.
  const [board, setBoard] = useState<Scenario[]>(() => readBoard(qs(), [
    { site: "nobile-rim-1", iso: "2027-01-09T12:00", days: 14 }, { site: "nobile-rim-1", iso: "2027-01-23T12:00", days: 14 },
    { site: "connecting-ridge", iso: "2027-01-09T12:00", days: 14 }]));
  const [boardTitle, setBoardTitle] = useState(() => qs().get("bt")?.slice(0, 80) || "Lunar south pole landing, January 2027");
  // S7 mission stories: ?story=im2|apollo|farside&ch=N
  const [story, setStory] = useState<{ id: StoryId | null; ch: number }>(() => {
    const id = qs().get("story");
    return { id: id === "im2" || id === "apollo" || id === "farside" ? id : null, ch: Math.max(0, Number(qs().get("ch")) || 0) };
  });
  const [paintMode, setPaintMode] = useState<PaintMode>("live");
  const [psrOn, setPsrOn] = useState(false);
  const [maps, setMaps] = useState<Record<string, Uint8Array>>({});
  const [paintProgress, setPaintProgress] = useState(0);
  const [sites, setSites] = useState<GlobeSite[]>([]);
  // the south-pole catalog (3D regions, study area) and the lunar atlas (S4: landing sites anywhere on the Moon)
  const polarSites = useMemo(() => sites.filter((s) => s.kind !== "atlas"), [sites]);
  const atlasSites = useMemo(() => sites.filter((s) => s.kind === "atlas"), [sites]);
  const [cmpFocus, setCmpFocus] = useState<string | null>(null);
  // S5: the user's own pin anywhere on the Moon (?pin=lat,lon), computed in the browser (data/pin.ts)
  const [pin, setPin] = useState<PinState | null>(() => { const p = readPin(); return p && { ...p, stage: "terrain" }; });
  const pinRun = useRef(0);
  const placePin = useCallback((lat: number, lon: number) => {
    const run = ++pinRun.current, mine = (f: (p: PinState) => PinState) => setPin((p) => (p && pinRun.current === run ? f(p) : p));
    regionCache.current.delete("pin"); // its 3D region (S5b) is rebuilt for the new point
    setPin({ lat, lon, stage: "terrain" });
    dropPin(lat, lon, (pr) => mine((p) => ({ ...p, ...pr })))
      .then(({ entry, ms, steps }) => mine((p) => ({ ...p, lat: entry.lat_deg, lon: entry.lon_deg, stage: "done", ms, steps })))
      .catch((e) => { if (e?.name !== "AbortError") mine((p) => ({ ...p, stage: "error", error: String(e?.message ?? e) })); });
  }, []);
  const clearPin = () => { pinRun.current++; removePin(); setPin(null); };
  // typed coordinates: the globe flies there and the pin drops on the spot
  const [globeFly, setGlobeFly] = useState<{ lat: number; lon: number; altKm: number; seq: number } | null>(null);
  const goToCoords = (lat: number, lon: number) => {
    setMode("home"); setExploring(true); placePin(lat, lon);
    setGlobeFly({ lat, lon, altKm: Math.abs(lat) > 77 ? 900 : 1600, seq: Date.now() });
  };
  const [gotoText, setGotoText] = useState(""), [gotoBad, setGotoBad] = useState(false);
  const openPin = () => { setCmpFocus("pin"); setMode("compare"); };
  useEffect(() => {
    const u = new URL(location.href);
    if (pin) u.searchParams.set("pin", `${+pin.lat.toFixed(5)},${+pin.lon.toFixed(5)}`); else u.searchParams.delete("pin");
    history.replaceState(null, "", u);
  }, [pin?.lat, pin?.lon]);
  const [diving, setDiving] = useState(false);
  const [globeFade, setGlobeFade] = useState(false);
  const [zoomTo, setZoomTo] = useState<"sun" | "earth" | null>(null);
  const [focusOut, setFocusOut] = useState(false);
  const [intro, setIntro] = useState(false);
  // ?focus=earth|sun opens the close-up directly (shareable)
  const [focus, setFocus] = useState<"sun" | "earth" | null>(() => {
    const f = qs().get("focus");
    return f === "earth" || f === "sun" ? f : null;
  });
  useEffect(() => {
    const u = new URL(location.href);
    if (focus) u.searchParams.set("focus", focus); else u.searchParams.delete("focus");
    history.replaceState(null, "", u);
  }, [focus]);
  const [resetKey, setResetKey] = useState(0);
  const [exploring, setExploring] = useState(() => !!readPin());
  // Director tour (director/tour.ts): tourT = seconds into the tour (null = off), pending = waiting for its data
  const [tourT, setTourT] = useState<number | null>(null);
  const [tourPending, setTourPending] = useState(false);
  const [tourPaused, setTourPaused] = useState(false);
  const [tourEnded, setTourEnded] = useState(false);
  const [tourEpoch, setTourEpoch] = useState(0); // a fresh 3D region scene for each tour
  const [sceneReady, setSceneReady] = useState(false);
  const touring = tourT !== null || tourPending;
  // Light Path
  // ?lps=x,y (start) &lpt=x,y (target, grid metres) &dep=YYYY-MM-DDTHH: a shareable route
  const readXY = (k: string): GridPoint | null => {
    const v = qs().get(k)?.split(",").map(Number);
    return v && v.length === 2 && v.every(Number.isFinite) ? { x_m: v[0], y_m: v[1] } : null;
  };
  const [lpStart, setLpStart] = useState<GridPoint | null>(() => readXY("lps"));
  const [lpTarget, setLpTarget] = useState<GridPoint | null>(() => readXY("lpt"));
  const [lpPick, setLpPick] = useState<"target" | "start">("target");
  const [rover, setRover] = useState<RoverParams>(VIPER);
  const [lpDeparture, setLpDeparture] = useState<number | null>(null);
  const [steepOn, setSteepOn] = useState(false);
  const look = useRef<Look>({ yaw: 0, pitch: 3, fov: 60 });
  const stick = useRef<Stick>({ x: 0, y: 0, run: false, jump: false });
  const teleport = useRef<{ x: number; z: number } | null>(null);
  const lpLabels = useMemo(() => Array.from({ length: 6 }, () => createRef<HTMLDivElement>()), []);
  const [globe, setGlobe] = useState<GlobeViewState>({ altKm: 6000, nearPole: false });
  const altKm = useRef(6000), altHook = useRef<((km: number) => void) | null>(null);
  // App state changes only when something it shows switches (land button, auto-land below 30 km)
  const onGlobeView = useCallback((v: GlobeViewState) => {
    altKm.current = v.altKm; altHook.current?.(v.altKm);
    setGlobe((g) => (g.nearPole === v.nearPole && (g.altKm < 30) === (v.altKm < 30) && (g.altKm < 340) === (v.altKm < 340) ? g : v));
  }, []);

  useEffect(() => {
    fetch("/data/sites/manifest.json").then((r) => r.json()).then((m) => setSites(m.sites)).catch(() => setSites([]));
  }, []);
  const enter = () => {
    if (diving) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { setMode("explore"); return; }
    setDiving(true);
  };
  // ?autodive: demo/kiosk link that flies from the Moon to the pole by itself
  useEffect(() => {
    if (!qs().has("autodive") || mode !== "home" || !data) return;
    const t = setTimeout(enter, 1500);
    return () => clearTimeout(t);
  }, [data]);
  // zooming the globe down close over the pole lands you (the reverse of zooming out of the surface view)
  useEffect(() => {
    if (mode === "home" && exploring && !diving && !touring && globe.nearPole && globe.altKm < 30) enter();
  }, [mode, exploring, diving, globe.altKm < 30, globe.nearPole]);
  const dived = () => {
    setGlobeStart(null);
    // the surface view has been waiting at the top of its descent under the globe: start it, fade the globe away
    setMode("explore");
    setIntro(true);
    setDiving(false);
    setGlobeFade(true);
    setTimeout(() => setGlobeFade(false), 1100);
  };
  // tap a body: zoom the lens into it, then open its close-up; closing fades the close-up while the lens zooms back
  const openBody = (b: "sun" | "earth", el: number) => {
    setPlaying(false);
    if (el < -1 || mode === "astronaut") { setFocus(b); return; } // below the horizon (or walking): no zoom
    setZoomTo(b);
  };
  const closeBody = () => {
    setFocusOut(true);
    setZoomTo(null);
    setTimeout(() => { setFocus(null); setFocusOut(false); }, 520);
  };

  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set("mode", mode);
    u.searchParams.set("z", String(z));
    u.searchParams.set("c", `${cmp.start},${cmp.days}`);
    u.searchParams.set("w", [req.days, req.minSunPct, req.maxDarkH ?? "-", req.minDtePct, req.maxBlackoutH ?? "-", req.battery ? "b" : "-"].join(","));
    u.searchParams.set("power", [power.panelM2, power.efficiency, power.loadW, power.batteryWh].join(","));
    u.searchParams.set("r", `${plan.site},${plan.iso},${plan.slip}`);
    if (mode === "scenarios") { u.searchParams.set("sc", writeBoard(board)); u.searchParams.set("bt", boardTitle); }
    else { u.searchParams.delete("sc"); u.searchParams.delete("bt"); }
    if (mode === "stories" && story.id) { u.searchParams.set("story", story.id); u.searchParams.set("ch", String(story.ch)); }
    else { u.searchParams.delete("story"); u.searchParams.delete("ch"); }
    if (!pin) u.searchParams.delete("pin");
    history.replaceState(null, "", u);
  }, [mode, z, cmp, req, power, plan, board, boardTitle, story]);

  useEffect(() => {
    fetch("/data/regions/index.json").then((r) => r.json()).then((x) => setRegions(x.regions), () => setRegions([]));
    let live = true; // a second run of this effect (React dev) must not reset the time chosen since
    loadRegion().then((d) => {
      if (!live) return;
      const t = readTime(d.manifest.tracks);
      setPer(t.per);
      setHour(t.hour);
      setSpeed(defaultSpeed(t.per.days * 24));
      setHero(d);
    }, (e) => setError(String(e)));
    return () => { live = false; };
  }, []);

  // The region on screen: hero + at most one other site kept in memory (a site's horizons decode to ~11 MB).
  const regionCache = useRef(new Map<string, { data: Promise<RegionData>; horizon: Promise<HorizonGrid> }>());
  const shown = useRef("");
  // S5b: the pin's 3D region, built in the browser (data/pinRegion.ts); progress for the pin card
  const [pinBuild, setPinBuild] = useState<PinRegionProgress | { stage: "error"; error: string } | null>(null);
  const regionEntry = (id: string) => {
    const c = regionCache.current, entry = regions?.find((r) => r.id === id);
    if (id === "pin") {
      if (!hero || pin?.stage !== "done") return null;
      let e = c.get(id);
      if (!e) {
        setPinBuild({ stage: "terrain", frac: 0 });
        const b = buildPinRegion(pin.lat, pin.lon, hero, setPinBuild);
        b.then(() => setPinBuild(null), (err) => setPinBuild({ stage: "error", error: String(err?.message ?? err) }));
        e = { data: b.then((r) => r.data), horizon: b.then((r) => r.horizon) };
        for (const k of [...c.keys()]) if (k !== HERO_REGION) c.delete(k);
        c.set(id, e);
      }
      return e;
    }
    if (!hero || (id !== HERO_REGION && !entry)) return null;
    let e = c.get(id);
    if (!e) {
      const d = id === HERO_REGION ? Promise.resolve(hero) : loadRegion(entry!.base).then((r) => ({
        ...r, manifest: { ...r.manifest, tracks: hero.manifest.tracks, dsn_stations: hero.manifest.dsn_stations } }));
      e = { data: d, horizon: d.then((r) => loadHorizon(r.manifest, r.base)) };
      for (const k of [...c.keys()]) if (k !== HERO_REGION) c.delete(k);
      c.set(id, e);
    }
    return e;
  };
  useEffect(() => {
    if (!hero) return;
    const c = regionCache.current;
    let id = regionId, e = regionEntry(id);
    if (!e && id === "pin" && pin && pin.stage !== "error") {
      if (shown.current) return; // the pin is still being computed; the region on screen stays
      id = HERO_REGION; e = regionEntry(id); // first load (a refreshed pin link): the hero meanwhile, or nothing would ever start the pin
    }
    if (!e) { if (regions) setRegionId(HERO_REGION); return; } // unknown site: the hero
    let live = true;
    const fail = (err: unknown) => {
      if (id === HERO_REGION) { setError(String(err)); return; }
      console.error(`region ${id}:`, err);
      c.delete(id);
      if (live) setRegionId(HERO_REGION);
    };
    e.data.then((r) => {
      if (!live || shown.current === id) return;
      shown.current = id;
      setData(r);
      setDataId(id);
      setHorizon(null);
    }, fail);
    e.horizon.then((h) => { if (live) setHorizon(h); }, fail);
    return () => { live = false; };
  }, [hero, regionId, regions, regionId === "pin" ? `${pin?.stage}${pin?.lat}${pin?.lon}` : ""]);
  useEffect(() => {
    const u = new URL(location.href);
    if (regionId !== HERO_REGION) u.searchParams.set("region", regionId); else u.searchParams.delete("region");
    history.replaceState(null, "", u);
  }, [regionId]);
  // switching site: a short fade to black hides the rebuild of the 3D region, then the new site fades in
  const [curtain, setCurtain] = useState(false);
  const goRegion = (id: string, descend = true) => {
    if (id === regionId) return;
    setPlaying(false);
    setCurtain(true);
    setTimeout(() => {
      setPoint(null);
      setLpStart(null);
      setLpTarget(null);
      setIntro(descend); // the new site's view opens with the descent from orbit (an astronaut just walks in)
      setRegionId(id);
    }, touring ? 0 : 320);
  };

  useEffect(() => {
    if (!curtain || dataId !== regionId || !horizon) return;
    const t = setTimeout(() => setCurtain(false), 120);
    return () => clearTimeout(t);
  }, [curtain, dataId, regionId, !!horizon]);

  const idx = hero?.manifest.tracks ?? null;
  const n = per && idx ? Math.min(per.days * 24, idx.n - per.start) : 1;
  const p0 = per?.start ?? 0;
  const clamp = (h: number) => Math.max(p0, Math.min(p0 + n - 1, h));

  // Period tracks: the years it touches are fetched once and cut; the previous period stays on screen meanwhile.
  useEffect(() => {
    if (!idx || !per) return;
    let live = true;
    loadPeriod(idx, per.start, n).then((t) => { if (live) setPtHero(t); }, (e) => setError(String(e)));
    return () => { live = false; };
  }, [idx, per?.start, n]);

  // All 26 years for the almanac: fetched when the time machine opens (about 3 MB, then cached).
  useEffect(() => {
    if (!idx || !machine || allHero) return;
    loadAll(idx, setYearsIn).then(setAllHero, (e) => setError(String(e)));
  }, [idx, machine]);

  // Sun/Earth at the region on screen (identity at the hero region; V5d checks the derivation against SPICE)
  const heroFrame = useMemo(() => (hero ? regionFrame(hero.manifest) : null), [hero]);
  const frame = useMemo(() => (data && heroFrame ? (data === hero ? heroFrame : regionFrame(data.manifest)) : null), [data, heroFrame]);
  const pt = useMemo(() => (ptHero && heroFrame && frame ? deriveTracks(ptHero, heroFrame, frame) : null), [ptHero, frame]);
  const all = useMemo(() => (allHero && heroFrame && frame ? deriveTracks(allHero, heroFrame, frame) : null), [allHero, frame]);

  const setPeriod = (start: number, days: number, h?: number) => {
    setPlaying(false);
    setPer({ start, days });
    setSpeed(defaultSpeed(days * 24));
    setHour((cur) => Math.max(start, Math.min(start + days * 24 - 1, h ?? start + (cur - p0))));
  };
  const goNow = () => {
    if (!idx || !per) return;
    const now = msToHour(idx, Date.now());
    setPeriod(Math.max(0, Math.min(idx.n - per.days * 24, Math.floor(now / 24) * 24)), per.days, now);
  };

  // Shareable URL: ?per=<start day>,<days>&t=<UTC hour>&p=<x,y grid metres>
  useEffect(() => {
    if (!idx || !per) return;
    // once time stops moving (while it plays this ran 12 times a second, and replaceState is slow); the URL is read at
    // write time so a setting changed meanwhile (mode, site) is kept
    const t = setTimeout(() => {
      const u = new URL(location.href);
      u.searchParams.set("per", `${isoDay(hourToMs(idx, per.start))},${per.days}`);
      u.searchParams.set("t", isoHour(hourToMs(idx, Math.round(hour))));
      if (point) u.searchParams.set("p", `${Math.round(point.x_m)},${Math.round(point.y_m)}`);
      else u.searchParams.delete("p");
      history.replaceState(null, "", u);
    }, 400);
    return () => clearTimeout(t);
  }, [idx, per, Math.round(hour), point]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      // the step is fixed here: React may run the updater later, after `last` has moved on (time ran backwards)
      const step = (Math.max(0, now - last) / 1000) * speed;
      last = now;
      setHour((h) => p0 + ((((h - p0 + step) % (n - 1)) + (n - 1)) % (n - 1)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, n, p0, speed]);

  const perRef = useRef(per);
  perRef.current = per;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mode !== "explore" || touring || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const step = e.shiftKey ? 24 : 1, cur = perRef.current;
      if (e.key === "ArrowRight") setHour((h) => clamp(Math.round(h) + step));
      else if (e.key === "ArrowLeft") setHour((h) => clamp(Math.round(h) - step));
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "l" || e.key === "L") setPaintMode((m) => (m === "sun" ? "live" : "sun"));
      else if ((e.key === "]" || e.key === "[") && cur && idx) {
        const s = cur.start + (e.key === "]" ? 1 : -1) * cur.days * 24;
        setPeriod(Math.max(0, Math.min(idx.n - cur.days * 24, s)), cur.days);
      } else if (e.key === "t" || e.key === "T") setMachine((o) => !o);
      else if (e.key === "d" || e.key === "D") startTour(); // Director tour
      else if (e.key === "Escape") setMachine(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [n, p0, mode, idx, touring]);

  // Light painting: computed once per body and period in a worker from the same horizons and formula as the stats.
  const paintBody = paintMode !== "live" ? paintMode : touring && dataId === HERO_REGION ? "sun" : null;
  const paintKey = pt && paintBody ? `${paintBody}@${dataId}:${pt.start}+${pt.n}` : "";
  useEffect(() => {
    if (!paintBody || !horizon || !pt || maps[paintKey]) return;
    const body = paintBody, key = paintKey;
    const w = new Worker(new URL("./workers/lightmap.worker.ts", import.meta.url), { type: "module" });
    const t = pt[body];
    setPaintProgress(0);
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) { setPaintProgress(e.data.progress); return; }
      // keep the last few maps (each 24 x 62,500 bytes)
      setMaps((m) => Object.fromEntries([...Object.entries(m).slice(-5), [key, e.data.map]]));
      w.terminate();
    };
    w.postMessage({
      id: 1, grid: horizon, checkpoints: PAINT_LAYERS, earth: body === "earth",
      radiusKm: body === "sun" ? SUN_RADIUS_KM : EARTH_RADIUS_KM,
      track: { az_grid_deg: t.az_grid_deg, elev_deg: t.elev_deg, dist_km: t.dist_km },
    });
    return () => w.terminate();
  }, [paintKey, horizon]);

  // Selected point (or the catalogued site) and its horizon cell (row 0 = north).
  const sel = useMemo<GridPoint | null>(() => {
    if (!data) return null;
    const site = { x_m: data.manifest.region.site_x_m, y_m: data.manifest.region.site_y_m };
    return point && horizonCell(data, point) ? point : site;
  }, [data, point]);
  const cell = useMemo(() => (data && sel ? horizonCell(data, sel) : null), [data, sel]);

  // Landing safety and science access at the selected point (engine/terrainmetrics, docs/METHODS.md §15)
  const [landLimit, setLandLimit] = useState(10);
  const [slopeOn, setSlopeOn] = useState(false);
  const slopes = useMemo(() => (data ? slopeMap(data.heights, data.manifest.terrain) : null), [data]);
  const landing = useMemo(() => (slopes && data && sel ? landingCircle(slopes, data.manifest.terrain, sel.x_m, sel.y_m) : null), [slopes, sel]);
  const psrNear = useMemo(() => {
    if (!data || !sel) return null;
    const h = data.manifest.horizon;
    return nearestFlagged(data.psr, { rows: h.rows, cols: h.cols, res_m: h.cell_m, x0_m: h.x0_m, y0_m: h.y0_m }, sel.x_m, sel.y_m);
  }, [data, sel]);
  const slopeMask = useMemo(() => (slopes && slopeOn ? Uint8Array.from(slopes, (v) => (v >= landLimit ? 1 : 0)) : null), [slopes, slopeOn, landLimit]);
  const series = useMemo(() => {
    if (!pt || !horizon || !cell) return null;
    const s = siteSeries(horizon, cell.fr, cell.fc, pt.sun, SUN_RADIUS_KM);
    const e = siteSeries(horizon, cell.fr, cell.fc, pt.earth, EARTH_RADIUS_KM);
    return { sun: s, earth: e, sunStats: seriesStats(s), earthStats: seriesStats(e) };
  }, [pt, horizon, cell]);

  // Mission clock and landing accuracy (S1, S2): condition margins at the selected point and at its 19 landing points
  const margins = useMargins(horizon, cell, pt, data?.manifest.dsn_stations ?? NO_STATIONS);
  const spread = useSpread(data, horizon, sel, pt, margins);
  const heat = useHeat(data, horizon, sel, pt);
  const [showRing, setShowRing] = useState(true);

  // Almanac: the same per-hour series over 2020-2045 at the selected point, averaged per UTC day.
  const almanac = useMemo<Almanac | null>(() => {
    if (!all || !horizon || !cell) return null;
    const s = siteSeries(horizon, cell.fr, cell.fc, all.sun, SUN_RADIUS_KM);
    const e = siteSeries(horizon, cell.fr, cell.fc, all.earth, EARTH_RADIUS_KM);
    const nd = Math.floor(s.length / 24), sun = new Float32Array(nd), earth = new Float32Array(nd);
    for (let d = 0; d < nd; d++) {
      let a = 0, b = 0;
      for (let i = 24 * d; i < 24 * d + 24; i++) { a += s[i]; b += e[i] > 0 ? 1 : 0; }
      sun[d] = a / 24;
      earth[d] = b / 24;
    }
    return { sun, earth };
  }, [all, horizon, cell]);

  // Sky at the current hour, sampled from the period tracks (clamped while a new period loads).
  const local = pt ? Math.max(0, Math.min(pt.n - 1, hour - pt.start)) : 0;
  const sky = useMemo(() => (pt ? { sun: sampleTrack(pt.sun, local), earth: sampleTrack(pt.earth, local) } : null), [pt, local]);
  // the panels follow time at 10 Hz while it plays; the 3D view keeps every frame (every panel re-rendering 60 times a
  // second held playback near 19 fps on the T495)
  const uiHour = useThrottled(hour, playing ? 100 : 0);
  const uiLocal = pt ? Math.max(0, Math.min(pt.n - 1, uiHour - pt.start)) : 0;
  const uiSky = useMemo(() => (pt ? { sun: sampleTrack(pt.sun, uiLocal), earth: sampleTrack(pt.earth, uiLocal) } : null), [pt, uiLocal]);

  // Astronaut's eye: face the Sun when you stand up there; Esc stands back up
  const astro = mode === "astronaut";
  // ?look=yaw,pitch[,fov] (degrees) opens the astronaut looking that way (shared views, tests)
  const lookParam = useRef(qs().get("look")?.split(",").map(Number) ?? null);
  useEffect(() => {
    if (!astro || !sky) return;
    const l = lookParam.current;
    lookParam.current = null;
    look.current = l && l.length >= 2 && l.every(Number.isFinite) ? { yaw: l[0], pitch: l[1], fov: l[2] ?? 60 } : { yaw: sky.sun.az, pitch: 3, fov: 60 };
  }, [astro, !!sky]);
  const [atEdge, setAtEdge] = useState(false);
  // Explore -> globe when zooming far out; globe -> surface when zooming back in close over the pole
  // a shared pin link opens looking down at the pin
  const [globeStart, setGlobeStart] = useState<{ lat: number; lon: number; altKm: number } | null>(() => { const p = readPin(); return p && { ...p, altKm: 6000 }; });
  const [mapOpen, setMapOpen] = useState(false);
  // Smooth transitions: once the home page is up, build the 3D site view and load the polar textures quietly in the
  // background, so "Fly to the south pole" only animates (no 3 s freeze while terrain and 22 MB of horizons upload)
  const [prewarm, setPrewarm] = useState(false);
  const [globeReady, setGlobeReady] = useState(false);
  // a shared pin link: start computing once the first screen is up (the globe is ready, or another view opened)
  useEffect(() => {
    if (pin && pin.stage === "terrain" && pinRun.current === 0 && (globeReady || mode !== "home")) placePin(pin.lat, pin.lon);
  }, [globeReady, mode]);
  const lastFocus = useRef<"sun" | "earth">("earth");
  if (focus) lastFocus.current = focus;
  useEffect(() => {
    if (prewarm || !horizon || !data || (mode === "home" && !globeReady)) return;
    let live = true;
    whenIdle(1500).then(() => { if (live) setPrewarm(true); }); // only once the user pauses
    return () => { live = false; };
  }, [prewarm, !!horizon, !!data, mode, globeReady]);
  // the globe fades in whenever it comes back
  const [globeIn, setGlobeIn] = useState(false);
  const prevMode = useRef(mode);
  useEffect(() => {
    if (mode === "home" && prevMode.current !== "home") { setGlobeIn(true); const t = setTimeout(() => setGlobeIn(false), 750); prevMode.current = mode; return () => clearTimeout(t); }
    prevMode.current = mode;
  }, [mode]);
  const [outsideNote, setOutsideNote] = useState(false);
  const [detail, setDetail] = useState(true);
  useEffect(() => {
    if (!astro) { setMapOpen(false); return; }
    const k = (e: KeyboardEvent) => { if ((e.key === "m" || e.key === "M") && !(e.target instanceof HTMLInputElement)) { document.exitPointerLock?.(); setMapOpen(true); } };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [astro]);
  useEffect(() => {
    if (!astro) return;
    // Esc first takes the helmet off (the browser releases the pointer lock); only an Esc without the helmet stands up
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !focus && !document.pointerLockElement && !justUnlocked()) { setMode("explore"); setResetKey((r) => r + 1); } };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [astro, focus]);

  // Light Path: start defaults to the catalogued site; departure is fixed when the mode opens (playing moves the clock)
  const lpOn = mode === "lightpath";
  useEffect(() => {
    if (!lpOn || lpDeparture !== null || !per || !idx) return;
    const d = qs().get("dep");
    const h = d && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(d) ? Math.round(msToHour(idx, Date.parse(d + ":00:00Z"))) : NaN;
    setLpDeparture(Number.isFinite(h) && h >= 0 && h < idx.n ? h : Math.round(hour));
  }, [lpOn, per]);
  useEffect(() => {
    const u = new URL(location.href);
    const xy = (k: string, v: GridPoint | null) => (v ? u.searchParams.set(k, `${Math.round(v.x_m)},${Math.round(v.y_m)}`) : u.searchParams.delete(k));
    xy("lps", lpOn ? lpStart : null);
    xy("lpt", lpOn ? lpTarget : null);
    if (lpOn && lpDeparture !== null && idx) u.searchParams.set("dep", isoHour(hourToMs(idx, lpDeparture)));
    else if (!lpOn) u.searchParams.delete("dep"); // keep a shared departure until it has been read
    history.replaceState(null, "", u);
  }, [lpOn, lpStart, lpTarget, lpDeparture]);
  const lpStartPt = lpStart ?? (data ? { x_m: data.manifest.region.site_x_m, y_m: data.manifest.region.site_y_m } : { x_m: 0, y_m: 0 });
  const lp = useLightPath(data!, horizon, idx ?? ({ n: 0 } as TrackIndex), (lpOn || (touring && dataId === TOUR.site)) && !!data && !!idx, lpStartPt, lpTarget,
    lpDeparture ?? Math.round(hour), rover, heroFrame && frame ? [heroFrame, frame] : null);

  // playing a traverse stops when the rover has arrived
  const lpEnd = lp.result?.found ? lp.result.departure + lp.result.arrival / lp.result.k : null;
  useEffect(() => {
    if (lpOn && playing && lpEnd !== null && tourT === null && hour >= lpEnd + 0.25 && hour < lpEnd + 3) setPlaying(false);
  }, [lpOn, playing, lpEnd, hour >= (lpEnd ?? Infinity) + 0.25]);

  // Window Finder -> Explore: that site, the landing hour, the period around the stay
  const exploreLanding = (id: string, landMs: number, stayDays: number) => {
    if (!idx) return;
    const land = msToHour(idx, landMs), d = Math.min(366, Math.ceil(stayDays) + 1);
    setTrip({ region: id, land, days: stayDays, from: mode });
    setPeriod(Math.max(0, Math.min(idx.n - d * 24, Math.floor(land / 24) * 24)), d, land);
    if (id !== regionId) goRegion(id); else setResetKey((k) => k + 1);
    setMode("explore");
  };
  const regionName = regionId === "pin" ? "your pin" : regions?.find((r) => r.id === regionId)?.name ?? "Connecting Ridge";
  // S5b: "Fly there in 3D" — build the pin's region, then the globe dives into it
  const [pinDive, setPinDive] = useState(false);
  const flyToPin = () => { setPinDive(true); if (regionId !== "pin") { setPoint(null); setRegionId("pin"); } };
  // from a story: drop a pin there, build its 3D region and dive in from the globe
  const flyAnywhere = (lat: number, lon: number) => {
    setMode("home"); setExploring(true); setGlobeStart({ lat, lon, altKm: 6000 });
    placePin(lat, lon); setPinDive(true); setPoint(null); setRegionId("pin");
  };
  useEffect(() => {
    if (pinBuild?.stage === "error") setPinDive(false);
    if (pinDive && dataId === "pin" && horizon && mode === "home") { setPinDive(false); enter(); }
  }, [pinDive, dataId, horizon, pinBuild?.stage]);
  const switching = !!data && dataId !== regionId;

  // ---------- Director tour: cues, time of day, gaze and cameras all follow the tour clock ----------
  const tourClock = useRef({ origin: 0, pausedAt: null as number | null });
  const tourNow = () => { const c = tourClock.current; return Math.max(0, ((c.pausedAt ?? performance.now()) - c.origin) / 1000); };
  const tourCue = useRef(0);
  const tourH0 = idx ? Math.round(msToHour(idx, Date.parse(TOUR.hour + ":00:00Z"))) : 0;
  const tourP0 = idx ? Math.floor(msToHour(idx, Date.parse(TOUR.periodStart + "T00:00:00Z")) / 24) * 24 : 0;
  const startTour = () => {
    if (!idx) return;
    setTourT(null); setTourEnded(false); setTourPaused(false);
    setFocus(null); setFocusOut(false); setZoomTo(null); setMachine(false); setPlaying(false);
    setPaintMode("live"); setPsrOn(false); setPenumbra(false); setSteepOn(false);
    setPoint(null); setLpStart(null); setLpTarget(null); setLpDeparture(null); setRover(VIPER); setTrip(null);
    setDiving(false); setGlobeFade(false); setIntro(false); setExploring(true);
    setRegionId(HERO_REGION);
    setCmp({ start: TOUR.periodStart, days: TOUR.days });
    setPeriod(tourP0, TOUR.days, tourH0);
    setMode("home");
    setSceneReady(false);
    setTourEpoch((e) => e + 1); // the 3D scene is built (hidden under the globe) before the clock starts
    regionEntry(TOUR.site); // warm the landing site's terrain and horizons,
    sitesClient();          // and the ten sites' tables for Compare
    setTourPending(true);
  };
  // start the clock once the tour's period is loaded at the hero region, with a fresh globe
  useEffect(() => {
    if (tourPending && per && per.start !== tourP0) { setPeriod(tourP0, TOUR.days, tourH0); return; } // keep the tour's date
    if (!tourPending || !sceneReady || !ptHero || ptHero.start !== tourP0 || dataId !== HERO_REGION || mode !== "home") return;
    tourClock.current = { origin: performance.now() + 400, pausedAt: null };
    tourCue.current = 0;
    setTourPending(false);
    setTourT(0);
  }, [tourPending, sceneReady, ptHero, dataId, mode, per?.start]);
  const tourApi = useRef<TourApi | null>(null);
  tourApi.current = {
    dive: enter,
    paint: (on) => setPaintMode(on ? "sun" : "live"),
    compare: () => setMode("compare"),
    land: () => idx && exploreLanding(TOUR.site, hourToMs(idx, tourH0), TOUR.days),
    planRoute: () => { setLpTarget(TOUR.route); setLpDeparture(tourH0); },
    lightPath: () => setMode("lightpath"),
    earth: (open) => { if (!open) closeBody(); else if (sky) openBody("earth", sky.earth.el); },
    astronaut: () => setMode("astronaut"),
  };
  const tourLive = useRef({ route: null as { dep: number; hours: number } | null, sunAz: 0, earthAz: 0 });
  tourLive.current = {
    route: lp.result?.found ? { dep: lp.result.departure, hours: lp.result.arrival / lp.result.k } : null,
    sunAz: sky?.sun.az ?? 0, earthAz: sky?.earth.az ?? 0,
  };
  const tourRunning = tourT !== null && !tourPaused && !tourEnded;
  useEffect(() => {
    if (!tourRunning) return;
    let raf = 0;
    const tick = () => {
      const t = tourNow();
      while (tourCue.current < CUES.length && CUES[tourCue.current][0] <= t) CUES[tourCue.current++][1](tourApi.current!);
      const h = tourHour(t, tourH0, tourLive.current.route);
      if (h !== null) setHour(h);
      const g = tourGaze(t, tourLive.current.sunAz, tourLive.current.earthAz);
      if (g) look.current = g;
      // captions and the progress bar: 10 updates a second are plenty, except while the curtain fades
      setTourT(tourCurtain(t) > 0 ? t : Math.round(t * 10) / 10);
      if (t >= TOUR.length) { setTourEnded(true); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [tourRunning]);
  const pauseTour = () => {
    const c = tourClock.current;
    if (c.pausedAt === null) { c.pausedAt = performance.now(); setTourPaused(true); }
    else { c.origin += performance.now() - c.pausedAt; c.pausedAt = null; setTourPaused(false); }
  };
  const exitTour = () => {
    setTourT(null); setTourPending(false); setTourPaused(false); setTourEnded(false);
    tourClock.current.pausedAt = null;
    const u = new URL(location.href);
    u.searchParams.delete("tour"); // a link copied after the tour opens the app, not the tour
    history.replaceState(null, "", u);
    if (focus) closeBody();
    if (mode === "astronaut" || mode === "lightpath") { setMode("explore"); setResetKey((k) => k + 1); }
  };
  useEffect(() => {
    if (!touring) return;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== " ") return;
      e.preventDefault();
      e.stopImmediatePropagation(); // before the explore and astronaut shortcuts
      if (e.key === "Escape") exitTour(); else if (!tourEnded) pauseTour();
    };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, [touring, tourEnded, mode, focus]);
  // ?tour opens straight into the tour (recording the video, kiosk)
  const tourAuto = useRef(qs().has("tour"));
  useEffect(() => {
    if (!tourAuto.current || !hero || !regions || !idx) return;
    tourAuto.current = false;
    startTour();
  }, [hero, regions, idx]);
  const fillCaption = (s: string) => {
    const sm = lp.result?.summary;
    return s.replace("{dark}", sm ? `${sm.darkH.toFixed(1)} hours` : "hours").replace("{soc}", sm ? `${Math.round(sm.minSocPct)} %` : "the reserve");
  };

  // Ask Sunchaser's "show me" buttons: open the view on what the answer discussed
  const runAction = (a: Action) => {
    const site = a.site_id ? sitesClient().manifest?.sites.find((s) => s.id === a.site_id) : undefined;
    const land = a.landing_utc ? Date.parse(a.landing_utc.slice(0, 16) + ":00Z") : NaN;
    const day = Number.isFinite(land) ? new Date(land).toISOString().slice(0, 10) : null;
    if (a.view === "globe") {
      const lat = a.lat ?? site?.lat_deg, lon = a.lon ?? site?.lon_deg;
      if (lat != null && lon != null) goToCoords(lat, lon); else setMode("home");
    } else if (a.view === "explore") {
      if (site?.kind === "atlas") flyAnywhere(site.lat_deg, site.lon_deg);
      else if (site) exploreLanding(site.id, Number.isFinite(land) ? land : Date.now(), a.days ?? 14);
      else setMode("explore");
    } else if (a.view === "compare") {
      if (day || a.days) setCmp((c) => ({ start: day ?? c.start, days: a.days ?? c.days }));
      if (site) setCmpFocus(site.id);
      setMode("compare");
    } else if (a.view === "replan") {
      if (site && a.landing_utc) setPlan({ site: site.id, iso: a.landing_utc.slice(0, 16), slip: 0 });
      setMode("replan");
    } else if (a.view === "scenarios") {
      const b = (a.scenarios ?? []).filter((s) => s?.site_id && /^\d{4}-\d{2}-\d{2}/.test(s.landing_utc ?? "")).slice(0, 4)
        .map((s) => ({ site: s.site_id, iso: (s.landing_utc.length >= 16 ? s.landing_utc : s.landing_utc.slice(0, 10) + "T12:00").slice(0, 16), days: Math.max(1, Math.min(60, Math.round(s.days ?? 14))) }));
      if (b.length) { setBoard(b); setBoardTitle(a.label.slice(0, 80)); }
      setMode("scenarios");
    } else if (a.view === "stories") {
      if (a.story) setStory({ id: a.story, ch: 0 });
      setMode("stories");
    } else setMode(a.view);
  };

  if (error) return <div className="boot"><span className="boot-mark">SUNCHASER</span>Could not load data: {error}</div>;
  if (!data || !sky || !uiSky || !cell || !sel || !pt || !per || !idx) {
    return <div className="boot"><span className="boot-mark">SUNCHASER</span><span>Loading south pole terrain…</span></div>;
  }

  const m = data.manifest;
  const isSite = !point || sel.x_m !== point.x_m || sel.y_m !== point.y_m;
  const isPinRegion = m.region.frame === "pin";
  const ll = isPinRegion ? (([la, lo]) => ({ lat: la, lon: lo }))(gridToLatLon(m.region.center_lat_deg, m.region.center_lon_deg, sel.x_m, sel.y_m))
    : stereoToLatLon(sel.x_m, sel.y_m);
  const gridLon = isPinRegion ? 0 : m.region.center_lon_deg; // grid bearing - gridLon = azimuth from north
  const label = isSite ? m.region.name : "Selected point";
  const hm = m.horizon;
  const sunH = horizon ? horizonAtPoint(horizon, cell.fr, cell.fc, uiSky.sun.az) : NaN; // panel readouts: uiSky (10 Hz while playing)
  const earthH = horizon ? horizonAtPoint(horizon, cell.fr, cell.fc, uiSky.earth.az) : NaN;
  // 0 until horizons load (the tiles show "–" meanwhile).
  const sunFrac = horizon ? visibleDiscFraction(uiSky.sun.el, sunH, angularRadiusDeg(SUN_RADIUS_KM, uiSky.sun.dist)) : 0;
  const earthFrac = horizon ? visibleDiscFraction(uiSky.earth.el, earthH, angularRadiusDeg(EARTH_RADIUS_KM, uiSky.earth.dist)) : 0;
  const ptStartMs = hourToMs(idx, pt.start);
  const days = Math.round(pt.n / 24);
  const map = paintMode === "live" ? null : maps[paintKey] ?? null;

  return (
    <div className={`app ${lpOn && !touring ? "lp-mode" : ""}`}>
      {(mode !== "home" || diving || touring || prewarm) && (
      <SceneRoot marks={mode === "explore" && !touring && pt ? (() => {
        const sp = sunsetPoint(margins, pt, uiLocal);
        return { sunset: sp && { az: sp.az, el: sp.el, label: `Sunset point · in ${fmtDuration(sp.at - uiLocal)}` },
          ring: showRing && spread ? spread.map((q) => ({ x_m: q.x_m, y_m: q.y_m, v: q.sunPct })) : null };
      })() : undefined} plan={lpOn && !touring ? { target: lpTarget, onOutside: () => { setOutsideNote(true); setTimeout(() => setOutsideNote(false), 2600); } } : null} onZoomOut={mode === "explore" && !touring ? () => {
        setGlobeStart({ lat: data.manifest.region.center_lat_deg, lon: data.manifest.region.center_lon_deg, altKm: 150 });
        setExploring(true);
        setMode("home");
      } : undefined} epoch={tourEpoch} onReady={() => setSceneReady(true)} frozen={(touring || prewarm) && mode === "home"} tour={tourT !== null && mode !== "home" ? { clock: tourNow } : null} data={data} horizon={horizon} sun={sky.sun} earth={sky.earth} period={pt} local={local} penumbra={penumbra}
        pin={lpOn ? { ...lpStartPt, label: "Lander" } : { ...sel, label }}
        onPick={(p) => { if (!lpOn) setPoint(p); else if (lpPick === "start") { setLpStart(p); setLpPick("target"); } else setLpTarget(p); }}
        active={(mode === "explore" || lpOn || astro) && !focus} intro={intro}
        astronaut={astro && cell ? { point: sel, cell, look, stick, teleport, onMove: setPoint, onEdge: setAtEdge, detail } : null}
        route={lpOn && lp.result?.found ? { cells: lp.result.cells, k: lp.result.k, sunAlong: lp.result.sunAlong, departure: lp.result.departure, arrival: lp.result.arrival, grid: lp.result.grid, follow: playing || (tourT !== null && tourT >= 49.5 && tourT < 61.5) } : null}
        routeLabels={lpLabels} steep={lpOn && steepOn && lp.result ? { mask: lp.result.steep, n: lp.result.grid.n } : !lpOn && !astro && slopeMask ? { mask: slopeMask, n: data.manifest.terrain.cols } : null}
        onFocus={(b) => openBody(b, b === "sun" ? sky.sun.el : sky.earth.el)} resetKey={resetKey}
        zoomTo={mode !== "home" ? zoomTo : null} onZoomArrived={() => setFocus(zoomTo)} hold={diving || ((touring || prewarm) && mode === "home")}
        paint={{ mode: paintMode, map, layers: PAINT_LAYERS, psr: psrOn }}
        onSeek={(l) => { setPlaying(false); setHour(clamp(pt.start + l)); }} />
      )}
      <div className={`curtain ${curtain && !touring ? "on" : ""}`} aria-hidden />
      <EarthInset hidden={!(mode === "explore" || lpOn)} earth={uiSky.earth} sun={uiSky.sun} quat={quatAt(pt.earthQ, uiLocal)} visible={earthFrac} onOpen={() => openBody("earth", sky.earth.el)} />
      <div className={`vignette ${mode !== "explore" && mode !== "home" ? "deep" : ""}`} aria-hidden />
      {switching && mode !== "home" && <div className="region-switch glass" role="status"><i aria-hidden />Flying to {regionName}…
        {regionId === "pin" && pinBuild && pinBuild.stage !== "error" && <span className="dim"> {pinBuild.stage === "terrain" ? "loading 59 m NASA terrain" : `casting shadows ${Math.round(pinBuild.frac * 100)} %`}</span>}</div>}
      {(mode === "home" || globeFade || prewarm) && (
        <div className={`globe-layer ${globeFade ? "fading" : ""} ${globeIn ? "arriving" : ""} ${mode !== "home" && !globeFade ? "hidden" : ""}`}>
          <GlobeView hidden={mode !== "home" && !globeFade} leaving={mode !== "home"} preload={touring || prewarm} startAt={globeStart} data={data} period={pt} local={local} sun={sky.sun} earth={sky.earth} sites={polarSites} atlas={atlasSites}
            onAtlas={(id) => { setCmpFocus(id); setMode("compare"); }}
            onPin={placePin} onPinOpen={() => pin?.stage === "done" && openPin()}
            heroSite={dataId === "pin" && pin ? { id: "pin", name: "Your pin", lat_deg: pin.lat, lon_deg: pin.lon } : undefined} flyTo={globeFly}
            pin={pin && { lat: pin.lat, lon: pin.lon, busy: pin.stage !== "done" && pin.stage !== "error",
              label: pin.stage === "done" ? "Your pin" : pin.stage === "error" ? "Your pin · failed" : pin.stage === "horizon" ? <>Your pin · <PinPct /></> : "Your pin · terrain…" }}
            heroId={dataId} diving={diving} onDived={dived} onFocus={(b) => openBody(b, 1)}
            exploring={exploring || touring} onInteract={() => setExploring(true)} onView={onGlobeView}
            drift={tourT !== null ? { clock: tourNow, degPerSec: TOUR.globeDegPerSec } : undefined}
            zoomTo={mode === "home" ? zoomTo : null} onZoomArrived={() => setFocus(zoomTo)} onReady={() => { deferIdle(); setGlobeReady(true); }} />
        </div>
      )}
      {/* the boot screen stays until the globe is ready to turn (shaders linked, maps on the GPU) */}
      {mode === "home" && <div className={`boot boot-over ${globeReady ? "gone" : ""}`} aria-hidden={globeReady}><span className="boot-mark">SUNCHASER</span><span>Preparing the Moon…</span></div>}
      {/* built after the 3D view (both at once was a 2 s stall) */}
      {(focus || (prewarm && sceneReady)) && (
        <FocusView open={!!focus} kind={focus ?? lastFocus.current} sun={sky.sun} earth={sky.earth} earthQ={quatAt(pt.earthQ, local)} skyQ={quatAt(pt.skyQ, local)}
          stations={m.dsn_stations ?? []} onClose={closeBody} closing={focusOut}
          when={`${fmtDate(hourToMs(idx, hour))} ${isoHour(hourToMs(idx, hour)).slice(11)}:00 UTC`} />
      )}

      {mode === "home" && !touring && (
        <section className={`home ${diving ? "leaving" : ""} ${exploring ? "exploring" : ""}`} aria-label="Sunchaser">
          <div className="home-copy">
            <div className="eyebrow">NASA Space Apps 2026 · Lunar Landing Site Navigator</div>
            <h1 className="home-title">SUNCHASER</h1>
            <p className="home-tag">Follow the <span className="sun-word">Sun</span>, stay in touch with <span className="earth-word">Earth</span>.</p>
            <p className="home-lede">
              Any landing site on the Moon, lit exactly as it will be, for any hour from 2020 to 2045: the south pole in 20 m detail,
              anywhere else at 59 m, real Sun and Earth positions, validated against JPL and Goddard.
            </p>
            <div className="home-live num">
              <span className="home-chip live"><span className="live-dot" aria-hidden /> Live · {fmtDate(hourToMs(idx, hour))}, {isoHour(hourToMs(idx, hour)).slice(11)}:00 UTC · {m.region.name.replace(/ \(.*\)$/, "")}</span>
              <span className="home-chip sun"><SunIcon size={14} /> Sun {horizon ? `${Math.round(sunFrac * 100)}%` : `${uiSky.sun.el.toFixed(1)}°`}</span>
              <span className="home-chip earth"><EarthIcon size={14} /> Earth {horizon ? `${Math.round(earthFrac * 100)}%` : `${uiSky.earth.el.toFixed(1)}°`}</span>
            </div>
            <div className="home-cta">
              <button className="cta" onClick={enter}>Fly to the south pole</button>
              <button className="cta ghost" onClick={() => setMode("compare")}>Compare {sites.length || 25} landing sites</button>
            </div>
            <div className="home-cta second">
              <button className="cta ghost quiet" onClick={startTour}>▶ 90-second guided tour</button>
              <button className="cta ghost quiet" onClick={() => { setStory({ id: null, ch: 0 }); setMode("stories"); }}>Mission stories</button>
            </div>
            <label className="goto-label" htmlFor="goto-input">Go to any point on the Moon</label>
            <form className="goto" onSubmit={(e) => { e.preventDefault(); const p = parseLatLon(gotoText); setGotoBad(!p); if (p) goToCoords(p.lat, p.lon); }}>
              <PinIcon size={14} />
              <input id="goto-input" value={gotoText} onChange={(e) => { setGotoText(e.target.value); setGotoBad(false); }} placeholder="e.g. 26.13 N, 3.63 E" aria-invalid={gotoBad} spellCheck={false} />
              <button type="submit" disabled={!gotoText.trim()}>Fly there</button>
              {gotoBad && <span className="goto-bad">latitude, longitude in degrees (12.5 S, 33 E or −12.5, 33)</span>}
            </form>
            {!pin && <p className="home-pin-hint"><PinIcon size={13} /> Or tap anywhere on the Moon: Sunchaser computes the Sun, Earth and horizon at your own landing point.</p>}
          </div>
          {exploring && !diving && (
            <div className="globe-hud">
              <AltReadout hook={altHook} init={altKm.current} />
              <span className="dim">{!globe.nearPole && globe.altKm < 340 ? "closest view of the global map here · for metres-scale detail, tap the Moon and fly in 3D"
                : "drag to turn · scroll or pinch to zoom · tap Earth or the Sun · tap the Moon to drop a pin"}</span>
              <button className="link" onClick={() => setExploring(false)}>show intro</button>
            </div>
          )}
          {pin && !diving && (
            <PinCard pin={pin} start={cmp.start} days={cmp.days} z={z} known={sites.map((s) => ({ id: s.id, name: s.name, lat_deg: s.lat_deg, lon_deg: s.lon_deg }))}
              onOpen={openPin} onPlan={() => { setPlan({ ...plan, site: "pin" }); setMode("replan"); }} onRemove={clearPin} onRetry={() => placePin(pin.lat, pin.lon)}
              onFly={flyToPin} fly={pinBuild ?? (pinDive ? (dataId === "pin" && horizon ? { stage: "shadows", frac: 1 } : { stage: "terrain", frac: 0 }) : null)} />
          )}
          {globe.nearPole && !diving && (
            <button className="cta land" onClick={enter}>Land at {regionName} →</button>
          )}
          <p className="home-credit">Moon: NASA LRO LROC WAC + LOLA (SVS CGI Moon Kit) · Sky: NASA SVS Deep Star Maps, ESA Hipparcos · Earth: NASA Blue Marble, Black Marble · Ephemeris: NASA/JPL SPICE · drag to turn the Moon</p>
        </section>
      )}

      <header className="brand" onClick={() => setMode("home")} role="link" aria-label="Back to the whole Moon" style={{ cursor: "pointer", pointerEvents: mode === "home" ? "none" : "auto", opacity: mode === "home" ? 0 : 1 }}>
        <span className="brand-name">SUNCHASER</span>
        <span className="brand-tag">follow the Sun, stay in touch with Earth</span>
      </header>

      {mode !== "home" && <nav className="rail glass" aria-label="Modes">
        {MODES.map(([label, id]) => {
          // Light Path needs the 20 m south-pole terrain: from a pin's region it takes you back to the south pole
          const toPole = id === "lightpath" && data?.manifest.region.frame === "pin";
          return (
            <button key={label} className={`${mode === id ? "active" : ""} ${id === "validation" ? "rail-gap" : ""}`} aria-current={mode === id ? "page" : undefined}
              title={toPole ? "Light Path (opens at the south pole: it needs the 20 m terrain)" : label}
              onClick={() => { if (toPole) goRegion(HERO_REGION, false); setMode(id as Mode); }}>
              {label}
            </button>
          );
        })}
      </nav>}

      {mode === "compare" && (
        <CompareView start={cmp.start} days={cmp.days} z={z} power={power} onExplore={exploreLanding} onAllLimits={() => setMode("validation")}
          pin={pin} onPin={placePin} onShowGlobe={() => pin && goToCoords(pin.lat, pin.lon)} onStory={(id) => { setStory({ id, ch: 0 }); setMode("stories"); }}
          focus={cmpFocus} onFocused={() => setCmpFocus(null)}
          onChange={(p) => {
            if (p.z != null) setZ(p.z);
            if (p.power) setPower(p.power);
            setCmp((c) => ({ start: p.start ?? c.start, days: p.days ?? c.days }));
          }} />
      )}
      {mode === "windows" && (
        <WindowsView req={req} z={z} power={power} onExplore={exploreLanding} onAllLimits={() => setMode("validation")}
          onChange={(p) => { if (p.z != null) setZ(p.z); if (p.req) setReq(p.req); if (p.power) setPower(p.power); }} />
      )}

      {mode === "replan" && (
        <ReplanView req={req} z={z} power={power} plan={plan} onPlan={setPlan} onExplore={exploreLanding} onAllLimits={() => setMode("validation")}
          onChange={(p) => { if (p.z != null) setZ(p.z); if (p.req) setReq(p.req); if (p.power) setPower(p.power); }}
          onBoard={(b) => { setBoard(b); setBoardTitle("After the slip: planned landing, new date, Plan B"); setMode("scenarios"); }} />
      )}
      {mode === "stories" && (
        <StoriesView story={story.id} ch={story.ch} onStory={(id, ch = 0) => setStory({ id, ch })}
          onExplore={exploreLanding} onFlyPin={flyAnywhere} onCompare={(id) => { setCmpFocus(id); setMode("compare"); }} />
      )}
      {mode === "scenarios" && (
        <ScenarioBoard board={board} onBoard={setBoard} title={boardTitle} onTitle={setBoardTitle} req={req} z={z} power={power}
          onExplore={exploreLanding} onAllLimits={() => setMode("validation")}
          onChange={(p) => { if (p.z != null) setZ(p.z); if (p.req) setReq(p.req); if (p.power) setPower(p.power); }} />
      )}
      {mode === "validation" && <ValidationView />}
      {mode === "learn" && <LearnView onGo={setMode} />}

      {(mode === "explore" || lpOn || astro) && <>
      {astro ? (
        <AstronautHud look={look} lonDeg={gridLon} sun={uiSky.sun} earth={uiSky.earth} sunFrac={sunFrac} earthFrac={earthFrac}
          sunAu={uiSky.sun.dist / 149597870.7} dsnUp={dsnElevations(m.dsn_stations ?? [], uiSky.earth, quatAt(pt.earthQ, uiLocal)).filter((d) => d.up).length}
          dsnTotal={(m.dsn_stations ?? []).length} detail={detail} onDetail={setDetail} onExit={() => { setMode("explore"); setResetKey((r) => r + 1); }} />
      ) : null}
      {lpOn && outsideNote && <div className="region-switch glass" role="status">That spot is outside the 3D region: click inside the glowing outline</div>}
      {astro && atEdge && <div className="region-switch glass" role="status">Edge of the {Math.round((m.terrain.cols * m.terrain.res_m) / 1000)} km 3D region: Sunchaser's numbers stop here</div>}
      {astro && <>
        <Joystick stick={stick} />
        <Minimap data={data} horizon={horizon} sun={uiSky.sun} at={sel} look={look} lonDeg={gridLon}
          onTeleport={(p) => {
            setPoint(p);
            const c = regionCenter(data);
            teleport.current = { x: (p.x_m - c.x_m) / 1000, z: -(p.y_m - c.y_m) / 1000 };
          }} onExpand={() => setMapOpen(true)} />
        {mapOpen && !isPinRegion && <AstroMap data={data} horizon={horizon} sun={sky.sun} at={sel} look={look} lonDeg={gridLon}
          sites={polarSites} regionId={dataId} onClose={() => setMapOpen(false)} onGoSite={(id) => goRegion(id, false)}
          onTeleport={(p) => {
            setPoint(p);
            const c = regionCenter(data);
            teleport.current = { x: (p.x_m - c.x_m) / 1000, z: -(p.y_m - c.y_m) / 1000 };
          }} />}
      </>}
      {astro ? null : lpOn ? (
        <LightPathPanel idx={idx} start={lpStartPt} startLabel={lpStart ? "chosen point" : `${m.region.name} (lander)`} target={lpTarget}
          pick={lpPick} departure={lpDeparture ?? Math.round(hour)} hour={uiHour} rover={rover} result={lp.result} busy={lp.busy}
          error={lp.error} steepOn={steepOn} onPick={setLpPick} onDepartNow={() => setLpDeparture(Math.round(hour))}
          onRover={setRover} onSteep={setSteepOn} onClear={() => setLpTarget(null)} onAllLimits={() => setMode("validation")}
          onExample={() => { if (regionId === TOUR.site) setLpTarget(TOUR.route); else { goRegion(TOUR.site, false); setTimeout(() => setLpTarget(TOUR.route), 450); } }}
          onPlay={() => {
            const r = lp.result;
            if (!r || !r.found) return;
            const dep = r.departure, end = dep + Math.ceil(r.arrival / r.k);
            if (dep < pt.start || end > pt.start + pt.n - 1) setPeriod(Math.floor(dep / 24) * 24, Math.max(per.days, Math.ceil((end - Math.floor(dep / 24) * 24) / 24) + 1), dep);
            else setHour(dep);
            setSpeed(Math.max(1, Math.min(48, Math.round((end - dep) / 20))));
            setTimeout(() => setPlaying(true), 50);
          }} />
      ) : (
      <aside className="inspector glass" aria-live="polite">
        <div className="eyebrow">
          <PinIcon size={13} /> {isSite ? "Site" : "Point"}
          {!isSite && <button className="link" onClick={() => setPoint(null)}>back to {m.region.name}</button>}
        </div>
        <h2>{label}</h2>
        <p className="coords num">
          {isPinRegion ? fmtLatLon(ll.lat, ll.lon, 4) : `${Math.abs(ll.lat).toFixed(4)}° S · ${ll.lon.toFixed(3)}° E`} · {heightAt(data, sel).toFixed(0)} m
        </p>
        {regions && regions.length > 1 && (
          <label className="region-pick">
            <span>Go to site</span>
            <select value={regionId} onChange={(e) => goRegion(e.target.value)} disabled={switching}>
              {regions.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.extent_km} km</option>)}
              {pin?.stage === "done" && <option value="pin">Your pin · {fmtLatLon(pin.lat, pin.lon, 1)} · 24 km</option>}
            </select>
          </label>
        )}
        {trip && trip.region === dataId && (
          <div className="trip">
            <div className="trip-head"><span className="eyebrow">Your landing window</span>
              <button className="link" onClick={() => setTrip(null)} aria-label="Dismiss landing window">×</button></div>
            <div className="num"><b>Touchdown {fmtDate(hourToMs(idx, trip.land))} {new Date(hourToMs(idx, trip.land)).toISOString().slice(11, 16)} UTC</b> · {fmtSpan(trip.days)} on the surface</div>
            <div className="trip-actions">
              <button className="link" onClick={() => { setPlaying(false); setHour(clamp(trip.land)); }}>jump to touchdown</button>
              <button className="link" onClick={() => { setHour(clamp(trip.land)); setSpeed(Math.max(1, Math.round((trip.days * 24) / 40))); setTimeout(() => setPlaying(true), 50); }}>play the stay</button>
              <button className="link" onClick={() => setMode(trip.from)}>back to {trip.from === "compare" ? "Compare" : trip.from === "replan" ? "Replan" : trip.from === "stories" ? "the story" : trip.from === "scenarios" ? "Scenarios" : "Windows"}</button>
            </div>
          </div>
        )}
        {isPinRegion && <p className="source">Your pin · terrain {m.terrain.source} · shadows computed on your GPU
          {data.pinCheck && <> in {(data.pinCheck.ms.shadows / 1000).toFixed(1)} s, within {data.pinCheck.v12 < 0.001 ? "0.001" : data.pinCheck.v12.toFixed(3)}° of the CPU (V12)</>} · {Math.round((m.terrain.cols * m.terrain.res_m) / 1000)} km around ·{" "}
          <button className="link inline-link" onClick={() => { setCmpFocus("pin"); setMode("compare"); }}>compare with every site</button></p>}
        {isSite && !isPinRegion && <p className="source">Site: {m.region.site_source.split(",")[0]}{dataId === HERO_REGION ? ", RoI 4 centroid" : ""} · click the terrain to inspect any point ·{" "}
          <button className="link inline-link" onClick={() => setMode("compare")}>compare with 9 other sites</button></p>}

        <div className="section-title">Now <span className="dim">· {hm.z_m} m above ground</span></div>
        <div className="tiles">
          <div className="tile sun">
            <div className="tile-head"><SunIcon size={15} title="Sun" /> Sun</div>
            <div className="big num">{horizon ? Math.round(sunFrac * 100) : "–"}<small>%</small></div>
            <div className="bar"><i style={{ width: `${sunFrac * 100}%` }} /></div>
            <div className="tile-foot num"><span>elevation {uiSky.sun.el.toFixed(2)}°</span><span>horizon {Number.isNaN(sunH) ? "…" : `${sunH.toFixed(2)}°`}</span></div>
          </div>
          <div className="tile earth">
            <div className="tile-head"><EarthIcon size={15} title="Earth" /> Earth</div>
            <div className="big num">{horizon ? Math.round(earthFrac * 100) : "–"}<small>%</small></div>
            <div className="bar earth"><i style={{ width: `${earthFrac * 100}%` }} /></div>
            <div className="tile-foot num"><span>elevation {uiSky.earth.el.toFixed(2)}°</span><span>horizon {Number.isNaN(earthH) ? "…" : `${earthH.toFixed(2)}°`}</span></div>
          </div>
        </div>
        {horizon && (() => {
          const dsn = dsnElevations(m.dsn_stations ?? [], uiSky.earth, quatAt(pt.earthQ, uiLocal)).filter((d) => d.up);
          const up = earthFrac >= 0.5 && dsn.length > 0;
          return <div className={`link-now ${up ? "up" : "down"}`} role="status">
            <span className="link-mark" aria-hidden>{up ? "" : "✕"}</span>
            <span><b>{up ? "Link up" : "Link down"}</b> · {up ? `Earth is above the skyline and ${dsn.map((d) => d.name.split(" ")[0]).join(", ")} can hear the lander.`
              : earthFrac < 0.5 ? "Earth is hidden behind the terrain." : "Earth is up, but no NASA 70 m dish can see the Moon right now."}</span>
          </div>;
        })()}
        <p className="hint">Share of each disc above the real terrain horizon in its direction.
          <button className="link inline-link" onClick={() => setMode("astronaut")}>Stand here and look around →</button></p>
        <LimitsStrip ids={[isPinRegion ? "pin3d" : "terrain", "disc", "comms", "power", "shadows3d"]} onAll={() => setMode("validation")} />

        <div className="section-title">Mission clock <span className="dim">· click a row to go there</span></div>
        <MissionClock m={margins} pt={pt} t={uiLocal} lonDeg={gridLon} startMs={hourToMs(idx, pt.start)}
          onJump={(l) => { setPlaying(false); setHour(pt.start + l); }} />

        <div className="section-title">Landing accuracy <span className="dim">· 250 m around</span></div>
        <LandingSpread pts={spread} show={showRing} onShow={setShowRing} heat={heat} onLand={(dx, dy) => setPoint({ x_m: sel.x_m + dx, y_m: sel.y_m + dy })} />

        <div className="section-title">This period <span className="dim">· {fmtSpan(days)} from {fmtDate(ptStartMs)}</span>
          <button className="link" onClick={() => setMachine(true)}>change</button></div>
        {series ? (
          <dl className="stats">
            <div><dt><SunIcon size={12} /> Sunlight</dt><dd className="num">{series.sunStats.meanPct.toFixed(1)}%</dd></div>
            <div><dt><EarthIcon size={12} /> Earth in view</dt><dd className="num">{series.earthStats.anyPct.toFixed(1)}%</dd></div>
            <div><dt>Longest darkness</dt><dd className="num">{fmtDur(series.sunStats.longestZeroH)}</dd></div>
            <div><dt>Longest Earth loss</dt><dd className="num">{fmtDur(series.earthStats.longestZeroH)}</dd></div>
          </dl>
        ) : <div className="loading-line">Loading terrain horizons…</div>}

        <div className="section-title">Open this point in NASA's tools</div>
        <NasaLinks lat={ll.lat} lon={ll.lon} h_m={heightAt(data, sel)} tMs={ptStartMs + uiLocal * 3_600_000} />

        <div className="section-title">Landing &amp; science <span className="dim">· NASA's site criteria</span></div>
        {isPinRegion && <p className="hint">Landing slope and the nearest permanent shadow need the 20 m south-pole maps: this
          region's terrain is 59 m, so small craters and boulders are not in it.</p>}
        {landing && !isPinRegion && (() => {
          const ok = landing.p95 < landLimit, marginal = !ok && landing.median < landLimit;
          const siteT = (sites.find((x) => x.id === dataId) as { terrain?: { psr_km: number | null } } | undefined)?.terrain;
          const dir = (b: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((b - gridLon) % 360) + 360) % 360 / 45) % 8];
          return (
            <div className="landing">
              <div className="landing-row">
                <span className={`chip ${ok ? "ok" : marginal ? "warn" : "bad"}`}>{ok ? "Safe slope" : marginal ? "Marginal" : "Too steep"}</span>
                <span className="dim">for a lander limited to</span>
                <select value={landLimit} onChange={(e) => setLandLimit(Number(e.target.value))} aria-label="Lander slope limit">
                  {[5, 8, 10, 12, 15].map((d) => <option key={d} value={d}>{d}°</option>)}
                </select>
              </div>
              <dl className="stats">
                <div><dt>Slope, 100 m circle</dt><dd className="num">{landing.median.toFixed(1)}° <small>median</small></dd></div>
                <div><dt>Steepest 5 %</dt><dd className="num">{landing.p95.toFixed(1)}° <small>max {landing.max.toFixed(1)}°</small></dd></div>
                <div><dt>Ground under {landLimit}°</dt><dd className="num">{Math.round(landing.shareBelow(landLimit) * 100)}%</dd></div>
                <div><dt>Nearest permanent shadow</dt><dd className="num">{psrNear ? `${(psrNear.m / 1000).toFixed(2)} km ${dir(psrNear.bearing)}` : siteT?.psr_km != null && isSite ? `${siteT.psr_km.toFixed(2)} km` : "beyond this region"}</dd></div>
              </dl>
              <label className="toggle">
                <input type="checkbox" checked={slopeOn} onChange={(e) => setSlopeOn(e.target.checked)} /> Show ground steeper than {landLimit}° (red hatch)
              </label>
              <p className="hint">NASA picks Artemis sites for lighting, Earth contact, slope and a nearby permanently shadowed region
                (water ice). Slope from LOLA 20 m: boulders and small craters are not seen (IM-2 tipped over at a site that looks under 5° at
                this scale).</p>
            </div>
          );
        })()}

        <div className="section-title">Map layer</div>
        <div className="seg" role="radiogroup" aria-label="Map layer">
          {([["live", "Live shadows"], ["sun", "Sunlight"], ["earth", "Earth view"]] as const).map(([k, l]) => (
            <button key={k} role="radio" aria-checked={paintMode === k} className={paintMode === k ? "on" : ""}
              onClick={() => setPaintMode(k)}>
              {k === "sun" && <SunIcon size={12} />}{k === "earth" && <EarthIcon size={12} />}{l}
            </button>
          ))}
        </div>
        {paintMode !== "live" && (
          <div className={`paint-legend ${paintMode}`}>
            <i />
            <div className="num"><span>0%</span><span>{map ? `share of the ${fmtSpan(days)} period` : `painting… ${Math.round(paintProgress * 100)}%`}</span><span>100%</span></div>
          </div>
        )}
        {!isPinRegion && <label className="toggle" title="NASA Goddard's permanent-shadow map (Mazarico et al. 2011, 60 m). Patches of at least ~4 map pixels are shown; isolated single-pixel specks are hidden because near the pole most of them receive sunlight in our 20 m terrain.">
          <input type="checkbox" checked={psrOn} onChange={(e) => setPsrOn(e.target.checked)} />
          <span className="psr-swatch" aria-hidden /> NASA permanent shadow (PSR) · {(m.psr.fraction * 100).toFixed(1)}% of view
        </label>}
        {paintMode === "live" && (
          <label className="toggle">
            <input type="checkbox" checked={penumbra} onChange={(e) => setPenumbra(e.target.checked)} /> Highlight penumbra
          </label>
        )}
        <details className="method">
          <summary>How this is computed</summary>
          <p>
            Shadows are computed, not drawn. Each 40 m cell has its real terrain horizon in {hm.n_az} directions, traced
            out to 300 km over NASA LOLA elevation data ({hm.layers.map((l) => l.split(":")[0]).join(" → ")}) on the
            curved Moon. The visible part of the Sun's disc over that horizon sets the light, both on screen and in these
            numbers: one dataset, one formula. Sun and Earth positions come from NASA/JPL SPICE for every hour of
            2020–2045 and match JPL Horizons to 0.000002° over that whole range.
          </p>
          <button className="link inline-link" onClick={() => setMode("validation")}>All checks and limitations →</button>
        </details>
      </aside>
      )}
      {lpOn && lp.result?.found && (() => {
        const r = lp.result, s = Math.max(0, Math.min(r.cells.length - 1, Math.round((hour - r.departure) * r.k)));
        const arr = hourToMs(idx, r.departure + r.arrival / r.k);
        const waits = routeWaits({ ...r }, 4);
        return <>
          <div ref={lpLabels[0]} className="pin-label floating lp-label target">Target · arrives {fmtDate(arr)} {new Date(arr).toISOString().slice(11, 16)} UTC</div>
          <div ref={lpLabels[1]} className="pin-label floating lp-label rover">Rover · battery {Math.round((100 * r.socWh[s]) / r.socWh[0])}%</div>
          {waits.map((w, i) => <div key={i} ref={lpLabels[i + 2]} className="pin-label floating lp-label wait">waits {w >= 10 ? Math.round(w) : w.toFixed(1)} h</div>)}
        </>;
      })()}

      {!astro && !touring && <button className="view-reset glass" onClick={() => setResetKey((k) => k + 1)} title="Fly back to the opening view (double-click the ground to fly to a point)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4" /></svg>
        Reset view
      </button>}
      {!astro && !touring && <p className="grab-hint" aria-hidden>{lpOn ? "Click the ground to set the rover's target · drag the sliders to re-plan live · " : ""}Drag the Sun to move time · tap the Sun or Earth to fly there · double-click the ground to fly to it · <kbd>L</kbd> paints the period's sunlight · <kbd>T</kbd> time machine · click the ground to inspect it</p>}
      {machine && (
        <TimeMachine startMs={hourToMs(idx, 0)} totalHours={idx.n} per={per} hour={uiHour} label={label} almanac={almanac}
          loaded={yearsIn} years={idx.years.length} onPeriod={(st, d) => setPeriod(st, d)} onNow={goNow} onClose={() => setMachine(false)} />
      )}
      <TimeDock periodStartMs={ptStartMs} n={pt.n} local={uiLocal} days={days} sun={series?.sun ?? null} earth={series?.earth ?? null}
        playing={playing} speed={speed} machineOpen={machine} onPlay={() => setPlaying((v) => !v)} onSpeed={setSpeed}
        onSeek={(l) => { setPlaying(false); setHour(pt.start + l); }} onMachine={() => setMachine((o) => !o)} />
      </>}
      {!touring && (
        <CopilotPanel ctx={{ req, z, power }} mode={mode} onAction={runAction} state={{
          today_utc: new Date().toISOString().slice(0, 16), view: mode,
          ...(mode === "explore" || astro || lpOn ? { site_id: regionId, site_on_screen: regionName, view_time_utc: new Date(hourToMs(idx, uiHour)).toISOString().slice(0, 16) } : {}),
          compare_start: cmp.start, compare_days: cmp.days, requirements: reqOut(req), observer_height_m: sitesClient().manifest?.z_m[z],
          power_system: power, ...(pin ? { pin: { lat: +pin.lat.toFixed(3), lon: +pin.lon.toFixed(3), site_id: "pin" } } : {}),
          ...(mode === "scenarios" ? { board: board.map((s, i) => ({ letter: "ABCD"[i], site_id: s.site, landing_utc: s.iso, days: s.days })) } : {}),
          ...(mode === "replan" ? { plan } : {}), ...(mode === "stories" && story.id ? { story: story.id } : {}),
        }} />
      )}
      {tourT !== null && (
        <TourOverlay t={tourT} paused={tourPaused} ended={tourEnded} low={astro} fill={fillCaption}
          onPause={pauseTour} onExit={exitTour} onReplay={startTour} />
      )}
    </div>
  );
}
