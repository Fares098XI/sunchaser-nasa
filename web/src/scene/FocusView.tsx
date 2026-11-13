import { OrbitControls } from "@react-three/drei";
import { uploadQuietly, useBitmapTexture } from "./bitmapTexture";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { createRef, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { whenIdle } from "../data/background";
import { skyDirection } from "../engine/sky";
import { DISPLAY_GLSL } from "./display";
import { Projector } from "./Label";
import { useEarthMaterial } from "./Sky";
import { MilkyWay, StarField } from "./Space";

/**
 * Fly to Earth or the Sun from the site. Both scenes use the site's scene axes (so the stars, the Sun direction and
 * Earth's orientation are the same SPICE values as in Explore) and start from the Moon's side, as seen from the site.
 * Earth: true orientation and phase, clouds, night lights, atmosphere, the Moon at its true distance and size, and
 * the three DSN 70 m dishes with the Moon's elevation above each. Sun: an illustrative photosphere (granulation,
 * spots, limb darkening), chromosphere, prominences and corona, spinning about its true axis (time-lapse).
 */
interface Body { az: number; el: number; dist: number }
export interface Station { id: string; name: string; lat_deg: number; lon_deg: number; min_elev_deg: number }
const R_EARTH_KM = 6371.0088;

/** Fly in from far out along the Moon's direction; then free orbit. */
function Intro({ from, to }: { from: THREE.Vector3; to: THREE.Vector3 }) {
  const { camera } = useThree();
  const t = useRef(0);
  useEffect(() => { camera.position.copy(from); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0); }, []);
  useFrame((_, dt) => {
    if (t.current >= 1) return;
    t.current = Math.min(1, t.current + dt / 2.2);
    const e = 1 - (1 - t.current) ** 4;
    camera.position.lerpVectors(from, to, e);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

// ---------- Earth ----------

const cloudMaterial = (map: THREE.Texture) => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, transparent: true, depthWrite: false,
  uniforms: { uMap: { value: map }, uSunDir: { value: new THREE.Vector3() } },
  vertexShader: /* glsl */ `
    out vec3 vN; out vec2 vUv;
    void main() { vN = normalize(mat3(modelMatrix) * normal); vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D uMap; uniform vec3 uSunDir;
    in vec3 vN; in vec2 vUv; out vec4 outColor;
    ${DISPLAY_GLSL}
    void main() {
      float c = texture(uMap, vUv).r;
      float ndl = dot(normalize(vN), normalize(uSunDir));
      vec3 tint = mix(vec3(1.0, 0.45, 0.22), vec3(1.0), smoothstep(0.0, 0.3, ndl));
      // cloud tops stay lit a little past the ground terminator (they stand ~10 km higher)
      float lit = max(ndl + 0.03, 0.0) + exp(min(ndl, 0.0) * 10.0) * 0.04 * (1.0 - smoothstep(0.0, 0.2, ndl));
      vec3 col = tint * lit * 2.4;
      outColor = vec4(display(col), c * 0.9 * smoothstep(-0.35, -0.05, ndl + 0.1 * c));
    }`,
});

const atmosphereMaterial = () => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
  uniforms: { uSunDir: { value: new THREE.Vector3() } },
  vertexShader: /* glsl */ `
    out vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec3 uSunDir;
    in vec3 vWorld; out vec4 outColor;
    ${DISPLAY_GLSL}
    void main() {
      vec3 d = normalize(vWorld - cameraPosition);
      float t = -dot(cameraPosition, d);
      vec3 P = cameraPosition + d * t;                  // closest approach of the view ray to Earth's centre
      float b = length(P);
      if (b < 1.0) discard;                             // the planet itself is in front
      float glow = exp(-(b - 1.0) / 0.011);             // ~70 km scale height on a 6,371 km Earth
      float mu = dot(normalize(P), normalize(uSunDir));
      float lit = smoothstep(-0.18, 0.25, mu);
      vec3 c = mix(vec3(1.0, 0.42, 0.16), vec3(0.30, 0.56, 1.0), smoothstep(-0.05, 0.35, mu));
      outColor = vec4(display(c * glow * lit * 2.2), 1.0);
    }`,
});

