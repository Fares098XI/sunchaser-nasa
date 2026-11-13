import { cutPeriod, decodeTrackYear, yearsFor, type PeriodTracks, type TrackIndex } from "../engine/tracks";

/** Decoded years, fetched once each (a failed fetch is forgotten so it can be retried). */
const pending = new Map<number, Promise<void>>();
const decoded = new Map<number, Float64Array[]>();

export function loadYear(idx: TrackIndex, year: number, base = "/data/"): Promise<void> {
  let p = pending.get(year);
  if (!p) {
    const y = idx.years.find((v) => v.year === year);
    if (!y) return Promise.reject(new Error(`no track for ${year}`));
    p = fetch(base + y.file)
      .then((r) => { if (!r.ok) throw new Error(`${y.file}: HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => { decoded.set(year, decodeTrackYear(new Uint8Array(b), y, idx.channels.map((c) => c.quantum))); });
    p.catch(() => pending.delete(year));
    pending.set(year, p);
  }
  return p;
}

export async function loadPeriod(idx: TrackIndex, start: number, n: number): Promise<PeriodTracks> {
  await Promise.all(yearsFor(idx, start, n).map((y) => loadYear(idx, y.year)));
  return cutPeriod(idx, decoded, start, n);
}

/** Every year (for the almanac), reporting how many are in. */
export async function loadAll(idx: TrackIndex, onProgress: (done: number) => void): Promise<PeriodTracks> {
  let done = 0;
  await Promise.all(idx.years.map((y) => loadYear(idx, y.year).then(() => onProgress(++done))));
  return cutPeriod(idx, decoded, 0, idx.n, false);
}
