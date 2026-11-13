import { useEffect, useRef, useState } from "react";
import { loadHorizon, loadRegion, type Manifest, type RegionData } from "../data/manifest";
import { apiCrop } from "../data/demFetch";
import { sitesClient } from "../data/sitesClient";
import { loadPeriod } from "../data/tracks";
import type { HorizonGrid } from "../engine/horizon";
import { deriveTracks, regionFrame } from "../engine/regiontracks";
import { siteSeries } from "../engine/series";
import { SUN_RADIUS_KM } from "../engine/sky";
import { landingCircle, slopeMap } from "../engine/terrainmetrics";
import type { PeriodTracks } from "../engine/tracks";
import { SunIcon } from "../ui/icons";
import { fmtDate } from "../ui/time";

/**
 * S7 mission stories (docs/METHODS.md §23): the interactive figures, each computed from the app's real data:
 * IM-2 from the im2-target region (20 m LOLA terrain, its horizons, the Sun derived from the SPICE tracks for March
 * 2025); Apollo from stories.json (SPICE at the six touchdowns) and SLDEM2015 around Apollo 15; the far side from the
 * atlas sites' Earth tables.
 */

// ---------- IM-2: the landing zone ----------
export const IM2 = {
  target: { x_m: 77106.75, y_m: 138362.95 }, athena: { x_m: 77108.24, y_m: 137993.27 }, // LROC 1401 and 1408 (sites manifest)
  touchdownUtc: "2025-03-06T17:28:50Z", // Wikipedia "IM-2", 17:28:50 UTC
  craterM: 20, // LROC 1408: "on its side in a ~20 m crater"
};
export interface Im2Data { data: RegionData; horizon: HorizonGrid; pt: PeriodTracks; slopes: Float32Array }

export function useIm2(): Im2Data | null {
  const [d, setD] = useState<Im2Data | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const [hero, data]: [Manifest, RegionData] = await Promise.all([fetch("/data/manifest.json").then((r) => r.json()), loadRegion("/data/regions/im2-target/")]);
      const idx = hero.tracks, start = Math.round((Date.parse(IM2.touchdownUtc) - Date.parse(idx.start_utc + "Z")) / 3600e3);
      const [horizon, period] = await Promise.all([loadHorizon(data.manifest, data.base), loadPeriod(idx, start, 12 * 24)]);
      const pt = deriveTracks(period, regionFrame(hero), regionFrame(data.manifest));
      if (live) setD({ data, horizon, pt, slopes: slopeMap(data.heights, data.manifest.terrain) });
    })().catch(() => undefined);
    return () => { live = false; };
  }, []);
  return d;
}

/** At a grid point: share of the solar disc visible over the first 12 days, the first dark hour, the 100 m slope. */
export function im2At(d: Im2Data, p: { x_m: number; y_m: number }) {
  const h = d.data.manifest.horizon, fr = (h.y0_m - p.y_m) / h.cell_m - 0.5, fc = (p.x_m - h.x0_m) / h.cell_m - 0.5;
  const s = siteSeries(d.horizon, fr, fc, d.pt.sun, SUN_RADIUS_KM);
  let sum = 0, dark = -1;
  for (let i = 0; i < s.length; i++) { sum += s[i]; if (dark < 0 && s[i] < 0.5) dark = i; }
  const lc = landingCircle(d.slopes, d.data.manifest.terrain, p.x_m, p.y_m);
  return { sunPct: (100 * sum) / s.length, darkH: dark, slope: lc };
}