function EarthScene({ sun, earth, earthQ, stations, labels, moonColor }: {
  sun: THREE.Vector3; earth: Body; earthQ: THREE.Quaternion; stations: (Station & { up: boolean })[];
  labels: React.RefObject<HTMLDivElement | null>[]; moonColor: string;
}) {
  const base = useEarthMaterial();
  const cloudsTex = useBitmapTexture("/textures/earth_clouds_2k.jpg");
  const moonTex = useBitmapTexture(moonColor);
  const clouds = useMemo(() => cloudMaterial(cloudsTex), [cloudsTex]);
  const atmo = useMemo(atmosphereMaterial, []);
  base.uniforms.uSunDir.value.copy(sun);
  base.uniforms.uExposure.value = 1.0;
  base.uniforms.uCloudMix.value = 0; // clouds are their own layer here
  base.uniforms.uAir.value = 0.35;
  clouds.uniforms.uSunDir.value.copy(sun);
  atmo.uniforms.uSunDir.value.copy(sun);
  const moonDir = new THREE.Vector3(...skyDirection(earth.az, earth.el)).negate(); // from Earth toward the site
  const moonDist = earth.dist / R_EARTH_KM;
  const station = (s: Station) => {
    const la = (s.lat_deg * Math.PI) / 180, lo = (s.lon_deg * Math.PI) / 180;
    // three.js sphere axes: +X lon 0, +Y north, +Z lon -90
    return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(1.004);
  };
  return (
    <>
      <directionalLight position={sun.clone().multiplyScalar(100)} intensity={2.2} />
      <group quaternion={earthQ}>
        <mesh material={base}><sphereGeometry args={[1, 160, 80]} /></mesh>
        <mesh material={clouds}><sphereGeometry args={[1.008, 160, 80]} /></mesh>
        {stations.map((s, i) => {
          const p = station(s);
          return (
            <group key={s.id} position={p}>
              <mesh><sphereGeometry args={[0.012, 12, 8]} /><meshBasicMaterial color={s.up ? "#6be6a6" : "#8e8a82"} toneMapped={false} /></mesh>
              <Projector at={p.clone().multiplyScalar(1.06).applyQuaternion(earthQ)} el={labels[i]} onSphere />
            </group>
          );
        })}
      </group>
      <mesh material={atmo}><sphereGeometry args={[1.045, 128, 64]} /></mesh>
      {/* the Moon, true size (0.273 Earth radii) and true distance; near side toward Earth */}
      <mesh position={moonDir.clone().multiplyScalar(moonDist)}>
        <sphereGeometry args={[0.2727, 64, 32]} />
        <meshStandardMaterial map={moonTex} roughness={1} metalness={0} />
      </mesh>
    </>
  );
}

// ---------- Sun ----------

