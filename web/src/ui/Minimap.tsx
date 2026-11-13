import { useEffect, useMemo, useRef } from "react";
import type { RegionData } from "../data/manifest";
import type { GridPoint } from "../data/region";
import { horizonAtPoint, type HorizonGrid } from "../engine/horizon";
import { SUN_RADIUS_KM, angularRadiusDeg, visibleDiscFraction } from "../engine/sky";
import type { Look } from "../scene/Astronaut";

/**
 * Mini-map of the 10 km region: relief, live sunlight (same horizons and formula as the numbers), your position and
 * view cone. Click to teleport.
 */
export function Minimap({ data, horizon, sun, at, look, lonDeg, onTeleport, onExpand, px: PX = 168, className = "minimap" }: {
  data: RegionData; horizon: HorizonGrid | null; sun: { az: number; el: number; dist: number }; at: GridPoint;
  look: React.RefObject<Look>; lonDeg: number; onTeleport: (p: GridPoint) => void;
  /** open the full-size map */
  onExpand?: () => void;
  /** canvas size in pixels (the big map draws the same picture larger) */
  px?: number; className?: string;
}) {
  const t = data.manifest.terrain, hm = data.manifest.horizon;
  const ref = useRef<HTMLCanvasElement>(null);
  // hillshade once (light from the upper left, display only)
  const shade = useMemo(() => {
    const out = new Float32Array(PX * PX), s = t.cols / PX;
    for (let r = 0; r < PX; r++) for (let c = 0; c < PX; c++) {
      const i = Math.min(t.rows - 2, Math.floor(r * s)), j = Math.min(t.cols - 2, Math.floor(c * s));
      const h = data.heights, k = i * t.cols + j;
      const dx = (h[k + 1] - h[k]) / t.res_m, dy = (h[k + t.cols] - h[k]) / t.res_m;
      out[r * PX + c] = Math.max(0, Math.min(1, 0.55 + (dy - dx) * 0.9));
    }
    return out;
  }, [data, PX]);
  // live sunlight, recomputed when the Sun moves
  const lit = useMemo(() => {
    if (!horizon) return null;
    const out = new Float32Array(PX * PX), rs = angularRadiusDeg(SUN_RADIUS_KM, sun.dist);
    for (let r = 0; r < PX; r++) for (let c = 0; c < PX; c++) {
      const fr = ((r + 0.5) / PX) * hm.rows - 0.5, fc = ((c + 0.5) / PX) * hm.cols - 0.5;
      out[r * PX + c] = visibleDiscFraction(sun.el, horizonAtPoint(horizon, fr, fc, sun.az), rs);
    }
    return out;
  }, [horizon, PX, Math.round(sun.az * 4), Math.round(sun.el * 40)]);

  useEffect(() => {
    let raf = 0;
    const img = new ImageData(PX, PX);
    for (let i = 0; i < PX * PX; i++) {
      const v = shade[i], l = lit ? lit[i] : 1;
      const base = 18 + 60 * v, sunlit = 120 + 120 * v;
      const g = base + (sunlit - base) * l;
      img.data[4 * i] = g; img.data[4 * i + 1] = g * 0.97; img.data[4 * i + 2] = g * 0.92 + (1 - l) * 18; img.data[4 * i + 3] = 255;
    }
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current;
      if (!cv) return;
      const g = cv.getContext("2d")!;
      g.putImageData(img, 0, 0);
      const x = ((at.x_m - t.x0_m) / (t.cols * t.res_m)) * PX, y = ((t.y0_m - at.y_m) / (t.rows * t.res_m)) * PX;
      const yaw = ((look.current?.yaw ?? 0) * Math.PI) / 180, half = (((look.current?.fov ?? 60) * 0.8) * Math.PI) / 360;
      // view cone (grid bearing: 0 = up on the map)
      g.fillStyle = "rgba(111,227,225,0.22)";
      g.beginPath(); g.moveTo(x, y);
      g.arc(x, y, PX * 0.155, yaw - half - Math.PI / 2, yaw + half - Math.PI / 2);
      g.closePath(); g.fill();
      g.fillStyle = "#6fe3e1"; g.strokeStyle = "#04121c"; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); g.stroke();
      // north (local) marker
      const n = ((-lonDeg) * Math.PI) / 180;
      g.fillStyle = "rgba(230,227,220,0.85)"; g.font = "12px JetBrains Mono, monospace"; g.textAlign = "center";
      g.fillText("N", PX / 2 + Math.sin(n) * PX * 0.42, PX / 2 - Math.cos(n) * PX * 0.42 + 3);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [shade, lit, at.x_m, at.y_m, PX]);

  const canvas = (
    <canvas ref={ref} width={PX} height={PX} className={className} aria-label="Map of this site: click to teleport"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
        onTeleport({ x_m: t.x0_m + fx * t.cols * t.res_m, y_m: t.y0_m - fy * t.rows * t.res_m });
      }} />
  );
  return onExpand ? (
    <div className="minimap-wrap">
      {canvas}
      <button className="minimap-expand glass" onClick={onExpand} aria-label="Open the full map" title="Open the full map (M)">⤢</button>
    </div>
  ) : canvas;
}
