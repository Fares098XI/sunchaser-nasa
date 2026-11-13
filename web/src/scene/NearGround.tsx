import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import { DISPLAY_GLSL } from "./display";
import { MICRO_GLSL, microM } from "./micro";
import { HORIZON_GLSL } from "./terrainMaterial";
import { uploadQuietly } from "./bitmapTexture";
import { whenIdle } from "../data/background";

/**
 * Astronaut's eye, the ground at your feet: a 600 m patch that follows the walker, 12 cm between vertices under the
 * eye and ~5 m at its rim, standing on the real LOLA 20 m heights plus visual micro-relief (scene/micro.ts), with
 * scattered rocks and a sun-aligned shadow map so bumps and boulders cast the long shadows of a grazing Sun.
 * DEM-scale light still comes from the horizons (same lookups as the terrain); the micro shadows only add to it.
 * The terrain below is cut away under the patch (uHole), so the two never overlap.
 */
export const NEAR_R_KM = 0.3;
const N = 257, WARP = 0.05, SHADOW_RES = 2048, SHADOW_HALF_KM = 0.21, R_MOON = 1737.4;

const HEIGHT_GLSL = /* glsl */ `
  uniform sampler2D uHeights;
  uniform vec2 uDemSize, uExtent, uCam;
  uniform float uRes, uHc;
  // bilinear between DEM vertices, exactly as the terrain mesh and Astronaut ground-following (SceneRoot.surfaceY)
  float demM(vec2 xz) {
    vec2 f = clamp(xz / uRes + uDemSize * 0.5 - 0.5, vec2(0.0), uDemSize - 1.0);
    ivec2 i0 = ivec2(floor(f)), i1 = min(i0 + 1, ivec2(uDemSize) - 1);
    vec2 t = f - vec2(i0);
    float a = mix(texelFetch(uHeights, i0, 0).r, texelFetch(uHeights, ivec2(i1.x, i0.y), 0).r, t.x);
    float b = mix(texelFetch(uHeights, ivec2(i0.x, i1.y), 0).r, texelFetch(uHeights, i1, 0).r, t.x);
    return mix(a, b, t.y);
  }
  float groundKm(vec2 xz, float camD) {
    return (demM(xz) - uHc) / 1000.0 - dot(xz, xz) / (2.0 * ${R_MOON.toFixed(1)}) + microM(xz * 1000.0, camD) / 1000.0;
  }
`;

const PATCH_VERTEX = /* glsl */ `
  uniform vec2 uCenter;
  uniform float uR, uWarp;
  out vec3 vWorld;
  out vec2 vUv;
  out vec3 vN;
  out float vCamD;
  ${MICRO_GLSL}
  ${HEIGHT_GLSL}
  void main() {
    vec2 g = position.xz;
    vec2 xz = uCenter + uR * (uWarp * g + (1.0 - uWarp) * g * abs(g));
    float camD = length(xz - uCam) * 1000.0;
    float sp = uR * (uWarp + 2.0 * (1.0 - uWarp) * max(abs(g.x), abs(g.y))) * ${(2 / (N - 1)).toFixed(8)};
    float e = max(0.00012, sp * 0.7);
    float y = groundKm(xz, camD);
    float yx = groundKm(xz + vec2(e, 0.0), camD), yz = groundKm(xz + vec2(0.0, e), camD);
    vN = normalize(vec3(-(yx - y) / e, 1.0, -(yz - y) / e));
    vWorld = vec3(xz.x, y, xz.y);
    vUv = vec2(xz.x / uExtent.x + 0.5, xz.y / uExtent.y + 0.5);
    vCamD = camD;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }`;