const NOISE_GLSL = /* glsl */ `
  vec3 hash3(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }
  // Worley distances to the nearest and second-nearest feature point
  vec2 worley(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    float F1 = 8.0, F2 = 8.0;
    for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int k = -1; k <= 1; k++) {
      vec3 g = vec3(float(k), float(y), float(z));
      vec3 r = g + hash3(i + g) - f;
      float d = dot(r, r);
      if (d < F1) { F2 = F1; F1 = d; } else if (d < F2) { F2 = d; }
    }
    return sqrt(vec2(F1, F2));
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash3(i).x, b = hash3(i + vec3(1, 0, 0)).x, c = hash3(i + vec3(0, 1, 0)).x, d = hash3(i + vec3(1, 1, 0)).x;
    float e = hash3(i + vec3(0, 0, 1)).x, g = hash3(i + vec3(1, 0, 1)).x, h = hash3(i + vec3(0, 1, 1)).x, k = hash3(i + vec3(1, 1, 1)).x;
    return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

/** One-time GPU bake of the photosphere pattern into an equirectangular texture (seamless: sampled on the sphere). */
function useSunBake() {
  const { gl, invalidate } = useThree();
  const bake = useMemo(() => {
    const W = 2048, H = 1024;
    const rt = new THREE.WebGLRenderTarget(W, H, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `out vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        in vec2 vUv; out vec4 outColor;
        ${NOISE_GLSL}
        void main() {
          float lon = (vUv.x - 0.5) * 6.283185307, lat = (vUv.y - 0.5) * 3.141592654;
          vec3 p = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
          vec3 warp = vec3(vnoise(p * 9.0), vnoise(p * 9.0 + 7.1), vnoise(p * 9.0 + 3.7)) - 0.5;
          vec2 a = worley(p * 70.0 + warp * 1.4);
          vec2 b = worley(p * 70.0 + warp * 1.4 + vec3(0.41, 0.17, 0.73));
          float ga = smoothstep(0.02, 0.32, a.y - a.x) * (0.8 + 0.2 * vnoise(p * 140.0));
          float gb = smoothstep(0.02, 0.32, b.y - b.x) * (0.8 + 0.2 * vnoise(p * 140.0 + 5.0));
          vec2 s = worley(p * 14.0);
          float sg = smoothstep(0.0, 0.5, s.y - s.x);
          outColor = vec4(ga, gb, sg, fbm(p * 4.0));
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    const scene = new THREE.Scene();
    scene.add(quad);
    const cam = new THREE.Camera();
    quad.frustumCulled = false;
    return { rt, mat, quad, scene, cam, W, H };
  }, []);
  // baked in the background (built at page load, it froze the page ~2.7 s): the shader for the render target links
  // in parallel, then one strip per pause of the user's input
  useEffect(() => {
    const { rt, mat, quad, scene, cam, W, H } = bake;
    let live = true;
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(rt);
    const linked = gl.compileAsync(scene, cam).catch(() => undefined);
    gl.setRenderTarget(prev);
    (async () => {
      await linked;
      for (let k = 0; k < 8; k++) {
        await whenIdle(); if (!live) return;
        const p = gl.getRenderTarget();
        rt.scissorTest = true; rt.scissor.set(0, (k * H) / 8, W, H / 8);
        gl.setRenderTarget(rt); gl.render(scene, cam); gl.setRenderTarget(p);
        rt.scissorTest = false;
      }
      mat.dispose(); quad.geometry.dispose(); invalidate();
    })();
    return () => { live = false; };
  }, [bake]);
  return bake.rt.texture;
}

const SPOTS: [number, number, number][] = [[14, 40, 0.07], [-11, 75, 0.05], [19, 160, 0.04], [-22, 230, 0.06], [8, 300, 0.035]]; // lat, lon, radius (rad) — illustrative

