import { useEffect, useRef, useState } from "react";
import { LimitsStrip } from "../ui/LimitsStrip";
import type { RegionData } from "../data/manifest";
import type { GridPoint } from "../data/region";
import { loadPeriod } from "../data/tracks";
import type { HorizonGrid } from "../engine/horizon";
import { VIPER, type RoverParams } from "../engine/lightpath";
import { deriveTracks, type RegionFrame } from "../engine/regiontracks";
import { hourToMs, type TrackIndex } from "../engine/tracks";
import { EarthIcon, PlayIcon, SunIcon } from "../ui/icons";
import { fmtDate, fmtTime } from "../ui/time";

export const WINDOW_H = 168; // plan up to 7 days ahead

export interface LightPathResult {
  found: boolean; reason?: string; k: number; cells: Int32Array; socWh: Float64Array; arrival: number;
  summary: null | {
    hours: number; driveKm: number; straightKm: number; waitAtStartH: number; waitTotalH: number;
    darkH: number; longestDarkH: number; earthPct: number; minSocPct: number;
  };
  checkErrors: string[]; snapped?: { start: number; target: number }; sunAlong: Float32Array; earthAlong: Float32Array; steep: Uint8Array;
  grid: { n: number; cellM: number; x0M: number; y0M: number }; ms: number; departure: number;
}

/** Light Path worker: initialised with each region's terrain, re-plans whenever start, target, departure or rover change.
 * frames: hero -> this region, to derive the region's Sun/Earth tracks from the hero tracks (engine/regiontracks). */
export function useLightPath(data: RegionData, horizon: HorizonGrid | null, idx: TrackIndex, enabled: boolean,
  start: GridPoint, target: GridPoint | null, departure: number, rover: RoverParams, frames: [RegionFrame, RegionFrame] | null) {
  const worker = useRef<Worker | null>(null);
  const ready = useRef<Promise<void> | null>(null);
  const pending = useRef(new Map<number, (d: any) => void>());
  const seq = useRef(0);
  const [result, setResult] = useState<LightPathResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !horizon) return;
    const w = new Worker(new URL("../workers/lightpath.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e) => { const f = pending.current.get(e.data.id); pending.current.delete(e.data.id); f?.(e.data); };
    ready.current = new Promise((res) => {
      pending.current.set(0, () => res());
      w.postMessage({ type: "init", id: 0, hg: horizon, hm: data.manifest.horizon, heights: data.heights, tm: data.manifest.terrain });
    });
    // a new region's horizons replace the worker (requests still waiting on the old one are superseded by the re-plan)
    return () => { w.terminate(); worker.current = null; ready.current = null; };
  }, [enabled, horizon]);

  useEffect(() => {
    if (!enabled || !target || !ready.current) return;
    const id = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const n = Math.min(WINDOW_H, idx.n - departure);
        const raw = await loadPeriod(idx, departure, n);
        const pt = frames ? deriveTracks(raw, frames[0], frames[1]) : raw;
        await ready.current;
        const w = worker.current!;
        const reply = await new Promise<any>((res) => {
          pending.current.set(id, res);
          w.postMessage({
            type: "plan", id, windowStart: departure, rover, start, target,
            sun: { az_grid_deg: pt.sun.az_grid_deg, elev_deg: pt.sun.elev_deg, dist_km: pt.sun.dist_km },
            earth: { az_grid_deg: pt.earth.az_grid_deg, elev_deg: pt.earth.elev_deg, dist_km: pt.earth.dist_km },
          });
        });
        if (id !== seq.current) return; // a newer request is on its way
        if (!reply.ok) { setError(reply.error); setResult(null); } else { setError(null); setResult({ ...reply.route, ...reply, departure }); }
      } catch (err) { setError(String(err)); }
      finally { if (id === seq.current) setBusy(false); }
    }, 120); // live re-plan while dragging sliders, without flooding the worker
    return () => clearTimeout(t);
  }, [enabled, target?.x_m, target?.y_m, start.x_m, start.y_m, departure, rover, horizon]);

  return { result: target ? result : null, busy, error };
}

