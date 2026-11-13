import { Billboard } from "@react-three/drei";
import { useBitmapTexture } from "./bitmapTexture";
import { useMemo } from "react";
import * as THREE from "three";
import { Lensflare, LensflareElement } from "three/examples/jsm/objects/Lensflare.js";
import { EARTH_RADIUS_KM, SUN_RADIUS_DEG, skyDirection } from "../engine/sky";
import { DISPLAY_GLSL, SKY_KM } from "./display";

interface SkyBody { az: number; el: number; dist: number }

/** Canvas-drawn flare sprites (additive, sRGB). */
function sprite(draw: (g: CanvasRenderingContext2D, s: number) => void, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glare = () => sprite((g, s) => {
  const h = s / 2;
  const r = g.createRadialGradient(h, h, 0, h, h, h);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.03, "rgba(255,252,242,0.95)");
  r.addColorStop(0.09, "rgba(255,226,170,0.42)");
  r.addColorStop(0.3, "rgba(255,190,110,0.1)");
  r.addColorStop(1, "rgba(255,160,60,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
  // faint diffraction spikes of a camera aperture
  g.globalCompositeOperation = "lighter";
  for (let k = 0; k < 6; k++) {
    g.save();
    g.translate(h, h);
    g.rotate((k * Math.PI) / 3 + 0.2);
    const l = g.createLinearGradient(0, 0, h, 0);
    l.addColorStop(0, "rgba(255,245,225,0.5)");
    l.addColorStop(1, "rgba(255,245,225,0)");
    g.fillStyle = l;
    g.beginPath();
    g.moveTo(0, -1.2); g.lineTo(h, 0); g.lineTo(0, 1.2);
    g.fill();
    g.restore();
  }
}, 512);
const ghost = (rgb: string, ring: boolean) => sprite((g, s) => {
  const h = s / 2, r = g.createRadialGradient(h, h, 0, h, h, h);
  if (ring) {
    r.addColorStop(0.7, `rgba(${rgb},0)`); r.addColorStop(0.86, `rgba(${rgb},0.22)`); r.addColorStop(1, `rgba(${rgb},0)`);
  } else {
    r.addColorStop(0, `rgba(${rgb},0.18)`); r.addColorStop(0.8, `rgba(${rgb},0.08)`); r.addColorStop(1, `rgba(${rgb},0)`);
  }
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
}, 128);

/** Camera glare for the Sun: hides itself when terrain (or the Moon) covers the Sun's pixel. */
export function makeFlare() {
  const f = new Lensflare();
  f.addElement(new LensflareElement(glare(), 620, 0, new THREE.Color(1, 1, 1)));
  f.addElement(new LensflareElement(ghost("255,210,160", true), 90, 0.42, new THREE.Color(0.5, 0.5, 0.5)));
  f.addElement(new LensflareElement(ghost("150,200,255", false), 40, 0.62, new THREE.Color(0.45, 0.45, 0.45)));
  f.addElement(new LensflareElement(ghost("200,240,255", true), 150, 1.0, new THREE.Color(0.35, 0.35, 0.35)));
  return f;
}

interface SunProps { sun: SkyBody }

export const sunMaterial = () => new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uR: { value: 0.1 } },
  vertexShader: /* glsl */ `
    out vec2 vP;
    void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uR;
    in vec2 vP;
    out vec4 outColor;
    ${DISPLAY_GLSL}
    void main() {
      float d = length(vP) / uR;                 // in solar radii
      float mu = sqrt(max(1.0 - d * d, 0.0));
      // limb darkening, I(mu)/I(1) = 1 - 0.6 (1 - mu) (visible band); outside: a tight corona-like glow
      vec3 disc = vec3(1.0, 0.97, 0.92) * 40.0 * (1.0 - 0.6 * (1.0 - mu)) * smoothstep(1.02, 0.98, d);
      vec3 halo = vec3(1.0, 0.85, 0.62) * 0.9 * exp(-(d - 1.0) * 1.1) * step(1.0, d);
      outColor = vec4(display(disc + halo), 1.0);
    }`,
});

export function Sun({ sun }: SunProps) {
  const d = skyDirection(sun.az, sun.el);
  const r = Math.tan((SUN_RADIUS_DEG * Math.PI) / 180) * SKY_KM; // true angular size
  const material = useMemo(sunMaterial, []);
  material.uniforms.uR.value = r;
  const flare = useMemo(makeFlare, []);
  const pos: [number, number, number] = [d[0] * SKY_KM, d[1] * SKY_KM, d[2] * SKY_KM];
  return (
    <>
      <primitive object={flare} position={pos} raycast={() => null} />
      <Billboard position={pos}>
        <mesh material={material} renderOrder={-800} raycast={() => null}>
          <planeGeometry args={[r * 14, r * 14]} />
        </mesh>
      </Billboard>
    </>
  );
}

