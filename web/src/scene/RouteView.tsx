import { Line } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import { gridFromScene, heightAt, regionCenter } from "../data/region";
import { Projector } from "./Label";
import { R_MOON_KM } from "./Terrain";

/**
 * Light Path in 3D: the route as a glowing ribbon draped over the terrain (amber where the rover is in sunlight,
 * blue where it runs on battery), the lander at the start, the target beacon, labelled waits, and a VIPER-class rover
 * driving the route at the current hour (headlights on in shadow). Models keep a readable size at any zoom (true size
 * when close). With `follow`, the camera chases the rover while the traverse plays.
 */
export interface RouteDraw {
  cells: Int32Array; k: number; sunAlong: Float32Array; departure: number; arrival: number;
  grid: { n: number; cellM: number; x0M: number; y0M: number };
  /** chase the rover with the camera (playing the traverse) */
  follow?: boolean;
}
type Controls = { enabled: boolean; target: THREE.Vector3; update: () => void };

const LIFT_KM = 0.004;

function scenePoint(data: RegionData, x_m: number, y_m: number, lift = LIFT_KM) {
  const c = regionCenter(data);
  const x = (x_m - c.x_m) / 1000, z = -(y_m - c.y_m) / 1000;
  const h = heightAt(data, gridFromScene(data, x, z));
  return new THREE.Vector3(x, (h - data.manifest.region.center_h_m) / 1000 - (x * x + z * z) / (2 * R_MOON_KM) + lift, z);
}

const centre = (g: RouteDraw["grid"], cell: number) => ({
  x_m: g.x0M + ((cell % g.n) + 0.5) * g.cellM, y_m: g.y0M - (Math.floor(cell / g.n) + 0.5) * g.cellM,
});

/** Scale for a model `trueKm` long: real size up close, at least ~`px` pixels tall when far. */
function screenScale(camera: THREE.Camera, at: THREE.Vector3, trueKm: number, px: number, viewH: number) {
  const cam = camera as THREE.PerspectiveCamera;
  const d = camera.position.distanceTo(at);
  const kmPerPx = (2 * d * Math.tan((cam.fov * Math.PI) / 360)) / viewH;
  return Math.max(trueKm, kmPerPx * px) / trueKm;
}

const white = new THREE.MeshStandardMaterial({ color: "#e9e6df", roughness: 0.55, metalness: 0.15 });
const dark = new THREE.MeshStandardMaterial({ color: "#2a2c31", roughness: 0.9 });
const panel = new THREE.MeshStandardMaterial({ color: "#1d2a52", roughness: 0.35, metalness: 0.5, emissive: "#0b1430", emissiveIntensity: 0.4 });
const gold = new THREE.MeshStandardMaterial({ color: "#c9a043", roughness: 0.35, metalness: 0.8 });
const lamp = new THREE.MeshBasicMaterial({ color: "#fff6d8", toneMapped: false });