/** The landing zone: real LOLA 20 m terrain, relief-shaded by the Sun at touchdown; drag the lander anywhere. */
export function Im2Map({ d, at, onAt, showAthena, showRing }: {
  d: Im2Data; at: { x_m: number; y_m: number }; onAt?: (p: { x_m: number; y_m: number }) => void; showAthena: boolean; showRing: boolean;
}) {
  const t = d.data.manifest.terrain, W = 1400, cx = (IM2.target.x_m + IM2.athena.x_m) / 2, cy = (IM2.target.y_m + IM2.athena.y_m) / 2;
  const x0 = cx - W / 2, y1 = cy + W / 2, S = 520, k = S / W;
  const ref = useRef<HTMLCanvasElement>(null), svg = useRef<SVGSVGElement>(null);
  const sunAz = d.pt.sun.az_grid_deg[0], sunEl = d.pt.sun.elev_deg[0];
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const n = Math.round(W / t.res_m);
    c.width = c.height = n;
    const g = c.getContext("2d")!, img = g.createImageData(n, n), a = (sunAz * Math.PI) / 180, e = (12 * Math.PI) / 180; // relief light 12 deg up (readable), from the real azimuth
    const L = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
    const H = (r: number, cc: number) => d.data.heights[Math.min(t.rows - 1, Math.max(0, r)) * t.cols + Math.min(t.cols - 1, Math.max(0, cc))];
    const r0 = Math.round((t.y0_m - y1) / t.res_m), c0 = Math.round((x0 - t.x0_m) / t.res_m);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const r = r0 + i, cc = c0 + j, gx = (H(r, cc + 1) - H(r, cc - 1)) / (2 * t.res_m), gy = (H(r - 1, cc) - H(r + 1, cc)) / (2 * t.res_m);
      const nz = 1 / Math.hypot(gx, gy, 1), v = Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) * nz);
      const o = 4 * (i * n + j), lum = 18 + 225 * Math.pow(Math.min(1, v * 1.15), 1.25);
      img.data[o] = lum; img.data[o + 1] = lum * 0.97; img.data[o + 2] = lum * 0.92; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [d]);
  const X = (x: number) => (x - x0) * k, Y = (y: number) => (y1 - y) * k;
  const drag = (e: React.PointerEvent) => {
    if (!onAt || !(e.buttons & 1) || !svg.current) return;
    const b = svg.current.getBoundingClientRect();
    onAt({ x_m: x0 + ((e.clientX - b.left) / b.width) * W, y_m: y1 - ((e.clientY - b.top) / b.height) * W });
  };
  const sa = (sunAz * Math.PI) / 180;
  return (
    <div className="st-map">
      <canvas ref={ref} />
      <svg ref={svg} viewBox={`0 0 ${S} ${S}`} className={onAt ? "drag" : ""} role="img" aria-label="IM-2 landing zone"
        onPointerDown={(e) => { if (!onAt) return; svg.current?.setPointerCapture(e.pointerId); drag(e); }} onPointerMove={drag}>
        {showRing && [125, 250].map((r) => <circle key={r} cx={X(IM2.target.x_m)} cy={Y(IM2.target.y_m)} r={r * k} className="st-ring" />)}
        {showRing && <text x={X(IM2.target.x_m) + 250 * k + 4} y={Y(IM2.target.y_m)} className="st-lbl">250 m</text>}
        <g transform={`translate(${X(IM2.target.x_m)} ${Y(IM2.target.y_m)})`}><path d="M0,-11 L3,-3 11,-3 4.5,2 7,10 0,5 -7,10 -4.5,2 -11,-3 -3,-3Z" className="st-star" /></g>
        <text x={X(IM2.target.x_m) + 14} y={Y(IM2.target.y_m) - 8} className="st-lbl">target</text>
        {showAthena && <>
          <line x1={X(IM2.target.x_m)} y1={Y(IM2.target.y_m)} x2={X(IM2.athena.x_m)} y2={Y(IM2.athena.y_m)} className="st-miss" />
          <g transform={`translate(${X(IM2.athena.x_m)} ${Y(IM2.athena.y_m)})`}><path d="M-7,-7 L7,7 M7,-7 L-7,7" className="st-x" /></g>
          <text x={X(IM2.athena.x_m) + 12} y={Y(IM2.athena.y_m) + 4} className="st-lbl red">Athena came to rest</text>
          <text x={(X(IM2.target.x_m) + X(IM2.athena.x_m)) / 2 + 8} y={(Y(IM2.target.y_m) + Y(IM2.athena.y_m)) / 2} className="st-lbl">370 m</text>
        </>}
        {onAt && <g transform={`translate(${X(at.x_m)} ${Y(at.y_m)})`} className="st-lander"><circle r={13} /><path d="M-6,5 L0,-7 L6,5 M-9,8 L-5,4 M9,8 L5,4" /></g>}
        <g transform={`translate(${S - 46} 46)`} className="st-sunarrow"><circle r={30} /><line x1={0} y1={0} x2={Math.sin(sa) * 26} y2={-Math.cos(sa) * 26} />
          <text y={44} textAnchor="middle">Sun {sunEl.toFixed(1)}° up</text><text y={-34} textAnchor="middle">N</text></g>
        <g transform={`translate(16 ${S - 18})`} className="st-scale"><line x1={0} x2={500 * k} y1={0} y2={0} /><text x={0} y={-6}>500 m</text></g>
      </svg>
    </div>
  );
}

