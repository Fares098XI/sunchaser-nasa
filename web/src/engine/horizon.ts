/** Horizon grid lookups, identical to pipeline/sunchaser/visibility.py horizon_at (V5 golden test). */

export interface HorizonGrid {
  nAz: number; rows: number; cols: number;
  quantum: number;
  /** horizon in steps of `quantum` degrees, layout [az][row][col] */
  k: Int16Array;
}

/** Inverse of pipeline export.encode_horizon: byte-unshuffle, int16, cumulative sum along azimuth. */
export function decodeHorizon(bytes: Uint8Array, nAz: number, rows: number, cols: number, quantum: number): HorizonGrid {
  const n = nAz * rows * cols;
  if (bytes.length !== 2 * n) throw new Error("horizon size mismatch");
  const plane = rows * cols;
  const k = new Int16Array(n);
  const acc = new Int32Array(plane);
  for (let a = 0; a < nAz; a++) {
    const base = a * plane;
    for (let p = 0; p < plane; p++) {
      const i = base + p;
      let d = bytes[i] | (bytes[n + i] << 8);
      if (d & 0x8000) d -= 0x10000;
      acc[p] += d;
      k[i] = acc[p];
    }
  }
  return { nAz, rows, cols, quantum, k };
}

/** Horizon elevation (deg) at cell (row, col), linear in grid azimuth between bins, periodic. */
export function horizonAt(g: HorizonGrid, row: number, col: number, azGridDeg: number): number {
  const u = ((azGridDeg % 360) + 360) % 360 * g.nAz / 360;
  const i = Math.floor(u) % g.nAz;
  const f = u - Math.floor(u);
  const j = (i + 1) % g.nAz;
  const cell = row * g.cols + col;
  const plane = g.rows * g.cols;
  return (g.k[i * plane + cell] * (1 - f) + g.k[j * plane + cell] * f) * g.quantum;
}

/**
 * Horizon at fractional cell coordinates (fr, fc measured from cell centres, row 0 = north): bilinear between
 * the four nearest cell centres, clamped at the edges. Same arithmetic as the terrain shader, so the readout at
 * a point equals the shading drawn there; at integer (fr, fc) it equals horizonAt.
 */
export function horizonAtPoint(g: HorizonGrid, fr: number, fc: number, azGridDeg: number): number {
  const r = Math.min(Math.max(fr, 0), g.rows - 1), c = Math.min(Math.max(fc, 0), g.cols - 1);
  const r0 = Math.floor(r), c0 = Math.floor(c);
  const r1 = Math.min(r0 + 1, g.rows - 1), c1 = Math.min(c0 + 1, g.cols - 1);
  const tr = r - r0, tc = c - c0;
  const a = horizonAt(g, r0, c0, azGridDeg) * (1 - tc) + horizonAt(g, r0, c1, azGridDeg) * tc;
  const b = horizonAt(g, r1, c0, azGridDeg) * (1 - tc) + horizonAt(g, r1, c1, azGridDeg) * tc;
  return a * (1 - tr) + b * tr;
}