const ROCK_VERTEX = /* glsl */ `
  out vec3 vWorld;
  out vec2 vUv;
  out vec3 vN;
  out float vCamD;
  out float vTone;
  ${MICRO_GLSL}
  ${HEIGHT_GLSL}
  void main() {
    vec2 c = instanceMatrix[3].xz;
    float size = length(instanceMatrix[1].xyz);           // vertical extent of this rock (km)
    float camD = length(c - uCam) * 1000.0;
    vec4 w = instanceMatrix * vec4(position, 1.0);
    w.y += groundKm(c, camD) - 0.3 * size;                // half-buried, as rocks sit in regolith
    vN = normalize(mat3(instanceMatrix) * normal);
    vWorld = w.xyz;
    vUv = vec2(w.x / uExtent.x + 0.5, w.z / uExtent.y + 0.5);
    vCamD = camD;
    vTone = mh01(ivec2(floor(c * 100000.0)), 9u);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const SHADE_GLSL = /* glsl */ `
  uniform float uSunAz, uSunEl, uSunR, uEarthAz, uEarthEl, uEarthR, uEarthLit, uShadowOn;
  uniform vec3 uSunDir, uEarthDir;
  uniform highp sampler2D uShadow;
  uniform mat4 uShadowMat;
  uniform vec2 uShadowTexel;
  ${DISPLAY_GLSL}
  // micro shadows from the sun-aligned map (rocks, bumps), faded out at its border; 6 cm normal offset against acne
  float nearShadow(vec3 w, vec3 n) {
    if (uShadowOn < 0.5) return 1.0;
    vec3 q = (uShadowMat * vec4(w + n * 0.00006, 1.0)).xyz * 0.5 + 0.5;
    float edge = max(abs(q.x - 0.5), abs(q.y - 0.5)) * 2.0;
    if (edge >= 1.0 || q.z >= 1.0) return 1.0;
    float s = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
      s += step(q.z - 0.00004, textureLod(uShadow, q.xy + vec2(float(i), float(j)) * uShadowTexel, 0.0).r);
    return mix(s / 9.0, 1.0, smoothstep(0.85, 1.0, edge));
  }
  // same response as the terrain material, so the patch meets the terrain without a seam
  vec3 shade(vec3 n, vec3 nd, vec3 albedo, vec3 w) {
    float frac = discFraction(uSunEl, horizonToward(uSunAz), uSunR);
    vec3 V = normalize(cameraPosition - w);
    float g = degrees(acos(clamp(dot(uSunDir, V), -1.0, 1.0)));
    float ll = lunarLambert(dot(nd, uSunDir), dot(nd, V), min(g, 110.0));
    float lit = frac * (frac > 0.0 ? nearShadow(w, n) : 1.0) * step(0.0, dot(n, uSunDir) + 0.02);
    float earth = uEarthEl > -8.0 ? discFraction(uEarthEl, horizonToward(uEarthAz), uEarthR) : 0.0;
    vec3 eshine = vec3(0.55, 0.68, 1.0) * 0.035 * uEarthLit * earth * max(dot(nd, uEarthDir), 0.0);
    return display(regolith(albedo, ll, lit, sin(radians(uSunEl)), eshine));
  }
`;

const PATCH_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec2 uCenter;
  uniform float uR;
  uniform sampler2D uDetail;
  in vec3 vWorld;
  in vec2 vUv;
  in vec3 vN;
  in float vCamD;
  out vec4 outColor;
  ${HORIZON_GLSL}
  ${MICRO_GLSL}
  ${SHADE_GLSL}
  void main() {
    if (length(vWorld.xz - uCenter) >= uR) discard;   // the terrain draws outside, the patch inside
    vec3 n = normalize(vN);
    vec2 pm = vWorld.xz * 1000.0;
    // pebbles and regolith texture near the eye (detail map tiles of 2.5 m and 0.6 m)
    float d1 = 1.0 - smoothstep(6.0, 30.0, vCamD), d2 = 1.0 - smoothstep(2.0, 9.0, vCamD);
    vec4 ta = texture(uDetail, pm / 2.5);
    vec3 a = ta.xyz * 2.0 - 1.0, b = texture(uDetail, pm / 0.6 + 0.37).xyz * 2.0 - 1.0;
    vec3 nd = normalize(n + vec3(a.x, 0.0, a.y) * 0.35 * d1 + vec3(b.x, 0.0, b.y) * 0.3 * d2);
    float alb = 0.93 + 0.08 * mnoise(pm / 45.0, 21u) + 0.04 * mnoise(pm / 8.0, 22u) + 0.06 * (ta.a - 0.5) * d1;
    outColor = vec4(shade(n, nd, vec3(0.60, 0.585, 0.56) * alb * regionAlbedo(), vWorld), 1.0);
  }`;

