/**
 * Sky geometry shared by the scene and (later) the visibility engine.
 * Scene axes: x = grid x (stereographic), y = up, z = -grid y.
 * Azimuth is clockwise from grid +y, as exported by pipeline/sunchaser/export.py.
 */
export function skyDirection(azGridDeg: number, elevDeg: number): [number, number, number] {
  const az = (azGridDeg * Math.PI) / 180;
  const el = (elevDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
}

/** Body radii (km): IAU 2015 nominal solar radius; IUGG mean Earth radius (docs/METHODS.md §3). */
export const SUN_RADIUS_KM = 695700;
export const EARTH_RADIUS_KM = 6371.0088;

export const angularRadiusDeg = (radiusKm: number, distKm: number) => (Math.asin(radiusKm / distKm) * 180) / Math.PI;

/** Mean solar angular radius at 1 au. */
export const SUN_RADIUS_DEG = angularRadiusDeg(SUN_RADIUS_KM, 149597870.7);

/**
 * Visible fraction of the solar disc above a horizon at `horizonElevDeg` (small-angle, straight horizon edge):
 * d = (elev - horizon) / r, f = 1 - (acos(d) - d sqrt(1 - d^2)) / pi.
 */
export function visibleDiscFraction(sunElevDeg: number, horizonElevDeg: number, radiusDeg = SUN_RADIUS_DEG): number {
  const d = (sunElevDeg - horizonElevDeg) / radiusDeg;
  if (d >= 1) return 1; // the formula gives exactly 1 and 0 at the clamps; skipping acos speeds up long periods
  if (d <= -1) return 0;
  return 1 - (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
}

/** Linear interpolation of an hourly track at fractional hour `h`; azimuth unwrapped across 0/360. */
export function sampleTrack(
  t: { az_grid_deg: ArrayLike<number>; elev_deg: ArrayLike<number>; dist_km: ArrayLike<number> }, h: number,
): { az: number; el: number; dist: number } {
  const az = t.az_grid_deg, el = t.elev_deg, dist = t.dist_km;
  const i = Math.max(0, Math.min(az.length - 2, Math.floor(h)));
  const f = Math.max(0, Math.min(1, h - i));
  let d = az[i + 1] - az[i];
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return {
    az: (((az[i] + f * d) % 360) + 360) % 360,
    el: el[i] + f * (el[i + 1] - el[i]),
    dist: dist[i] + f * (dist[i + 1] - dist[i]),
  };
}
