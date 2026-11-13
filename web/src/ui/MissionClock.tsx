import { useMemo } from "react";
import { allOf, compass, fmtDuration, marginSeries, nextChange } from "../engine/clock";
import type { HorizonGrid } from "../engine/horizon";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM, sampleTrack } from "../engine/sky";
import type { PeriodTracks } from "../engine/tracks";
import { dsnElevations, type Station } from "../scene/FocusView";
import { quatAt } from "../scene/SceneRoot";
import { EarthIcon, SunIcon } from "./icons";
import { fmtDate, fmtTime } from "./time";

/** Per-hour condition margins at a point over the loaded period (METHODS §17), shared by the clock and the ring. */
export function useMargins(horizon: HorizonGrid | null, cell: { fr: number; fc: number } | null, pt: PeriodTracks | null, stations: Station[]) {
  const dsn = useMemo(() => {
    if (!pt || !stations.length) return null;
    const out = new Float64Array(pt.n);
    for (let i = 0; i < pt.n; i++)
      out[i] = Math.max(...dsnElevations(stations, sampleTrack(pt.earth, i), quatAt(pt.earthQ, i)).map((d) => d.el - d.min_elev_deg));
    return out;
  }, [pt, stations]);
  return useMemo(() => {
    if (!horizon || !cell || !pt || !dsn) return null;
    const sun = marginSeries(horizon, cell.fr, cell.fc, pt.sun, SUN_RADIUS_KM, true);
    const earth = marginSeries(horizon, cell.fr, cell.fc, pt.earth, EARTH_RADIUS_KM, false);
    const link = allOf(earth, dsn);
    return { sun, earth, dsn, link, ops: allOf(sun, link) };
  }, [horizon, cell, pt, dsn]);
}

export type Margins = NonNullable<ReturnType<typeof useMargins>>;

/** Where the Sun will next touch the skyline (grid az / elevation, deg) and when (local hour), if it sets in this period. */
export function sunsetPoint(m: Margins | null, pt: PeriodTracks | null, t: number) {
  if (!m || !pt) return null;
  const c = nextChange(m.sun, t);
  if (!c.up || c.at == null) return null;
  const s = sampleTrack(pt.sun, c.at);
  return { az: s.az, el: s.el, at: c.at };
}

interface Props {
  m: Margins | null; pt: PeriodTracks; t: number; lonDeg: number; startMs: number;
  /** jump the timeline to a local hour of the period */
  onJump: (local: number) => void;
}

/**
 * Live countdowns at the selected point: sunset/sunrise, Earthset/Earthrise, the direct-to-Earth link and the "ops window"
 * (Sun and link together). Each row jumps the timeline to that moment.
 */
