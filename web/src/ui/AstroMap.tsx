import { useEffect, useMemo, useRef, useState } from "react";
import type { RegionData } from "../data/manifest";
import type { GridPoint } from "../data/region";
import { stereoToLatLon } from "../engine/frames";
import type { HorizonGrid } from "../engine/horizon";
import type { Look } from "../scene/Astronaut";
import { Minimap } from "./Minimap";

/**
 * The full map for Astronaut's eye, at three scales:
 *  - this site: the region's relief with live sunlight (same horizons and formula as the numbers), click to teleport;
 *  - south pole: relief of the polar cap (LOLA normals, ±200 km) with every catalogued site, the region and you;
 *    click a site to go there;
 *  - whole Moon: the LRO WAC colour mosaic (equirectangular) with your position.
 */
type Level = "site" | "pole" | "moon";
export interface MapSite { id: string; name: string; lat_deg: number; lon_deg: number }

const R_KM = 1737.4, POLE_HALF_KM = 200, WIDE_HALF_KM = 460;
/** polar stereographic grid (km) of a latitude/longitude, as the DEMs (x = rho sin lon, y = rho cos lon) */
const grid = (lat: number, lon: number) => {
  const rho = 2 * R_KM * Math.tan(Math.PI / 4 + (lat * Math.PI) / 360);
  return { x: rho * Math.sin((lon * Math.PI) / 180), y: rho * Math.cos((lon * Math.PI) / 180) };
};

function useImage(url: string, on: boolean) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!on || img) return;
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
  }, [on]);
  return img;
}

