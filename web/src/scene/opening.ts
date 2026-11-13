/**
 * The opening shot over a site, shared by the globe's dive and the surface view so the hand-off is a match cut:
 * look 100 deg away from the Sun (side light: lit slopes, long shadows across the view), on the side where Earth
 * stands when it is up. Returns the grid bearing (deg) the camera looks toward.
 */
export const OPENING = { offDeg: 100, upKm: 1.1, backKm: 4.2, diveUpKm: 60, diveBackKm: 45 };

export function openingBearing(sunAz: number, earthAz: number, earthEl: number) {
  const wrap = (a: number) => ((a + 540) % 360) - 180;
  const off = OPENING.offDeg;
  const side = earthEl > 0 && Math.abs(wrap(earthAz - sunAz + off)) < Math.abs(wrap(earthAz - sunAz - off)) ? -1 : 1;
  return sunAz + side * off;
}
