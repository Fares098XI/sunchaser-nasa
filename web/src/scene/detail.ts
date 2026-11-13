import * as THREE from "three";

/**
 * Tileable micro-relief (small craters + rolling regolith) as a normal map, built once in the browser.
 * Visual only: it shades below the 20 m DEM resolution so close views do not look like smooth plastic;
 * it never changes where light falls (that comes from the horizons).
 */
let cached: THREE.DataTexture | null = null;

export function detailNormalTexture(size = 256): THREE.DataTexture {
  if (cached) return cached;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const h = new Float32Array(size * size);
  // value noise, two octaves, tileable
  const grid = (n: number) => { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
  for (const [n, amp] of [[8, 0.35], [32, 0.12]] as const) {
    const g = grid(n);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * n, fy = (y / size) * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => g[((j + n) % n) * n + ((i + n) % n)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      h[y * size + x] += amp * (a + (b - a) * sy);
    }
  }
  // craters: bowl with a raised rim, power-law sizes, wrapped around the tile edges
  for (let k = 0; k < 140; k++) {
    const cx = rnd() * size, cy = rnd() * size, r = 2 + 22 * Math.pow(rnd(), 3), depth = 0.25 * r / 22 + 0.04;
    const R = Math.ceil(r * 1.6);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const d = Math.hypot(dx, dy) / r;
      if (d > 1.6) continue;
      const v = d < 1 ? -depth * (1 - d * d) + 0.25 * depth * Math.exp(-((d - 0.95) ** 2) / 0.02) : 0.25 * depth * Math.exp(-((d - 1) ** 2) / 0.06);
      const x = ((Math.round(cx + dx) % size) + size) % size, y = ((Math.round(cy + dy) % size) + size) % size;
      h[y * size + x] += v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = (at(x + 1, y) - at(x - 1, y)) * 3, gy = (at(x, y + 1) - at(x, y - 1)) * 3;
    const inv = 1 / Math.hypot(gx, gy, 1);
    const o = 4 * (y * size + x);
    data[o] = Math.round((-gx * inv * 0.5 + 0.5) * 255);
    data[o + 1] = Math.round((-gy * inv * 0.5 + 0.5) * 255);
    data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
    data[o + 3] = Math.round(Math.min(1, Math.max(0, 0.5 + 0.8 * (h[y * size + x] - 0.24))) * 255); // albedo hint
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  cached = t;
  return t;
}

/** GLSL: perturb a world normal (y up) with the detail map at two scales, fading with camera distance. */
export const DETAIL_GLSL = /* glsl */ `
  uniform sampler2D uDetail;
  vec3 detailNormal(vec3 n, vec3 world, float strength) {
    float dist = length(cameraPosition - world);
    float near = 1.0 - smoothstep(1.5, 9.0, dist);
    vec3 a = texture(uDetail, world.xz / 0.42).xyz * 2.0 - 1.0;
    vec3 b = texture(uDetail, world.xz / 0.09 + 0.37).xyz * 2.0 - 1.0;
    vec2 d = a.xy * 0.55 + b.xy * 0.45 * (1.0 - smoothstep(0.4, 2.5, dist));
    return normalize(n + vec3(d.x, 0.0, d.y) * strength * (0.35 + 0.65 * near));
  }
  float detailAlbedo(vec3 world) {
    // fine speckle plus a broad, rotated mottle (odd scale ratio: no visible tiling), like regolith in NASA images
    float broad = texture(uDetail, mat2(0.8, -0.6, 0.6, 0.8) * world.xz / 3.7 + 0.21).a;
    return (0.92 + 0.16 * texture(uDetail, world.xz / 0.42).a) * (0.86 + 0.28 * broad);
  }
`;