function SunScene({ axis }: { axis: THREE.Vector3 }) {
  const bake = useSunBake();
  const spin = useRef<THREE.Group>(null);
  const sunMat = useMemo(() => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uBake: { value: bake }, uTime: { value: 0 },
      uSpots: { value: SPOTS.map(([la, lo, r]) => {
        const a = (la * Math.PI) / 180, o = (lo * Math.PI) / 180;
        return new THREE.Vector4(Math.cos(a) * Math.cos(o), Math.sin(a), -Math.cos(a) * Math.sin(o), r);
      }) },
    },
    vertexShader: /* glsl */ `
      out vec3 vPos; out vec3 vN; out vec3 vView;
      void main() {
        vPos = position;
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vView = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uBake; uniform float uTime; uniform vec4 uSpots[5];
      in vec3 vPos; in vec3 vN; in vec3 vView; out vec4 outColor;
      ${DISPLAY_GLSL}
      void main() {
        vec3 p = normalize(vPos);
        float lat = asin(clamp(p.y, -1.0, 1.0)), lon = atan(-p.z, p.x);
        vec4 b = texture(uBake, vec2(lon / 6.283185307 + 0.5, lat / 3.141592654 + 0.5));
        float gran = mix(b.r, b.g, 0.5 + 0.5 * sin(uTime * 0.35));      // granules boil
        float I = (0.62 + 0.38 * gran) * (0.9 + 0.1 * b.b);
        float spotDark = 0.0, pen = 0.0, fac = 0.0;
        for (int i = 0; i < 5; i++) {
          vec3 c = uSpots[i].xyz;
          vec3 t1 = normalize(cross(c, vec3(0.0, 1.0, 0.0))), t2 = cross(c, t1);
          float ang = atan(dot(p, t2), dot(p, t1));
          float ragged = 1.0 + 0.07 * sin(ang * 3.0 + float(i) * 1.7) + 0.05 * sin(ang * 7.0 + float(i)) + 0.12 * (b.a - 0.5);
          float d = acos(clamp(dot(p, c), -1.0, 1.0)) / (uSpots[i].w * ragged);
          float fil = 0.75 + 0.25 * sin(ang * 70.0 + d * 6.0);   // radial penumbral filaments
          spotDark = max(spotDark, 1.0 - smoothstep(0.32, 0.42, d));
          pen = max(pen, (1.0 - smoothstep(0.85, 1.0, d)) * fil);
          fac = max(fac, (1.0 - smoothstep(1.0, 2.6, d)) * b.a);
        }
        I *= mix(1.0, 0.5, pen);
        I *= mix(1.0, 0.1, spotDark);
        float mu = max(dot(normalize(vN), normalize(vView)), 0.0);
        float limb = 1.0 - 0.47 * (1.0 - mu) - 0.23 * (1.0 - mu) * (1.0 - mu); // quadratic limb darkening (visible)
        I += fac * 0.5 * pow(1.0 - mu, 2.0);                                     // faculae, bright near the limb
        vec3 tint = mix(vec3(0.95, 0.30, 0.05), vec3(1.0, 0.72, 0.34), pow(mu, 0.5));
        outColor = vec4(display(tint * I * limb * 1.35), 1.0);
      }`,
  }), [bake]);
  const coronaMat = useMemo(() => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `out vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime; in vec2 vP; out vec4 outColor;
      ${NOISE_GLSL}
      ${DISPLAY_GLSL}
      void main() {
        float r = length(vP);
        if (r < 0.995) discard;
        float ang = atan(vP.y, vP.x);
        vec3 q = vec3(cos(ang), sin(ang), 0.0);
        float streak = fbm(q * 3.0 + vec3(0.0, 0.0, log(r) * 0.8 - uTime * 0.01));
        float corona = pow(1.0 / r, 4.5) * (0.18 + 1.3 * pow(streak, 2.8)) * 0.55;
        float chrom = exp(-(r - 1.0) * 55.0);
        float m = fbm(q * 7.0 + vec3(0.0, 0.0, (r - 1.0) * 7.0 - uTime * 0.03));
        float where = smoothstep(0.5, 0.7, fbm(q * 2.0 + 11.0));
        // prominences: loops of plasma standing on the limb (H-alpha red), densest at their feet
        float loop = smoothstep(0.6, 0.78, m) * exp(-(r - 1.0) * 16.0) * where * smoothstep(1.0, 1.008, r);
        vec3 col = vec3(1.0, 0.86, 0.7) * corona + vec3(1.0, 0.32, 0.14) * chrom * 1.8 + vec3(1.0, 0.28, 0.22) * loop * 5.0;
        outColor = vec4(display(col), 1.0);
      }`,
  }), []);
  const corona = useRef<THREE.Mesh>(null);
  useFrame(({ camera, clock }, dt) => {
    sunMat.uniforms.uTime.value = clock.elapsedTime;
    coronaMat.uniforms.uTime.value = clock.elapsedTime;
    spin.current?.rotateOnAxis(new THREE.Vector3(0, 1, 0), dt * 0.05); // time-lapse spin about the true axis
    corona.current?.quaternion.copy(camera.quaternion);
  });
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis), [axis]);
  return (
    <>
      <group quaternion={q}>
        <group ref={spin}>
          <mesh material={sunMat}><sphereGeometry args={[1, 192, 96]} /></mesh>
        </group>
      </group>
      <mesh ref={corona} material={coronaMat}><planeGeometry args={[9, 9]} /></mesh>
    </>
  );
}