/** One crater, one pixel: the 20 m LOLA cells around Athena (real heights) with a 20 m crater drawn to scale. */
export function PixelZoom({ d }: { d: Im2Data }) {
  const t = d.data.manifest.terrain, N = 9, S = 360, px = S / N;
  const c0 = Math.floor((IM2.athena.x_m - t.x0_m) / t.res_m) - 4, r0 = Math.floor((t.y0_m - IM2.athena.y_m) / t.res_m) - 4;
  const cells = [];
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const h = d.data.heights[(r0 + i) * t.cols + c0 + j]; lo = Math.min(lo, h); hi = Math.max(hi, h); cells.push(h); }
  const ax = ((IM2.athena.x_m - (t.x0_m + c0 * t.res_m)) / t.res_m) * px, ay = (((t.y0_m - r0 * t.res_m) - IM2.athena.y_m) / t.res_m) * px;
  const [show, setShow] = useState(false);
  useEffect(() => { const tm = setTimeout(() => setShow(true), 700); return () => clearTimeout(tm); }, []);
  return (
    <figure className="st-zoom">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Twenty-metre map cells around Athena with a twenty-metre crater">
        {cells.map((h, i) => <rect key={i} x={(i % N) * px} y={Math.floor(i / N) * px} width={px - 1} height={px - 1}
          fill={`hsl(30, 6%, ${22 + 40 * ((h - lo) / Math.max(1, hi - lo))}%)`}><title>{`${h.toFixed(1)} m`}</title></rect>)}
        <circle cx={ax} cy={ay} r={(IM2.craterM / 2 / t.res_m) * px} className={`st-crater ${show ? "on" : ""}`} />
        <text x={ax + (IM2.craterM / 2 / t.res_m) * px + 6} y={ay + 4} className={`st-lbl red st-tipped ${show ? "on" : ""}`}>~20 m crater (Athena)</text>
        <g transform={`translate(10 ${S - 12})`} className="st-scale"><line x1={0} x2={px} y1={0} y2={0} /><text x={0} y={-6}>20 m = one map cell</text></g>
      </svg>
      <figcaption className="dim">Each square is one cell of NASA's best south-pole map (LOLA, 20 m), shaded by its real height
        ({lo.toFixed(0)}–{hi.toFixed(0)} m). The circle is a 20 m crater, drawn to scale where LROC found Athena.</figcaption>
    </figure>
  );
}

// ---------- Apollo ----------
export interface ApolloStory { id: string; name: string; lat_deg: number; lon_deg: number; touchdown_utc: string; sun: { az: number; el: number }; earth: { az: number; el: number }; track: { from_h: number; az: number[]; el: number[] } }
export function useApollo() {
  const [d, setD] = useState<ApolloStory[] | null>(null);
  useEffect(() => { fetch("/data/stories.json").then((r) => r.json()).then((j) => setD(j.apollo), () => undefined); }, []);
  return d;
}

