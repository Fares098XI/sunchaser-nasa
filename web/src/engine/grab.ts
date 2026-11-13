/**
 * Grab the Sun: the moment near `hour` whose Sun grid azimuth best matches the pointer's azimuth.
 * Searches +-window hours (the Sun moves ~0.5 deg/h, one circuit per ~29.5 d, so a local search keeps the drag
 * continuous), then refines linearly between the two neighbouring hours.
 */
export function hourForAzimuth(az: ArrayLike<number>, hour: number, targetAz: number, window = 48): number {
  const wrap = (x: number) => ((x + 540) % 360) - 180;
  const n = az.length;
  const h0 = Math.round(hour);
  let best = h0, bestD = Infinity;
  for (let h = Math.max(0, h0 - window); h <= Math.min(n - 1, h0 + window); h++) {
    const d = Math.abs(wrap(az[h] - targetAz));
    if (d < bestD) { bestD = d; best = h; }
  }
  // refine between best and the neighbour on the side of the target
  for (const nb of [best - 1, best + 1]) {
    if (nb < 0 || nb >= n) continue;
    const span = wrap(az[nb] - az[best]);
    const want = wrap(targetAz - az[best]);
    if (span !== 0 && want / span > 0 && want / span <= 1) return best + ((nb - best) * want) / span;
  }
  return best;
}