export function AstroMap({ data, horizon, sun, at, look, lonDeg, sites, regionId, onTeleport, onGoSite, onClose }: {
  data: RegionData; horizon: HorizonGrid | null; sun: { az: number; el: number; dist: number }; at: GridPoint;
  look: React.RefObject<Look>; lonDeg: number; sites: MapSite[]; regionId: string;
  onTeleport: (p: GridPoint) => void; onGoSite: (id: string) => void; onClose: () => void;
}) {
  const [level, setLevel] = useState<Level>("site");
  const [hover, setHover] = useState<string | null>(null);
  const size = Math.round(Math.max(280, Math.min(innerWidth - 40, innerHeight - 190, 720)));
  const t = data.manifest.terrain;
  const here = stereoToLatLon(at.x_m, at.y_m);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "m" || e.key === "M") { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", k, true);
    return () => removeEventListener("keydown", k, true);
  }, []);

  // ---- south pole: hillshade of the LOLA normal map, cropped to +-200 km ----
  const normals = useImage("/textures/moon_southcap_wide_2k.jpg", level === "pole");
  const poleRef = useRef<HTMLCanvasElement>(null);
  const poleShade = useMemo(() => {
    if (!normals) return null;
    const c = document.createElement("canvas"), n = normals.width;
    c.width = c.height = n;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(normals, 0, 0);
    const src = g.getImageData(0, 0, n, n), out = g.createImageData(n, n);
    const lx = -0.55, ly = 0.55, lz = 0.63; // light from the upper left, display only
    for (let i = 0; i < n * n; i++) {
      const x = src.data[4 * i] / 127.5 - 1, y = src.data[4 * i + 1] / 127.5 - 1, z = src.data[4 * i + 2] / 127.5 - 1;
      const v = Math.max(0, Math.min(1, 0.18 + 0.95 * (x * lx + y * ly + z * lz)));
      out.data[4 * i] = 30 + 200 * v; out.data[4 * i + 1] = 30 + 196 * v; out.data[4 * i + 2] = 34 + 186 * v; out.data[4 * i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return c;
  }, [normals]);
  useEffect(() => {
    const cv = poleRef.current;
    if (level !== "pole" || !cv || !poleShade) return;
    const g = cv.getContext("2d")!, n = poleShade.width, crop = (POLE_HALF_KM / WIDE_HALF_KM) * n;
    g.drawImage(poleShade, (n - crop) / 2, (n - crop) / 2, crop, crop, 0, 0, size, size);
    const px = (xKm: number, yKm: number) => [((xKm / POLE_HALF_KM) + 1) * size / 2, (1 - yKm / POLE_HALF_KM) * size / 2];
    // the 3D region
    const [x0, y0] = px(t.x0_m / 1000, t.y0_m / 1000), [x1, y1] = px((t.x0_m + t.cols * t.res_m) / 1000, (t.y0_m - t.rows * t.res_m) / 1000);
    g.strokeStyle = "#6fe3e1"; g.lineWidth = 2; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // sites: dots first, then labels placed where they do not collide (right, left, above, below; else a leader)
    g.font = "12px Inter, system-ui, sans-serif"; g.textAlign = "left";
    const pts = sites.map((s) => { const p = grid(s.lat_deg, s.lon_deg), [sx, sy] = px(p.x, p.y); return { s, sx, sy }; });
    for (const { s, sx, sy } of pts) {
      const cur = s.id === regionId;
      g.fillStyle = cur ? "#f5c451" : hover === s.id ? "#ffffff" : "#6fe3e1";
      g.beginPath(); g.arc(sx, sy, cur ? 6 : 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#04121c"; g.lineWidth = 1.5; g.stroke();
    }
    const placed: [number, number, number, number][] = [];
    const hit = (r: [number, number, number, number]) => r[0] < 0 || r[0] + r[2] > size || r[1] < 0 || r[1] + r[3] > size ||
      placed.some((q) => r[0] < q[0] + q[2] && q[0] < r[0] + r[2] && r[1] < q[1] + q[3] && q[1] < r[1] + r[3]);
    // the current site and the hovered one get first pick
    const order = [...pts].sort((a, b) => Number(b.s.id === regionId || b.s.id === hover) - Number(a.s.id === regionId || a.s.id === hover));
    for (const { s, sx, sy } of order) {
      const w = g.measureText(s.name).width + 8, h = 17, cur = s.id === regionId;
      const tries: [number, number][] = [[sx + 9, sy - 9], [sx - 9 - w, sy - 9], [sx - w / 2, sy - 27], [sx - w / 2, sy + 9],
        [sx + 9, sy - 28], [sx - 9 - w, sy + 10], [sx + 9, sy + 10], [sx - 9 - w, sy - 28], [sx - w / 2, sy - 46], [sx - w / 2, sy + 28]];
      const at = tries.find(([x, y]) => !hit([x, y, w, h]));
      if (!at) continue;
      placed.push([at[0], at[1], w, h]);
      const far = Math.abs(at[1] + h / 2 - sy) > 14;
      if (far) { g.strokeStyle = "rgba(219,230,242,0.5)"; g.lineWidth = 1; g.beginPath(); g.moveTo(sx, sy); g.lineTo(at[0] + w / 2, at[1] + (at[1] > sy ? 0 : h)); g.stroke(); }
      g.fillStyle = "rgba(4,10,18,0.75)"; g.fillRect(at[0], at[1], w, h);
      g.fillStyle = cur ? "#ffd9a0" : hover === s.id ? "#ffffff" : "#dbe6f2"; g.fillText(s.name, at[0] + 4, at[1] + 13);
    }
    // you
    const [ux, uy] = px(at.x_m / 1000, at.y_m / 1000);
    g.fillStyle = "#ffffff"; g.beginPath(); g.arc(ux, uy, 3, 0, Math.PI * 2); g.fill();
    // pole, scale bar
    const [qx, qy] = px(0, 0);
    g.strokeStyle = "rgba(255,255,255,0.6)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(qx - 6, qy); g.lineTo(qx + 6, qy); g.moveTo(qx, qy - 6); g.lineTo(qx, qy + 6); g.stroke();
    g.fillStyle = "rgba(255,255,255,0.75)"; g.fillText("South pole", qx + 8, qy - 6);
    const bar = (100 / (2 * POLE_HALF_KM)) * size;
    g.fillRect(16, size - 22, bar, 3); g.fillText("100 km", 16, size - 28);
  }, [level, poleShade, hover, size, at.x_m, at.y_m, regionId]);
  const siteAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * size, my = ((e.clientY - r.top) / r.height) * size;
    let best: string | null = null, bd = 14;
    for (const s of sites) {
      const p = grid(s.lat_deg, s.lon_deg), sx = ((p.x / POLE_HALF_KM) + 1) * size / 2, sy = (1 - p.y / POLE_HALF_KM) * size / 2;
      const d = Math.hypot(sx - mx, sy - my);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  };

  // ---- whole Moon: equirectangular colour map ----
  const moon = useImage("/textures/moon_color_4k.jpg", level === "moon");
  const moonRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = moonRef.current;
    if (level !== "moon" || !cv || !moon) return;
    const g = cv.getContext("2d")!, W = cv.width, H = cv.height;
    g.drawImage(moon, 0, 0, W, H);
    g.strokeStyle = "rgba(255,255,255,0.12)"; g.lineWidth = 1;
    for (let lat = -60; lat <= 60; lat += 30) { const y = (0.5 - lat / 180) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    for (let lon = -150; lon <= 150; lon += 30) { const x = (0.5 + lon / 360) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    // the polar band where Sunchaser works, and you
    const yb = (0.5 + 84 / 180) * H;
    g.fillStyle = "rgba(245,196,81,0.18)"; g.fillRect(0, yb, W, H - yb);
    const lon = ((here.lon + 540) % 360) - 180, x = (0.5 + lon / 360) * W, y = (0.5 - here.lat / 180) * H;
    g.fillStyle = "#f5c451"; g.beginPath(); g.arc(x, y - 4, 6, 0, Math.PI * 2); g.fill();
    g.font = "12px Inter, system-ui, sans-serif"; g.fillStyle = "#ffd9a0"; g.textAlign = x > W * 0.7 ? "right" : "left";
    g.fillText(`You: ${Math.abs(here.lat).toFixed(2)}° S, ${here.lon.toFixed(1)}° E`, x + (x > W * 0.7 ? -10 : 10), y - 12);
  }, [level, moon, here.lat, here.lon]);

  return (
    <div className="astro-map-back" onClick={onClose}>
      <div className="astro-map glass" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Map">
        <div className="astro-map-head">
          <div className="seg" role="tablist" aria-label="Map scale">
            {([["site", "This site"], ["pole", "South pole"], ["moon", "Whole Moon"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={level === k} className={level === k ? "on" : ""} onClick={() => setLevel(k)}>{l}</button>
            ))}
          </div>
          <span className="num dim">{Math.abs(here.lat).toFixed(4)}° S · {here.lon.toFixed(3)}° E</span>
          <button className="link" onClick={onClose}>Close <kbd>M</kbd></button>
        </div>
        {level === "site" && (
          <>
            <Minimap data={data} horizon={horizon} sun={sun} at={at} look={look} lonDeg={lonDeg} px={size} className="astro-map-canvas"
              onTeleport={(p) => { onTeleport(p); onClose(); }} />
            <p className="hint">{data.manifest.region.name}: {(t.cols * t.res_m) / 1000} km of LOLA 20 m terrain, bright = in sunlight now
              (computed from the real horizons), blue cone = where you look. Click anywhere to go there.</p>
          </>
        )}
        {level === "pole" && (
          <>
            {poleShade ? (
              <canvas ref={poleRef} width={size} height={size} className="astro-map-canvas" style={{ cursor: hover ? "pointer" : "default" }}
                onMouseMove={(e) => setHover(siteAt(e))}
                onClick={(e) => { const id = siteAt(e); if (id && id !== regionId) { onGoSite(id); onClose(); } }} />
            ) : <div className="astro-map-canvas loading-line" style={{ width: size, height: size }}>Loading the polar relief…</div>}
            <p className="hint">±200 km around the pole, LOLA relief (lit from the upper left for reading, not the real Sun).
              Cyan square = the 3D region you are in. Click a site to go there.</p>
          </>
        )}
        {level === "moon" && (
          <>
            <canvas ref={moonRef} width={size * 2 > innerWidth - 40 ? innerWidth - 40 : size * 1.6} height={(size * 2 > innerWidth - 40 ? innerWidth - 40 : size * 1.6) / 2} className="astro-map-canvas" />
            <p className="hint">The whole Moon (NASA LRO WAC mosaic). Amber band = the south polar region Sunchaser covers.</p>
          </>
        )}
      </div>
    </div>
  );
}