/** Looking east at each Apollo touchdown: the Sun's real azimuth and elevation (the sky is 90 deg tall; this is its lowest 22). */
export function ApolloSky({ a, pick, onPick }: { a: ApolloStory[]; pick: string; onPick: (id: string) => void }) {
  const W = 640, H = 340, top = 30, base = 270, az0 = 60, az1 = 120, el1 = 22;
  const x = (az: number) => ((az - az0) / (az1 - az0)) * W, y = (el: number) => base - (el / el1) * (base - top);
  const e0 = Math.min(...a.map((m) => m.sun.el)), e1 = Math.max(...a.map((m) => m.sun.el));
  // labels left or right of their Sun (alternating by azimuth), pushed apart vertically so none overlap
  const lab: Record<string, { side: number; y: number }> = {};
  [...a].sort((p, q) => p.sun.az - q.sun.az).forEach((m, k) => { lab[m.id] = { side: k % 2 ? 1 : -1, y: 0 }; });
  for (const sd of [-1, 1]) {
    let last = -1e9;
    for (const m of a.filter((q) => lab[q.id].side === sd).sort((p, q) => q.sun.el - p.sun.el)) { lab[m.id].y = Math.max(y(m.sun.el) + 4, last + 15); last = lab[m.id].y; }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="st-sky" role="img" aria-label="The Sun at the six Apollo touchdowns, looking east">
      <defs><linearGradient id="st-dawn" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#2b1a0a" /><stop offset="0.35" stopColor="#0d0f17" /><stop offset="1" stopColor="#050608" /></linearGradient></defs>
      <rect x={0} y={0} width={W} height={base} fill="url(#st-dawn)" />
      <rect x={0} y={y(e1 + 0.6)} width={W} height={y(e0 - 0.6) - y(e1 + 0.6)} className="st-band" />
      <text x={8} y={y(e1 + 0.6) - 6} className="st-lbl">every touchdown: {e0.toFixed(1)}°–{e1.toFixed(1)}° up</text>
      {[5, 10, 15, 20].map((el) => <g key={el}><line x1={0} x2={W} y1={y(el)} y2={y(el)} className="st-grid" /><text x={W - 4} y={y(el) - 3} textAnchor="end" className="st-lbl dim">{el}°</text></g>)}
      <text x={W / 2} y={18} textAnchor="middle" className="st-lbl dim">↑ overhead is 90°, far above this view</text>
      <path d={`M0,${base} L${W},${base} L${W},${H} L0,${H}Z`} className="st-groundfill" />
      <line x1={0} x2={W} y1={base} y2={base} className="st-hzline" />
      {[["NE", 45], ["E", 90], ["SE", 135]].map(([l, az]) => Number(az) >= az0 && Number(az) <= az1 ? <text key={l} x={x(Number(az))} y={base + 18} textAnchor="middle" className="st-lbl">{l}</text> : null)}
      {a.map((m) => {
        const cx = x(m.sun.az), cy = y(m.sun.el), on = pick === m.id, sd = lab[m.id].side;
        return (
          <g key={m.id} className={`st-sunpt ${on ? "on" : ""}`} onClick={() => onPick(m.id)} role="button" aria-label={`${m.name}: Sun ${m.sun.el.toFixed(1)} degrees`}>
            <line x1={cx} x2={cx} y1={cy} y2={base} className="st-drop" />
            <circle cx={cx} cy={cy} r={on ? 11 : 7} />
            <text x={cx + sd * 13} y={lab[m.id].y} textAnchor={sd > 0 ? "start" : "end"}>{m.name.replace("Apollo ", "A")} {m.sun.el.toFixed(1)}°</text>
          </g>
        );
      })}
      <text x={8} y={H - 10} className="st-lbl dim">looking east from each landing site · SPICE</text>
    </svg>
  );
}