export function MissionClock({ m, pt, t, lonDeg, startMs, onJump }: Props) {
  if (!m) return <div className="clock loading-line">Reading the sky…</div>;
  const at = (x: number) => startMs + x * 3600e3;
  const rows: { key: string; icon: React.ReactNode; on: string; off: string; c: ReturnType<typeof nextChange>; note?: string }[] = [
    { key: "sun", icon: <SunIcon size={14} />, on: "Sunset", off: "Sunrise", c: nextChange(m.sun, t) },
    { key: "earth", icon: <EarthIcon size={14} />, on: "Earthset", off: "Earthrise", c: nextChange(m.earth, t) },
    { key: "link", icon: <span className="clock-dot link" aria-hidden />, on: "Link to Earth ends", off: "Link to Earth starts", c: nextChange(m.link, t),
      note: "Earth up and a DSN dish ≥ 6°" },
    { key: "ops", icon: <span className="clock-dot ops" aria-hidden />, on: "Ops window ends", off: "Next ops window", c: nextChange(m.ops, t),
      note: "Sun and link together" },
  ];
  const set = rows[0].c;
  if (set.up && set.at != null) {
    const az = ((sampleTrack(pt.sun, set.at).az - lonDeg) % 360 + 360) % 360;
    rows[0].note = `behind terrain, ${compass(az)} · az ${Math.round(az)}°`;
  }
  const left = (pt.n - 1 - t) / 24;
  // the hero: the Sun's next change, and how far through the current light (or night) we are
  const ti = Math.max(0, Math.min(m.sun.length - 1, Math.round(t))), upNow = m.sun[ti] > 0;
  let since = ti;
  while (since > 0 && (m.sun[since - 1] > 0) === upNow) since--;
  const frac = set.at != null ? (t - since) / Math.max(1e-6, set.at - since) : null;
  const R = 34, C = 2 * Math.PI * R;
  return (
    <div className="clock" role="list">
      <div className={`clock-hero ${upNow ? "up" : "down"}`}>
        <svg viewBox="0 0 84 84" aria-hidden><circle cx={42} cy={42} r={R} className="ch-track" />
          {frac != null && <circle cx={42} cy={42} r={R} className="ch-arc" strokeDasharray={`${C * Math.min(1, frac)} ${C}`} transform="rotate(-90 42 42)" />}
          <g transform="translate(30 30)"><SunIcon size={24} /></g></svg>
        <div><span className="dim">{upNow ? "Sunlight here · sunset in" : "Dark here · sunrise in"}</span>
          <b className="num">{set.at != null ? fmtDuration(set.at - t) : `> ${left.toFixed(0)} d`}</b>
          <small className="dim">{frac != null ? `${Math.round(frac * 100)} % of this ${upNow ? "light" : "night"} has passed` : `no ${upNow ? "sunset" : "sunrise"} in this period`}</small></div>
      </div>
      <OpsRibbon m={m} t={t} onJump={onJump} />
      {rows.map((r) => (
        <button key={r.key} role="listitem" className={`clock-row k-${r.key} ${r.c.up ? "up" : "down"}`} disabled={r.c.at == null}
          onClick={() => r.c.at != null && onJump(r.c.at)} title={r.c.at != null ? "Jump the timeline to this moment" : undefined}>
          <span className="clock-icon">{r.icon}</span>
          <span className="clock-what">{r.c.up ? r.on : r.off}<small>{r.note ?? (r.c.up ? "now: yes" : "now: no")}</small></span>
          <span className="clock-when num">
            {r.c.at != null ? <>in {fmtDuration(r.c.at - t)}<small>{fmtDate(at(r.c.at), true).replace(/ \d{4}$/, "")} · {fmtTime(at(r.c.at))} UTC</small></>
              : <>&gt; {left.toFixed(0)} d<small>not in this period</small></>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The whole period at this point: Sun, link and ops windows as bars, "now" marked; click to jump there. */
function OpsRibbon({ m, t, onJump }: { m: Margins; t: number; onJump: (local: number) => void }) {
  const n = m.sun.length, W = 260, rows: [string, Float64Array, string][] = [["Sun", m.sun, "#f5c451"], ["Link", m.link, "#6be6a6"], ["Ops", m.ops, "#ffe9a6"]];
  const bars = (v: Float64Array, y: number, color: string) => {
    const out: React.ReactNode[] = [];
    let s = -1;
    for (let i = 0; i <= n; i++) {
      const on = i < n && v[i] > 0;
      if (on && s < 0) s = i;
      if (!on && s >= 0) { out.push(<rect key={i} x={(s / n) * W} y={y} width={Math.max(0.8, ((i - s) / n) * W)} height={9} rx={2} fill={color} />); s = -1; }
    }
    return out;
  };
  return (
    <svg viewBox={`0 0 ${W + 34} 44`} className="ops-ribbon" role="img" aria-label="Sun, link and operations windows over the period; click to jump"
      onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(), x = ((e.clientX - b.left) / b.width) * (W + 34) - 34; if (x >= 0) onJump(Math.round((x / W) * (n - 1))); }}>
      {rows.map(([l, v, c], k) => <g key={l} transform="translate(34 0)"><rect x={0} y={2 + k * 14} width={W} height={9} rx={2} className="or-bg" />{bars(v, 2 + k * 14, c)}
        <text x={-5} y={10 + k * 14} textAnchor="end" className="or-lbl">{l}</text></g>)}
      <line x1={34 + (t / (n - 1)) * W} x2={34 + (t / (n - 1)) * W} y1={0} y2={42} className="or-now" />
    </svg>
  );
}