/** VIPER-class rover in metres (~1.5 x 1.5 x 2.5 m), +z forward; in shadow it goes dark and turns its lights on. */
function Rover({ lights }: { lights: boolean }) {
  const m = useMemo(() => ({ white: white.clone(), dark: dark.clone(), panel: panel.clone(), gold: gold.clone() }), []);
  for (const [k, base] of [["white", white], ["dark", dark], ["panel", panel], ["gold", gold]] as const)
    m[k].color.copy(base.color).multiplyScalar(lights ? 0.1 : 1);
  const { white: W, dark: D, panel: P, gold: G } = m;
  return (
    <group>
      <mesh material={W} position={[0, 0.78, 0]}><boxGeometry args={[1.25, 0.45, 1.55]} /></mesh>
      <mesh material={G} position={[0, 0.5, 0]}><boxGeometry args={[1.05, 0.12, 1.35]} /></mesh>
      {[[-0.72, 0.62], [0.72, 0.62], [-0.72, -0.62], [0.72, -0.62]].map(([x, z], i) => (
        <group key={i} position={[x, 0.3, z]}>
          <mesh material={D} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.3, 0.3, 0.24, 18]} /></mesh>
          <mesh material={W} position={[x > 0 ? -0.12 : 0.12, 0.2, 0]}><boxGeometry args={[0.08, 0.45, 0.08]} /></mesh>
        </group>
      ))}
      {[-1, 1].map((s) => <mesh key={s} material={P} position={[s * 0.66, 1.0, -0.05]}><boxGeometry args={[0.04, 0.55, 1.3]} /></mesh>)}
      <mesh material={P} position={[0, 1.02, -0.45]} rotation={[-0.35, 0, 0]}><boxGeometry args={[1.15, 0.04, 0.6]} /></mesh>
      <mesh material={W} position={[0.25, 1.55, 0.55]}><cylinderGeometry args={[0.05, 0.05, 1.1, 10]} /></mesh>
      <mesh material={W} position={[0.25, 2.12, 0.6]}><boxGeometry args={[0.42, 0.2, 0.18]} /></mesh>
      <mesh material={D} position={[0.25, 2.12, 0.7]}><boxGeometry args={[0.3, 0.1, 0.04]} /></mesh>
      {lights && [-0.35, 0.35].map((x) => <mesh key={x} material={lamp} position={[x, 0.82, 0.79]}><sphereGeometry args={[0.07, 10, 8]} /></mesh>)}
    </group>
  );
}

/** Lander (a generic CLPS-class lander, ~3 m across), legs and gold foil. */
function Lander() {
  return (
    <group>
      <mesh material={gold} position={[0, 1.6, 0]}><cylinderGeometry args={[1.0, 1.15, 1.3, 8]} /></mesh>
      <mesh material={white} position={[0, 2.45, 0]}><cylinderGeometry args={[0.55, 0.9, 0.4, 8]} /></mesh>
      <mesh material={panel} position={[0, 2.75, 0]} rotation={[0.2, 0, 0]}><boxGeometry args={[2.4, 0.05, 0.9]} /></mesh>
      {[0, 1, 2, 3].map((i) => {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        return (
          <group key={i} rotation={[0, -a, 0]}>
            <mesh material={white} position={[1.35, 0.75, 0]} rotation={[0, 0, 0.55]}><cylinderGeometry args={[0.06, 0.06, 1.8, 6]} /></mesh>
            <mesh material={white} position={[1.75, 0.05, 0]}><cylinderGeometry args={[0.28, 0.28, 0.08, 12]} /></mesh>
          </group>
        );
      })}
    </group>
  );
}

