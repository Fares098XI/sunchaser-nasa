import * as THREE from "three";
import type { HorizonGrid } from "../engine/horizon";
import { DETAIL_GLSL, detailNormalTexture } from "./detail";
import { DISPLAY_GLSL } from "./display";

/**
 * Terrain shading from precomputed horizons: per fragment, the visible fraction of the solar disc over the
 * real terrain horizon. The GPU reads the same int16 horizon steps as engine/horizon.ts and interpolates them
 * the same way (bilinear between cell centres, linear between azimuth bins), then applies the same disc formula
 * as engine/sky.ts. Where it is lit, and how much of the Sun shows, is computed; the surface reflects like lunar
 * regolith (lunar-Lambert), and shadowed ground facing a visible Earth gets earthshine (Earth visibility from the same
 * horizons; its brightness is boosted for display, real earthshine is ~1e-4 of sunlight).
 */
/** uint8 per cell (PSR mask) on the horizon grid; nearest filtering keeps NASA's 60 m cells crisp. */
export function makeMaskTexture(mask: Uint8Array, cols: number, rows: number) {
  const t = new THREE.DataTexture(mask.map((v) => v * 255), cols, rows, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Light-painting checkpoints [layer][row][col] as uint8 0-255. */
export function makePaintTexture(map: Uint8Array, cols: number, rows: number, layers: number) {
  const t = new THREE.DataArrayTexture(map, cols, rows, layers);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/**
 * Horizon lookups shared by every surface shader (terrain, astronaut ground, rocks): needs `in vec2 vUv` (region
 * plane 0..1, row 0 = north) declared before it, and the uHorizon/uGrid/uNAz/uQuantum uniforms of the terrain material.
 */
export const HORIZON_GLSL = /* glsl */ `
  uniform highp isampler2DArray uHorizon;
  uniform vec2 uGrid;
  uniform float uNAz, uQuantum;
  uniform sampler2D uAlbedo;
  uniform float uAlbedoOn;
  const float PI = 3.141592653589793;

  // regional albedo relative to the Moon's mean (S5b pin regions: LRO WAC colour map; mare darker, highlands brighter)
  float regionAlbedo() { return mix(1.0, texture(uAlbedo, vUv).r * 2.0, uAlbedoOn); }

  float k(int layer, ivec2 p) { return float(texelFetch(uHorizon, ivec3(p, layer), 0).r); }

  // Bilinear between cell centres (row 0 = north = -z), same as engine/horizon.ts at fractional cells.
  float horizonAt(int layer) {
    vec2 f = clamp(vUv * uGrid - 0.5, vec2(0.0), uGrid - 1.0);
    ivec2 i0 = ivec2(floor(f));
    ivec2 i1 = min(i0 + 1, ivec2(uGrid) - 1);
    vec2 t = f - vec2(i0);
    float a = mix(k(layer, i0), k(layer, ivec2(i1.x, i0.y)), t.x);
    float b = mix(k(layer, ivec2(i0.x, i1.y)), k(layer, i1), t.x);
    return mix(a, b, t.y) * uQuantum;
  }

  float discFraction(float e, float h, float r) {
    float d = clamp((e - h) / r, -1.0, 1.0);
    return 1.0 - (acos(d) - d * sqrt(1.0 - d * d)) / PI;
  }

  // horizon toward a grid azimuth: linear between azimuth bins, as engine/horizon.ts
  float horizonToward(float az) {
    float u = mod(az, 360.0) * uNAz / 360.0;
    float a0 = floor(u);
    int l0 = int(a0) % int(uNAz);
    int l1 = (l0 + 1) % int(uNAz);
    return mix(horizonAt(l0), horizonAt(l1), u - a0);
  }
`;

/** Albedo factors (relative to the Moon's mean, 0..2) on an n x n grid, row 0 = north, as a smooth texture. */
export function albedoTexture(a: { data: Float32Array; n: number } | null | undefined) {
  const t = new THREE.DataTexture(a ? Uint8Array.from(a.data, (v) => Math.round(Math.min(2, Math.max(0, v)) * 127.5)) : new Uint8Array([128]),
    a?.n ?? 1, a?.n ?? 1, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function makeTerrainMaterial(g: HorizonGrid, extentKm: [number, number], psr: THREE.Texture, albedo?: { data: Float32Array; n: number } | null) {
  const tex = new THREE.DataArrayTexture(g.k, g.cols, g.rows, g.nAz);
  tex.format = THREE.RedIntegerFormat;
  tex.type = THREE.ShortType;
  tex.internalFormat = "R16I";
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.unpackAlignment = 2;
  tex.needsUpdate = true;

  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uPaint: { value: makePaintTexture(new Uint8Array(1), 1, 1, 1) },
      uPaintMode: { value: 0 },
      uPaintLayer: { value: 0 },
      uPaintLayers: { value: 1 },
      uPsr: { value: psr },
      uPsrOn: { value: 1 },
      uSteep: { value: makeMaskTexture(new Uint8Array(1), 1, 1) },
      uSteepOn: { value: 0 },
      uHorizon: { value: tex },
      uGrid: { value: new THREE.Vector2(g.cols, g.rows) },
      uNAz: { value: g.nAz },
      uQuantum: { value: g.quantum },
      uExtent: { value: new THREE.Vector2(...extentKm) },
      uSunAz: { value: 0 },
      uSunEl: { value: 0 },
      uSunR: { value: 0.2665 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uEarthAz: { value: 0 },
      uEarthEl: { value: -90 },
      uEarthR: { value: 0.95 },
      uEarthDir: { value: new THREE.Vector3(0, 1, 0) },
      uEarthLit: { value: 0 },
      uPenumbra: { value: 1 },
      uDetail: { value: detailNormalTexture() },
      uHole: { value: new THREE.Vector3(0, 0, 0) }, // x, z, radius (km): the astronaut's near ground is drawn there
      uAlbedo: { value: albedoTexture(albedo) },
      uAlbedoOn: { value: albedo ? 1 : 0 },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uExtent;
      out vec3 vN;
      out vec2 vUv;
      out vec3 vWorld;
      void main() {
        vN = normal;
        vUv = vec2(position.x / uExtent.x + 0.5, position.z / uExtent.y + 0.5);
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp isampler2DArray;
      precision highp sampler2DArray;
      uniform sampler2DArray uPaint;
      uniform sampler2D uPsr, uSteep;
      uniform float uSteepOn;
      uniform int uPaintMode;
      uniform float uPaintLayer, uPaintLayers, uPsrOn;
      uniform float uSunAz, uSunEl, uSunR, uPenumbra;
      uniform vec3 uHole;
      uniform vec3 uSunDir, uEarthDir;
      uniform float uEarthAz, uEarthEl, uEarthR, uEarthLit;
      ${DISPLAY_GLSL}
      ${DETAIL_GLSL}

      vec3 ramp(float v, vec3 c0, vec3 c1, vec3 c2, vec3 c3) {
        return v < 0.33 ? mix(c0, c1, v / 0.33) : v < 0.66 ? mix(c1, c2, (v - 0.33) / 0.33) : mix(c2, c3, (v - 0.66) / 0.34);
      }
      in vec3 vN;
      in vec2 vUv;
      in vec3 vWorld;
      out vec4 outColor;
      ${HORIZON_GLSL}

      void main() {
        if (uHole.z > 0.0 && length(vWorld.xz - uHole.xy) < uHole.z) discard;
        float frac = discFraction(uSunEl, horizonToward(uSunAz), uSunR);
        vec3 n = normalize(vN);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 nd = detailNormal(n, vWorld, 0.55);   // sub-DEM texture: shading only, never where light falls
        float g = degrees(acos(clamp(dot(uSunDir, V), -1.0, 1.0)));
        float ll = lunarLambert(dot(nd, uSunDir), dot(nd, V), min(g, 110.0));
        vec3 albedo = vec3(0.60, 0.585, 0.56) * detailAlbedo(vWorld) * regionAlbedo();
        float lit = frac * step(0.0, dot(n, uSunDir) + 0.02), light = lit * pow(ll, 0.6);
        // Earthshine where Earth is above this point's horizon (boosted for display: real earthshine is ~1e-4 of sunlight)
        float earth = uEarthEl > -8.0 ? discFraction(uEarthEl, horizonToward(uEarthAz), uEarthR) : 0.0;
        vec3 eshine = vec3(0.55, 0.68, 1.0) * 0.035 * uEarthLit * earth * max(dot(n, uEarthDir), 0.0);
        vec3 col = regolith(albedo, ll, lit, sin(radians(uSunEl)), eshine);
        // Penumbra: where only part of the disc shows, a faint amber rim.
        float pen = uPenumbra * smoothstep(0.0, 0.08, frac) * smoothstep(1.0, 0.92, frac);
        col = mix(col, vec3(1.0, 0.62, 0.22) * (0.3 + 2.0 * light), 0.55 * pen);
        col = display(col);

        if (uPaintMode > 0) {
          // light painting: the period average of the same quantity as the panel stats (0..1)
          float l0 = floor(uPaintLayer);
          float v = mix(texture(uPaint, vec3(vUv, l0)).r, texture(uPaint, vec3(vUv, min(l0 + 1.0, uPaintLayers - 1.0))).r,
                        uPaintLayer - l0);
          vec3 c = uPaintMode == 1
            ? ramp(v, vec3(0.012, 0.016, 0.035), vec3(0.16, 0.09, 0.03), vec3(1.0, 0.45, 0.10), vec3(1.0, 0.92, 0.70))
            : ramp(v, vec3(0.008, 0.02, 0.04), vec3(0.03, 0.16, 0.28), vec3(0.10, 0.55, 0.85), vec3(0.75, 0.95, 1.0));
          float relief = 0.55 + 0.6 * max(dot(n, normalize(vec3(0.35, 1.0, 0.25))), 0.0);
          col = pow(c * relief, vec3(1.0 / 2.2));
        }
        if (uSteepOn > 0.5 && texture(uSteep, vUv).r > 0.5) {
          // Light Path: too steep for the rover (red, diagonal hatch the other way from the PSR one)
          float hatch = step(0.6, fract((gl_FragCoord.x - gl_FragCoord.y) / 7.0));
          col = mix(col, vec3(0.75, 0.16, 0.2) * (0.6 + 0.4 * hatch), 0.55);
        }
        if (uPsrOn > 0.5 && texture(uPsr, vUv).r > 0.5) {
          // NASA permanent-shadow regions: deep blue with a fine hatch (meaning not carried by colour alone)
          float hatch = step(0.62, fract((gl_FragCoord.x + gl_FragCoord.y) / 6.0));
          col = mix(col, pow(vec3(0.05, 0.07, 0.22) + vec3(0.10, 0.16, 0.30) * hatch, vec3(1.0 / 2.2)), 0.9);
        }
        outColor = vec4(col, 1.0);
      }`,
  });
}
