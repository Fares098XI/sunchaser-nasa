/**
 * Sun/Earth directions at another site, derived from the hero region's SPICE tracks (docs/METHODS.md §14, V5d):
 * scene direction -> MOON_ME (transpose of the hero's scene_from_me), observer shifted from the hero centre to the
 * site centre (exact for Earth's 0.26 deg parallax), -> the site's scene axes. Earth and sky orientations turn by the
 * same rotation. Mirrors pipeline/sunchaser/export_regions.derive (golden file v5_regions.json).
 */
import type { PeriodTracks, Track } from "./tracks";

export interface RegionFrame { sceneFromMe: number[][]; posKm: [number, number, number] }

const R_MOON_KM = 1737.4;
const RAD = Math.PI / 180;

export function regionFrame(m: { region: { center_lat_deg: number; center_lon_deg: number; center_h_m: number }; scene_from_me: number[][] }): RegionFrame {
  const la = m.region.center_lat_deg * RAD, lo = m.region.center_lon_deg * RAD, r = R_MOON_KM + m.region.center_h_m / 1000;
  return { sceneFromMe: m.scene_from_me, posKm: [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)] };
}

/** One direction (grid az, elevation in deg; distance km) seen from `from`, re-expressed for an observer at `to`. */
export function deriveDirection(azDeg: number, elDeg: number, distKm: number, from: RegionFrame, to: RegionFrame): [number, number, number] {
  const az = azDeg * RAD, el = elDeg * RAD;
  const s = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)]; // scene axes of `from`
  const M = from.sceneFromMe, N = to.sceneFromMe;
  const v = [0, 1, 2].map((k) => (s[0] * M[0][k] + s[1] * M[1][k] + s[2] * M[2][k]) * distKm + from.posKm[k] - to.posKm[k]);
  const d = Math.hypot(v[0], v[1], v[2]);
  const x = (N[0][0] * v[0] + N[0][1] * v[1] + N[0][2] * v[2]) / d;
  const y = (N[1][0] * v[0] + N[1][1] * v[1] + N[1][2] * v[2]) / d;
  const z = (N[2][0] * v[0] + N[2][1] * v[1] + N[2][2] * v[2]) / d;
  const azOut = ((Math.atan2(x, -z) / RAD) % 360 + 360) % 360;
  return [azOut, Math.asin(Math.max(-1, Math.min(1, y))) / RAD, d];
}

/** Quaternion [x, y, z, w] of the rotation hero scene axes -> site scene axes (N M^T). */
export function frameRotation(from: RegionFrame, to: RegionFrame): [number, number, number, number] {
  const M = from.sceneFromMe, N = to.sceneFromMe;
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => N[i][0] * M[j][0] + N[i][1] * M[j][1] + N[i][2] * M[j][2]));
  // rotation matrix -> quaternion (Shepperd)
  const tr = R[0][0] + R[1][1] + R[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = 0.25 * S; x = (R[2][1] - R[1][2]) / S; y = (R[0][2] - R[2][0]) / S; z = (R[1][0] - R[0][1]) / S; }
  else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) { const S = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2; w = (R[2][1] - R[1][2]) / S; x = 0.25 * S; y = (R[0][1] + R[1][0]) / S; z = (R[0][2] + R[2][0]) / S; }
  else if (R[1][1] > R[2][2]) { const S = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2; w = (R[0][2] - R[2][0]) / S; x = (R[0][1] + R[1][0]) / S; y = 0.25 * S; z = (R[1][2] + R[2][1]) / S; }
  else { const S = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2; w = (R[1][0] - R[0][1]) / S; x = (R[0][2] + R[2][0]) / S; y = (R[1][2] + R[2][1]) / S; z = 0.25 * S; }
  return [x, y, z, w];
}

const qmul = (a: number[], b: number[]) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

function deriveTrack(t: Track, from: RegionFrame, to: RegionFrame): Track {
  const n = t.elev_deg.length, az = new Float64Array(n), el = new Float64Array(n), dist = new Float64Array(n);
  for (let i = 0; i < n; i++) [az[i], el[i], dist[i]] = deriveDirection(t.az_grid_deg[i], t.elev_deg[i], t.dist_km[i], from, to);
  return { az_grid_deg: az, elev_deg: el, dist_km: dist };
}

export function deriveTracks(pt: PeriodTracks, from: RegionFrame, to: RegionFrame): PeriodTracks {
  if (from === to) return pt;
  const q = frameRotation(from, to);
  const rot = (src: Float64Array) => {
    const out = new Float64Array(src.length);
    for (let i = 0; i < src.length; i += 4) out.set(qmul(q, [src[i], src[i + 1], src[i + 2], src[i + 3]]), i);
    return out;
  };
  return { ...pt, sun: deriveTrack(pt.sun, from, to), earth: deriveTrack(pt.earth, from, to), earthQ: rot(pt.earthQ), skyQ: rot(pt.skyQ) };
}