export function RouteView({ data, route, hour, labels, follow }: {
  data: RegionData; route: RouteDraw; hour: number; labels: React.RefObject<HTMLDivElement | null>[];
  follow?: React.RefObject<Controls | null>;
}) {
  const { cells, k, grid } = route;
  const { camera, size, invalidate } = useThree();
  const geo = useMemo(() => {
    // one point per move (waits collapse), Chaikin-smoothed twice for the ribbon; colour from the lighting at each move
    const pts: THREE.Vector3[] = [], cols: THREE.Color[] = [];
    const amber = new THREE.Color("#ffbe5c"), blue = new THREE.Color("#7a93ff");
    const add = (cell: number, lit: boolean) => {
      const c = centre(grid, cell);
      pts.push(scenePoint(data, c.x_m, c.y_m));
      cols.push(lit ? amber : blue);
    };
    add(cells[0], route.sunAlong[0] > 0);
    for (let s = 1; s < cells.length; s++) if (cells[s] !== cells[s - 1]) add(cells[s], route.sunAlong[s - 1] > 0);
    let P = pts, C = cols;
    for (let it = 0; it < 2 && P.length > 2; it++) {
      const p2: THREE.Vector3[] = [P[0]], c2: THREE.Color[] = [C[0]];
      for (let i = 0; i < P.length - 1; i++) {
        p2.push(P[i].clone().lerp(P[i + 1], 0.25), P[i].clone().lerp(P[i + 1], 0.75));
        c2.push(C[i].clone(), C[i + 1].clone());
      }
      p2.push(P[P.length - 1]); c2.push(C[C.length - 1]);
      P = p2; C = c2;
    }
    // re-drape the smoothed points on the terrain
    P = P.map((v) => { const g = gridFromScene(data, v.x, v.z); return scenePoint(data, g.x_m, g.y_m); });
    // waits of an hour or more, labelled where they happen
    const waits: { at: THREE.Vector3; hours: number }[] = [];
    let run = 0;
    for (let s = 1; s <= cells.length; s++) {
      if (s < cells.length && cells[s] === cells[s - 1]) { run++; continue; }
      if (run >= k) { const c = centre(grid, cells[s - 1]); waits.push({ at: scenePoint(data, c.x_m, c.y_m, 0.05), hours: run / k }); }
      run = 0;
    }
    waits.sort((a, b) => b.hours - a.hours);
    return { points: P, colors: C, waits: waits.slice(0, labels.length - 2) };
  }, [route]);
  const start = useMemo(() => { const c = centre(grid, cells[0]); return scenePoint(data, c.x_m, c.y_m, 0); }, [route]);
  const end = useMemo(() => { const c = centre(grid, cells[cells.length - 1]); return scenePoint(data, c.x_m, c.y_m, 0); }, [route]);

  // the rover at the current hour (before departure: at the start; after arrival: at the target), between cells
  const s = Math.max(0, Math.min(cells.length - 1, (hour - route.departure) * k));
  const i0 = Math.floor(s), i1 = Math.min(cells.length - 1, i0 + 1);
  const a = centre(grid, cells[i0]), b = centre(grid, cells[i1]), f = s - i0;
  const pos = scenePoint(data, a.x_m + (b.x_m - a.x_m) * f, a.y_m + (b.y_m - a.y_m) * f, 0);
  const lit = route.sunAlong[Math.max(0, Math.min(route.sunAlong.length - 1, Math.floor(s)))] > 0;
  // heading: direction of the next move (a waiting rover keeps its last heading)
  const heading = useRef(0);
  let j = i0;
  while (j < cells.length - 1 && cells[j + 1] === cells[j]) j++;
  if (j < cells.length - 1) {
    const p = centre(grid, cells[j]), q = centre(grid, cells[j + 1]);
    heading.current = Math.atan2(q.x_m - p.x_m, -(q.y_m - p.y_m)); // scene: +x east, +z = -grid y
  }

  const rover = useRef<THREE.Group>(null);
  const lander = useRef<THREE.Group>(null);
  const beacon = useRef<THREE.Group>(null);
  const roverLabelAt = useMemo(() => new THREE.Vector3(), []);
  const endLabelAt = useMemo(() => new THREE.Vector3(), []);
  const yaw = useRef(heading.current);
  useFrame((_, dt) => {
    const r = rover.current;
    if (r) {
      // turn smoothly toward the heading (shortest way)
      const d = Math.atan2(Math.sin(heading.current - yaw.current), Math.cos(heading.current - yaw.current));
      yaw.current += d * (1 - Math.exp(-Math.min(dt, 0.1) * 6));
      r.rotation.set(0, Math.PI - yaw.current, 0);
      const sc = screenScale(camera, r.position, 0.0025, 34, size.height);
      r.scale.setScalar(sc * 0.001);
      roverLabelAt.copy(r.position).y += 0.0025 * sc + 0.004;
      if (Math.abs(d) > 1e-3) invalidate();
    }
    for (const g of [lander.current, beacon.current]) if (g) g.scale.setScalar(screenScale(camera, g.position, 0.004, 30, size.height) * 0.001);
    if (beacon.current) endLabelAt.copy(beacon.current.position).y += 0.004 * beacon.current.scale.x * 1000 + 0.004;
    // chase camera while the traverse plays: the orbit centre follows the rover, the camera keeps its bearing
    const c = follow?.current;
    if (c && r && route.follow) {
      const e = 1 - Math.exp(-Math.min(dt, 0.1) * 2.5);
      const off = camera.position.clone().sub(c.target);
      const len = off.length();
      c.target.lerp(r.position, e);
      off.setLength(len + (0.55 - len) * e);
      if (off.y < 0.12) off.y += (0.12 - off.y) * e;
      camera.position.copy(c.target).add(off);
      c.update();
      invalidate();
    }
  });

  return (
    <group>
      <Line points={geo.points} vertexColors={geo.colors} lineWidth={11} transparent opacity={0.2} depthWrite={false} />
      <Line points={geo.points} vertexColors={geo.colors} lineWidth={3.5} />
      <group ref={lander} position={start}><Lander /></group>
      <group ref={beacon} position={end}>
        <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.2, 3.0, 40]} /><meshBasicMaterial color="#f5c451" toneMapped={false} transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>
        <mesh position={[0, 3, 0]}><cylinderGeometry args={[0.08, 0.08, 6, 8]} /><meshBasicMaterial color="#f5c451" toneMapped={false} transparent opacity={0.8} /></mesh>
        <mesh position={[0, 6.2, 0]}><sphereGeometry args={[0.45, 14, 10]} /><meshBasicMaterial color="#ffd27a" toneMapped={false} /></mesh>
      </group>
      <group ref={rover} position={pos}><Rover lights={!lit} /></group>
      <Projector at={endLabelAt} el={labels[0]} />
      <Projector at={roverLabelAt} el={labels[1]} />
      {geo.waits.map((w, i) => <Projector key={i} at={w.at} el={labels[i + 2]} />)}
    </group>
  );
}