export const earthVertex = /* glsl */ `
  out vec3 vN;
  out vec2 vUv;
  out vec3 vView;
  void main() {
    vN = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

/** Day (Blue Marble NG), night lights (Black Marble 2016), clouds, ocean glint and a thin scattering limb. */
export const earthFragment = /* glsl */ `
  precision highp float;
  uniform sampler2D uDay, uNight, uClouds;
  uniform vec3 uSunDir;
  uniform float uExposure, uCloudMix, uAir;
  in vec3 vN;
  in vec2 vUv;
  in vec3 vView;
  out vec4 outColor;
  ${DISPLAY_GLSL}
  void main() {
    vec3 n = normalize(vN), v = normalize(vView), s = normalize(uSunDir);
    float ndl = dot(n, s);
    vec3 day = pow(texture(uDay, vUv).rgb, vec3(2.2));
    vec3 night = pow(texture(uNight, vUv).rgb, vec3(2.2));
    float cloud = texture(uClouds, vUv).r * uCloudMix;
    // direct sunlight, reddened by the long path through the air near the terminator
    vec3 sunTint = mix(vec3(1.0, 0.42, 0.18), vec3(1.0), smoothstep(0.0, 0.3, ndl));
    float direct = max(ndl, 0.0);
    // twilight: the sky keeps lighting the ground ~18 deg past the terminator, fading smoothly
    float twilight = exp(min(ndl, 0.0) * 9.0) * (1.0 - smoothstep(0.0, 0.2, ndl)) * 0.06;
    vec3 ground = mix(day, vec3(0.92), cloud * 0.85);
    vec3 col = ground * (sunTint * direct * 2.6 + vec3(0.55, 0.62, 0.9) * twilight);
    // sun glint on open water (water: bluer than red in Blue Marble NG), hidden by clouds
    float water = smoothstep(0.02, 0.10, day.b - day.r) * (1.0 - cloud);
    vec3 h = normalize(s + v);
    col += sunTint * pow(max(dot(n, h), 0.0), 80.0) * water * 1.6 * smoothstep(0.0, 0.15, ndl);
    // city lights fade in through dusk, dimmed under clouds
    float dark = 1.0 - smoothstep(-0.22, 0.04, ndl);
    col += night * vec3(1.0, 0.76, 0.48) * dark * (1.0 - 0.75 * cloud) * 2.2;
    // atmosphere: bright thin limb on the day side, reddened near the terminator
    // air seen edge-on near the limb: blue by day, glowing orange along the terminator, nothing on the night side
    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    float sunside = smoothstep(-0.25, 0.3, ndl);
    vec3 air = mix(vec3(1.0, 0.5, 0.25), vec3(0.35, 0.6, 1.0), smoothstep(-0.05, 0.3, ndl));
    col += air * rim * sunside * 1.6 * uAir;
    // haze over the whole day side, thicker toward the limb (softens the planet like real photographs)
    col += vec3(0.32, 0.52, 0.95) * 0.08 * (0.3 + rim) * smoothstep(-0.1, 0.4, ndl) * uAir;
    outColor = vec4(display(col * uExposure), 1.0);
  }`;

export function useEarthMaterial() {
  const [day, night, clouds] = useBitmapTexture(["/textures/earth_day_4k.jpg", "/textures/earth_night_2k.jpg", "/textures/earth_clouds_2k.jpg"]);
  return useMemo(() => {
    for (const t of [day, night, clouds]) { t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4; }
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uDay: { value: day }, uNight: { value: night }, uClouds: { value: clouds }, uSunDir: { value: new THREE.Vector3() }, uExposure: { value: 1 }, uCloudMix: { value: 1 }, uAir: { value: 1 } },
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
    });
  }, [day, night, clouds]);
}

export function Earth({ earth, quat, sunDir }: { earth: SkyBody; quat: THREE.Quaternion; sunDir: [number, number, number] }) {
  const material = useEarthMaterial();
  material.uniforms.uSunDir.value.set(...sunDir);
  const d = skyDirection(earth.az, earth.el);
  const radius = (EARTH_RADIUS_KM / earth.dist) * SKY_KM; // true angular size from the site
  return (
    <mesh position={[d[0] * SKY_KM, d[1] * SKY_KM, d[2] * SKY_KM]} quaternion={quat} material={material} renderOrder={-700}>
      <sphereGeometry args={[radius, 96, 48]} />
    </mesh>
  );
}