const ROCK_FRAGMENT = /* glsl */ `
  precision highp float;
  in vec3 vWorld;
  in vec2 vUv;
  in vec3 vN;
  in float vCamD;
  in float vTone;
  out vec4 outColor;
  ${HORIZON_GLSL}
  ${SHADE_GLSL}
  void main() {
    vec3 n = normalize(vN);
    outColor = vec4(shade(n, n, vec3(0.50, 0.49, 0.47) * (0.75 + 0.4 * vTone), vWorld), 1.0);
  }`;

const DEPTH_FRAGMENT = /* glsl */ `precision highp float; out vec4 outColor; void main() { outColor = vec4(1.0); }`;

/** Lumpy, slightly flattened rock: an icosphere pushed in and out by a fixed pseudo-random field. */
function rockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 3.1 + 1.3) * Math.sin(v.y * 2.7 + 0.4) * Math.sin(v.z * 3.7 + 2.1);
    const facet = Math.max(0.78, 1 - 0.3 * Math.abs(Math.sin(v.x * 7.3 + v.z * 5.1)));
    v.multiplyScalar((1 + 0.28 * n) * facet);
    p.setXYZ(i, v.x, v.y * 0.62, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// rock fields: cells of `cell` m, each holding a rock with probability p; sizes skewed toward the small end
const TIERS = [
  { cell: 1.5, p: 0.1, dmin: 0.15, dmax: 0.9, radius: 110, seed: 7001 },
  { cell: 8, p: 0.08, dmin: 0.7, dmax: 3.0, radius: 280, seed: 7101 },
];
const MAX_ROCKS = 3000;
function hashU(x: number, y: number, s: number) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s, 0x9e3779b1)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
  return ((h >>> 0) & 0xffffff) / 16777216;
}
function placeRocks(mesh: THREE.InstancedMesh, depth: THREE.InstancedMesh, cxKm: number, czKm: number) {
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  let n = 0;
  const cx = cxKm * 1000, cz = czKm * 1000;
  for (const t of TIERS) {
    const r = Math.ceil(t.radius / t.cell), i0 = Math.floor(cx / t.cell), j0 = Math.floor(cz / t.cell);
    for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
      if (n >= MAX_ROCKS || hashU(i, j, t.seed) > t.p) continue;
      const x = (i + hashU(i, j, t.seed + 1)) * t.cell, z = (j + hashU(i, j, t.seed + 2)) * t.cell;
      if (Math.hypot(x - cx, z - cz) > t.radius) continue;
      const d = t.dmin * (t.dmax / t.dmin) ** (hashU(i, j, t.seed + 3) ** 2.2);
      e.set(hashU(i, j, t.seed + 4) * 6.28, hashU(i, j, t.seed + 5) * 6.28, hashU(i, j, t.seed + 6) * 0.6);
      q.setFromEuler(e);
      s.set(0.7 + 0.6 * hashU(i, j, t.seed + 7), 0.75 + 0.4 * hashU(i, j, t.seed + 8), 0.7 + 0.6 * hashU(i, j, t.seed + 9)).multiplyScalar(d / 2000);
      p.set(x / 1000, 0, z / 1000);
      m.compose(p, q, s);
      mesh.setMatrixAt(n++, m);
    }
  }
  mesh.count = depth.count = n;
  mesh.instanceMatrix.needsUpdate = true;
}