/** Apollo 15's ground (SLDEM2015, 59 m) lit by the real Sun at any hour of that lunar day: cast shadows included. */
export function ApolloRelief({ m, h, setH }: { m: ApolloStory; h: number; setH: (h: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [dem, setDem] = useState<{ h: Float32Array; nr: number; nc: number; dy: number; dx: number } | null | "none">(null);
  useEffect(() => {
    let live = true;
    apiCrop(`product=hi&half_km=6&lat=${m.lat_deg}&lon=${m.lon_deg}`).then((r) => {
      if (!live) return;
      if (!r) { setDem("none"); return; }
      // the crop as a north-up height grid around the site
      const ppd = r.ppd, d = 6 / 1737.4 * 180 / Math.PI, rows = Math.round(2 * d * ppd), cols = Math.round((2 * d * ppd) / Math.cos((m.lat_deg * Math.PI) / 180));
      const top = Math.round((90 - m.lat_deg - d) * ppd), left = Math.round(((m.lon_deg + 360) % 360) * ppd - cols / 2);
      const out = new Float32Array(rows * cols);
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[i * cols + j] = r.get(top + i, (left + j + r.ns) % r.ns);
      const dy = (1737400 * Math.PI) / 180 / ppd;
      setDem({ h: out, nr: rows, nc: cols, dy, dx: dy * Math.cos((m.lat_deg * Math.PI) / 180) });
    });
    return () => { live = false; };
  }, [m.id]);
  const k = h - m.track.from_h, az = m.track.az[k] ?? 0, el = m.track.el[k] ?? -90;
  useEffect(() => {
    const c = ref.current;
    if (!c || !dem || dem === "none") return;
    const { nr, nc, dx, dy } = dem, H = dem.h;
    c.width = nc; c.height = nr;
    const g = c.getContext("2d")!, img = g.createImageData(nc, nr);
    const a = (az * Math.PI) / 180, e = (Math.max(el, -5) * Math.PI) / 180, L = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
    const tanE = Math.tan(e), stepX = Math.sin(a), stepY = -Math.cos(a), stepM = Math.hypot(stepX * dx, stepY * dy);
    const exposure = Math.min(1, 0.14 / Math.max(Math.sin(e), 0.01)) * 2.4; // as the 3D view's auto-exposure
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
      const q = i * nc + j, gx = (H[i * nc + Math.min(nc - 1, j + 1)] - H[i * nc + Math.max(0, j - 1)]) / (2 * dx);
      const gy = (H[Math.max(0, i - 1) * nc + j] - H[Math.min(nr - 1, i + 1) * nc + j]) / (2 * dy);
      let lit = el > -0.3 ? Math.max(0, (-gx * L[0] - gy * L[1] + L[2]) / Math.hypot(gx, gy, 1)) : 0;
      if (lit > 0) for (let s = 1; ; s++) { // walk toward the Sun: any terrain above the ray casts a shadow here
        const y = Math.round(i + s * stepY), x = Math.round(j + s * stepX);
        if (y < 0 || x < 0 || y >= nr || x >= nc) break;
        if (H[y * nc + x] > H[q] + s * stepM * tanE) { lit = 0; break; }
      }
      const v = Math.min(255, 255 * Math.pow(Math.min(1, lit * exposure), 1 / 2.2)) , o = 4 * q;
      img.data[o] = v * 0.98 + 6; img.data[o + 1] = v * 0.96 + 7; img.data[o + 2] = v * 0.9 + 12; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, [dem, k]);
  const day = m.track.el.map((v, i) => [i + m.track.from_h, v] as const).filter(([, v]) => v > -1);
  const lo = day[0]?.[0] ?? 0, hi = day[day.length - 1]?.[0] ?? 0;
  return (
    <figure className="st-relief">
      <div className="st-relief-img">
        {dem === "none" ? <div className="dim st-offline">The 59 m terrain needs the network (NASA PDS through the app's terrain service).</div> : <canvas ref={ref} />}
        <div className="st-target" aria-hidden><i /></div>
        <div className="st-relief-read num"><SunIcon size={12} /> {el.toFixed(1)}° up, from the {az < 180 ? "east" : "west"} ({az.toFixed(0)}°){el > 0.5 && <> · a 1 m rock casts a <b>{(1 / Math.tan((el * Math.PI) / 180)).toFixed(1)} m</b> shadow</>}</div>
      </div>
      <input type="range" min={lo} max={hi} value={h} onChange={(e) => setH(Number(e.target.value))} aria-label="Hour of the lunar day" />
      <div className="st-relief-scale num"><span>sunrise</span><button className="link" onClick={() => setH(0)}>◆ {m.name} touchdown ({m.sun.el.toFixed(1)}°)</button><span>sunset · {((hi - lo) / 24).toFixed(1)} Earth days later</span></div>
      <figcaption className="dim">NASA SLDEM2015 (LOLA + SELENE, 59 m), 12 km around the landing site (the cross), lit and shadowed by the Sun's real position
        that lunar day (SPICE). Hadley Rille winds across the plain.</figcaption>
    </figure>
  );
}

// ---------- the far side ----------
export const FAR_SITES: [string, string][] = [["apollo-11", "#f3f1ec"], ["blue-ghost-1", "#6be6a6"], ["change-6", "#b49cff"], ["change-4", "#ff8fb1"]];

export function useEarthTracks(days = 60) {
  const [d, setD] = useState<{ id: string; name: string; lon: number; el: Float32Array; t0: number; stepH: number }[] | null>(null);
  useEffect(() => {
    const c = sitesClient();
    let live = true;
    c.ready.then(async () => {
      const a = c.stepAt("2027-01-01T00:00:00Z"), b = a + Math.round((days * 86400) / c.manifest.step_s), every = 6; // hourly
      const out = await Promise.all(FAR_SITES.map(async ([id]) => {
        const r = await c.call({ type: "sky", site: id, z: 1, a, b }), e = c.manifest.sites.find((s) => s.id === id)!;
        return { id, name: e.name, lon: e.lon_deg, el: Float32Array.from({ length: Math.floor((b - a) / every) }, (_, i) => r.earth.el[i * every]), t0: c.timeAt(a).getTime(), stepH: 1 };
      }));
      if (live) setD(out);
    }, () => undefined);
    return () => { live = false; };
  }, [days]);
  return d;
}

/** Earth's elevation over two months from four sites, west of the near side's centre to the far side. */
export function EarthCurves({ tracks, cur, onCur }: { tracks: NonNullable<ReturnType<typeof useEarthTracks>>; cur: number; onCur: (i: number) => void }) {
  const W = 620, H = 320, n = tracks[0].el.length, top = 14, bot = 30, lo = -60, hi = 80;
  const x = (i: number) => (i / (n - 1)) * W, y = (v: number) => top + ((hi - v) / (hi - lo)) * (H - top - bot);
  const ref = useRef<SVGSVGElement>(null);
  const pick = (e: React.PointerEvent) => { if (!(e.buttons & 1) || !ref.current) return; const b = ref.current.getBoundingClientRect(); onCur(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - b.left) / b.width) * (n - 1))))); };
  const col = Object.fromEntries(FAR_SITES);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="st-curves drag-x" role="img" aria-label="Earth's elevation from four sites over two months"
      onPointerDown={(e) => { ref.current?.setPointerCapture(e.pointerId); pick(e); }} onPointerMove={pick}>
      <rect x={0} y={y(0)} width={W} height={H - bot - y(0)} className="st-ground" />
      <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="st-hzline" />
      <text x={4} y={y(0) - 5} className="st-lbl">horizon</text>
      {[30, 60].map((v) => <g key={v}><line x1={0} x2={W} y1={y(v)} y2={y(v)} className="st-grid" /><text x={4} y={y(v) - 4} className="st-lbl dim">{v}°</text></g>)}
      {tracks.map((t) => (
        <polyline key={t.id} points={Array.from(t.el, (v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} className="st-curve" style={{ stroke: col[t.id] }} />
      ))}
      {[0, 14, 28, 42, 56].map((dd) => <text key={dd} x={x(dd * 24)} y={H - 10} className="st-lbl dim">{fmtDate(tracks[0].t0 + dd * 86400e3).replace(/ \d{4}$/, "")}</text>)}
      <line x1={x(cur)} x2={x(cur)} y1={top} y2={H - bot} className="st-cur" />
      {tracks.map((t) => <circle key={t.id} cx={x(cur)} cy={y(t.el[cur])} r={5} style={{ fill: col[t.id] }} />)}
    </svg>
  );
}

/** Top view of the Earth–Moon system over a month: the Moon turns once per orbit, so one face always looks at Earth. */
export function LockedOrbit() {
  const [day, setDay] = useState(0);
  const S = 420, c = S / 2, R = 150, th = (day / 27.32) * 2 * Math.PI, mx = c + R * Math.cos(th), my = c - R * Math.sin(th), mr = 30;
  // the face toward Earth points back along -th; Apollo 11 sits there, Chang'e 4 on the opposite side
  const toEarth = th + Math.PI, a11 = [mx + mr * Math.cos(toEarth), my - mr * Math.sin(toEarth)], c4 = [mx - mr * Math.cos(toEarth), my + mr * Math.sin(toEarth)];
  const [play, setPlay] = useState(true);
  useEffect(() => {
    if (!play || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => { const dt = (now - last) / 1000; last = now; setDay((d) => (d + dt * 2.2) % 27.32); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [play]);
  return (
    <figure className="st-orbit">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="The Moon keeps one face toward Earth as it orbits">
        <circle cx={c} cy={c} r={R} className="st-orbitpath" />
        <circle cx={c} cy={c} r={22} className="st-earth" /><text x={c} y={c + 40} textAnchor="middle" className="st-lbl">Earth</text>
        <line x1={a11[0]} y1={a11[1]} x2={c} y2={c} className="st-los ok" />
        <g><circle cx={mx} cy={my} r={mr} className="st-moon" />
          <path d={`M${mx + mr * Math.cos(toEarth + Math.PI / 2)},${my - mr * Math.sin(toEarth + Math.PI / 2)} A${mr},${mr} 0 0 ${1} ${mx + mr * Math.cos(toEarth - Math.PI / 2)},${my - mr * Math.sin(toEarth - Math.PI / 2)}`} className="st-nearface" />
        </g>
        <circle cx={a11[0]} cy={a11[1]} r={4} className="st-site a11" /><circle cx={c4[0]} cy={c4[1]} r={4} className="st-site c4" />
        <text x={c4[0] + (c4[0] - mx) * 0.6} y={c4[1] + (c4[1] - my) * 0.6} textAnchor="middle" className="st-lbl pink">Chang'e 4</text>
        <text x={12} y={22} className="st-lbl">Day {day.toFixed(1)} of 27.3 (one orbit, one turn)</text>
      </svg>
      <div className="st-orbit-ctl"><button className="chip-btn" onClick={() => setPlay((p) => !p)}>{play ? "❚❚ pause" : "▶ play"}</button>
        <input type="range" min={0} max={27.32} step={0.05} value={day} onChange={(e) => { setPlay(false); setDay(Number(e.target.value)); }} aria-label="Day of the orbit" /></div>
    </figure>
  );
}

/** How Chang'e 4 talks to Earth: through a relay satellite circling the Earth–Moon L2 point, beyond the far side. */
export function RelayDiagram() {
  return (
    <svg viewBox="0 0 700 300" className="st-relay" role="img" aria-label="Chang'e 4 relays through Queqiao near the Earth–Moon L2 point">
      <defs><marker id="st-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10Z" className="st-arrhead" /></marker></defs>
      <circle cx={70} cy={150} r={44} className="st-earth" /><text x={70} y={220} textAnchor="middle" className="st-lbl">Earth</text>
      <circle cx={420} cy={150} r={34} className="st-moon" /><text x={420} y={208} textAnchor="middle" className="st-lbl">Moon</text>
      <circle cx={452} cy={150} r={4} className="st-site c4" /><text x={440} y={112} textAnchor="middle" className="st-lbl pink">Chang'e 4 (far side)</text>
      <ellipse cx={565} cy={150} rx={22} ry={70} className="st-halo" /><text x={565} y={240} textAnchor="middle" className="st-lbl">L2 halo orbit</text>
      <circle cx={565} cy={80} r={6} className="st-sat" /><text x={578} y={72} className="st-lbl">Queqiao relay</text>
      <line x1={455} y1={146} x2={560} y2={84} className="st-link" markerEnd="url(#st-arr)" />
      <path d="M560,78 C460,10 220,20 112,118" className="st-link" markerEnd="url(#st-arr)" fill="none" />
      <line x1={452} y1={150} x2={114} y2={150} className="st-blocked" /><text x={260} y={168} textAnchor="middle" className="st-lbl red">blocked by the Moon itself</text>
    </svg>
  );
}

