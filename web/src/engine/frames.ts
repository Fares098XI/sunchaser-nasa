/** South polar stereographic grid -> lat/lon, identical to pipeline/sunchaser/frames.py stereo_to_latlon. */
export const R_MOON_M = 1737400;

export function stereoToLatLon(x_m: number, y_m: number): { lat: number; lon: number } {
  const rho = Math.hypot(x_m, y_m);
  const lat = 2 * Math.atan(rho / (2 * R_MOON_M)) - Math.PI / 2;
  const lon = Math.atan2(x_m, y_m);
  return { lat: (lat * 180) / Math.PI, lon: (((lon * 180) / Math.PI) % 360 + 360) % 360 };
}
