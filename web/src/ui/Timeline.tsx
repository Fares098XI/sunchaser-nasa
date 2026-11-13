import { useEffect, useRef } from "react";
import { EarthIcon, SunIcon } from "./icons";

interface Props {
  sun: ArrayLike<number> | null;   // visible solar-disc fraction per hour at the site
  earth: ArrayLike<number> | null; // visible Earth-disc fraction per hour at the site
  hour: number;
  onSeek: (h: number) => void;
}

/** Two hairline strips over the time slider: when the site has Sun (power) and Earth (comms). */
export function Timeline({ sun, earth, hour, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const n = sun?.length ?? 0;

  useEffect(() => {
    const c = ref.current;
    if (!c || !sun || !earth) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const row = (data: ArrayLike<number>, y: number, rgb: string) => {
      g.fillStyle = "rgba(38,43,53,0.95)";
      g.fillRect(0, y, w, 8);
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor((x / w) * data.length), i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * data.length));
        let s = 0;
        for (let i = i0; i < i1; i++) s += data[i];
        const v = s / (i1 - i0);
        if (v > 0) {
          g.fillStyle = `rgba(${rgb},${0.25 + 0.75 * v})`;
          g.fillRect(x, y, 1, 8);
        }
      }
    };
    row(sun, 1, "245,196,81"); // solar gold
    row(earth, 13, "63,169,245"); // ocean
  }, [sun, earth]);

  if (!n) return <div className="timeline placeholder" />;
  return (
    <div className="timeline-row">
      <div className="legend" aria-hidden>
        <span className="sun"><SunIcon size={9} /></span>
        <span className="earth"><EarthIcon size={9} /></span>
      </div>
      <div className="timeline" title="Top: Sun disc visible at the selected point (power). Bottom: Earth disc visible (direct-to-Earth comms). Click to jump.">
        <canvas ref={ref} onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - r.left) / r.width) * (n - 1));
        }} />
        <i className="cursor" style={{ left: `${(hour / (n - 1)) * 100}%` }} />
      </div>
    </div>
  );
}
