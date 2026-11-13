import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import type { HorizonGrid } from "../engine/horizon";
import { EARTH_RADIUS_KM, SUN_RADIUS_DEG, angularRadiusDeg, skyDirection } from "../engine/sky";
import { makeMaskTexture, makePaintTexture, makeTerrainMaterial } from "./terrainMaterial";
import { NearGround } from "./NearGround";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import { buildBvhOff } from "../data/background";

export type PaintMode = "live" | "sun" | "earth";
export interface Paint { mode: PaintMode; map: Uint8Array | null; layers: number; psr: boolean }

interface Body { az: number; el: number; dist: number }
interface Props {
  data: RegionData; horizon: HorizonGrid | null; sun: Body; earth: Body; penumbra: boolean;
  paint: Paint;
  onPick?: (p: THREE.Vector3) => void;
  /** double-click: fly the orbit centre here */
  steep?: { mask: Uint8Array; n: number } | null;
  onDoublePick?: (p: THREE.Vector3) => void;
  /** Astronaut's eye: draw the detailed ground around the camera */
  near?: boolean;
}

export const R_MOON_KM = 1737.4;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Real LOLA heights as a mesh, 1 scene unit = 1 km, no vertical exaggeration, centred on the region centre. */
export function Terrain({ data, horizon, sun, earth, penumbra, paint, onPick, onDoublePick, steep, near }: Props) {
  const { rows, cols, res_m } = data.manifest.terrain;
  const invalidate = useThree((s) => s.invalidate);
  const geometry = useMemo(() => {
    const hc = data.manifest.region.center_h_m;
    const pos = new Float32Array(rows * cols * 3);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c;
        const x = ((c + 0.5 - cols / 2) * res_m) / 1000, z = ((r + 0.5 - rows / 2) * res_m) / 1000; // row 0 = north = -z
        pos[3 * k] = x;
        pos[3 * k + 1] = (data.heights[k] - hc) / 1000 - (x * x + z * z) / (2 * R_MOON_KM); // the Moon curves away
        pos[3 * k + 2] = z;
      }
    }
    const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
    let i = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
        idx.set([a, d, b, b, d, e], i);
        i += 6;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    return g;
  }, [data]);

  const material = useMemo(() => {
    if (!horizon) return null;
    // Horizon cells cover the same window as the terrain (same x0/y0 and 10 km extent in the manifest).
    const psr = makeMaskTexture(data.psr, data.manifest.psr.cols, data.manifest.psr.rows);
    return makeTerrainMaterial(horizon, [(cols * res_m) / 1000, (rows * res_m) / 1000], psr, data.albedo);
  }, [horizon]);

  // light painting: swap in the map, then "paint" it in over ~1.2 s by sweeping through its checkpoints
  const progress = useRef(0);
  useEffect(() => {
    if (!material) return;
    const u = material.uniforms;
    const on = paint.mode !== "live" && paint.map;
    if (on) {
      (u.uPaint.value as THREE.Texture).dispose();
      u.uPaint.value = makePaintTexture(paint.map!, horizon!.cols, horizon!.rows, paint.layers);
      u.uPaintLayers.value = paint.layers;
      progress.current = reducedMotion() ? paint.layers - 1 : 0;
    }
    u.uPaintMode.value = on ? (paint.mode === "sun" ? 1 : 2) : 0;
    u.uPsrOn.value = paint.psr ? 1 : 0;
    invalidate();
  }, [material, paint.mode, paint.map, paint.psr]);
  // Light Path: ground steeper than the rover's limit, on the routing grid
  useEffect(() => {
    if (!material) return;
    const u = material.uniforms;
    if (steep) { (u.uSteep.value as THREE.Texture).dispose(); u.uSteep.value = makeMaskTexture(steep.mask, steep.n, steep.n); }
    u.uSteepOn.value = steep ? 1 : 0;
    invalidate();
  }, [material, steep?.mask]);

  useFrame(({ invalidate }, dt) => {
    if (!material || material.uniforms.uPaintMode.value === 0) return;
    const last = paint.layers - 1;
    if (progress.current >= last) return;
    progress.current = Math.min(last, progress.current + (dt / 1.2) * last);
    material.uniforms.uPaintLayer.value = progress.current;
    invalidate(); // keep drawing until the painting is in (the canvas renders on demand)
  });

  useEffect(() => {
    if (!material) return;
    const u = material.uniforms;
    u.uSunAz.value = sun.az;
    u.uSunEl.value = sun.el;
    u.uSunR.value = SUN_RADIUS_DEG;
    u.uSunDir.value.set(...skyDirection(sun.az, sun.el));
    u.uEarthAz.value = earth.az;
    u.uEarthEl.value = earth.el;
    u.uEarthR.value = angularRadiusDeg(EARTH_RADIUS_KM, earth.dist);
    u.uEarthDir.value.set(...skyDirection(earth.az, earth.el));
    // Earth's lit fraction seen from the Moon: new Earth when it stands next to the Sun
    u.uEarthLit.value = (1 - u.uEarthDir.value.dot(u.uSunDir.value)) / 2;
    u.uPenumbra.value = penumbra ? 1 : 0;
    invalidate();
  }, [material, sun.az, sun.el, earth.az, earth.el, earth.dist, penumbra]);

  // a bounding-volume tree, built in the worker: each press (click, start of a drag) tested 500k triangles, ~80 ms
  useEffect(() => {
    let live = true;
    buildBvhOff(geometry.getAttribute("position").array as Float32Array, geometry.getIndex()!.array as Uint32Array)
      .then((d) => { if (live) geometry.boundsTree = MeshBVH.deserialize({ ...d, index: null as never }, geometry, { setIndex: false }); }, () => undefined);
    return () => { live = false; };
  }, [geometry]);

  // Click (not drag) picks a point: ignore pointer-ups that moved, so orbiting never moves the pin.
  const pick = onPick && ((e: { point: THREE.Vector3; delta: number; stopPropagation: () => void }) => {
    if (e.delta > 4) return;
    e.stopPropagation();
    onPick(e.point.clone());
  });

  return material ? (
    <>
      <mesh geometry={geometry} material={material} onClick={pick} castShadow raycast={acceleratedRaycast}
        onDoubleClick={(e) => { e.stopPropagation(); onDoublePick?.(e.point.clone()); }} />
      <NearGround data={data} shared={material.uniforms} active={!!near} />
    </>
  ) : (
    <mesh geometry={geometry} onClick={pick} raycast={acceleratedRaycast}>
      <meshStandardMaterial color="#9a9890" roughness={1} metalness={0} />
    </mesh>
  );
}