/** The Moon's elevation above each DSN dish (topocentric, from the dish's own position) and whether it is in reach. */
export function dsnElevations(stations: Station[], earth: Body, earthQ: THREE.Quaternion) {
  const e = new THREE.Vector3(...skyDirection(earth.az, earth.el));
  return stations.map((d) => {
    const la = (d.lat_deg * Math.PI) / 180, lo = (d.lon_deg * Math.PI) / 180;
    const up = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(earthQ);
    const toMoon = e.clone().multiplyScalar(-earth.dist).sub(up.clone().multiplyScalar(R_EARTH_KM)).normalize();
    const el = (Math.asin(up.dot(toMoon)) * 180) / Math.PI;
    return { ...d, el, up: el >= d.min_elev_deg };
  });
}

export interface FocusProps {
  kind: "earth" | "sun";
  sun: Body; earth: Body; earthQ: THREE.Quaternion; skyQ: THREE.Quaternion;
  stations: Station[];
  onClose: () => void;
  when: string;
  closing?: boolean;
  /** kept mounted (built in advance, paused when closed) so opening a close-up never waits for a new canvas */
  open?: boolean;
}

function Warm({ onDone }: { onDone: () => void }) {
  const { gl, scene, camera } = useThree();
  // compiled in parallel, then one hidden draw in a pause (D3D finishes shaders on first use); no frames before it
  useEffect(() => {
    let live = true;
    gl.compileAsync(scene, camera).catch(() => undefined).then(() => uploadQuietly(gl, scene, () => live)).then(() => whenIdle())
      .then(() => { if (live) { gl.render(scene, camera); onDone(); } });
    return () => { live = false; };
  }, []);
  return null;
}