const pct = (x: number) => `${Math.round(x)}%`;
const hrs = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(h < 10 ? 1 : 0)} h`);

function BatteryChart({ r }: { r: LightPathResult }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const steps = r.cells.length - 1;
    if (steps < 1) return;
    const top = 6, chartH = h - 22, x = (s: number) => (s / steps) * w;
    // lighting strips under the chart: Sun (amber) and Earth (cyan)
    for (let s = 0; s < steps; s++) {
      if (r.sunAlong[s] > 0) { g.fillStyle = `rgba(245,196,81,${0.25 + 0.75 * r.sunAlong[s]})`; g.fillRect(x(s), h - 12, Math.max(1, x(s + 1) - x(s)), 4); }
      if (r.earthAlong[s] > 0) { g.fillStyle = "rgba(111,227,225,0.85)"; g.fillRect(x(s), h - 6, Math.max(1, x(s + 1) - x(s)), 4); }
    }
    // reserve line
    const cap = r.socWh[0], y = (wh: number) => top + chartH - (wh / cap) * chartH;
    g.strokeStyle = "rgba(240,83,63,0.6)"; g.setLineDash([3, 3]); g.beginPath();
    const res = Math.min(...Array.from(r.socWh));
    g.moveTo(0, y(res)); g.lineTo(w, y(res)); g.stroke(); g.setLineDash([]);
    // battery
    const grad = g.createLinearGradient(0, top, 0, top + chartH);
    grad.addColorStop(0, "rgba(107,230,166,0.35)"); grad.addColorStop(1, "rgba(107,230,166,0)");
    g.beginPath(); g.moveTo(0, y(r.socWh[0]));
    for (let s = 1; s <= steps; s++) g.lineTo(x(s), y(r.socWh[s]));
    g.lineTo(w, top + chartH); g.lineTo(0, top + chartH); g.closePath(); g.fillStyle = grad; g.fill();
    g.beginPath(); g.moveTo(0, y(r.socWh[0]));
    for (let s = 1; s <= steps; s++) g.lineTo(x(s), y(r.socWh[s]));
    g.strokeStyle = "#6be6a6"; g.lineWidth = 1.5; g.stroke();
  }, [r]);
  return <canvas ref={ref} className="lp-chart" aria-label="Battery along the traverse, with Sun and Earth strips" />;
}

interface PanelProps {
  /** load the director tour's example route (Shackleton Rim, 1.6 km) */
  onExample?: () => void;
  idx: TrackIndex; start: GridPoint; startLabel: string; target: GridPoint | null; pick: "target" | "start";
  departure: number; hour: number; rover: RoverParams; result: LightPathResult | null; busy: boolean; error: string | null;
  steepOn: boolean;
  onPick: (p: "target" | "start") => void; onDepartNow: () => void; onRover: (r: RoverParams) => void; onPlay: () => void;
  onSteep: (on: boolean) => void; onClear: () => void; onAllLimits: () => void;
}

export function LightPathPanel(p: PanelProps) {
  const r = p.result, s = r?.summary;
  const depMs = hourToMs(p.idx, p.departure);
  const arriveMs = r?.found ? depMs + (r.arrival / r.k) * 3600e3 : 0;
  const dist = p.target ? Math.hypot(p.target.x_m - p.start.x_m, p.target.y_m - p.start.y_m) / 1000 : 0;
  const slider = (key: keyof RoverParams, label: string, min: number, max: number, step: number, unit: string, fmt = (v: number) => String(v)) => (
    <label className="lp-param">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={p.rover[key]} aria-label={label}
        onChange={(e) => p.onRover({ ...p.rover, [key]: Number(e.target.value) })} />
      <b className="num">{fmt(p.rover[key])}{unit}</b>
    </label>
  );
  const why: string[] = [];
  if (s) {
    if (s.waitAtStartH >= 1) why.push(`Waits ${hrs(s.waitAtStartH)} at the start: leaving earlier would run the battery down in shadow.`);
    if (s.straightKm > 0.2 && s.driveKm / s.straightKm > 1.25) why.push(`Detours ${Math.round((s.driveKm / s.straightKm - 1) * 100)}% beyond the straight line, around ground steeper than ${p.rover.maxSlopeDeg}° or into light.`);
    if (s.darkH > 0) why.push(`Crosses ${hrs(s.darkH)} of shadow on battery (longest stretch ${hrs(s.longestDarkH)}).`);
    else why.push("Stays in sunlight the whole way.");
  }
  return (
    <aside className="inspector glass lp" aria-live="polite">
      <div className="eyebrow">Light Path · rover traverse planner</div>
      <h2>Through the moving shadows</h2>
      <p className="source">Earliest arrival through space, time and battery: the rover may wait for the Sun, never drives
        steeper than the limit and never lets the battery fall below the reserve.</p>
      <LimitsStrip ids={["rover", "terrain"]} onAll={p.onAllLimits} />

      <div className="section-title">Route</div>
      <div className="lp-ends">
        <div><span className="lp-dot start" /> <b>Start</b> {p.startLabel}</div>
        <div><span className="lp-dot target" /> <b>Target</b> {p.target ? `${dist.toFixed(2)} km away` : <span className="dim">click the ground</span>}
          {p.target && <button className="link" onClick={p.onClear}>clear</button>}</div>
      </div>
      <div className="seg compact" role="radiogroup" aria-label="Next click sets">
        <button role="radio" aria-checked={p.pick === "target"} className={p.pick === "target" ? "on" : ""} onClick={() => p.onPick("target")}>Click sets target</button>
        <button role="radio" aria-checked={p.pick === "start"} className={p.pick === "start" ? "on" : ""} onClick={() => p.onPick("start")}>Click sets start</button>
      </div>
      <p className="hint num">Departs {fmtDate(depMs)} {fmtTime(depMs)} UTC
        {Math.round(p.hour) !== p.departure && <button className="link inline-link" onClick={p.onDepartNow}>depart at the time shown</button>}</p>

      {p.error && <p className="lp-error">{p.error}</p>}
      {!p.target && <p className="lp-hint-big">Click the ground inside the glowing outline to set where the rover should go.
        {p.onExample && <> Or <button className="link inline-link" onClick={p.onExample}>try the example drive at Shackleton Rim</button> (1.6 km, across the shadows).</>}</p>}
      {p.target && p.busy && !r && <div className="loading-line">Planning…</div>}
      {r && r.snapped && r.snapped.target > 0 && <p className="hint">Target moved {Math.round(r.snapped.target)} m to the nearest ground the rover can drive on (under {p.rover.maxSlopeDeg}°).</p>}
      {r && !r.found && <p className="lp-error">No safe route: {r.reason}.</p>}
      {r?.found && s && (
        <div className={`lp-result ${p.busy ? "stale" : ""}`}>
          <div className="lp-arrive"><span className="dim">Arrives</span> <b className="num">{fmtDate(arriveMs)} {fmtTime(arriveMs)} UTC</b> <span className="num dim">· {hrs(s.hours)}</span></div>
          <dl className="stats">
            <div><dt>Drives</dt><dd className="num">{s.driveKm.toFixed(2)} km</dd></div>
            <div><dt>Waits</dt><dd className="num">{hrs(s.waitTotalH)}</dd></div>
            <div><dt><SunIcon size={12} /> In shadow</dt><dd className="num">{hrs(s.darkH)}</dd></div>
            <div><dt><EarthIcon size={12} /> Earth in view</dt><dd className="num">{pct(s.earthPct)}</dd></div>
            <div><dt>Battery never below</dt><dd className="num">{pct(s.minSocPct)}</dd></div>
            <div><dt>Planned in</dt><dd className="num">{Math.round(r.ms)} ms</dd></div>
          </dl>
          <BatteryChart r={r} />
          <ul className="lp-why">{why.map((w) => <li key={w}>{w}</li>)}</ul>
          <p className={`lp-check ${r.checkErrors.length ? "bad" : "ok"}`}>
            {r.checkErrors.length ? `Independent check found ${r.checkErrors.length} problem(s): ${r.checkErrors[0]}` : "✓ Verified by the independent route checker (V6)"}
          </p>
          <button className="cta small" onClick={p.onPlay}><PlayIcon size={12} /> Play the traverse</button>
        </div>
      )}

      <div className="section-title">Rover <span className="dim">· VIPER-class defaults (NASA)</span></div>
      {slider("speedMPerH", "Drive speed", 90, 720, 30, " m/h")}
      {slider("maxSlopeDeg", "Max slope", 5, 25, 1, "°")}
      {slider("batteryWh", "Battery", 1000, 10000, 100, " Wh")}
      {slider("reserveFrac", "Reserve", 0, 0.6, 0.05, "%", (v) => String(Math.round(v * 100)))}
      <details className="method">
        <summary>Power model</summary>
        {slider("panelW", "Solar (full Sun)", 100, 1000, 10, " W")}
        {slider("driveW", "Driving load", 100, 1200, 10, " W")}
        {slider("idleW", "Waiting load", 20, 400, 2, " W")}
        <p>Defaults from NASA VIPER documents: 10 cm/s nominal drive, 15° slope design limit, 5,420 Wh battery, 450 W
          with the Sun on a panel corner; loads derived from "9 h of operations in a PSR" and "50 h survival".
          Solar input scales with the visible part of the Sun's disc at each cell and hour.</p>
        <button className="link" onClick={() => p.onRover(VIPER)}>reset to defaults</button>
      </details>
      <label className="toggle">
        <input type="checkbox" checked={p.steepOn} onChange={(e) => p.onSteep(e.target.checked)} /> Show ground steeper than {p.rover.maxSlopeDeg}°
      </label>
    </aside>
  );
}
