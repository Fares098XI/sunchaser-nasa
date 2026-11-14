import { OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { Canvas, invalidate, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import { gridFromScene, heightAt, regionCenter as regionCentre, sceneFromGrid, type GridPoint } from "../data/region";
import type { HorizonGrid } from "../engine/horizon";
import type { PeriodTracks } from "../engine/tracks";
import { hourForAzimuth } from "../engine/grab";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, skyDirection } from "../engine/sky";
import { SKY_KM } from "./display";
import { FarField } from "./FarField";
import { Projector } from "./Label";
import { Earth, Sun } from "./Sky";
import { SkyArrows, SkyTracker, newHits, useSkyGestures } from "./skyPick";
import { BodyZoom } from "./BodyZoom";
import { OPENING, openingBearing } from "./opening";
import { activeOrbit } from "../director/tour";
import { MilkyWay, StarField } from "./Space";
import { R_MOON_KM, Terrain, type Paint } from "./Terrain";
import { PlanArea, RouteView, TargetMark, type RouteDraw } from "./RouteView";
import { AstronautLook, Skyline, type Look, type Stick } from "./Astronaut";
import { NEAR_R_KM, nearGroundKm } from "./NearGround";
import { whenIdle } from "../data/background";
import { drawEachOnce, uploadQuietly } from "./bitmapTexture";

interface Body { az: number; el: number; dist: number }
interface Props {
  data: RegionData; horizon: HorizonGrid | null; sun: Body; earth: Body; penumbra: boolean;
  /** tracks of the chosen period and the fractional hour within it */
  period: PeriodTracks; local: number;
  pin: GridPoint & { label: string }; onPick: (p: GridPoint) => void;
  /** false while a data view covers the scene: render only on demand (no GPU cost) */
  active: boolean;
  paint: Paint;
  /** arriving from the Moon globe: descend from orbit to the opening view */
  intro?: boolean;
  /** Grab the Sun: new (fractional) hour within the period chosen by dragging the Sun */
  onSeek: (hour: number) => void;
  /** tap on the Sun or Earth */
  onFocus?: (body: "sun" | "earth") => void;
  /** telephoto move into a body before its close-up opens (and back out when it closes) */
  zoomTo?: "sun" | "earth" | null;
  onZoomArrived?: () => void;
  /** mounted under the globe during its dive: wait at the top of the descent until the globe hands over */
  hold?: boolean;
  /** Director tour running: continuous frames and the tour's camera orbits */
  tour?: { clock: () => number } | null;
  /** the region's terrain has been drawn with its horizons once */
  onReady?: () => void;
  /** changing it rebuilds the region scene from scratch (each Director tour starts from a fresh one) */
  epoch?: number;
  /** built and waiting out of sight (under the globe): draw nothing until released */
  frozen?: boolean;
  /** the user zoomed out beyond the far field: hand over to the whole-Moon globe */
  onZoomOut?: () => void;
  /** Light Path: outline the plannable area, mark the chosen target, and report clicks outside the region */
  plan?: { target: GridPoint | null; onOutside: () => void } | null;
  /** changes -> fly back to the opening view */
  resetKey?: number;
  /** Mission clock: where the Sun will next touch the skyline (grid az / el, deg); landing-accuracy points (sunlight %) */
  marks?: { sunset?: { az: number; el: number; label: string } | null; ring?: { x_m: number; y_m: number; v: number }[] | null };
  /** Light Path route, its DOM labels, and the too-steep mask (routing grid) */
  route?: RouteDraw | null;
  routeLabels?: React.RefObject<HTMLDivElement | null>[];
  steep?: { mask: Uint8Array; n: number } | null;
  /** Astronaut's eye: stand 2 m above this point; the look direction lives in a ref the HUD also reads */
  astronaut?: {
    point: GridPoint; cell: { fr: number; fc: number }; look: React.RefObject<Look>; stick: React.RefObject<Stick>;
    teleport: React.RefObject<{ x: number; z: number } | null>; onMove: (p: GridPoint) => void;
    onEdge?: (atEdge: boolean) => void;
    /** draw the illustrative ground detail (rocks, small craters) below the 20 m map */
    detail?: boolean;
  } | null;
}

/** Orientation quaternion at a fractional hour (slerp between hourly values; flat [x, y, z, w] per hour). */
export function quatAt(q: Float64Array, hour: number) {
  const n = q.length / 4;
  if (n < 2) return new THREE.Quaternion(q[0], q[1], q[2], q[3]);
  const i = Math.max(0, Math.min(n - 2, Math.floor(hour)));
  const a = new THREE.Quaternion(q[4 * i], q[4 * i + 1], q[4 * i + 2], q[4 * i + 3]);
  const b = new THREE.Quaternion(q[4 * i + 4], q[4 * i + 5], q[4 * i + 6], q[4 * i + 7]);
  return a.slerp(b, Math.max(0, Math.min(1, hour - i)));
}

/** Terrain surface height in scene units at scene (x, z), or null outside the analysed region. */
function groundY(data: RegionData, x: number, z: number) {
  const t = data.manifest.terrain, half = (t.cols * t.res_m) / 2000;
  if (Math.abs(x) > half || Math.abs(z) > half) return null;
  const p = gridFromScene(data, x, z);
  return (heightAt(data, p) - data.manifest.region.center_h_m) / 1000 - (x * x + z * z) / (2 * R_MOON_KM);
}

/** Mesh surface height (bilinear between the vertex heights, as the triangles are) in scene units. */
export function surfaceY(data: RegionData, x: number, z: number) {
  const t = data.manifest.terrain, res = t.res_m / 1000;
  const fc = Math.min(t.cols - 1, Math.max(0, x / res + t.cols / 2 - 0.5)), fr = Math.min(t.rows - 1, Math.max(0, z / res + t.rows / 2 - 0.5));
  const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(t.cols - 1, c0 + 1), r1 = Math.min(t.rows - 1, r0 + 1);
  const h = (r: number, c: number) => data.heights[r * t.cols + c];
  const a = h(r0, c0) + (h(r0, c1) - h(r0, c0)) * (fc - c0), b = h(r1, c0) + (h(r1, c1) - h(r1, c0)) * (fc - c0);
  return (a + (b - a) * (fr - r0) - data.manifest.region.center_h_m) / 1000 - (x * x + z * z) / (2 * R_MOON_KM);
}

function SitePin({ data, pin, label }: { data: RegionData; pin: GridPoint & { label: string }; label: React.RefObject<HTMLDivElement | null> }) {
  const pos = useMemo(() => sceneFromGrid(data, pin), [data, pin.x_m, pin.y_m]);
  const group = useRef<THREE.Group>(null);
  const top = useMemo(() => new THREE.Vector3(), []);
  const { camera } = useThree();
  // drawn for the ~5 km opening view; scaled with distance so it never swamps a close view
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const s = THREE.MathUtils.clamp(camera.position.distanceTo(g.position) / 5, 0.04, 1);
    g.scale.setScalar(s);
    top.set(pos[0], pos[1] + 0.61 * s, pos[2]);
  });
  const H = 0.55;
  return (
    <>
      <group ref={group} position={pos}>
        <mesh position={[0, H / 2, 0]}>
          <cylinderGeometry args={[0.004, 0.004, H, 6]} />
          <meshBasicMaterial color="#6fe3e1" transparent opacity={0.75} />
        </mesh>
        <mesh position={[0, H, 0]}>
          <sphereGeometry args={[0.022, 16, 12]} />
          <meshBasicMaterial color="#6fe3e1" />
        </mesh>
      </group>
      <Projector at={top} el={label} />
    </>
  );
}

