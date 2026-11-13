import { useEffect, useMemo, useRef, useState } from "react";
import { EarthIcon, SunIcon } from "./icons";
import { MONTHS, fmtDate, fmtSpan, isoDay } from "./time";

/** Per UTC day since the index start: mean visible Sun disc and share of hours with Earth in view (0..1). */
export interface Almanac { sun: Float32Array; earth: Float32Array }

interface Props {
  startMs: number;  // index start (2020-01-01T00:00Z)
  totalHours: number;
  per: { start: number; days: number };
  hour: number;
  label: string;
  almanac: Almanac | null;
  loaded: number;   // years loaded so far, for the progress line
  years: number;
  onPeriod: (startHour: number, days: number) => void;
  onNow: () => void;
  onClose: () => void;
}

const SPANS = [1, 7, 30, 90, 365];
const DAY_MS = 86400e3;
// Same ramps as the terrain light painting (linear RGB stops), encoded to sRGB for the canvas
const RAMPS = {
  sun: [[0.012, 0.016, 0.035], [0.16, 0.09, 0.03], [1.0, 0.45, 0.10], [1.0, 0.92, 0.70]],
  earth: [[0.008, 0.02, 0.04], [0.03, 0.16, 0.28], [0.10, 0.55, 0.85], [0.75, 0.95, 1.0]],
};
function ramp(stops: number[][], v: number): [number, number, number] {
  const s = v < 0.33 ? 0 : v < 0.66 ? 1 : 2, t = s === 0 ? v / 0.33 : s === 1 ? (v - 0.33) / 0.33 : (v - 0.66) / 0.34;
  const c = stops[s].map((a, i) => a + (stops[s + 1][i] - a) * Math.min(1, Math.max(0, t)));
  return c.map((x) => Math.round(255 * Math.pow(x, 1 / 2.2))) as [number, number, number];
}