export function FocusView({ kind, sun, earth, earthQ, skyQ, stations, onClose, when, closing, open = true }: FocusProps) {
  const [warm, setWarm] = useState(false);
  // each opening replays the arrival move
  const opens = useRef(0);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opens.current++;
  wasOpen.current = open;
  const s = new THREE.Vector3(...skyDirection(sun.az, sun.el));
  const e = new THREE.Vector3(...skyDirection(earth.az, earth.el));
  const labels = useMemo(() => stations.map(() => createRef<HTMLDivElement>()), [stations.length]);
  useEffect(() => {
    if (!open) return;
    const k = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose, open]);
  const st = dsnElevations(stations, earth, earthQ);
  // Sun's rotation axis: IAU north pole RA 286.13, Dec 63.87 (J2000) turned into scene axes by the sky quaternion
  const ra = (286.13 * Math.PI) / 180, dec = (63.87 * Math.PI) / 180;
  const axis = new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)).applyQuaternion(skyQ).normalize();
  const look = kind === "earth" ? e : s;
  // the telephoto zoom hands over with the body filling 40 % of the frame: start at that apparent size (fov 38)
  const from = look.clone().multiplyScalar(-1 / Math.sin(((0.4 * 38) / 2) * (Math.PI / 180)));
  const to = look.clone().multiplyScalar(-(kind === "earth" ? 3.1 : 3.6));
  const au = sun.dist / 149597870.7;
  const sunAt = s.clone().multiplyScalar(2000);
  const lit = Math.round(((1 - e.dot(s)) / 2) * 100);
  return (
    <div className={`focus ${closing ? "closing" : ""} ${open ? "" : "is-hidden"}`} role="dialog" aria-hidden={!open} aria-label={kind === "earth" ? "Earth close-up" : "Sun close-up"}>
      <Canvas camera={{ fov: 38, near: 0.01, far: 6000 }} dpr={[1, 1.5]} gl={{ antialias: true }} flat frameloop={open ? "always" : "never"}>
        {!warm && <Warm onDone={() => setWarm(true)} />}
        <color attach="background" args={["#000000"]} />
        <Suspense fallback={null}><MilkyWay quat={skyQ} /></Suspense>
        <StarField quat={skyQ} sunDir={[s.x, s.y, s.z]} />
        <Suspense fallback={null}>
          {/* both scenes stay built; the closed view shows neither (warm-up draws both once) */}
          <group visible={kind === "earth" || !warm}>
            <EarthScene sun={s} earth={earth} earthQ={earthQ} stations={st} labels={labels} moonColor="/textures/moon_color_4k.jpg" />
          </group>
          <group visible={kind === "sun" || !warm}><SunScene axis={axis} /></group>
        </Suspense>
        {kind === "earth" && <mesh position={sunAt}><sphereGeometry args={[9.3, 16, 8]} /><meshBasicMaterial color="#fff6e0" toneMapped={false} /></mesh>}
        <Intro key={opens.current} from={from} to={to} />
        <OrbitControls makeDefault enablePan={false} enableDamping dampingFactor={0.06} rotateSpeed={0.5} zoomSpeed={0.8}
          minDistance={kind === "earth" ? 1.12 : 1.25} maxDistance={kind === "earth" ? 90 : 40} />
      </Canvas>
      {open && kind === "earth" && st.map((d, i) => (
        <div key={d.id} ref={labels[i]} className={`pin-label floating dsn ${d.up ? "up" : ""}`}>
          {d.name} · Moon {d.el.toFixed(0)}°{d.up ? " · can hear you" : ""}
        </div>
      ))}
      <div className="focus-card glass">
        <div className="eyebrow">{kind === "earth" ? "Earth, as seen from the site" : "The Sun"}</div>
        <h2>{kind === "earth" ? "Earth" : "Sun"} <span className="dim num">· {when}</span></h2>
        {kind === "earth" ? (
          <dl className="stats">
            <div><dt>Lit from the Moon</dt><dd className="num">{lit}%</dd></div>
            <div><dt>Distance</dt><dd className="num">{Math.round(earth.dist).toLocaleString("en")} km</dd></div>
            <div><dt>Above your horizon</dt><dd className="num">{earth.el.toFixed(2)}°</dd></div>
            <div><dt>DSN dishes in reach</dt><dd className="num">{st.filter((d) => d.up).length} of 3</dd></div>
          </dl>
        ) : (
          <dl className="stats">
            <div><dt>Distance</dt><dd className="num">{au.toFixed(4)} au</dd></div>
            <div><dt>Light travel</dt><dd className="num">{Math.floor((sun.dist / 299792.458) / 60)} min {Math.round((sun.dist / 299792.458) % 60)} s</dd></div>
            <div><dt>Sunlight at the site</dt><dd className="num">{Math.round(1361 / (au * au))} W/m²</dd></div>
            <div><dt>Disc as seen</dt><dd className="num">{((2 * Math.asin(695700 / sun.dist) * 180) / Math.PI).toFixed(3)}°</dd></div>
          </dl>
        )}
        <p className="hint">
          {kind === "earth"
            ? "True orientation, phase and Moon distance for this hour (NASA/JPL SPICE). Green dishes see the Moon at least 6° above their horizon. Drag to orbit."
            : "Distance and sunlight for this hour (SPICE; 1361 W/m² at 1 au). The surface is an illustration: granulation, spots and prominences are simulated, spinning about the Sun's true axis in time-lapse. Drag to orbit."}
        </p>
        <button className="cta ghost small" onClick={onClose}>Back to the Moon <kbd>Esc</kbd></button>
      </div>
    </div>
  );
}
