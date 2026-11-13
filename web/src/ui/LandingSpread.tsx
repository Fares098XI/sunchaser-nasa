import { useEffect, useMemo, useRef, useState } from "react";
import { horizonCell, type GridPoint } from "../data/region";
import type { RegionData } from "../data/manifest";
import type { HorizonGrid } from "../engine/horizon";
import { siteSeries } from "../engine/series";
import { EARTH_RADIUS_KM, SUN_RADIUS_KM } from "../engine/sky";
import { marginSeries } from "../engine/clock";
import type { PeriodTracks } from "../engine/tracks";
import type { Margins } from "./MissionClock";

/** The landing-dispersion pattern of the site catalog (pipeline build_sites.dispersion_points): centre, 6 at 125 m, 12 at 250 m. */
export const RINGS: [number, number][] = [[125, 6], [250, 12]];
export function dispersionPoints(p: GridPoint): (GridPoint & { r: number })[] {
  const out = [{ ...p, r: 0 }];
  for (const [r, n] of RINGS) for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    out.push({ x_m: p.x_m + r * Math.sin(a), y_m: p.y_m + r * Math.cos(a), r });
  }
  return out;
}

export interface SpreadPoint extends GridPoint { r: number; sunPct: number; linkPct: number }

/** Sunlight (mean visible disc, %) and link-to-Earth time (%) over the period at each landing point inside the region. */
export function useSpread(data: RegionData | null, horizon: HorizonGrid | null, sel: GridPoint | null, pt: PeriodTracks | null, m: Margins | null) {
  return useMemo(() => {
    if (!data || !horizon || !sel || !pt || !m) return null;
    const pts: SpreadPoint[] = [];
    for (const p of dispersionPoints(sel)) {
      const c = horizonCell(data, p);
      if (!c) continue;
      const s = siteSeries(horizon, c.fr, c.fc, pt.sun, SUN_RADIUS_KM), e = marginSeries(horizon, c.fr, c.fc, pt.earth, EARTH_RADIUS_KM, false);
      let sun = 0, link = 0;
      for (let i = 0; i < pt.n; i++) { sun += s[i]; if (e[i] > 0 && m.dsn[i] > 0) link++; }
      pts.push({ ...p, sunPct: (100 * sun) / pt.n, linkPct: (100 * link) / pt.n });
    }
    return pts;
  }, [data, horizon, sel, pt, m]);
}

const range = (v: number[]) => [Math.min(...v), Math.max(...v)];
/** dark (no sunlight) → amber (always lit) */
export const sunColor = (pct: number) => `hsl(${28 + pct * 0.08}, ${40 + pct * 0.6}%, ${14 + pct * 0.5}%)`;

const HEAT_N = 21, HEAT_HALF_M = 300; // 30 m spacing out to 300 m

/** Sunlight (%) over the period on a grid around the point (S2+): every spot a lander could end up within 300 m. */
export function useHeat(data: RegionData | null, horizon: HorizonGrid | null, sel: GridPoint | null, pt: PeriodTracks | null) {
  return useMemo(() => {
    if (!data || !horizon || !sel || !pt) return null;
    const v = new Float32Array(HEAT_N * HEAT_N).fill(NaN), step = (2 * HEAT_HALF_M) / (HEAT_N - 1);
    for (let i = 0; i < HEAT_N; i++) for (let j = 0; j < HEAT_N; j++) {
      const c = horizonCell(data, { x_m: sel.x_m - HEAT_HALF_M + j * step, y_m: sel.y_m + HEAT_HALF_M - i * step });
      if (!c) continue;
      const s = siteSeries(horizon, c.fr, c.fc, pt.sun, SUN_RADIUS_KM);
      let sum = 0;
      for (let k = 0; k < pt.n; k++) sum += s[k];
      v[i * HEAT_N + j] = (100 * sum) / pt.n;
    }
    return v;
  }, [data, horizon, sel?.x_m, sel?.y_m, pt]);
}

