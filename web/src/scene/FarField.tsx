import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import { skyDirection } from "../engine/sky";
import { DETAIL_GLSL, detailNormalTexture } from "./detail";
import { DISPLAY_GLSL } from "./display";
import { albedoTexture } from "./terrainMaterial";
import { R_MOON_KM } from "./Terrain";
import { whenIdle } from "../data/background";

/**
 * Visual context around the analysed 10 km region: LOLA 80 m terrain resampled into two rings (+-25 km at 250 m,
 * +-150 km at 1 km) on the curved Moon, shaded like the hero terrain and shadowed by a shadow map of the real Sun
 * direction. No statistic reads it; numbers come only from the hero region's exact horizons.
 */
export interface FarFieldMeta {
  file: string; centre_x_m: number; centre_y_m: number;
  rings: { half_km: number; step_m: number; hole_km: number; n: number; h_min_m: number; h_max_m: number }[];
}

function ringGeometry(h: Int16Array, ring: FarFieldMeta["rings"][number], hc: number, drop: number) {
  const { n, half_km: half, hole_km: hole } = ring, s = ring.step_m / 1000;
  const pos = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j, x = -half + j * s, z = -half + i * s; // row 0 = north = -z
      const inside = Math.max(Math.abs(x), Math.abs(z)) < hole - 1e-6;
      pos[3 * k] = x;
      pos[3 * k + 1] = (h[k] - hc) / 1000 - (x * x + z * z) / (2 * R_MOON_KM) - (inside ? drop : 0);
      pos[3 * k + 2] = z;
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const cx = -half + (j + 0.5) * s, cz = -half + (i + 0.5) * s;
      if (Math.max(Math.abs(cx), Math.abs(cz)) < hole - s / 2) continue; // the finer ring (or hero) covers it
      const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** albedo: S5b pin regions' regional albedo over ±halfKm (the same LRO WAC map as the mesh), else uniform */
function farMaterial(albedo?: { data: Float32Array; n: number; halfKm: number } | null) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    lights: true,
    uniforms: { ...THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { uSunDir: { value: new THREE.Vector3(0, 1, 0) } }]), uDetail: { value: detailNormalTexture() },
      uAlbedo: { value: albedoTexture(albedo) }, uAlbedoOn: { value: albedo ? 1 : 0 }, uAlbedoHalf: { value: albedo?.halfKm ?? 1 } },
    vertexShader: /* glsl */ `
      #include <common>
      #include <shadowmap_pars_vertex>
      out vec3 vN;
      out vec3 vWorld;
      void main() {
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <project_vertex>
        #include <worldpos_vertex>
        #include <shadowmap_vertex>
        vN = normalize(mat3(modelMatrix) * normal);
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      uniform vec3 uSunDir;
      uniform sampler2D uAlbedo;
      uniform float uAlbedoOn, uAlbedoHalf;
      in vec3 vN;
      in vec3 vWorld;
      out vec4 outColor;
      ${DISPLAY_GLSL}
      ${DETAIL_GLSL}
      void main() {
        vec3 n = normalize(vN), V = normalize(cameraPosition - vWorld);
        vec3 nd = detailNormal(n, vWorld, 0.45);
        float g = degrees(acos(clamp(dot(uSunDir, V), -1.0, 1.0)));
        float reg = mix(1.0, texture(uAlbedo, vWorld.xz / (2.0 * uAlbedoHalf) + 0.5).r * 2.0, uAlbedoOn);
        vec3 col = regolith(vec3(0.60, 0.585, 0.56) * reg * detailAlbedo(vWorld), lunarLambert(dot(nd, uSunDir), dot(nd, V), min(g, 110.0)),
          getShadowMask(), uSunDir.y, vec3(0.0));
        outColor = vec4(display(col), 1.0);
      }`,
  });
}

export function FarField({ data, sun, onClickOutside }: { data: RegionData; sun: { az: number; el: number }; onClickOutside?: () => void }) {
  const meta = (data.manifest as unknown as { farfield?: FarFieldMeta }).farfield;
  const [geos, setGeos] = useState<THREE.BufferGeometry[] | null>(null);
  const material = useMemo(() => farMaterial(data.albedo?.far ? { data: data.albedo.far, n: data.albedo.n, halfKm: data.albedo.farHalfKm ?? 150 } : null), [data]);
  const light = useRef<THREE.DirectionalLight>(null);
  const { gl, invalidate } = useThree();

  useEffect(() => {
    if (!meta) return;
    let live = true;
    (data.farfieldBuf ? Promise.resolve(data.farfieldBuf) : fetch(data.base + meta.file).then((r) => r.arrayBuffer())).then(async (buf) => {
      const all = new Int16Array(buf), out: THREE.BufferGeometry[] = [];
      let o = 0;
      const hc = data.manifest.region.center_h_m;
      // one ring per idle moment (~0.2 s each on a laptop; all three at once was a 0.5 s stall)
      for (const [i, ring] of meta.rings.entries()) {
        await whenIdle(0);
        if (!live) return;
        out.push(ringGeometry(all.subarray(o, o + ring.n * ring.n), ring, hc, i === 0 ? 0.04 : 0.08));
        o += ring.n * ring.n;
      }
      setGeos(out);
    });
    return () => { live = false; };
  }, [meta?.file, data.farfieldBuf]);

  // Shadow camera fitted around the terrain as seen along the Sun: nearly horizontal light, so the map spends its
  // texels on height (~5 m) rather than on the 300 km of ground (~75 m across the beam).
  useEffect(() => {
    const L = light.current;
    if (!L || !meta) return;
    const d = new THREE.Vector3(...skyDirection(sun.az, sun.el));
    L.position.copy(d).multiplyScalar(400);
    L.target.position.set(0, 0, 0);
    L.target.updateMatrixWorld();
    L.updateMatrixWorld();
    const cam = L.shadow.camera as THREE.OrthographicCamera;
    cam.position.copy(L.position);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const half = meta.rings[meta.rings.length - 1].half_km, hc = data.manifest.region.center_h_m;
    const yLo = (Math.min(...meta.rings.map((r) => r.h_min_m)) - hc) / 1000 - (half * half) / R_MOON_KM;
    const yHi = (Math.max(...meta.rings.map((r) => r.h_max_m)) - hc) / 1000;
    const box = new THREE.Box3();
    const inv = cam.matrixWorldInverse;
    for (const x of [-half, half]) for (const y of [yLo, yHi]) for (const z of [-half, half]) box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
    cam.left = box.min.x; cam.right = box.max.x; cam.bottom = box.min.y; cam.top = box.max.y;
    cam.near = -box.max.z - 1; cam.far = -box.min.z + 1;
    cam.updateProjectionMatrix();
    material.uniforms.uSunDir.value.copy(d);
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [sun.az, sun.el, geos]);

  return (
    <>
      <directionalLight ref={light} castShadow intensity={0} shadow-mapSize={[4096, 4096]} shadow-bias={-0.0004} shadow-normalBias={0.06} />
      {geos?.map((g, i) => <mesh key={i} geometry={g} material={material} castShadow receiveShadow
        onClick={onClickOutside ? (e) => { if (e.delta <= 4) { e.stopPropagation(); onClickOutside(); } } : undefined} />)}
    </>
  );
}