/** Mounted with the terrain so its shaders compile in the background; drawn (and the terrain cut away) only when
 * active and compiled, so entering Astronaut's eye never shows a hole while the GPU driver works. */
export function NearGround({ data, shared, active }: { data: RegionData; shared: Record<string, THREE.IUniform>; active: boolean }) {
  const { camera, gl, invalidate, scene } = useThree();
  const [ready, setReady] = useState(false);
  const t = data.manifest.terrain;

  const parts = useMemo(() => {
    const heights = new THREE.DataTexture(data.heights, t.cols, t.rows, THREE.RedFormat, THREE.FloatType);
    heights.minFilter = heights.magFilter = THREE.NearestFilter;
    heights.needsUpdate = true;
    const rt = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES);
    rt.depthTexture = new THREE.DepthTexture(SHADOW_RES, SHADOW_RES, THREE.UnsignedIntType);
    // sampled as a plain float texture and compared in the shader: works on every WebGL2 GPU (shadow samplers do not)
    rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.NearestFilter;
    const own = {
      uHeights: { value: heights }, uDemSize: { value: new THREE.Vector2(t.cols, t.rows) }, uRes: { value: t.res_m / 1000 },
      uHc: { value: data.manifest.region.center_h_m }, uCam: { value: new THREE.Vector2() }, uCenter: { value: new THREE.Vector2() },
      uR: { value: NEAR_R_KM }, uWarp: { value: WARP },
      uShadow: { value: rt.depthTexture }, uShadowMat: { value: new THREE.Matrix4() }, uShadowOn: { value: 0 },
      uShadowTexel: { value: new THREE.Vector2(1 / SHADOW_RES, 1 / SHADOW_RES) },
    };
    // the terrain material's uniform objects themselves: Sun, Earth, horizons and extent stay in step automatically
    const pick = ["uHorizon", "uGrid", "uNAz", "uQuantum", "uExtent", "uSunAz", "uSunEl", "uSunR", "uSunDir",
      "uEarthAz", "uEarthEl", "uEarthR", "uEarthDir", "uEarthLit", "uDetail", "uAlbedo", "uAlbedoOn"];
    const uniforms = { ...Object.fromEntries(pick.map((k) => [k, shared[k]])), ...own };
    const mat = (vertexShader: string, fragmentShader: string) =>
      new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader, fragmentShader });

    const pos = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      pos[3 * k] = (i / (N - 1)) * 2 - 1;
      pos[3 * k + 2] = (j / (N - 1)) * 2 - 1;
    }
    const idx = new Uint32Array((N - 1) * (N - 1) * 6);
    let o = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx.set([a, c, b, b, c, d], o);
      o += 6;
    }
    const patchGeo = new THREE.BufferGeometry();
    patchGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    patchGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    const patch = new THREE.Mesh(patchGeo, mat(PATCH_VERTEX, PATCH_FRAGMENT));
    const rockGeo = rockGeometry();
    const rocks = new THREE.InstancedMesh(rockGeo, mat(ROCK_VERTEX, ROCK_FRAGMENT), MAX_ROCKS);
    const shadowScene = new THREE.Scene();
    const patchDepth = new THREE.Mesh(patchGeo, mat(PATCH_VERTEX, DEPTH_FRAGMENT));
    const rocksDepth = new THREE.InstancedMesh(rockGeo, mat(ROCK_VERTEX, DEPTH_FRAGMENT), MAX_ROCKS);
    rocksDepth.instanceMatrix = rocks.instanceMatrix; // one set of rocks, drawn twice
    for (const o3 of [patch, rocks, patchDepth, rocksDepth]) o3.frustumCulled = false; // positions are built in the shader
    rocks.count = rocksDepth.count = 0;
    shadowScene.add(patchDepth, rocksDepth);
    const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    return { heights, rt, own, patch, rocks, shadowScene, shadowCam, placedAt: new THREE.Vector2(1e9, 1e9), hLo: 0, hHi: 0 };
  }, [data]);

  // give the shadow map defined contents before the first frame samples it (render() clears with the right masks)
  useEffect(() => {
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(parts.rt);
    gl.render(new THREE.Scene(), parts.shadowCam);
    gl.setRenderTarget(prev);
  }, [parts]);
  useEffect(() => {
    let live = true;
    // dev screenshots (?nearsync): skip the background compile and let the first draw compile synchronously
    if (import.meta.env.DEV && location.search.includes("nearsync")) { setReady(true); return; }
    setReady(false);
    // the shadow pass draws into its render target: compile that variant (the program key includes the output target)
    const prevRt = gl.getRenderTarget();
    gl.setRenderTarget(parts.rt);
    const shadowLinked = gl.compileAsync(parts.shadowScene, parts.shadowCam);
    gl.setRenderTarget(prevRt);
    // (compile skips hidden objects, and the patch stays hidden until it is ready)
    const vis = [parts.patch.visible, parts.rocks.visible];
    parts.patch.visible = parts.rocks.visible = true;
    const linked = [gl.compileAsync(parts.patch, camera, scene), gl.compileAsync(parts.rocks, camera, scene)];
    [parts.patch.visible, parts.rocks.visible] = vis;
    Promise.all([...linked, shadowLinked])
      .catch(() => undefined)
      // the scene's maps first (shared with the warm-up in SceneRoot), so this draw uploads nothing big
      .then(() => uploadQuietly(gl, scene, () => live))
      .then(() => whenIdle())
      .then(() => {
        if (!live) return;
        // one real draw, clipped to a single screen pixel: some drivers (Direct3D) finish shader work only on first use, so
        // entering Astronaut's eye later does not freeze. On screen, not into a render target: that would build (and
        // synchronously compile) a different shader variant, ~10 s of frozen page on an integrated GPU.
        const prev = gl.getRenderTarget(), vis = [parts.patch.visible, parts.rocks.visible];
        const sc = gl.getScissor(new THREE.Vector4()), st = gl.getScissorTest();
        placeRocks(parts.rocks, parts.shadowScene.children[1] as THREE.InstancedMesh, camera.position.x, camera.position.z);
        parts.patch.visible = parts.rocks.visible = true;
        gl.setRenderTarget(null); gl.setScissorTest(true); gl.setScissor(0, 0, 1, 1);
        gl.render(scene, camera);
        gl.setScissor(sc); gl.setScissorTest(st);
        gl.setRenderTarget(parts.rt); gl.render(parts.shadowScene, parts.shadowCam);
        gl.setRenderTarget(prev);
        [parts.patch.visible, parts.rocks.visible] = vis;
        parts.placedAt.set(1e9, 1e9);
        setReady(true); invalidate();
      });
    return () => { live = false; };
  }, [parts]);
  const on = active && ready;
  useEffect(() => {
    parts.patch.visible = parts.rocks.visible = on;
    if (!on) (shared.uHole.value as THREE.Vector3).set(0, 0, 0);
    invalidate();
  }, [on, parts]);
  useEffect(() => () => {
    (shared.uHole.value as THREE.Vector3).set(0, 0, 0);
    parts.heights.dispose(); parts.rt.dispose();
    parts.patch.geometry.dispose(); parts.rocks.geometry.dispose();
    (parts.patch.material as THREE.Material).dispose(); (parts.rocks.material as THREE.Material).dispose();
  }, [parts]);

  // height range (km) of the DEM around a point: fits the shadow camera to the ground it must cover
  const range = (cx: number, cz: number) => {
    const res = t.res_m / 1000, r = Math.ceil(0.25 / res), hc = data.manifest.region.center_h_m;
    const c0 = Math.round(cx / res + t.cols / 2 - 0.5), r0 = Math.round(cz / res + t.rows / 2 - 0.5);
    let lo = Infinity, hi = -Infinity;
    for (let rr = Math.max(0, r0 - r); rr <= Math.min(t.rows - 1, r0 + r); rr++)
      for (let cc = Math.max(0, c0 - r); cc <= Math.min(t.cols - 1, c0 + r); cc++) {
        const x = (cc + 0.5 - t.cols / 2) * res, z = (rr + 0.5 - t.rows / 2) * res;
        const y = (data.heights[rr * t.cols + cc] - hc) / 1000 - (x * x + z * z) / (2 * R_MOON);
        lo = Math.min(lo, y); hi = Math.max(hi, y);
      }
    return [lo - 0.004, hi + 0.004];
  };

  const box = useMemo(() => new THREE.Box3(), []);
  const corner = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    if (!on) return;
    const p = parts, cam = camera.position;
    // the patch centre moves in 4 m steps (its vertex lattice stays put in between)
    const cx = Math.round(cam.x / 0.004) * 0.004, cz = Math.round(cam.z / 0.004) * 0.004;
    p.own.uCenter.value.set(cx, cz);
    p.own.uCam.value.set(cam.x, cam.z);
    (shared.uHole.value as THREE.Vector3).set(cx, cz, NEAR_R_KM);
    if (Math.hypot(cx - p.placedAt.x, cz - p.placedAt.y) > 0.008) {
      placeRocks(p.rocks, p.shadowScene.children[1] as THREE.InstancedMesh, cx, cz);
      [p.hLo, p.hHi] = range(cx, cz);
      p.placedAt.set(cx, cz);
    }
    // sun-aligned shadow map, world-locked texels (no crawling while walking): camera fixed far up-sun of the origin,
    // the frustum fitted around the patch and snapped to whole texels
    const sd = shared.uSunDir.value as THREE.Vector3;
    const sunUp = (shared.uSunEl.value as number) > -1;
    p.own.uShadowOn.value = sunUp ? 1 : 0;
    if (!sunUp) return;
    const sc = p.shadowCam;
    sc.position.copy(sd).multiplyScalar(6);
    sc.up.set(0, 1, 0);
    if (Math.abs(sd.y) > 0.97) sc.up.set(0, 0, -1);
    sc.lookAt(0, 0, 0);
    sc.updateMatrixWorld();
    box.makeEmpty();
    for (const dx of [-SHADOW_HALF_KM, SHADOW_HALF_KM]) for (const dz of [-SHADOW_HALF_KM, SHADOW_HALF_KM]) for (const y of [p.hLo, p.hHi])
      box.expandByPoint(corner.set(cx + dx, y, cz + dz).applyMatrix4(sc.matrixWorldInverse));
    const tx = (box.max.x - box.min.x) / SHADOW_RES, ty = Math.max(1e-5, (box.max.y - box.min.y) / SHADOW_RES);
    sc.left = Math.floor(box.min.x / tx) * tx; sc.right = sc.left + tx * SHADOW_RES;
    sc.bottom = Math.floor(box.min.y / ty) * ty; sc.top = sc.bottom + ty * SHADOW_RES;
    sc.near = -box.max.z - 0.4; sc.far = -box.min.z + 0.05;
    sc.updateProjectionMatrix();
    p.own.uShadowMat.value.multiplyMatrices(sc.projectionMatrix, sc.matrixWorldInverse);
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(p.rt);
    gl.render(p.shadowScene, sc); // autoClear: colour and depth reset with depth writes on
    gl.setRenderTarget(prev);
  });

  return (
    <>
      <primitive object={parts.patch} />
      <primitive object={parts.rocks} />
    </>
  );
}

/** Ground height (km, scene axes) the astronaut stands on: the DEM surface plus the same micro-relief that is drawn. */
export function nearGroundKm(surfaceKm: number, x: number, z: number) {
  const h = microM(x * 1000, z * 1000, 0) / 1000;
  return Number.isFinite(surfaceKm + h) ? surfaceKm + h : surfaceKm;
}