export function LandingSpread({ pts, show, onShow, heat, onLand }: {
  pts: SpreadPoint[] | null; show: boolean; onShow: (v: boolean) => void;
  /** S2+: the sunlight heat map around the point, and landing on a spot of it */
  heat?: Float32Array | null; onLand?: (dx_m: number, dy_m: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; v: number } | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !heat) return;
    c.width = c.height = HEAT_N;
    const g = c.getContext("2d")!;
    for (let i = 0; i < HEAT_N; i++) for (let j = 0; j < HEAT_N; j++) { const v = heat[i * HEAT_N + j]; g.fillStyle = Number.isNaN(v) ? "#0b0f18" : sunColor(v); g.fillRect(j, i, 1, 1); }
  }, [heat]);
  if (!pts) return null;
  const here = pts[0], [sLo, sHi] = range(pts.map((p) => p.sunPct)), [lLo, lHi] = range(pts.map((p) => p.linkPct));
  const worst = pts.reduce((a, b) => (b.sunPct < a.sunPct ? b : a));
  const S = 150, k = (S / 2) / HEAT_HALF_M;
  const at = (e: React.MouseEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect(), dx = (((e.clientX - b.left) / b.width) * S - S / 2) / k, dy = -(((e.clientY - b.top) / b.height) * S - S / 2) / k;
    const j = Math.round(((dx + HEAT_HALF_M) / (2 * HEAT_HALF_M)) * (HEAT_N - 1)), i = Math.round(((HEAT_HALF_M - dy) / (2 * HEAT_HALF_M)) * (HEAT_N - 1));
    return { dx, dy, v: heat && i >= 0 && j >= 0 && i < HEAT_N && j < HEAT_N ? heat[i * HEAT_N + j] : NaN };
  };
  return (
    <div className="spread">
      <div className="spread-heat" style={{ width: S, height: S }}>
        {heat && <canvas ref={ref} />}
      <svg viewBox={`0 0 ${S} ${S}`} width={S} height={S} role="img" aria-label={`Sunlight from ${sLo.toFixed(0)} to ${sHi.toFixed(0)} percent within 250 metres; hover the map, click to land there`}
        className={onLand ? "spread-click" : ""} onPointerMove={(e) => { const p = at(e); setHover({ x: p.dx, y: p.dy, v: p.v }); }} onPointerLeave={() => setHover(null)}
        onClick={(e) => { const p = at(e); if (onLand && Math.hypot(p.dx, p.dy) <= HEAT_HALF_M) onLand(p.dx, p.dy); }}>
        {RINGS.map(([r]) => <circle key={r} cx={S / 2} cy={S / 2} r={r * k} className="spread-ring" />)}
        {pts.map((p, i) => (
          <circle key={i} cx={S / 2 + (p.x_m - here.x_m) * k} cy={S / 2 - (p.y_m - here.y_m) * k} r={i ? 6 : 8} fill={sunColor(p.sunPct)}
            className={i ? "spread-pt" : "spread-pt here"}><title>{`${p.r} m: sunlight ${p.sunPct.toFixed(1)} %, link ${p.linkPct.toFixed(1)} %`}</title></circle>
        ))}
        <text x={S / 2} y={9} textAnchor="middle" className="spread-n">N grid</text>
        {hover && <g transform={`translate(${S / 2 + hover.x * k} ${S / 2 - hover.y * k})`} className="spread-hover"><circle r={5} /></g>}
      </svg>
      </div>
      <div className="spread-read">
        <div><span className="dim">Sunlight</span> <b className="num">{sLo.toFixed(0)}–{sHi.toFixed(0)} %</b> <small className="dim">here {here.sunPct.toFixed(0)} %</small></div>
        <div><span className="dim">Link to Earth</span> <b className="num">{lLo.toFixed(0)}–{lHi.toFixed(0)} %</b> <small className="dim">here {here.linkPct.toFixed(0)} %</small></div>
        {hover && !Number.isNaN(hover.v) && <div className="spread-hint num">{Math.round(Math.hypot(hover.x, hover.y))} m away: <b>{hover.v.toFixed(0)} %</b> sunlight{onLand ? " · click to land there" : ""}</div>}
        <p className="dim">{sHi - sLo < 3 ? "Robust: a landing error of 250 m barely changes the light here."
          : `Land ${worst.r} m off in the wrong direction and sunlight drops to ${worst.sunPct.toFixed(0)} %.`}</p>
        <label className="toggle"><input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} /> Show the 19 points on the terrain</label>
      </div>
    </div>
  );
}