let dot: THREE.Texture | null = null;
/** A round dot with a dark rim (white inside, so the vertex colour shows). */
const dotTexture = () => dot ??= (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fillStyle = "#fff";
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = "rgba(0,0,0,0.6)";
  g.stroke();
  return new THREE.CanvasTexture(c);
})();

/**
 * The 19 landing-dispersion points as dots of a fixed screen size, coloured by their sunlight. Hidden by terrain in
 * front of them, so close to the ground they never float through the hills.
 */
function RingMarks({ data, pts }: { data: RegionData; pts: { x_m: number; y_m: number; v: number }[] }) {
  const geo = useMemo(() => {
    const pos: number[] = [], col: number[] = [], c = new THREE.Color();
    for (const p of pts) {
      const [x, y, z] = sceneFromGrid(data, p);
      pos.push(x, y + 0.004, z);
      c.set(`hsl(${28 + p.v * 0.08}, ${40 + p.v * 0.6}%, ${14 + p.v * 0.5}%)`);
      col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return g;
  }, [data, pts]);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <points geometry={geo} renderOrder={20}>
      <pointsMaterial size={10} sizeAttenuation={false} vertexColors map={dotTexture()} alphaTest={0.5} transparent />
    </points>
  );
}

type Controls = { enabled: boolean; target: THREE.Vector3; update: () => void };

