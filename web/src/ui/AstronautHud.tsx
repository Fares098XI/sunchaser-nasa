import { useEffect, useRef, useState } from "react";
import type { Look } from "../scene/Astronaut";
import { EarthIcon, SunIcon } from "./icons";

/**
 * Astronaut's eye overlay: a compass ribbon (local azimuth, with the Sun and Earth on it) redrawn every frame from
 * the look ref (no React re-render), and live gauges for power and the link home.
 */
interface Body { az: number; el: number }
interface Props {
  look: React.RefObject<Look>; lonDeg: number; sun: Body; earth: Body;
  sunFrac: number; earthFrac: number; sunAu: number; dsnUp: number; dsnTotal: number; onExit: () => void;
  /** illustrative ground detail below the 20 m map (rocks, small craters) on/off */
  detail: boolean; onDetail: (on: boolean) => void;
}

export function AstronautHud({ look, lonDeg, sun, earth, sunFrac, earthFrac, sunAu, dsnUp, dsnTotal, onExit, detail, onDetail }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bodies = useRef({ sun, earth });
  bodies.current = { sun, earth };
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = ref.current, l = look.current;
      if (!c || !l) return;
      const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      // horizontal field of view in degrees; ribbon shows a little more than the view
      const hfov = (2 * Math.atan(Math.tan((l.fov * Math.PI) / 360) * (innerWidth / innerHeight)) * 180) / Math.PI;
      const span = Math.min(360, hfov * 1.15), pxPerDeg = w / span;
      const localYaw = (((l.yaw - lonDeg) % 360) + 360) % 360; // grid bearing -> local azimuth from north
      const x = (az: number) => w / 2 + (((az - localYaw + 540) % 360) - 180) * pxPerDeg;
      g.font = "12px JetBrains Mono, monospace";
      g.textAlign = "center";
      for (let a = 0; a < 360; a += 5) {
        const px = x(a);
        if (px < -20 || px > w + 20) continue;
        const major = a % 45 === 0;
        g.fillStyle = major ? "rgba(230,227,220,0.9)" : "rgba(142,138,130,0.7)";
        g.fillRect(px, 18, 1, major ? 9 : a % 15 === 0 ? 6 : 3);
        if (a % 15 === 0) g.fillText(major ? ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][a / 45] : String(a), px, 12);
      }
      const mark = (az: number, color: string, label: string) => {
        let px = x(((az - lonDeg) % 360 + 360) % 360);
        const off = px < 8 ? -1 : px > w - 8 ? 1 : 0;
        px = Math.max(8, Math.min(w - 8, px));
        g.fillStyle = color;
        g.beginPath();
        if (off === 0) g.arc(px, 34, 4, 0, Math.PI * 2);
        else { g.moveTo(px + off * 6, 34); g.lineTo(px - off * 2, 29); g.lineTo(px - off * 2, 39); }
        g.fill();
        g.fillText(label, Math.max(22, Math.min(w - 22, px)), 50);
      };
      mark(bodies.current.sun.az, "#f5c451", "Sun");
      mark(bodies.current.earth.az, "#6fe3e1", "Earth");
      // centre reticle
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.fillRect(w / 2, 0, 1, 30);
      g.fillText(`${Math.round(localYaw)}°`, w / 2, 62);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [lonDeg]);
  const irr = (1361 * sunFrac) / (sunAu * sunAu);
  const link = earthFrac >= 0.5 && dsnUp > 0;
  // helmet on = the pointer is locked to the 3D view: the app's panels step aside and the suit display takes over
  const [helmet, setHelmet] = useState(() => !!document.pointerLockElement);
  useEffect(() => {
    const on = () => setHelmet(!!document.pointerLockElement);
    document.addEventListener("pointerlockchange", on);
    return () => { document.removeEventListener("pointerlockchange", on); document.body.classList.remove("astro-helmet"); };
  }, []);
  useEffect(() => { document.body.classList.toggle("astro-helmet", helmet); }, [helmet]);
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  const [tips, setTips] = useState(true);
  return (
    <>
      <div className="visor" aria-hidden />
      <canvas ref={ref} className="astro-compass" aria-hidden />
      <div className="visor-reticle" aria-hidden />
      <div className="suit suit-pwr" aria-live="polite">
        <span className="suit-k"><SunIcon size={12} /> PWR · sunlight</span>
        <b className="num">{Math.round(sunFrac * 100)}%</b>
        <span className="num">{Math.round(irr)} W/m² · Sun {sun.el.toFixed(1)}° up</span>
      </div>
      <div className={`suit suit-com ${link ? "up" : "down"}`} aria-live="polite">
        <span className="suit-k"><EarthIcon size={12} /> COMM · link to Earth</span>
        <b className="num">{link ? "LINK UP" : "LINK DOWN"}</b>
        <span className="num">Earth {Math.round(earthFrac * 100)}% · {earth.el.toFixed(1)}° up · DSN {dsnUp}/{dsnTotal}</span>
      </div>
      {!helmet && (
        <div className={`astro-card glass ${tips ? "" : "mini"}`}>
          {!touch && <p className="astro-cta">Click the view to put the helmet on</p>}
          {tips && <>
          <ul className="astro-keys">
            {touch ? <>
              <li><kbd>drag</kbd> look around</li>
              <li><kbd>stick</kbd> walk · <kbd>Run</kbd> lunar lope · <kbd>Jump</kbd> in 1/6 g</li>
            </> : <>
              <li><kbd>mouse</kbd> look around</li>
              <li><kbd>W A S D</kbd> walk</li>
              <li><kbd>Shift</kbd> lunar lope</li>
              <li><kbd>Space</kbd> jump in 1/6 g</li>
              <li><kbd>M</kbd> map · <kbd>wheel</kbd> zoom</li>
              <li><kbd>Esc</kbd> helmet off, then stand up</li>
            </>}
          </ul>
          <p className="dim small"><i className="astro-line" /> the thin line is the computed horizon behind every number. Your eyes are 2 m up, where every horizon is computed.</p>
          <label className="toggle small" title="The ground's shape is real NASA LOLA terrain (20 m). Rocks and craters smaller than that are not measured anywhere: they are drawn for a human-scale view and never used by any number.">
            <input type="checkbox" checked={detail} onChange={(e) => onDetail(e.target.checked)} /> rocks &amp; small craters (illustrative)
          </label>
          </>}
          <div className="astro-card-foot">
            {/* touch screens have no helmet to hide this card: let it fold away */}
            {touch && tips && <button className="link" onClick={() => setTips(false)}>got it</button>}
            <button className="link" onClick={onExit}>stand up{touch ? "" : " (Esc)"}</button>
          </div>
        </div>
      )}
    </>
  );
}
