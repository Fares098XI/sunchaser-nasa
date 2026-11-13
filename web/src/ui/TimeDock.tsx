import { useMemo } from "react";
import { CalendarIcon, PauseIcon, PlayIcon } from "./icons";
import { Timeline } from "./Timeline";
import { fmtDate, fmtSpan, fmtTime, ticks } from "./time";

export const SPEEDS = [1, 4, 12, 48, 168]; // hours of Moon time per second of playback
const speedLabel = (h: number) => (h >= 168 ? `${h / 168} wk/s` : h >= 24 ? `${h / 24} d/s` : `${h} h/s`);
/** Default speed: a whole period plays in about a minute. */
export const defaultSpeed = (hours: number) => SPEEDS.reduce((a, b) => (Math.abs(b - hours / 60) < Math.abs(a - hours / 60) ? b : a));

interface Props {
  periodStartMs: number; n: number; local: number; days: number;
  sun: Float64Array | null; earth: Float64Array | null;
  playing: boolean; speed: number; machineOpen: boolean;
  onPlay: () => void; onSpeed: (s: number) => void; onSeek: (local: number) => void; onMachine: () => void;
}

export function TimeDock({ periodStartMs, n, local, days, sun, earth, playing, speed, machineOpen, onPlay, onSpeed, onSeek, onMachine }: Props) {
  const tk = useMemo(() => ticks(periodStartMs, n), [periodStartMs, n]);
  const ms = periodStartMs + local * 3600e3;
  return (
    <footer className="timebar glass">
      <button className="play" onClick={onPlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <PauseIcon size={15} /> : <PlayIcon size={15} />}
      </button>
      <button className="speed num" title="Playback speed (Moon time per second)" aria-label={`Playback speed ${speedLabel(speed)}`}
        onClick={() => onSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>{speedLabel(speed)}</button>
      <div className="track">
        <div className="ticks num" aria-hidden>
          {tk.map(([f, l]) => <span key={l + f} style={{ left: `${f * 100}%` }}>{l}</span>)}
        </div>
        <Timeline sun={sun} earth={earth} hour={local} onSeek={onSeek} />
        <input type="range" min={0} max={n - 1} step={0.01} value={local} aria-label="Time within the period"
          onChange={(e) => onSeek(Number(e.target.value))} />
      </div>
      <button className={`when num ${machineOpen ? "open" : ""}`} onClick={onMachine} aria-expanded={machineOpen}
        title="Time machine: any date 2020–2045, any period length">
        <span className="when-date"><CalendarIcon size={13} /> {fmtDate(ms)}</span>
        <span className="dim">{fmtTime(ms)} UTC · {fmtSpan(days)} period</span>
      </button>
    </footer>
  );
}