/**
 * Camera moves that are not the user's own drag: the descent from orbit, flying the orbit centre to a double-clicked
 * point, flying back to the opening view; plus keeping the eye above the ground.
 */
function CameraDirector({ data, view, intro, controls, flyTo, face, resetKey, fit, standing, hold }: {
  data: RegionData; view: { cam: THREE.Vector3; target: THREE.Vector3 }; intro?: boolean;
  controls: React.RefObject<Controls | null>; flyTo: React.RefObject<THREE.Vector3 | null>; resetKey?: number;
  /** a sky direction to turn toward (the Sun or Earth), keeping the orbit centre */
  face: React.RefObject<THREE.Vector3 | null>;
  /** frame a box (a new Light Path route): centre + radius in km */
  fit?: { key: string; centre: THREE.Vector3; radius: number } | null;
  standing?: boolean;
  hold?: boolean;
}) {
  const { camera, invalidate } = useThree();
  const tween = useRef<{ t: number; dur: number; fromCam: THREE.Vector3; toCam: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3 } | null>(null);
  const start = (toCam: THREE.Vector3, toT: THREE.Vector3, dur: number, fromCam = camera.position.clone()) => {
    const c = controls.current;
    tween.current = { t: 0, dur, fromCam, toCam, fromT: c ? c.target.clone() : toT.clone(), toT };
    invalidate();
  };
  const introFrom = useMemo(() => view.target.clone()
    .add(view.cam.clone().sub(view.target).setY(0).normalize().multiplyScalar(OPENING.diveBackKm)).setY(view.target.y + OPENING.diveUpKm), []);
  const introDone = useRef(false);
  useEffect(() => {
    if (!intro) return;
    // waiting under the globe (again): be ready to descend when it hands over
    if (hold) { introDone.current = false; camera.position.copy(introFrom); camera.lookAt(view.target); if (controls.current) controls.current.enabled = false; invalidate(); return; }
    if (introDone.current) return;
    introDone.current = true;
    camera.position.copy(introFrom);
    camera.lookAt(view.target);
    start(view.cam.clone(), view.target.clone(), 3.2, introFrom);
  }, [hold, intro]);
  const fitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!fit || fit.key === fitKey.current) return;
    fitKey.current = fit.key;
    const c = controls.current;
    const dir = c ? camera.position.clone().sub(c.target).normalize() : new THREE.Vector3(0, 0.5, 1).normalize();
    dir.y = Math.max(dir.y, 0.45);
    start(fit.centre.clone().add(dir.normalize().multiplyScalar(Math.max(1.2, fit.radius * 2.6))), fit.centre.clone(), 1.3);
  }, [fit?.key]);
  const firstReset = useRef(resetKey);
  useEffect(() => { if (resetKey !== firstReset.current) start(view.cam.clone(), view.target.clone(), 1.4); }, [resetKey]);
  useFrame((_, dt) => {
    const c = controls.current;
    if (flyTo.current && c) {
      // keep the camera's offset from the orbit centre, move both to the new point
      const off = camera.position.clone().sub(c.target);
      const toT = flyTo.current.clone();
      start(toT.clone().add(off.multiplyScalar(Math.min(1, 2.5 / off.length()))), toT, 1.0);
      flyTo.current = null;
    }
    if (face.current && c) {
      // swing round the orbit centre to look toward the body, 10° down, so a body near the horizon is in view
      const d = face.current, r = camera.position.distanceTo(c.target), hz = Math.hypot(d.x, d.z) || 1, p = (10 * Math.PI) / 180;
      start(c.target.clone().add(new THREE.Vector3((-d.x / hz) * r * Math.cos(p), r * Math.sin(p), (-d.z / hz) * r * Math.cos(p))), c.target.clone(), 1.2);
      face.current = null;
    }
    const tw = tween.current;
    if (tw && c) {
      tw.t = Math.min(1, tw.t + Math.min(dt, 1 / 30) / tw.dur); // a slow frame never makes the camera jump
      const e = tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - (-2 * tw.t + 2) ** 3 / 2;
      camera.position.lerpVectors(tw.fromCam, tw.toCam, e);
      c.target.lerpVectors(tw.fromT, tw.toT, e);
      c.enabled = tw.t >= 1;
      c.update();
      if (tw.t >= 1) tween.current = null;
      invalidate();
    }
    // never below the ground (30 m eye height) inside the analysed region (the astronaut stands at 2 m on purpose)
    if (standing) return;
    const g = groundY(data, camera.position.x, camera.position.z);
    if (g !== null && camera.position.y < g + 0.03) camera.position.y = g + 0.03;
  });
  return null;
}

