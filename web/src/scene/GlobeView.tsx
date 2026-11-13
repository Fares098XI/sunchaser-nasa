import { OrbitControls, PerformanceMonitor } from "@react-three/drei";
import { BitmapTextureLoader, stripedTexture, uploadQuietly, useBitmapTexture } from "./bitmapTexture";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, createRef, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { RegionData } from "../data/manifest";
import { EARTH_RADIUS_KM, SUN_RADIUS_DEG, skyDirection } from "../engine/sky";
import type { PeriodTracks } from "../engine/tracks";
import { DISPLAY_GLSL } from "./display";
import { detailNormalTexture } from "./detail";
import { Projector } from "./Label";
import { SkyTracker, newHits, rayAt, useSkyGestures } from "./skyPick";
import { quatAt } from "./SceneRoot";
import { BodyZoom } from "./BodyZoom";
import { OPENING, openingBearing } from "./opening";
import { decodeHeightsOff, sinceInput } from "../data/background";
import { makeFlare, sunMaterial, useEarthMaterial } from "./Sky";
import { MilkyWay, StarField } from "./Space";

/**
 * The whole Moon in space, as it is lit at the chosen hour: LROC WAC colour + LOLA relief (NASA SVS CGI Moon Kit),
 * sharper LOLA tiles streamed in where the camera looks, LOLA 80 m south polar caps, lunar-Lambert reflectance,
 * earthshine on the night side, Earth and the Sun in their true directions and the real star sky. The study area
 * (every catalogued site) and the 10 km analysis region are outlined so the pole is never mistaken for another spot.
 * Globe axes: X = MOON_ME x (lon 0), Y = MOON_ME z (north), Z = -MOON_ME y.
 */
const R = 1737.4;          // km
const FAR_KM = 30000;      // Sun and Earth are drawn this far out at their true angular size
const TILE_COLS = 8, TILE_ROWS = 4, TILE_DEG = 45; // pipeline export_assets.moontiles
const STUDY_MARGIN_KM = 14; // the study area: convex hull of every catalogued site, widened by this margin

/** Convex hull (polar grid km) of circles of STUDY_MARGIN_KM around each site. */
function studyHull(sites: GlobeSite[]): THREE.Vector2[] {
  const pts: [number, number][] = [];
  for (const s of sites) {
    const la = (s.lat_deg * Math.PI) / 180, lo = (s.lon_deg * Math.PI) / 180;
    const rho = 2 * R * Math.tan(Math.PI / 4 + la / 2);
    const x = rho * Math.sin(lo), y = rho * Math.cos(lo);
    for (let k = 0; k < 12; k++) pts.push([x + STUDY_MARGIN_KM * Math.cos((k * Math.PI) / 6), y + STUDY_MARGIN_KM * Math.sin((k * Math.PI) / 6)]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return hull.slice(0, 40).map(([x, y]) => new THREE.Vector2(x, y));
}

/** 16-bit packed polar heights (pipeline export_assets.save_heights) -> half-float km texture, linearly filtered;
 * decoded in a worker (a 2048^2 image on the main thread stalled the globe). */
function loadHeights(url: string, onReady: (t: THREE.DataTexture) => void) {
  decodeHeightsOff(url).then(({ n, data }) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    onReady(t);
  }, () => undefined);
}
interface Body { az: number; el: number; dist: number }
export interface GlobeSite { id: string; name: string; lat_deg: number; lon_deg: number; kind?: "atlas" | "pin"; group?: string; landed_utc?: string | null; status?: string }
/** pin colours of the lunar atlas (S4) */
const ATLAS_COLOR: Record<string, string> = { Apollo: "#f2f2f2", "Commercial (CLPS)": "#6be6a6", "Other countries": "#b49cff" };
export interface GlobeViewState { altKm: number; nearPole: boolean }
export interface GlobeDrift { clock: () => number; degPerSec: number }

interface Props {
  data: RegionData; period: PeriodTracks; local: number; sun: Body; earth: Body; sites: GlobeSite[];
  heroId: string; diving: boolean; onDived: () => void;
  /** the user has taken the controls: the Moon re-centres and the title steps aside */
  exploring: boolean; onInteract?: () => void; onView?: (s: GlobeViewState) => void;
  /** tap on the Sun or Earth */
  onFocus?: (body: "sun" | "earth") => void;
  zoomTo?: "sun" | "earth" | null;
  onZoomArrived?: () => void;
  /** Director tour: deterministic camera drift instead of auto-rotation */
  drift?: GlobeDrift;
  /** load the sharp polar textures now, before a dive needs them (and skip tile streaming) */
  preload?: boolean;
  /** open looking straight down at this spot (zooming out of the surface view) */
  startAt?: { lat: number; lon: number; altKm: number } | null;
  /** kept alive but paused and out of sight (the surface view is on): no frames, no rebuild when it comes back */
  hidden?: boolean;
  /** fading out after a dive: draw, but load nothing new */
  leaving?: boolean;
  /** first frame can be drawn without a stall */
  onReady?: () => void;
  /** landing sites anywhere on the Moon (S4): pins with clickable labels */
  atlas?: GlobeSite[];
  onAtlas?: (id: string) => void;
  /** S5: tap the Moon to drop a pin; the pin and its label (label click = open it) */
  onPin?: (lat: number, lon: number) => void;
  pin?: { lat: number; lon: number; label: React.ReactNode; busy: boolean } | null;
  onPinOpen?: () => void;
  /** the region the dive lands in when it is not one of `sites` (S5b: the pin's own 3D region) */
  heroSite?: GlobeSite;
  /** fly the camera to look down at a point (typed coordinates); a new seq starts a new flight */
  flyTo?: GlobeFly | null;
}
export interface GlobeFly { lat: number; lon: number; altKm: number; seq: number }

/** The user's pin: a bright dot that lands with a shrinking ring, and a ring that pulses while it computes. */
function PinMark({ at, busy, dot }: { at: THREE.Vector3; busy: boolean; dot: THREE.Texture }) {
  const ring = useRef<THREE.Sprite>(null), t0 = useRef(performance.now());
  const tex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    g.strokeStyle = "rgba(255,242,200,1)"; g.lineWidth = 7;
    g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }, []);
  useEffect(() => { t0.current = performance.now(); }, [at.x, at.y, at.z]);
  useFrame(() => {
    const r = ring.current;
    if (!r) return;
    const t = (performance.now() - t0.current) / 1000, land = Math.min(1, t / 0.7);
    // landing: 0.09 -> 0.022 eased; then a slow pulse while the horizons compute
    const k = land < 1 ? 0.09 - 0.068 * (1 - (1 - land) ** 3) : busy ? 0.022 + 0.012 * ((t * 0.9) % 1) : 0.022;
    r.scale.set(k, k, 1);
    (r.material as THREE.SpriteMaterial).opacity = land < 1 ? 0.3 + 0.7 * land : busy ? 1 - ((t * 0.9) % 1) * 0.85 : 0.75;
  });
  return (
    <group position={at}>
      <sprite scale={[0.013, 0.013, 1]} renderOrder={6}>
        <spriteMaterial map={dot} color="#fff2c8" sizeAttenuation={false} transparent toneMapped={false} depthTest={false} />
      </sprite>
      <sprite ref={ring} scale={[0.022, 0.022, 1]} renderOrder={6}>
        <spriteMaterial map={tex} color="#f5c451" sizeAttenuation={false} transparent toneMapped={false} depthTest={false} />
      </sprite>
    </group>
  );
}

