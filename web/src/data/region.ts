import type { RegionData } from "./manifest";

/** Grid point (south polar stereographic metres). */
export interface GridPoint { x_m: number; y_m: number }

export function regionCenter(d: RegionData): GridPoint {
  const t = d.manifest.terrain;
  return { x_m: t.x0_m + (t.cols * t.res_m) / 2, y_m: t.y0_m - (t.rows * t.res_m) / 2 };
}

/** Ground height (m) of the terrain cell containing p (nearest 20 m cell). */
export function heightAt(d: RegionData, p: GridPoint): number {
  const t = d.manifest.terrain;
  const col = Math.min(t.cols - 1, Math.max(0, Math.floor((p.x_m - t.x0_m) / t.res_m)));
  const row = Math.min(t.rows - 1, Math.max(0, Math.floor((t.y0_m - p.y_m) / t.res_m)));
  return d.heights[row * t.cols + col];
}

/** Scene coordinates (km; x = grid x, y = up from the region centre height, z = -grid y). */
export function sceneFromGrid(d: RegionData, p: GridPoint): [number, number, number] {
  const c = regionCenter(d);
  return [(p.x_m - c.x_m) / 1000, (heightAt(d, p) - d.manifest.region.center_h_m) / 1000, -(p.y_m - c.y_m) / 1000];
}

export function gridFromScene(d: RegionData, x: number, z: number): GridPoint {
  const c = regionCenter(d);
  return { x_m: c.x_m + x * 1000, y_m: c.y_m - z * 1000 };
}

/** Fractional horizon-grid coordinates of p (measured from cell centres), or null outside the grid. */
export function horizonCell(d: RegionData, p: GridPoint): { fr: number; fc: number } | null {
  const h = d.manifest.horizon;
  const fr = (h.y0_m - p.y_m) / h.cell_m - 0.5, fc = (p.x_m - h.x0_m) / h.cell_m - 0.5;
  return fr >= -0.5 && fc >= -0.5 && fr < h.rows - 0.5 && fc < h.cols - 0.5 ? { fr, fc } : null;
}