/** Director tour: eased orbits of the camera about the orbit centre, as a pure function of the tour clock. */
function TourOrbit({ clock, controls }: { clock: () => number; controls: React.RefObject<Controls | null> }) {
  const { camera } = useThree();
  const cur = useRef<{ from: number; off: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  useEffect(() => () => { if (controls.current) controls.current.enabled = true; }, []);
  useFrame(() => {
    const c = controls.current, o = activeOrbit(clock());
    if (!c) return;
    if (!o) { if (cur.current) c.enabled = true; cur.current = null; return; }
    if (cur.current?.from !== o.from) {
      if (!c.enabled) return; // another camera move (the descent) is still running: start from where it ends
      cur.current = { from: o.from, off: camera.position.clone().sub(c.target), target: c.target.clone() };
    }
    const u = (clock() - o.from) / (o.to - o.from), e = u * u * (3 - 2 * u);
    const off = cur.current.off.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), (-o.deg * e * Math.PI) / 180);
    camera.position.copy(cur.current.target).add(off);
    camera.lookAt(cur.current.target);
    c.enabled = false;
  });
  return null;
}

/** Everything that belongs to one region: its opening view, terrain, far field, pins, route, walker and cameras.
 * Keyed by region, so a new site rebuilds only this part; the canvas, sky, Sun and Earth stay (no new WebGL context). */