/** Rotation scene axes (at the hero site) -> globe axes. */
function sceneToGlobe(m: number[][]) {
  // ME vector of a scene axis = row of scene_from_me; globe = (me.x, me.z, -me.y)
  const g = (v: number[]) => [v[0], v[2], -v[1]];
  const [ax, ay, az] = m.map(g);
  return new THREE.Matrix4().set(ax[0], ay[0], az[0], 0, ax[1], ay[1], az[1], 0, ax[2], ay[2], az[2], 0, 0, 0, 0, 1);
}
const globeOf = (latDeg: number, lonDeg: number, r = 1) => {
  const la = (latDeg * Math.PI) / 180, lo = (lonDeg * Math.PI) / 180;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
};

const MOON_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uColor, uNormal, uCap, uCapHi, uCapWide, uHeight, uNear, uDetail, uTile, uTileC;
  uniform vec3 uSun, uEarth;
  uniform float uEarthLit, uCapHalf, uCapHiHalf, uCapHiOn, uCapWideHalf, uHeightHalf, uHeightOn, uTileOn, uTileCOn, uTileLon0, uTileLatTop, uHighlight, uTime;
  uniform vec2 uHero;
  uniform float uHeroHalf, uNearHalf, uNearOn;
  uniform vec2 uHull[40];
  uniform int uHullN;
  in vec3 vPos;
  in vec3 vWorld;
  out vec4 outColor;
  ${DISPLAY_GLSL}
  const float PI = 3.141592653589793;
  const float RK = ${R.toFixed(1)};

  // signed distance to the study-area polygon (negative inside), polar grid km
  float sdHull(vec2 p) {
    float d = dot(p - uHull[0], p - uHull[0]), s = 1.0;
    for (int i = 0; i < 40; i++) {
      if (i >= uHullN) break;
      int j = i == 0 ? uHullN - 1 : i - 1;
      vec2 e = uHull[j] - uHull[i], w = p - uHull[i];
      vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
      d = min(d, dot(b, b));
      bvec3 c = bvec3(p.y >= uHull[i].y, p.y < uHull[j].y, e.x * w.y > e.y * w.x);
      if (all(c) || all(not(c))) s *= -1.0;
    }
    return s * sqrt(d);
  }

  // weight of the native 80 m heights around the pole (0 outside them or before they load)
  float nearW(vec2 g) {
    vec2 q = abs(g) / uNearHalf;
    return uNearOn * (1.0 - smoothstep(0.88, 0.98, max(q.x, q.y)));
  }
  float heightKm(vec2 g) {
    float w = nearW(g);
    if (w >= 1.0) return texture(uNear, g / (2.0 * uNearHalf) + 0.5).r; // one fetch where the 80 m map alone applies
    float h = texture(uHeight, g / (2.0 * uHeightHalf) + 0.5).r;
    return w > 0.0 ? mix(h, texture(uNear, g / (2.0 * uNearHalf) + 0.5).r, w) : h;
  }

  // Visible part of the solar disc at a polar point: march toward the Sun over LOLA heights (curved Moon)
  float sunVisible(vec2 g0, vec3 up, vec3 gx, vec3 gy) {
    float sinEl = dot(uSun, up);
    vec3 sh = uSun - up * sinEl;
    float lh = length(sh);
    if (lh < 1e-4) return 1.0;
    vec2 d = vec2(dot(sh, gx), dot(sh, gy)) / lh;
    // over the 80 m heights: finer, more steps (0.1 km x 1.2^k reaches ~60 km); elsewhere 0.35 km x 1.27^k
    bool fine = nearW(g0) > 0.0;
    float tanEl = sinEl / lh, h0 = heightKm(g0) + 0.004, margin = 1.0, t = fine ? 0.1 : 0.35, f = fine ? 1.2 : 1.27;
    int n = fine ? 36 : 22;
    for (int i = 0; i < 36; i++) {
      if (i >= n) break;
      vec2 p = g0 + d * t;
      if (max(abs(p.x), abs(p.y)) > uHeightHalf) break;
      margin = min(margin, (h0 + t * tanEl + t * t / (2.0 * RK) - heightKm(p)) / t);
      if (margin < -0.006) break;
      t *= f;
    }
    return smoothstep(-0.00465, 0.00465, margin); // the Sun's angular radius: a soft, true penumbra
  }

  void main() {
    vec3 up = normalize(vPos);
    vec3 me = vec3(up.x, -up.z, up.y);
    float lat = asin(clamp(me.z, -1.0, 1.0)), lon = atan(me.y, me.x);
    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    vec3 albedo = pow(texture(uColor, uv).rgb, vec3(2.2));
    vec3 t = texture(uNormal, uv).xyz * 2.0 - 1.0;
    // this 45 x 45 deg patch's sharper tiles, faded in as the camera comes down: 474 m LOLA relief, ~2 km LRO WAC colour
    float du = degrees(lon) - uTileLon0;
    du += du < -180.0 ? 360.0 : 0.0;
    vec2 tuv = vec2(du / 45.0, (degrees(lat) - (uTileLatTop - 45.0)) / 45.0);
    if (all(greaterThanEqual(tuv, vec2(0.0))) && all(lessThanEqual(tuv, vec2(1.0)))) {
      if (uTileOn > 0.0) t = normalize(mix(t, texture(uTile, tuv).xyz * 2.0 - 1.0, uTileOn));
      if (uTileCOn > 0.0) albedo = mix(albedo, pow(texture(uTileC, tuv).rgb, vec3(2.2)), uTileCOn);
    }
    // the equirectangular colour map smears toward the pole: settle on the regolith's mean colour there
    albedo = mix(albedo, vec3(0.30, 0.29, 0.275), smoothstep(radians(-72.0), radians(-78.0), lat));
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up + vec3(1e-6, 0.0, 0.0)));
    vec3 north = cross(up, east);
    vec3 n = normalize(t.x * east + t.y * north + t.z * up);
    // south polar caps (polar stereographic grid: x = rho sin lon, y = rho cos lon): 450 m to 75 S, 297 m to 80 S, 104 m
    float rho = 2.0 * RK * tan(PI / 4.0 + lat / 2.0);
    vec2 g = vec2(rho * sin(lon), rho * cos(lon));
    vec3 gx = normalize(vec3(0.0, 0.0, -1.0) - up * dot(up, vec3(0.0, 0.0, -1.0))); // grid +x ~ MOON_ME +y
    vec3 gy = normalize(vec3(1.0, 0.0, 0.0) - up * dot(up, vec3(1.0, 0.0, 0.0)));   // grid +y ~ MOON_ME +x
    float wWide = smoothstep(radians(-72.5), radians(-75.0), lat);
    if (wWide > 0.0) {
      vec2 wuv = g / (2.0 * uCapWideHalf) + 0.5;
      vec3 c = texture(uCapWide, wuv).xyz * 2.0 - 1.0;
      vec2 cuv = g / (2.0 * uCapHalf) + 0.5;
      float mid = 1.0 - smoothstep(0.86, 0.98, 2.0 * max(abs(cuv.x - 0.5), abs(cuv.y - 0.5)));
      if (mid > 0.0) c = normalize(mix(c, texture(uCap, cuv).xyz * 2.0 - 1.0, mid));
      vec2 huv = g / (2.0 * uCapHiHalf) + 0.5;
      float hi = uCapHiOn * (1.0 - smoothstep(0.86, 0.98, 2.0 * max(abs(huv.x - 0.5), abs(huv.y - 0.5))));
      if (hi > 0.0) c = normalize(mix(c, texture(uCapHi, huv).xyz * 2.0 - 1.0, hi));
      n = normalize(mix(n, normalize(c.x * gx + c.y * gy + c.z * up), wWide));
    }
    vec3 V = normalize(cameraPosition - vWorld);
    float alt = length(cameraPosition) - RK;
    // below ~600 km near the pole: relief from the same 80 m heights that cast the shadows
    float wn = nearW(g) * (1.0 - smoothstep(300.0, 600.0, alt));
    if (wn > 0.0) {
      vec2 q = g / (2.0 * uNearHalf) + 0.5;
      float px = 1.0 / 2048.0, e = 2.0 * uNearHalf * px;
      float hx = texture(uNear, q + vec2(px, 0.0)).r - texture(uNear, q - vec2(px, 0.0)).r;
      float hy = texture(uNear, q + vec2(0.0, px)).r - texture(uNear, q - vec2(0.0, px)).r;
      vec3 cn = normalize(vec3(-hx, -hy, 2.0 * e));
      n = normalize(mix(n, normalize(cn.x * gx + cn.y * gy + cn.z * up), wn));
    }
    // close to the surface, faint sub-pixel relief (visual only)
    float near = 1.0 - smoothstep(40.0, 400.0, alt);
    if (near > 0.0) {
      vec2 duv = abs(lat) < radians(75.0) ? uv * vec2(2400.0, 1200.0) : g / 3.0;
      // two scales at an odd ratio and a rotation, so the repeating tile never reads as a pattern
      vec3 dd = texture(uDetail, duv).xyz * 2.0 - 1.0, de = texture(uDetail, mat2(0.8, -0.6, 0.6, 0.8) * duv * 0.37 + 0.31).xyz * 2.0 - 1.0;
      n = normalize(n + ((dd.x + de.x) * east + (dd.y + de.y) * north) * 0.05 * near);
    }
    float ph = degrees(acos(clamp(dot(uSun, V), -1.0, 1.0)));
    // the sphere's own curvature keeps the terminator; relief modulates the lit side
    float ll = lunarLambert(dot(n, uSun), dot(n, V), min(ph, 110.0)) * smoothstep(-0.02, 0.04, dot(up, uSun));
    // cast shadows near the pole, where the Sun grazes and the real ground is mostly in shadow
    float edge = max(abs(g.x), abs(g.y)) / uHeightHalf;
    if (uHeightOn > 0.5 && edge < 1.0 && ll > 0.0) ll *= mix(sunVisible(g, up, gx, gy), 1.0, smoothstep(0.85, 1.0, edge));
    vec3 col = albedo * vec3(1.0, 0.98, 0.95) * 2.5 * ll; // shadows black, as on the airless Moon
    // earthshine on the night side (Leonardo's glow), boosted for display
    col += albedo * vec3(0.5, 0.62, 0.9) * 0.02 * uEarthLit * max(dot(n, uEarth), 0.0);
    // where Sunchaser works: the study area around every catalogued site, and the 10 km analysis region
    if (lat < radians(-75.0) && uHighlight > 0.0 && uHullN > 2) {
      float sd = sdHull(g), fw = max(fwidth(sd), 1e-4);
      float line = 1.0 - smoothstep(0.7 * fw, 1.9 * fw, abs(sd));
      float glow = exp(-max(sd, 0.0) / (6.0 * fw + 1.5)) * step(0.0, sd);
      float inside = (1.0 - smoothstep(-fw, fw, sd));
      vec2 rel = g - uHero;
      float flow = 0.5 + 0.5 * sin(atan(rel.y, rel.x) * 24.0 - uTime * 1.6);   // light running along the edge
      col += vec3(1.0, 0.66, 0.24) * inside * exp(sd / (10.0 * fw)) * 0.06 * uHighlight; // a soft inner edge, shadows stay black
      col += vec3(1.0, 0.66, 0.24) * (line * (1.1 + 0.9 * flow) + glow * 0.22) * uHighlight;
      vec2 q = abs(g - uHero) - vec2(uHeroHalf);
      float box = max(q.x, q.y), fb = max(fwidth(box), 1e-4);
      float sq = 1.0 - smoothstep(0.7 * fb, 1.9 * fb, abs(box));
      float fill = (1.0 - smoothstep(-fb, fb, box)) * 0.1;
      col += vec3(0.35, 0.82, 1.0) * (sq * 2.0 + fill) * uHighlight;
    }
    outColor = vec4(display(col), 1.0);
  }`;

const MOON_VERTEX = /* glsl */ `
  out vec3 vPos;
  out vec3 vWorld;
  void main() {
    vPos = position;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
  }`;

const prep = (t: THREE.Texture) => { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; return t; };

/** The globe as 8 x 4 patches (45 deg each); every patch can carry its own sharper tile. */
function Moon({ sun, earth, earthLit, hero, heroHalf, hull, preload, noTiles }: { sun: THREE.Vector3; earth: THREE.Vector3; earthLit: number; hero: [number, number]; heroHalf: number; hull: THREE.Vector2[]; preload?: boolean; noTiles?: boolean }) {
  const [color, normal, cap, wide] = useBitmapTexture(["/textures/moon_color_4k.jpg", "/textures/moon_normal_4k.jpg", "/textures/moon_southcap_normal_2k.jpg", "/textures/moon_southcap_wide_2k.jpg"]);
  const shared = useMemo(() => ({
    uColor: { value: prep(color) }, uNormal: { value: prep(normal) }, uCap: { value: prep(cap) }, uCapWide: { value: prep(wide) },
    uCapHi: { value: null as THREE.Texture | null }, uCapHiOn: { value: 0 }, uCapHiHalf: { value: 212.0 }, uCapWideHalf: { value: 460.0 },
    uHeight: { value: null as THREE.Texture | null }, uHeightOn: { value: 0 }, uHeightHalf: { value: 304.0 },
    uNear: { value: null as THREE.Texture | null }, uNearOn: { value: 0 }, uNearHalf: { value: 81.92 },
    uSun: { value: new THREE.Vector3(1, 0, 0) }, uEarth: { value: new THREE.Vector3(1, 0, 0) }, uEarthLit: { value: 0 },
    uCapHalf: { value: 304.0 }, uDetail: { value: detailNormalTexture() }, uTime: { value: 0 },
    uHero: { value: new THREE.Vector2(...hero) }, uHeroHalf: { value: heroHalf }, uHighlight: { value: 1 },
    uHull: { value: Array.from({ length: 40 }, (_, i) => hull[i] ?? new THREE.Vector2()) }, uHullN: { value: hull.length },
  }), [color, normal, cap, wide]);
  const { invalidate: inv } = useThree();
  useEffect(() => loadHeights("/textures/moon_southcap_height_1k.png", (t) => { shared.uHeight.value = t; shared.uHeightOn.value = 1; inv(); }), [shared]);
  const patches = useMemo(() => {
    const out: { geo: THREE.SphereGeometry; mat: THREE.ShaderMaterial; i: number; j: number; centre: THREE.Vector3 }[] = [];
    for (let j = 0; j < TILE_ROWS; j++) for (let i = 0; i < TILE_COLS; i++) {
      const lon0 = -180 + TILE_DEG * i, latTop = 90 - TILE_DEG * j;
      // three.js sphere: phi = pi + lon puts lon 0 on +X and lon 90 E on -Z (globe axes)
      const geo = new THREE.SphereGeometry(R, 40, 40, Math.PI + (lon0 * Math.PI) / 180, Math.PI / 4, ((90 - latTop) * Math.PI) / 180, Math.PI / 4);
      const mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: MOON_VERTEX, fragmentShader: MOON_FRAGMENT,
        uniforms: { ...shared, uTile: { value: null }, uTileOn: { value: 0 }, uTileC: { value: null }, uTileCOn: { value: 0 }, uTileLon0: { value: lon0 }, uTileLatTop: { value: latTop } },
      });
      out.push({ geo, mat, i, j, centre: globeOf(latTop - TILE_DEG / 2, lon0 + TILE_DEG / 2) });
    }
    return out;
  }, [shared]);
  shared.uSun.value.copy(sun);
  shared.uHero.value.set(...hero);
  shared.uHeroHalf.value = heroHalf;
  shared.uEarth.value.copy(earth);
  shared.uEarthLit.value = earthLit;

  // Stream tiles: patches inside the camera's view cone below 2,200 km get their relief and colour tiles (at most 6 patches kept: two 2048^2 maps each)
  const tiles = useRef(new Map<string, { tex: THREE.Texture | null; col: THREE.Texture | null; used: number }>());
  const capHi = useRef<"none" | "loading" | "ready">("none");
  const uploads = useRef<(() => void)[]>([]);
  const lastUpload = useRef(0);
  const near = useRef<"none" | "loading" | "ready">("none");
  // tiles and the sharp cap are decoded off the main thread (createImageBitmap) and uploaded one by one in pauses
  const loader = useMemo(() => new BitmapTextureLoader(), []);
  const { invalidate, gl } = useThree();
  useFrame(({ camera, clock, size }, dt) => {
    if (uploads.current.length && clock.elapsedTime - lastUpload.current > 0.15 && sinceInput() > 350) { lastUpload.current = clock.elapsedTime; uploads.current.shift()!(); }
    shared.uTime.value = clock.elapsedTime;
    const alt = camera.position.length() - R, dir = camera.position.clone().normalize();
    const D = R + Math.max(alt, 1);
    const horizon = Math.acos(Math.min(1, R / D));
    // central angle reached by the screen corner ray (the camera looks at the Moon's centre)
    const half = Math.atan(Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360) * Math.hypot(1, size.width / size.height));
    const sinHit = (D / R) * Math.sin(half);
    const cone = sinHit >= 1 ? horizon : Math.min(horizon, Math.asin(sinHit) - half);
    const fade = 1 - THREE.MathUtils.smoothstep(alt, 1200, 2200);
    for (const p of patches) {
      const key = `${p.i}_${p.j}`, ang = Math.acos(THREE.MathUtils.clamp(p.centre.dot(dir), -1, 1));
      // (the tour's dive skips them: each 2048^2 upload would stutter the camera; the polar caps cover its view)
      const want = !noTiles && alt < 2200 && ang < cone + 0.57; // 0.57 rad: centre-to-corner of a 45 x 45 deg patch
      const t = tiles.current.get(key);
      if (want && !t) {
        tiles.current.set(key, { tex: null, col: null, used: clock.elapsedTime });
        for (const kind of ["tex", "col"] as const) {
          loader.load(`/textures/moon_tiles/${kind === "tex" ? "n" : "c"}_${key}.jpg`, (tex) => {
            prep(tex);
            // uploaded one tile at a time (several 2048^2 uploads in one frame made the globe stutter)
            uploads.current.push(() => {
              const e = tiles.current.get(key);
              if (e) { gl.initTexture(tex); e[kind] = tex; invalidate(); } else tex.dispose();
            });
          }, undefined, () => undefined); // missing tile: keep the base map, never retry
        }
      }
      if (t && want) t.used = clock.elapsedTime;
      p.mat.uniforms.uTile.value = t?.tex ?? null;
      p.mat.uniforms.uTileOn.value = t?.tex && want ? fade : 0;
      p.mat.uniforms.uTileC.value = t?.col ?? null;
      p.mat.uniforms.uTileCOn.value = t?.col && want ? fade : 0;
    }
    const loaded = [...tiles.current.entries()].filter(([, v]) => v.tex || v.col).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of loaded.slice(0, Math.max(0, loaded.length - 6))) {
      for (const x of [v.tex, v.col]) { x?.dispose(); (x?.image as ImageBitmap | undefined)?.close?.(); }
      tiles.current.delete(k);
    }
    // native 80 m heights around the pole (5 MB) once the camera comes within 700 km of it; faded in over ~0.6 s
    if (near.current === "none" && (preload || (alt < 700 && dir.y < -0.97))) { // the tour loads it before its dive
      near.current = "loading";
      loadHeights("/textures/moon_southcap_height_near_2k.png", (t) => { shared.uNear.value = t; near.current = "ready"; invalidate(); });
    }
    if (near.current === "ready" && shared.uNearOn.value < 1) { shared.uNearOn.value = Math.min(1, shared.uNearOn.value + dt / 0.6); invalidate(); }
    // sharper south cap (104 m) when looking at the pole from below 2,500 km
    if (capHi.current === "none" && (preload || (alt < 2500 && dir.y < -0.6))) {
      capHi.current = "loading";
      // a 4096^2 map: uploaded in strips in the user's pauses
      stripedTexture(gl, "/textures/moon_southcap_hi_4k.jpg").then((tex) => {
        shared.uCapHi.value = prep(tex); shared.uCapHiOn.value = 1; capHi.current = "ready"; invalidate();
      }, () => { capHi.current = "ready"; }); // missing: stay on the 297 m cap
    }
  });
  return <>{patches.map((p) => <mesh key={`${p.i}_${p.j}`} geometry={p.geo} material={p.mat} />)}</>;
}

function GlobeEarth({ dir, dist, quat, sun }: { dir: THREE.Vector3; dist: number; quat: THREE.Quaternion; sun: THREE.Vector3 }) {
  const material = useEarthMaterial();
  material.uniforms.uSunDir.value.copy(sun);
  return (
    <mesh position={dir.clone().multiplyScalar(FAR_KM)} quaternion={quat} material={material}>
      <sphereGeometry args={[(EARTH_RADIUS_KM / dist) * FAR_KM, 96, 48]} />
    </mesh>
  );
}

function GlobeSun({ dir }: { dir: THREE.Vector3 }) {
  const material = useMemo(sunMaterial, []);
  const flare = useMemo(makeFlare, []);
  const r = Math.tan((SUN_RADIUS_DEG * Math.PI) / 180) * FAR_KM;
  material.uniforms.uR.value = r;
  const pos = dir.clone().multiplyScalar(FAR_KM);
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => ref.current?.quaternion.copy(camera.quaternion));
  return (
    <>
      <primitive object={flare} position={pos} raycast={() => null} />
      <mesh ref={ref} position={pos} material={material} renderOrder={-800} raycast={() => null}>
        <planeGeometry args={[r * 14, r * 14]} />
      </mesh>
    </>
  );
}

/**
 * Before the globe's first frame (under the boot screen): its shaders link in parallel and its maps upload one by one,
 * so neither happens in the middle of the first drag (a blocking link on first use froze the page ~1 s).
 */
function Compiled({ onDone }: { onDone: () => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    let live = true;
    gl.compileAsync(scene, camera).catch(() => undefined).then(() => uploadQuietly(gl, scene, () => live, 0)).then((ok) => ok && onDone());
    return () => { live = false; };
  }, []);
  return null;
}

/**
 * Draws the globe's frames (priority 1 takes rendering over from R3F): every other frame once the user has let go for
 * 2 s and nothing flies, which leaves the GPU room for background uploads (they took 1-2 s against a busy GPU) and keeps
 * the laptop cool; full rate otherwise.
 */
function IdleRate({ busy }: { busy: boolean }) {
  const n = useRef(0);
  useFrame(({ gl, scene, camera }) => {
    if (!busy && sinceInput() > 2000 && n.current++ % 2) return;
    gl.render(scene, camera);
  }, 1);
  return null;
}

type Orbit = { enabled: boolean; autoRotate: boolean; zoomSpeed: number; rotateSpeed: number; update: () => void };

/**
 * Camera: free orbit around the Moon with speeds that scale with altitude (a wheel step is ~15 % of the height, so you
 * can go from 15,000 km down to 8 km smoothly), near plane following the altitude; on "dive", an eased flight onto
 * the hero site.
 */
function Rig({ start, site, back, diving, onDived, exploring, onView, controls, drift, flyTo }: {
  start: THREE.Vector3; site: THREE.Vector3; back: THREE.Vector3; diving: boolean; onDived: () => void;
  exploring: boolean; onView?: (s: GlobeViewState) => void; controls: React.RefObject<Orbit | null>;
  drift?: GlobeDrift; flyTo?: GlobeFly | null;
}) {
  const { camera, size } = useThree();
  const shift = useRef(1); // wide screens: the Moon sits right of the title until the user takes over
  const dive = useRef<{ t: number; from: THREE.Vector3; fromLook: THREE.Vector3 } | null>(null);
  const last = useRef({ alt: -1, near: false });
  // (re)framed whenever the globe is shown again: back to orbit, controls live, no dive in progress
  useEffect(() => {
    if (diving) return;
    dive.current = null;
    camera.position.copy(start);
    camera.lookAt(0, 0, 0);
    if (controls.current) { controls.current.enabled = true; controls.current.autoRotate = !drift && !exploring; }
  }, [start]);
  useEffect(() => {
    if (!diving || dive.current) return;
    if (controls.current) { controls.current.enabled = false; controls.current.autoRotate = false; }
    dive.current = { t: 0, from: camera.position.clone(), fromLook: new THREE.Vector3(0, 0, 0) };
  }, [diving]);
  useEffect(() => { if (exploring && controls.current) controls.current.autoRotate = false; }, [exploring]);
  // typed coordinates: an eased flight over the sphere to look straight down at the point
  const fly = useRef<{ t: number; from: THREE.Vector3; to: THREE.Vector3 } | null>(null);
  useEffect(() => {
    if (!flyTo || diving) return;
    const to = globeOf(flyTo.lat, flyTo.lon, R + flyTo.altKm);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { camera.position.copy(to); camera.lookAt(0, 0, 0); return; }
    fly.current = { t: 0, from: camera.position.clone(), to };
    if (controls.current) { controls.current.enabled = false; controls.current.autoRotate = false; }
  }, [flyTo?.seq]);
  useFrame((_, dt) => {
    const cam = camera as THREE.PerspectiveCamera;
    const wide = size.width > 900 ? 0.17 : 0;
    if (dive.current || exploring) shift.current = Math.max(0, shift.current - dt / 0.9);
    cam.setViewOffset(size.width, size.height, -size.width * wide * shift.current, 0, size.width, size.height);
    const alt = cam.position.length() - R;
    const near = THREE.MathUtils.clamp(alt * 0.05, 0.05, 200);
    if (Math.abs(near - cam.near) / cam.near > 0.05) { cam.near = near; cam.far = 90000; cam.updateProjectionMatrix(); }
    const c = controls.current;
    if (c) {
      c.zoomSpeed = THREE.MathUtils.clamp((3 * alt) / cam.position.length(), 0.04, 1.5);
      c.rotateSpeed = 0.5 * THREE.MathUtils.clamp(alt / (1.2 * R), 0.012, 1);
    }
    const nearPole = alt < 900 && cam.position.clone().normalize().y < -Math.cos((14 * Math.PI) / 180);
    if (onView && (nearPole !== last.current.near || Math.abs(alt - last.current.alt) > Math.max(5, 0.05 * alt))) {
      last.current = { alt, near: nearPole };
      onView({ altKm: alt, nearPole });
    }
    // Director tour: the camera turns about the pole axis as a pure function of the tour clock
    if (drift && !dive.current) {
      camera.position.copy(start).applyAxisAngle(new THREE.Vector3(0, 1, 0), (drift.degPerSec * drift.clock() * Math.PI) / 180);
      camera.lookAt(0, 0, 0);
    }
    // shortcut: the polar caps carry 80-104 m data; elsewhere the global 474 m relief turns soft below ~300 km, so the zoom stops there
    if (c && !dive.current) {
      const polar = cam.position.clone().normalize().y < -Math.sin((77 * Math.PI) / 180);
      const want = R + (polar ? 8 : 300), cur = (c as unknown as { minDistance: number }).minDistance;
      (c as unknown as { minDistance: number }).minDistance = want < cur ? want : cur + (want - cur) * Math.min(1, dt * 1.5);
    }
    const f = fly.current;
    if (f) {
      f.t = Math.min(1, f.t + Math.min(dt, 1 / 30) / 1.8);
      const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
      const a = f.from.clone().normalize(), b = f.to.clone().normalize(), ang = a.angleTo(b);
      const dir = ang < 1e-4 ? b : a.clone().multiplyScalar(Math.sin((1 - e) * ang)).add(b.clone().multiplyScalar(Math.sin(e * ang))).divideScalar(Math.sin(ang));
      // rise a little mid-flight on long hops, so the Moon swings past rather than skims
      const r = THREE.MathUtils.lerp(f.from.length(), f.to.length(), e) + Math.sin(Math.PI * e) * Math.min(1500, ang * 900);
      camera.position.copy(dir.normalize().multiplyScalar(r));
      camera.lookAt(0, 0, 0);
      if (f.t >= 1) { fly.current = null; if (controls.current) controls.current.enabled = true; }
    }
    const d = dive.current;
    if (!d) return;
    d.t = Math.min(1, d.t + Math.min(dt, 1 / 30) / 2.8); // a slow frame (the surface view loading) never jumps
    const e = d.t < 0.5 ? 4 * d.t ** 3 : 1 - (-2 * d.t + 2) ** 3 / 2;
    // end: exactly where the surface view's descent begins (match cut): 60 km up, 45 km back from the opening view
    const end = site.clone().multiplyScalar(R + OPENING.diveUpKm).addScaledVector(back, OPENING.diveBackKm);
    const look = site.clone().multiplyScalar(R);
    camera.position.lerpVectors(d.from, end, e);
    camera.lookAt(new THREE.Vector3().lerpVectors(d.fromLook, look, Math.min(1, e * 1.4)));
    if (d.t >= 1) { dive.current = null; onDived(); }
  });
  return <OrbitControls ref={controls as never} enablePan={false} minDistance={R + 8} maxDistance={R * 9} autoRotate={!drift} autoRotateSpeed={0.25}
    enableDamping dampingFactor={0.07} rotateSpeed={0.5} />;
}

export function GlobeView({ data, period, local, sun, earth, sites, heroId, diving, onDived, onFocus, exploring, onInteract, onView, zoomTo, onZoomArrived, drift, preload, startAt, hidden, leaving, onReady, atlas, onAtlas, onPin, pin, onPinOpen, heroSite, flyTo }: Props) {
  const atlasRefs = useMemo(() => (atlas ?? []).map(() => createRef<HTMLButtonElement>()), [atlas?.length]);
  const orbit = useRef<Orbit | null>(null);
  const [dpr, setDpr] = useState(1.25);
  const [compiled, setCompiled] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const hits = useRef(newHits());
  useSkyGestures(wrap, hits, { onTap: (b) => { if (!diving) onFocus?.(b); } });
  const pinLabel = useRef<HTMLButtonElement>(null);
  const onPinRef = useRef(onPin);
  onPinRef.current = diving || drift ? undefined : onPin;
  // a tap (not a drag) on the Moon drops a pin there: the view ray meets the sphere (Sun/Earth taps never get here)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let down: { x: number; y: number; t: number } | null = null;
    const pd = (e: PointerEvent) => { down = e.button === 0 && e.target instanceof HTMLCanvasElement ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; };
    const pu = (e: PointerEvent) => {
      const d = down, cam = hits.current.camera;
      down = null;
      if (!d || !cam || !onPinRef.current || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
      const dir = rayAt(hits.current, e.clientX, e.clientY, el.getBoundingClientRect()), o = cam.position;
      const b = o.dot(dir), c = o.lengthSq() - R * R, disc = b * b - c;
      if (disc < 0) return;
      const p = o.clone().addScaledVector(dir, -b - Math.sqrt(disc));
      const lat = (Math.asin(p.y / p.length()) * 180) / Math.PI, lon = (((Math.atan2(-p.z, p.x) * 180) / Math.PI) % 360 + 360) % 360;
      onPinRef.current(lat, lon);
    };
    el.addEventListener("pointerdown", pd);
    el.addEventListener("pointerup", pu);
    return () => { el.removeEventListener("pointerdown", pd); el.removeEventListener("pointerup", pu); };
  }, []);
  useEffect(() => {
    const el = wrap.current;
    if (!el || !onInteract) return;
    const take = () => onInteract();
    el.addEventListener("pointerdown", take);
    el.addEventListener("wheel", take, { passive: true });
    return () => { el.removeEventListener("pointerdown", take); el.removeEventListener("wheel", take); };
  }, [onInteract]);
  const m = data.manifest;
  const rot = useMemo(() => sceneToGlobe(m.scene_from_me), [m]);
  const rq = useMemo(() => new THREE.Quaternion().setFromRotationMatrix(rot), [rot]);
  const sunDir = new THREE.Vector3(...skyDirection(sun.az, sun.el)).applyMatrix4(rot).normalize();
  const earthDir = new THREE.Vector3(...skyDirection(earth.az, earth.el)).applyMatrix4(rot).normalize();
  const skyQ = rq.clone().multiply(quatAt(period.skyQ, local));
  const earthQ = rq.clone().multiply(quatAt(period.earthQ, local));
  const earthLit = (1 - sunDir.dot(earthDir)) / 2;
  const hero = heroSite ?? sites.find((s) => s.id === heroId) ?? sites[0];
  const site = globeOf(hero?.lat_deg ?? -89.45, hero?.lon_deg ?? 222.85);
  // horizontal unit vector from the site back toward the surface view's opening camera (globe axes)
  const diveBack = new THREE.Vector3(...skyDirection(openingBearing(sun.az, earth.az, earth.el), 0)).applyMatrix4(rot).normalize().negate();
  const t = m.terrain;
  const heroGrid: [number, number] = [(t.x0_m + (t.cols * t.res_m) / 2) / 1000, (t.y0_m - (t.rows * t.res_m) / 2) / 1000];
  // Opening: a three-quarter-lit Moon tipped to show the south pole, Sun off to one side.
  const [start] = useMemo(() => {
    if (startAt) return [globeOf(startAt.lat, startAt.lon, R + startAt.altKm)];
    // ?gcam=lat,lon,alt_km: open looking down at a spot (shareable views, tests)
    const gc = new URLSearchParams(location.search).get("gcam")?.split(",").map(Number);
    if (gc && gc.length === 3 && gc.every(Number.isFinite)) return [globeOf(gc[0], gc[1], R + Math.max(8, gc[2]))];
    const flat = new THREE.Vector3(sunDir.x, 0, sunDir.z).normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), flat).normalize();
    const v = flat.multiplyScalar(Math.cos(1.0)).addScaledVector(side, Math.sin(1.0)).normalize();
    v.y = -0.62;
    return [v.normalize().multiplyScalar(R * 4.5)];
  }, [!!drift, hidden, startAt?.lat, startAt?.lon]); // re-framed (not rebuilt) for the tour, a zoom-out or a return home
  const sky: [number, number, number] = [sunDir.x, sunDir.y, sunDir.z];
  const dot = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d")!;
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.35, "rgba(255,255,255,0.9)"); r.addColorStop(0.5, "rgba(255,255,255,0.25)"); r.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }, []);
  // R3F sizes its canvas from a ResizeObserver, whose first report can be skipped when the page is not painting
  // (background tab, headless); a resize event makes it measure again.
  useEffect(() => { const tm = setTimeout(() => dispatchEvent(new Event("resize")), 250); return () => clearTimeout(tm); }, []);
  const heroLabel = useRef<HTMLDivElement>(null);
  const studyLabel = useRef<HTMLDivElement>(null);
  const hull = useMemo(() => studyHull(sites), [sites]);
  // the study-area label sits on the outline's vertex farthest from the pole
  const studyAt = useMemo(() => {
    if (!hull.length) return globeOf(-84, 30, R + 1);
    const v = hull.reduce((a, b) => (b.length() > a.length() ? b : a));
    const lat = 2 * Math.atan(v.length() / (2 * R)) - Math.PI / 2, lon = Math.atan2(v.x, v.y);
    return globeOf((lat * 180) / Math.PI, (lon * 180) / Math.PI, R + 1);
  }, [hull]);
  return (
    <div ref={wrap} className="scene-wrap">
    <Canvas camera={{ fov: 32, near: 10, far: 90000, position: start.toArray() }} dpr={dpr} gl={{ antialias: true }} flat frameloop={hidden || !compiled ? "never" : "always"}>
      {/* resolution follows the frame rate (integrated GPUs at 1.5x are fill-rate bound on the polar shader) */}
      {!hidden && <PerformanceMonitor bounds={() => [45, 58]} flipflops={4} onDecline={() => setDpr((d) => Math.max(0.75, d - 0.25))}
        onIncline={() => setDpr((d) => Math.min(1.5, d + 0.25))} onFallback={() => setDpr(1)} />}
      <IdleRate busy={diving || !!drift || !!zoomTo} />
      <color attach="background" args={["#000000"]} />
      <StarField quat={skyQ} sunDir={sky} />
      <Suspense fallback={null}>
        <MilkyWay quat={skyQ} />
        <Moon sun={sunDir} earth={earthDir} earthLit={earthLit} hero={heroGrid} heroHalf={heroSite ? 0 : (t.cols * t.res_m) / 2000} hull={hull} preload={preload} noTiles={diving || !!drift || !!hidden || !!leaving} />
        <GlobeEarth dir={earthDir} dist={earth.dist} quat={earthQ} sun={sunDir} />
        <Compiled onDone={() => { setCompiled(true); onReady?.(); }} />
      </Suspense>
      <GlobeSun dir={sunDir} />
      {!diving && sites.map((s) => (
        <group key={s.id} position={globeOf(s.lat_deg, s.lon_deg, R + 0.5)}>
          <sprite scale={s.id === heroId ? [0.012, 0.012, 1] : [0.008, 0.008, 1]} renderOrder={5}>
            <spriteMaterial map={dot} color={s.id === heroId ? "#f5c451" : "#6fe3e1"} sizeAttenuation={false} transparent toneMapped={false} />
          </sprite>
        </group>
      ))}
      <Rig start={start} site={site} back={diveBack} diving={diving} onDived={onDived} exploring={exploring} onView={onView} controls={orbit} drift={drift} flyTo={flyTo} />
      <BodyZoom active={!!zoomTo} controls={orbit}
        target={zoomTo ? { pos: (zoomTo === "sun" ? sunDir : earthDir).clone().multiplyScalar(FAR_KM),
          radius: zoomTo === "sun" ? Math.tan((SUN_RADIUS_DEG * Math.PI) / 180) * FAR_KM : (EARTH_RADIUS_KM / earth.dist) * FAR_KM } : null}
        onArrived={() => onZoomArrived?.()} />
      {!diving && <Projector at={globeOf(hero?.lat_deg ?? -89.45, hero?.lon_deg ?? 222.85, R + 1)} el={heroLabel} onSphere range={[0, 900]} />}
      {!diving && <Projector at={studyAt} el={studyLabel} onSphere range={[500, 1e9]} />}
      {!diving && atlas?.map((s, i) => (
        <group key={s.id} position={globeOf(s.lat_deg, s.lon_deg, R + 0.5)}>
          <sprite scale={[0.009, 0.009, 1]} renderOrder={5}>
            <spriteMaterial map={dot} color={ATLAS_COLOR[s.group ?? ""] ?? "#f2f2f2"} sizeAttenuation={false} transparent toneMapped={false} />
          </sprite>
          <Projector at={globeOf(s.lat_deg, s.lon_deg, R + 1)} el={atlasRefs[i]} onSphere range={[0, 5200]} />
        </group>
      ))}
      {!diving && pin && <>
        <PinMark at={globeOf(pin.lat, pin.lon, R + 0.6)} busy={pin.busy} dot={dot} />
        <Projector at={globeOf(pin.lat, pin.lon, R + 1)} el={pinLabel} onSphere />
      </>}
      <SkyTracker hits={hits} sun={{ pos: sunDir.clone().multiplyScalar(FAR_KM), radius: Math.tan((SUN_RADIUS_DEG * Math.PI) / 180) * FAR_KM }}
        earth={{ pos: earthDir.clone().multiplyScalar(FAR_KM), radius: (EARTH_RADIUS_KM / earth.dist) * FAR_KM }} />
    </Canvas>
    <div ref={heroLabel} className="pin-label floating globe hero" style={{ display: diving ? "none" : undefined }}>{hero?.name ?? "Connecting Ridge"} · {Math.round((t.cols * t.res_m) / 1000)} km 3D region</div>
    <div ref={studyLabel} className="pin-label floating globe study" style={{ display: diving ? "none" : undefined }}>Sunchaser study area · 10 landing sites</div>
    {pin && (
      <button ref={pinLabel} className={`pin-label floating globe atlas mine ${pin.busy ? "busy" : ""}`} style={{ display: diving ? "none" : undefined }}
        onClick={() => onPinOpen?.()} title="Your pin: open its Sun, Earth and horizon analysis">{pin.label}</button>
    )}
    {atlas?.map((s, i) => (
      <button key={s.id} ref={atlasRefs[i]} className="pin-label floating globe atlas" style={{ display: diving ? "none" : undefined, borderColor: ATLAS_COLOR[s.group ?? ""] }}
        onClick={() => onAtlas?.(s.id)} title={`${s.name}: open its Sun, Earth and horizon analysis`}>
        {s.name}{s.landed_utc ? ` · ${s.landed_utc.slice(0, 4)}` : s.status === "planned" ? " · planned" : ""}
      </button>
    ))}
    </div>
  );
}