export function TimeMachine({ startMs, totalHours, per, hour, label, almanac, loaded, years, onPeriod, onNow, onClose }: Props) {
  const [body, setBody] = useState<"sun" | "earth">("sun");
  const [hover, setHover] = useState<number | null>(null); // day index
  const [custom, setCustom] = useState(String(per.days));
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => setCustom(String(per.days)), [per.days]);
  const y0 = new Date(startMs).getUTCFullYear();
  const nDays = Math.floor(totalHours / 24);
  // first day index of each year row
  const rows = useMemo(() => Array.from({ length: years }, (_, i) => Math.round((Date.UTC(y0 + i, 0, 1) - startMs) / DAY_MS)), [startMs, years]);
  const COLS = 366, RH = 9;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = COLS;
    c.height = years * RH;
    const g = c.getContext("2d")!;
    const img = g.createImageData(COLS, years * RH);
    const v = almanac?.[body];
    for (let r = 0; r < years; r++) {
      const d0 = rows[r], d1 = r + 1 < years ? rows[r + 1] : nDays;
      for (let d = d0; d < d1; d++) {
        const [R, G, B] = v ? ramp(RAMPS[body], v[d]) : [18, 24, 36];
        for (let y = r * RH + 1; y < (r + 1) * RH; y++) {
          const o = 4 * (y * COLS + (d - d0));
          img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    // the chosen period, outlined on every row it touches
    const p0 = Math.floor(per.start / 24), p1 = p0 + per.days;
    g.strokeStyle = "rgba(255,255,255,0.9)";
    g.lineWidth = 1;
    for (let r = 0; r < years; r++) {
      const d0 = rows[r], d1 = r + 1 < years ? rows[r + 1] : nDays;
      const a = Math.max(p0, d0), b = Math.min(p1, d1);
      if (a < b) g.strokeRect(a - d0 + 0.5, r * RH + 0.5, b - a - 1, RH - 1);
    }
  }, [almanac, body, per.start, per.days, rows]);

  const dayAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - b.left) / b.width) * COLS), r = Math.floor(((e.clientY - b.top) / b.height) * years);
    if (r < 0 || r >= years) return null;
    const d = rows[r] + col, end = r + 1 < years ? rows[r + 1] : nDays;
    return col >= 0 && d < end ? d : null;
  };
  const maxStart = totalHours - per.days * 24;
  const setStartDay = (d: number, days = per.days) => onPeriod(Math.max(0, Math.min(totalHours - days * 24, d * 24)), days);
  const shown = hover ?? Math.floor(hour / 24);
  const v = almanac && shown < nDays ? { sun: almanac.sun[shown], earth: almanac.earth[shown] } : null;

  return (
    <section className="machine glass" aria-label="Time machine">
      <header className="machine-head">
        <div>
          <div className="eyebrow">Time machine · 2020 – 2045</div>
          <h3>{fmtDate(startMs + per.start * 3600e3)} <span className="dim">→ {fmtDate(startMs + (per.start + per.days * 24 - 1) * 3600e3)}</span></h3>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close time machine">×</button>
      </header>

      <div className="machine-row">
        <label className="field">
          <span>Start</span>
          <input type="date" className="num" min={isoDay(startMs)} max={isoDay(startMs + maxStart * 3600e3)}
            value={isoDay(startMs + per.start * 3600e3)}
            onChange={(e) => { const ms = Date.parse(e.target.value + "T00:00:00Z"); if (Number.isFinite(ms)) setStartDay(Math.round((ms - startMs) / DAY_MS)); }} />
        </label>
        <div className="field">
          <span>Length</span>
          <div className="seg compact" role="radiogroup" aria-label="Period length">
            {SPANS.map((d) => (
              <button key={d} role="radio" aria-checked={per.days === d} className={per.days === d ? "on" : ""}
                onClick={() => setStartDay(Math.floor(per.start / 24), d)}>{fmtSpan(d)}</button>
            ))}
            <input className="num days" type="number" min={1} max={366} value={custom} aria-label="Custom length in days"
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => { const d = Math.round(Number(custom)); if (d >= 1 && d <= 366) setStartDay(Math.floor(per.start / 24), d); else setCustom(String(per.days)); }}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          </div>
        </div>
        <div className="field step">
          <span>Move</span>
          <div className="seg compact">
            <button onClick={() => setStartDay(Math.floor(per.start / 24) - per.days)} disabled={per.start <= 0} aria-label="Previous period">‹ Prev</button>
            <button onClick={onNow}>Now</button>
            <button onClick={() => setStartDay(Math.floor(per.start / 24) + per.days)} disabled={per.start >= maxStart} aria-label="Next period">Next ›</button>
          </div>
        </div>
      </div>

      <div className="almanac-head">
        <span>Almanac at <b>{label}</b></span>
        <div className="seg compact" role="radiogroup" aria-label="Almanac layer">
          <button role="radio" aria-checked={body === "sun"} className={body === "sun" ? "on" : ""} onClick={() => setBody("sun")}><SunIcon size={11} /> Sunlight</button>
          <button role="radio" aria-checked={body === "earth"} className={body === "earth" ? "on" : ""} onClick={() => setBody("earth")}><EarthIcon size={11} /> Earth in view</button>
        </div>
      </div>
      <div className="almanac">
        <div className="almanac-months" aria-hidden>{MONTHS.map((m, i) => <span key={m} style={{ left: `${(Math.round((Date.UTC(2021, i, 1) - Date.UTC(2021, 0, 1)) / DAY_MS) / COLS) * 100}%` }}>{m}</span>)}</div>
        <div className="almanac-body">
          <div className="almanac-years num" aria-hidden>{rows.map((_, i) => <span key={i}>{(y0 + i) % 5 === 0 ? y0 + i : ""}</span>)}</div>
          <canvas ref={ref} className="almanac-canvas" style={{ aspectRatio: `${COLS} / ${years * RH}` }}
            onPointerMove={(e) => setHover(dayAt(e))} onPointerLeave={() => setHover(null)}
            onClick={(e) => { const d = dayAt(e); if (d !== null) setStartDay(d); }}
            role="img" aria-label={`Daily ${body === "sun" ? "sunlight" : "Earth visibility"} at ${label}, 2020 to 2045, one row per year`} />
        </div>
      </div>
      <p className="almanac-foot num" aria-live="polite">
        {!almanac ? `Computing 26 years of Sun and Earth at this point… ${loaded}/${years} years loaded` : (
          <>{fmtDate(startMs + shown * DAY_MS, true)} · <SunIcon size={11} /> {v ? Math.round(v.sun * 100) : "–"}% of the Sun ·{" "}
            <EarthIcon size={11} /> Earth in view {v ? Math.round(v.earth * 100) : "–"}% of the day
            <span className="dim"> · click a day to start the period there</span></>
        )}
      </p>
    </section>
  );
}