/** The Light Path planning area (the 3D region) as a glowing outline draped on the terrain. */
export function PlanArea({ data }: { data: RegionData }) {
  const pts = useMemo(() => {
    const t = data.manifest.terrain, inset = t.res_m * 1.5;
    const x0 = t.x0_m + inset, x1 = t.x0_m + t.cols * t.res_m - inset, y0 = t.y0_m - inset, y1 = t.y0_m - t.rows * t.res_m + inset;
    const out: THREE.Vector3[] = [], N = 60;
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      for (let i = 0; i < N; i++) out.push(scenePoint(data, ax + ((bx - ax) * i) / N, ay + ((by - ay) * i) / N, 0.006));
    };
    edge(x0, y0, x1, y0); edge(x1, y0, x1, y1); edge(x1, y1, x0, y1); edge(x0, y1, x0, y0);
    out.push(out[0].clone());
    return out;
  }, [data]);
  return (
    <>
      <Line points={pts} color="#6fe3e1" lineWidth={8} transparent opacity={0.18} depthWrite={false} />
      <Line points={pts} color="#6fe3e1" lineWidth={2} transparent opacity={0.85} />
    </>
  );
}

/** The chosen target before (or without) a route: a beacon that keeps a readable size. */
export function TargetMark({ data, at }: { data: RegionData; at: { x_m: number; y_m: number } }) {
  const { camera, size } = useThree();
  const pos = useMemo(() => scenePoint(data, at.x_m, at.y_m, 0), [data, at.x_m, at.y_m]);
  const g = useRef<THREE.Group>(null);
  useFrame(() => { if (g.current) g.current.scale.setScalar(screenScale(camera, g.current.position, 0.004, 30, size.height) * 0.001); });
  return (
    <group ref={g} position={pos}>
      <mesh position={[0, 0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[2.2, 3.0, 40]} /><meshBasicMaterial color="#f5c451" toneMapped={false} transparent opacity={0.9} side={THREE.DoubleSide} /></mesh>
      <mesh position={[0, 3, 0]}><cylinderGeometry args={[0.08, 0.08, 6, 8]} /><meshBasicMaterial color="#f5c451" toneMapped={false} transparent opacity={0.8} /></mesh>
      <mesh position={[0, 6.2, 0]}><sphereGeometry args={[0.45, 14, 10]} /><meshBasicMaterial color="#ffd27a" toneMapped={false} /></mesh>
    </group>
  );
}

/** Wait labels for the DOM layer (same order as RouteView places them). */
export function routeWaits(route: RouteDraw, max: number) {
  const out: number[] = [];
  let run = 0;
  for (let s = 1; s <= route.cells.length; s++) {
    if (s < route.cells.length && route.cells[s] === route.cells[s - 1]) { run++; continue; }
    if (run >= route.k) out.push(run / route.k);
    run = 0;
  }
  return out.sort((a, b) => b - a).slice(0, max);
}
