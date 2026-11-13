/**
 * Micro-relief below the 20 m DEM for close views (Astronaut's eye): rolling regolith plus craters at three scales,
 * from an integer hash of world position, so the ground is the same every visit. Visual only: no number reads it
 * (light and shadow at the DEM scale still come from the horizons). The same function exists in GLSL (MICRO_GLSL)
 * and in JS (microM) so the astronaut walks on exactly the ground that is drawn. Positions and heights in metres.
 * Smaller scales fade in with distance to the camera (geomorphing), so they never shimmer far away.
 */

// ---------- JS (same arithmetic as the GLSL below) ----------
function hash2(x: number, y: number, s: number) {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(s, 0xcb1ab31f)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}
const h01 = (x: number, y: number, s: number) => (hash2(x, y, s) & 0xffffff) / 16777216;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function vnoise(px: number, py: number, s: number) {
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h01(ix, iy, s), b = h01(ix + 1, iy, s), c = h01(ix, iy + 1, s), d = h01(ix + 1, iy + 1, s);
  return (a + (b - a) * ux + (c + (d - c) * ux - a - (b - a) * ux) * uy) * 2 - 1;
}

// each cell may hold one crater (centre inside the cell, reach 1.6 r <= 0.48 cell), so only the 2 x 2 block of cells
// nearest the point can touch it
function craters(px: number, py: number, cell: number, s: number, pr: number, rmin: number, rmax: number) {
  const cx0 = Math.floor(px / cell - 0.5), cy0 = Math.floor(py / cell - 0.5);
  let h = 0;
  for (let j = 0; j <= 1; j++) for (let i = 0; i <= 1; i++) {
    const cx = cx0 + i, cy = cy0 + j;
    if (h01(cx, cy, s) > pr) continue;
    const ox = (cx + h01(cx, cy, s + 1)) * cell, oy = (cy + h01(cx, cy, s + 2)) * cell;
    const r = rmin + (rmax - rmin) * h01(cx, cy, s + 3) ** 2;
    const d = Math.hypot(px - ox, py - oy) / r;
    if (d > 1.6) continue;
    const depth = r * (0.08 + 0.16 * h01(cx, cy, s + 4)), rim = depth * 0.22;
    h += d < 1 ? depth * (d * d - 1) + rim * smooth(0.6, 1, d) : rim * Math.exp(-((d - 1) ** 2) / 0.08);
  }
  return h;
}

/** Micro-relief height (m) at (x, y) metres in the region's scene plane, seen from camDist metres away. */
export function microM(x: number, y: number, camDist = 0) {
  const f1 = 1 - smooth(25, 60, camDist), f2 = 1 - smooth(80, 200, camDist), f3 = 1 - smooth(200, 290, camDist);
  let h = 0;
  if (f3 > 0) h += f3 * (0.30 * vnoise(x / 22, y / 22, 11) + craters(x, y, 24, 101, 0.4, 2.5, 7));
  if (f2 > 0) h += f2 * (0.12 * vnoise(x / 7, y / 7, 12) + craters(x, y, 9, 201, 0.3, 0.8, 2.7));
  if (f1 > 0) h += f1 * (0.04 * vnoise(x / 2.2, y / 2.2, 13) + craters(x, y, 3, 301, 0.22, 0.25, 0.9));
  return h;
}

// ---------- GLSL ----------
export const MICRO_GLSL = /* glsl */ `
  uint mhash(ivec2 p, uint s) {
    uint h = (uint(p.x) * 0x8da6b343u) ^ (uint(p.y) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
    h ^= h >> 13u; h *= 0x5bd1e995u; h ^= h >> 15u;
    return h;
  }
  float mh01(ivec2 p, uint s) { return float(mhash(p, s) & 0xffffffu) / 16777216.0; }
  float mnoise(vec2 p, uint s) {
    ivec2 i = ivec2(floor(p)); vec2 f = p - floor(p); vec2 u = f * f * (3.0 - 2.0 * f);
    float a = mh01(i, s), b = mh01(i + ivec2(1, 0), s), c = mh01(i + ivec2(0, 1), s), d = mh01(i + ivec2(1, 1), s);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
  }
  float mcraters(vec2 p, float cell, uint s, float pr, float rmin, float rmax) {
    ivec2 c0 = ivec2(floor(p / cell - 0.5));
    float h = 0.0;
    for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
      ivec2 c = c0 + ivec2(i, j);
      if (mh01(c, s) > pr) continue;
      vec2 o = (vec2(c) + vec2(mh01(c, s + 1u), mh01(c, s + 2u))) * cell;
      float r = rmin + (rmax - rmin) * pow(mh01(c, s + 3u), 2.0);
      float d = length(p - o) / r;
      if (d > 1.6) continue;
      float depth = r * (0.08 + 0.16 * mh01(c, s + 4u)), rim = depth * 0.22;
      h += d < 1.0 ? depth * (d * d - 1.0) + rim * smoothstep(0.6, 1.0, d) : rim * exp(-(d - 1.0) * (d - 1.0) / 0.08);
    }
    return h;
  }
  float microM(vec2 p, float camDist) {
    float f1 = 1.0 - smoothstep(25.0, 60.0, camDist), f2 = 1.0 - smoothstep(80.0, 200.0, camDist), f3 = 1.0 - smoothstep(200.0, 290.0, camDist);
    float h = 0.0;
    if (f3 > 0.0) h += f3 * (0.30 * mnoise(p / 22.0, 11u) + mcraters(p, 24.0, 101u, 0.4, 2.5, 7.0));
    if (f2 > 0.0) h += f2 * (0.12 * mnoise(p / 7.0, 12u) + mcraters(p, 9.0, 201u, 0.3, 0.8, 2.7));
    if (f1 > 0.0) h += f1 * (0.04 * mnoise(p / 2.2, 13u) + mcraters(p, 3.0, 301u, 0.22, 0.25, 0.9));
    return h;
  }
`;
