/**
 * 2020-2045 hourly tracks (pipeline/sunchaser/export_tracks.py): decode one year's file, cut out any period.
 * Channels: Sun az/el/dist, Earth az/el/dist, Earth orientation quaternion, sky (J2000 -> scene) quaternion.
 */
export interface TrackYear { year: number; file: string; first_hour: number; n: number; head: [number, number][]; sha256: string }
export interface TrackIndex {
  start_utc: string; stop_utc: string; step_s: number; n: number;
  channels: { name: string; quantum: number }[]; years: TrackYear[];
}

/** Sun or Earth over a period: grid azimuth (deg), elevation (deg), distance (km), one sample per hour. */
export interface Track { az_grid_deg: ArrayLike<number>; elev_deg: ArrayLike<number>; dist_km: ArrayLike<number> }
export interface PeriodTracks {
  /** first hour of the period, counted from the index start (2020-01-01T00:00 UTC) */
  start: number;
  n: number;
  sun: Track; earth: Track;
  /** quaternions [x, y, z, w] per hour, flat */
  earthQ: Float64Array; skyQ: Float64Array;
}

const AZ_CHANNELS = [0, 3];

/** Inverse of export_tracks.encode: byte planes -> int32 second differences -> integers -> value * quantum. */
export function decodeTrackYear(bytes: Uint8Array, y: TrackYear, quanta: number[]): Float64Array[] {
  const c = quanta.length, n = y.n, m = n - 2, plane = c * m;
  if (bytes.length !== 4 * plane) throw new Error(`track ${y.year}: size mismatch`);
  const out: Float64Array[] = [];
  for (let ch = 0; ch < c; ch++) {
    const v = new Float64Array(n), q = quanta[ch];
    let k = y.head[ch][0], d = y.head[ch][1];
    v[0] = k * q;
    k += d;
    v[1] = k * q;
    for (let i = 0; i < m; i++) {
      const j = ch * m + i;
      d += bytes[j] | (bytes[plane + j] << 8) | (bytes[2 * plane + j] << 16) | (bytes[3 * plane + j] << 24);
      k += d;
      v[i + 2] = k * q;
    }
    if (AZ_CHANNELS.includes(ch)) for (let i = 0; i < n; i++) v[i] = ((v[i] % 360) + 360) % 360;
    out.push(v);
  }
  return out;
}

/** Years whose files a period [start, start + n) needs. */
export function yearsFor(idx: TrackIndex, start: number, n: number): TrackYear[] {
  return idx.years.filter((y) => y.first_hour < start + n && y.first_hour + y.n > start);
}

/** Stitch a period out of decoded years (all of yearsFor must be present in `decoded`); quats=false skips the
 * orientation channels (empty arrays), for long spans that only need Sun and Earth. */
export function cutPeriod(idx: TrackIndex, decoded: Map<number, Float64Array[]>, start: number, n: number, quats = true): PeriodTracks {
  const ch = quats ? idx.channels.length : 6;
  const cols = Array.from({ length: ch }, () => new Float64Array(n));
  for (const y of yearsFor(idx, start, n)) {
    const d = decoded.get(y.year);
    if (!d) throw new Error(`track ${y.year} not loaded`);
    const a = Math.max(start, y.first_hour), b = Math.min(start + n, y.first_hour + y.n);
    for (let c = 0; c < ch; c++) cols[c].set(d[c].subarray(a - y.first_hour, b - y.first_hour), a - start);
  }
  const quat = (c0: number) => {
    if (!quats) return new Float64Array(0);
    const q = new Float64Array(4 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) q[4 * i + k] = cols[c0 + k][i];
    return q;
  };
  return {
    start, n,
    sun: { az_grid_deg: cols[0], elev_deg: cols[1], dist_km: cols[2] },
    earth: { az_grid_deg: cols[3], elev_deg: cols[4], dist_km: cols[5] },
    earthQ: quat(6), skyQ: quat(10),
  };
}

const HOUR_MS = 3600e3;
/** Hours since the index start <-> UTC milliseconds. */
export const hourToMs = (idx: TrackIndex, h: number) => Date.parse(idx.start_utc + "Z") + h * HOUR_MS;
export const msToHour = (idx: TrackIndex, ms: number) => (ms - Date.parse(idx.start_utc + "Z")) / HOUR_MS;