function RegionScene({ data, horizon, sun, earth, period, local, penumbra, pin, pinLabel, onPick, paint, intro, resetKey,
  route, routeLabels, steep, astronaut, zoomTo, onZoomArrived, hold, tour, sunPos, earthPos, onReady, onZoomOut, plan, marks, face }: Omit<Props, "active" | "onSeek" | "onFocus" | "epoch" | "frozen"> & {
  pinLabel: React.RefObject<HTMLDivElement | null>; sunPos: THREE.Vector3; earthPos: THREE.Vector3;
  face: React.RefObject<THREE.Vector3 | null>;
}) {
  const controls = useRef<Controls | null>(null);
  const flyTo = useRef<THREE.Vector3 | null>(null);
  const { camera, gl, scene } = useThree();
  // Opening view over the site.
  const [view] = useState(() => {
    const s = data.manifest.region;
    const t = sceneFromGrid(data, { x_m: s.site_x_m, y_m: s.site_y_m });
    const target = new THREE.Vector3(t[0], t[1], t[2]);
    // the opening framing is set for the 10 km hero region; other regions are framed in proportion (pins: 24 km)
    const k = (data.manifest.terrain.cols * data.manifest.terrain.res_m) / 10000;
    const up = OPENING.upKm * k, dist = OPENING.backKm * k;
    const v = (openingBearing(sun.az, earth.az, earth.el) * Math.PI) / 180;
    const cam = target.clone().add(new THREE.Vector3(-Math.sin(v), 0, Math.cos(v)).multiplyScalar(dist));
    const g = groundY(data, cam.x, cam.z) ?? target.y;
    cam.y = Math.max(target.y + up, g + 0.3);
    return { cam, target };
  });
  // a region that opens without the descent starts at its opening view
  useState(() => { if (!intro) { camera.position.copy(view.cam); camera.lookAt(view.target); } return 0; });

  // the astronaut's eye, 2 m above the rendered surface (the height every horizon is computed for)
  const eye = useMemo(() => {
    if (!astronaut) return null;
    const c = regionCentre(data), x = (astronaut.point.x_m - c.x_m) / 1000, z = -(astronaut.point.y_m - c.y_m) / 1000;
    return new THREE.Vector3(x, surfaceY(data, x, z) + 0.002, z);
  }, [astronaut?.point.x_m, astronaut?.point.y_m]);
  // where the astronaut first stands (walking moves the point; the walker keeps its own position)
  const startEye = useRef<THREE.Vector3 | null>(null);
  if (!astronaut) startEye.current = null;
  else if (!startEye.current && eye) startEye.current = eye.clone();
  // a new Light Path route (new start or target): frame it once
  const routeFit = useMemo(() => {
    if (!route) return null;
    const g = route.grid, n = g.n, a = route.cells[0], b = route.cells[route.cells.length - 1];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of route.cells) {
      const x = g.x0M + ((c % n) + 0.5) * g.cellM, y = g.y0M - (Math.floor(c / n) + 0.5) * g.cellM;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const mid = { x_m: (x0 + x1) / 2, y_m: (y0 + y1) / 2 };
    const p = sceneFromGrid(data, mid);
    return { key: `${a}-${b}`, centre: new THREE.Vector3(p[0], p[1], p[2]), radius: Math.hypot(x1 - x0, y1 - y0) / 2000 };
  }, [route?.cells]);
  // set once: a new array each render would snap the orbit centre back whenever the time changes
  const initialTarget = useMemo(() => view.target.toArray(), [view]);
  // ready = terrain shaded from its horizons and drawn once (the Director tour waits for it before it starts)
  const told = useRef(false), zoomedOut = useRef(false);
  useEffect(() => {
    if (!location.search.includes("perf")) return;
    let t = 0;
    scene.onBeforeRender = () => { t = performance.now(); };
    scene.onAfterRender = () => { const ms = performance.now() - t; if (ms > 30) ((window as unknown as { __perf?: string[] }).__perf ??= []).push(`${(performance.now() / 1000).toFixed(2)} scene-render ${ms.toFixed(0)}ms`); };
  }, []);
  // Warm-up, between the user's interactions (never during a drag): compile every material (Sun, Earth, far field,
  // shadows: also those outside the opening view), upload every texture, draw one frame; then report ready.
  useEffect(() => {
    if (!horizon || told.current) return;
    let live = true;
    (async () => {
      await whenIdle(); if (!live) return;
      await gl.compileAsync(scene, camera).catch(() => undefined);
      if (!(await uploadQuietly(gl, scene, () => live))) return;
      if (!(await drawEachOnce(gl, scene, camera, () => live))) return;
      await whenIdle(); if (!live) return;
      gl.shadowMap.needsUpdate = true;
      gl.render(scene, camera);
      told.current = true;
      onReady?.();
    })();
    return () => { live = false; };
  }, [horizon]);
  useFrame(() => {
    // zooming out past ~105 km (where the far field ends) continues on the globe
    const c = controls.current;
    if (onZoomOut && c && !zoomedOut.current && camera.position.distanceTo(c.target) > 105) { zoomedOut.current = true; onZoomOut(); }
  });
  return (
    <>
      <Terrain data={data} horizon={horizon} sun={sun} earth={earth} penumbra={penumbra} paint={paint} steep={steep} near={!!astronaut && astronaut.detail !== false}
        onPick={(v) => onPick(gridFromScene(data, v.x, v.z))} onDoublePick={(v) => { flyTo.current = v; }} />
      <FarField data={data} sun={sun} onClickOutside={plan?.onOutside} />
      {plan && <PlanArea data={data} />}
      {plan?.target && !route && <TargetMark data={data} at={plan.target} />}
      {!astronaut && !route && <SitePin data={data} pin={pin} label={pinLabel} />}
      {!astronaut && !route && marks?.ring && <RingMarks data={data} pts={marks.ring} />}
      {route && routeLabels && <RouteView data={data} route={route} hour={period.start + local} labels={routeLabels} follow={route.follow ? controls : undefined} />}
      {tour && !astronaut && <TourOrbit clock={tour.clock} controls={controls} />}
      <CameraDirector data={data} view={view} intro={intro} controls={controls} flyTo={flyTo} face={face} resetKey={resetKey} fit={routeFit} standing={!!astronaut} hold={hold} />
      {!astronaut && <BodyZoom active={!!zoomTo} controls={controls}
        target={zoomTo ? { pos: zoomTo === "sun" ? sunPos : earthPos, radius: zoomTo === "sun" ? (SUN_RADIUS_KM / sun.dist) * SKY_KM : (EARTH_RADIUS_KM / earth.dist) * SKY_KM } : null}
        onArrived={() => onZoomArrived?.()} />}
      {astronaut && eye && horizon && <>
        <AstronautLook key="astronaut" start={startEye.current ?? eye} look={astronaut.look} stick={astronaut.stick}
          teleport={astronaut.teleport} limitKm={(data.manifest.terrain.cols * data.manifest.terrain.res_m) / 2000 - NEAR_R_KM - 0.02}
          ground={(x, z) => (astronaut.detail === false ? surfaceY(data, x, z) : nearGroundKm(surfaceY(data, x, z), x, z))} onMove={(x, z) => astronaut.onMove(gridFromScene(data, x, z))}
          onEdge={astronaut.onEdge} />
        <Skyline hg={horizon} fr={astronaut.cell.fr} fc={astronaut.cell.fc} eye={eye} />
      </>}
      {!astronaut && <OrbitControls ref={controls as never} target={initialTarget} makeDefault
        enableDamping dampingFactor={0.07} rotateSpeed={0.55} zoomSpeed={0.9} panSpeed={0.8} zoomToCursor
        minDistance={0.08} maxDistance={140} maxPolarAngle={Math.PI / 2 - 0.015} screenSpacePanning={false} />}
    </>
  );
}

export function SceneRoot(props: Props) {
  const { data, sun, earth, period, local, pin, active, onSeek, onFocus, astronaut, tour } = props;
  const pinLabel = useRef<HTMLDivElement>(null), setLabel = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const setMark = props.marks?.sunset;
  const setAt = useMemo(() => setMark ? new THREE.Vector3(...skyDirection(setMark.az, setMark.el)).multiplyScalar(SKY_KM / 2) : null, [setMark?.az, setMark?.el]);
  const hits = useRef(newHits());
  const face = useRef<THREE.Vector3 | null>(null);
  if (import.meta.env.DEV) (window as unknown as { __sky: unknown }).__sky = hits.current; // gesture tests
  const sunDir = skyDirection(sun.az, sun.el);
  const quat = quatAt(period.earthQ, local);
  const skyQuat = quatAt(period.skyQ, local);
  const state = useRef({ period, local, onSeek });
  // steps between 0.75 and 1.5 to hold the frame rate: an integrated GPU (T495) drawing 2 M terrain pixels a frame drops to ~17 fps while time plays
  const [dpr, setDpr] = useState(1.25);
  state.current = { period, local, onSeek };

  useSkyGestures(wrap, hits, {
    onSunDrag: (dir) => {
      const { period: p, local: l, onSeek: seek } = state.current;
      const az = ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360; // grid bearing of the pointer
      seek(hourForAzimuth(p.sun.az_grid_deg, l, az));
    },
    onTap: (b) => onFocus?.(b),
  });

  const sunPos = new THREE.Vector3(...sunDir).multiplyScalar(SKY_KM);
  const e = skyDirection(earth.az, earth.el);
  const earthPos = new THREE.Vector3(...e).multiplyScalar(SKY_KM);
  return (
    <div ref={wrap} className="scene-wrap">
      {/* Drawn on demand: frames only when the camera, the time or an animation changes, so the GPU idles otherwise */}
      <Canvas camera={{ position: [0, 3, 6], fov: 50, near: 0.02, far: 6000 }} dpr={dpr} gl={{ antialias: true }} flat
        shadows={{ type: THREE.PCFShadowMap, autoUpdate: false }} frameloop={props.frozen ? "never" : tour ? "always" : "demand"}>
        {active && <PerformanceMonitor onDecline={() => setDpr((d) => Math.max(0.75, d - 0.25))} onIncline={() => setDpr((d) => Math.min(1.5, d + 0.25))} flipflops={6} onFallback={() => setDpr(1)} />}
        <color attach="background" args={["#000000"]} />
        <Suspense fallback={null}>
          <MilkyWay quat={skyQuat} />
        </Suspense>
        <StarField quat={skyQuat} sunDir={sunDir} />
        {/* Lights only serve the fallback material shown until horizons load */}
        <ambientLight intensity={0.03} />
        <directionalLight position={[sunDir[0] * 50, sunDir[1] * 50, sunDir[2] * 50]} intensity={3} color="#fff6e6" />
        <RegionScene key={`${data.manifest.region.id}:${props.epoch ?? 0}`} {...props} pinLabel={pinLabel} sunPos={sunPos} earthPos={earthPos} face={face} />
        <Sun sun={sun} />
        <Suspense fallback={null}>
          <Earth earth={earth} quat={quat} sunDir={sunDir} />
        </Suspense>
        {setAt && <Projector at={setAt} el={setLabel} />}
        <SkyTracker hits={hits} sun={{ pos: sunPos, radius: (SUN_RADIUS_KM / sun.dist) * SKY_KM }}
          earth={{ pos: earthPos, radius: (EARTH_RADIUS_KM / earth.dist) * SKY_KM }} />
      </Canvas>
      <div ref={pinLabel} className="pin-label floating" style={{ display: astronaut || !active || props.route ? "none" : undefined }}>{pin.label}</div>
      <div ref={setLabel} className="pin-label floating set-mark" style={{ display: setMark && active ? undefined : "none" }}><span>{setMark?.label}</span><i aria-hidden /></div>
      {active && !astronaut && !tour && !props.zoomTo && <SkyArrows hits={hits} onFace={(b) => {
        face.current = new THREE.Vector3(...(b === "sun" ? sunDir : skyDirection(earth.az, earth.el)));
        invalidate();
      }} />}
    </div>
  );
}
