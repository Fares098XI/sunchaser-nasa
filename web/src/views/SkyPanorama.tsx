import { useEffect, useMemo, useRef, useState } from "react";
import { sitesClient } from "../data/sitesClient";
import { visibleDiscFraction } from "../engine/sky";
import { fmtDuration, nextChange } from "../engine/clock";
import { EarthIcon, PauseIcon, PlayIcon, SunIcon } from "../ui/icons";

interface Track { az: Float64Array; el: Float64Array; r: Float64Array }
interface Sky { horizon: Float64Array; lon: number; sun: Track; earth: Track; dsn: Uint8Array }

/** Horizon at a grid azimuth, linear between the 1,440 bins (same rule as engine/sites.ts siteHorizon). */
function hAt(h: Float64Array, azGrid: number) {
  const u = (((azGrid % 360) + 360) % 360) * h.length / 360;
  const i = Math.floor(u) % h.length, f = u - Math.floor(u);
  return h[i] * (1 - f) + h[(i + 1) % h.length] * f;
}

/** Unit vector for a local az/el (deg). */
const vec = (az: number, el: number) => {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
};

interface Props { siteId: string; siteName: string; z: number; a: number; b: number; onClose?: () => void }

/**
 * 360 deg panorama at a site: real terrain skyline, the Sun (true-size disc, cut by the ridge exactly where the
 * numbers say) and Earth (true phase), with their paths over the period. Azimuth is local (true north).
 */
export function SkyPanorama({ siteId, siteName, z, a, b, onClose }: Props) {
  const client = sitesClient();
  const [sky, setSky] = useState<Sky | null>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const ref = useRef<HTMLCanvasElement>(null);

  const [spread, setSpread] = useState<{ sunPct: number; dtePct: number }[] | null>(null);
  useEffect(() => {
    setSky(null); setSpread(null);
    client.call({ type: "sky", site: siteId, z, a, b }).then((r) => { setSky(r); setI(0); });
    client.call({ type: "spread", site: siteId, z, a, b }).then((r) => setSpread(r.pts), () => undefined);
  }, [siteId, z, a, b]);

  // mission clock (METHODS §17): margins per 10-minute step; the link needs Earth up and a DSN dish (bit set)
  const margins = useMemo(() => {
    if (!sky) return null;
    const n = sky.sun.az.length, sun = new Float64Array(n), earth = new Float64Array(n), link = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      sun[k] = sky.sun.el[k] - hAt(sky.horizon, sky.sun.az[k]) + sky.sun.r[k];
      earth[k] = sky.earth.el[k] - hAt(sky.horizon, sky.earth.az[k]);
      link[k] = Math.min(earth[k], sky.dsn[k] ? 1 : -1);
    }
    return { sun, earth, link };
  }, [sky]);
  const stepH = (client.manifest?.step_s ?? 600) / 3600;
  const ch = margins ? { sun: nextChange(margins.sun, i), earth: nextChange(margins.earth, i), link: nextChange(margins.link, i) } : null;
  const setIdx = ch?.sun.up && ch.sun.at != null ? Math.round(ch.sun.at) : null;

  useEffect(() => {
    if (!playing || !sky) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      setI((v) => (v + Math.max(1, Math.round(((now - last) / 1000) * 72))) % sky.sun.az.length); // 12 h per second
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, sky]);

  const now = useMemo(() => {
    if (!sky) return null;
    const lon = sky.lon;
    const body = (t: Track) => {
      const az = t.az[i], el = t.el[i], r = t.r[i], h = hAt(sky.horizon, az);
      return { azGrid: az, azLocal: (((az - lon) % 360) + 360) % 360, el, r, h, frac: visibleDiscFraction(el, h, r) };
    };
    const sun = body(sky.sun), earth = body(sky.earth);
    // Earth's illuminated fraction: phase angle at Earth ~ 180 deg - Sun-Earth elongation seen from the Moon
    const u = vec(sun.azLocal, sun.el), v = vec(earth.azLocal, earth.el);
    const elong = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2])));
    const lit = (1 - Math.cos(elong)) / 2;
    return { sun, earth, lit, dsn: sky.dsn[i] };
  }, [sky, i]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !sky || !now) return;
    const dpr = Math.min(devicePixelRatio, 2), W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const lon = sky.lon;
    let lo = Infinity, hi = -Infinity;
    for (const v of sky.horizon) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    // bodies count only near or above the skyline (far below it, e.g. the Sun at night or Earth on the far side, they
    // would flatten the view)
    for (const t of [sky.sun, sky.earth]) for (const v of t.el) if (v > -8) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    lo = Math.floor(lo - 0.6); hi = Math.ceil(hi + 1.2);
    // away from the pole the Sun and Earth climb far above the skyline: keep the skyline readable, mark them with arrows
    let hMax = -Infinity;
    for (const v of sky.horizon) hMax = Math.max(hMax, v);
    hi = Math.min(hi, Math.max(Math.ceil(hMax + 8), 12));
    const X = (azLocal: number) => (azLocal / 360) * W;
    const Y = (el: number) => H - 22 - ((el - lo) / (hi - lo)) * (H - 40);
    const xs = W / 360, ys = (H - 40) / (hi - lo);

    // sky
    const sk = g.createLinearGradient(0, 0, 0, H);
    sk.addColorStop(0, "#04060b"); sk.addColorStop(1, "#0b1220");
    g.fillStyle = sk; g.fillRect(0, 0, W, H);
    // elevation grid
    g.font = "12px JetBrains Mono, monospace"; g.fillStyle = "#8e8a82"; g.strokeStyle = "rgba(142,138,130,0.18)";
    for (let e = Math.ceil(lo); e <= hi; e++) {
      g.beginPath(); g.moveTo(0, Y(e)); g.lineTo(W, Y(e)); g.lineWidth = e === 0 ? 1.2 : 0.6;
      g.strokeStyle = e === 0 ? "rgba(230,227,220,0.35)" : "rgba(142,138,130,0.16)"; g.stroke();
      if (e % 2 === 0) g.fillText(`${e}°`, 4, Y(e) - 3);
    }
    // tracks over the period (dim where behind terrain)
    const track = (t: Track, rgb: string) => {
      for (let k = 0; k < t.az.length; k += 2) {
        const azL = (((t.az[k] - lon) % 360) + 360) % 360;
        const above = t.el[k] > hAt(sky.horizon, t.az[k]);
        g.fillStyle = `rgba(${rgb},${above ? 0.55 : 0.14})`;
        g.fillRect(X(azL), Y(t.el[k]), 1.2, 1.2);
      }
    };
    track(sky.sun, "255,179,71");
    track(sky.earth, "90,209,255");
    // bodies, drawn before the terrain so the skyline clips them exactly
    const disc = (azL: number, el: number, r: number) => [X(azL), Math.max(Y(el), 30), Math.max(r * xs, 2.5), Math.max(r * ys, 2.5)] as const;
    g.font = "12px Inter, sans-serif"; g.textAlign = "center";
    for (const [b, c] of [[now.sun, "#ffd9a0"], [now.earth, "#6fe3e1"]] as const)
      if (b.el > hi) { g.fillStyle = c; g.fillText(`↑ ${b.el.toFixed(0)}° above`, X(b.azLocal), 14); }
    g.textAlign = "left";
    const [sx, sy, srx, sry] = disc(now.sun.azLocal, now.sun.el, now.sun.r);
    const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 60);
    glow.addColorStop(0, "rgba(255,230,170,0.55)"); glow.addColorStop(1, "rgba(255,170,60,0)");
    g.fillStyle = glow; g.fillRect(sx - 60, sy - 60, 120, 120);
    g.fillStyle = "#fff4d6"; g.beginPath(); g.ellipse(sx, sy, srx, sry, 0, 0, Math.PI * 2); g.fill();
    const [ex, ey, erx, ery] = disc(now.earth.azLocal, now.earth.el, now.earth.r);
    // Earth with true phase: dark disc, Sun-facing half lit, then the terminator ellipse (width |1 - 2k|)
    // filled lit for gibbous (k > 0.5) or dark for crescent (k < 0.5).
    const DARK = "#0c1a2b", LIT = "#6fe3e1";
    const sunRight = ((now.sun.azLocal - now.earth.azLocal + 360) % 360) < 180;
    g.fillStyle = DARK; g.beginPath(); g.ellipse(ex, ey, erx, ery, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = LIT; g.beginPath();
    g.ellipse(ex, ey, erx, ery, 0, sunRight ? -Math.PI / 2 : Math.PI / 2, sunRight ? Math.PI / 2 : (3 * Math.PI) / 2);
    g.fill();
    g.fillStyle = now.lit > 0.5 ? LIT : DARK; g.beginPath();
    g.ellipse(ex, ey, Math.abs(1 - 2 * now.lit) * erx, ery, 0, 0, Math.PI * 2); g.fill();
    // terrain
    const terr = g.createLinearGradient(0, Y(hi), 0, H);
    terr.addColorStop(0, "#26221c"); terr.addColorStop(1, "#0d0c0b");
    g.beginPath(); g.moveTo(0, H);
    for (let px = 0; px <= W; px++) g.lineTo(px, Y(hAt(sky.horizon, (px / W) * 360 + lon)));
    g.lineTo(W, H); g.closePath(); g.fillStyle = terr; g.fill();
    g.beginPath();
    for (let px = 0; px <= W; px++) { const y = Y(hAt(sky.horizon, (px / W) * 360 + lon)); if (px) g.lineTo(px, y); else g.moveTo(px, y); }
    g.strokeStyle = "rgba(255,200,130,0.65)"; g.lineWidth = 1; g.stroke();
    // close-ups: the real skyline across the Sun's disc, and Earth's phase, at equal angular scale on both axes
    const inset = (ox: number, label: string, azL: number, el: number, half: number, body: (cx: number, cy: number, k: number) => void) => {
      const S = 92, oy = 24, k = S / (2 * half); // px per degree
      g.save();
      g.beginPath(); g.roundRect(ox, oy, S, S, 8); g.clip();
      g.fillStyle = "#05080f"; g.fillRect(ox, oy, S, S);
      body(ox + S / 2, oy + S / 2, k);
      g.beginPath(); g.moveTo(ox, oy + S);
      for (let px = 0; px <= S; px++) {
        const h = hAt(sky.horizon, azL + lon + (px - S / 2) / k);
        g.lineTo(ox + px, oy + S / 2 - (h - el) * k);
      }
      g.lineTo(ox + S, oy + S); g.closePath();
      g.fillStyle = "rgba(24,21,17,0.97)"; g.fill();
      g.strokeStyle = "rgba(255,200,130,0.8)"; g.lineWidth = 1; g.stroke();
      g.restore();
      g.strokeStyle = "rgba(194,190,181,0.35)"; g.beginPath(); g.roundRect(ox + 0.5, oy + 0.5, S - 1, S - 1, 8); g.stroke();
      g.fillStyle = "#8e8a82"; g.font = "12px Inter, sans-serif"; g.textAlign = "left";
      g.fillText(label, ox + 6, oy + S + 12);
    };
    inset(W - 214, "Sun close-up", now.sun.azLocal, now.sun.el, 0.8, (cx, cy, k) => {
      const gl = g.createRadialGradient(cx, cy, 0, cx, cy, now.sun.r * k * 2.4);
      gl.addColorStop(0, "rgba(255,240,200,0.5)"); gl.addColorStop(1, "rgba(255,170,60,0)");
      g.fillStyle = gl; g.fillRect(cx - 60, cy - 60, 120, 120);
      g.fillStyle = "#fff4d6"; g.beginPath(); g.arc(cx, cy, now.sun.r * k, 0, Math.PI * 2); g.fill();
    });
    inset(W - 112, "Earth close-up", now.earth.azLocal, now.earth.el, 1.6, (cx, cy, k) => {
      const R = now.earth.r * k, right = ((now.sun.azLocal - now.earth.azLocal + 360) % 360) < 180;
      g.fillStyle = "#0c1a2b"; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#6fe3e1"; g.beginPath();
      g.arc(cx, cy, R, right ? -Math.PI / 2 : Math.PI / 2, right ? Math.PI / 2 : (3 * Math.PI) / 2); g.fill();
      g.fillStyle = now.lit > 0.5 ? "#6fe3e1" : "#0c1a2b"; g.beginPath();
      g.ellipse(cx, cy, Math.abs(1 - 2 * now.lit) * R, R, 0, 0, Math.PI * 2); g.fill();
    });

    // compass
    g.fillStyle = "#e6e3dc"; g.font = "12px Inter, sans-serif"; g.textAlign = "center";
    [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([l, d]) => g.fillText(l as string, X(d as number) + (d === 0 ? 8 : 0), H - 6));
    g.textAlign = "left"; g.fillStyle = "#8e8a82"; g.fillText(`vertical ×${(ys / xs).toFixed(1)}`, W - 300, 14);
    // where the Sun will next touch the skyline
    if (setIdx != null) {
      const azL = (((sky.sun.az[setIdx] - lon) % 360) + 360) % 360, y = Y(hAt(sky.horizon, sky.sun.az[setIdx]));
      g.strokeStyle = "#f5c451"; g.lineWidth = 2; g.beginPath(); g.arc(X(azL), y, 6, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#ffd9a0"; g.font = "12px Inter, sans-serif"; g.textAlign = "center"; g.fillText("sunset point", X(azL), y - 11);
    }
  }, [sky, now, setIdx]);

  const names = sitesClient().manifest?.dsn.names ?? [];
  const inView = now ? names.filter((_, k) => now.dsn & (1 << k)) : [];
  const t = sky ? client.timeAt(a + i) : null;

  return (
    <div className="sky glass">
      <div className="sky-head">
        <div>
          <div className="eyebrow">Horizon view</div>
          <h3>{siteName}</h3>
        </div>
        {now && (
          <div className="sky-read num">
            <span className="sun"><SunIcon size={13} /> {Math.round(now.sun.frac * 100)}% of disc</span>
            <span className="earth"><EarthIcon size={13} /> {now.earth.el.toFixed(2)}° · {Math.round(now.lit * 100)}% lit</span>
            <span className={inView.length && now.earth.frac >= 0.5 ? "ok" : "dim"}>DSN {inView.length ? inView.join(", ") : "none"}</span>
            {ch && <span className="sun">{ch.sun.up ? "sunset" : "sunrise"} {ch.sun.at == null ? "not in period" : `in ${fmtDuration((ch.sun.at - i) * stepH)}`}</span>}
            {ch && <span className="earth">{ch.link.up ? "link ends" : "link starts"} {ch.link.at == null ? "not in period" : `in ${fmtDuration((ch.link.at - i) * stepH)}`}</span>}
          </div>
        )}
        {onClose && <button className="btn ghost" onClick={onClose} aria-label="Close horizon view">Close</button>}
      </div>
      {spread && (() => {
        const r = (k: "sunPct" | "dtePct") => { const v = spread.map((q) => q[k]); return `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)} %`; };
        return <p className="sky-spread">Land anywhere within 250 m (19 points) over this period: sunlight <b className="num">{r("sunPct")}</b>,
          link to Earth <b className="num">{r("dtePct")}</b></p>;
      })()}
      <canvas ref={ref} className="pano" aria-label={`360 degree horizon at ${siteName}`} />
      {sky && (
        <div className="sky-time">
          <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <PauseIcon size={14} /> : <PlayIcon size={14} />}
          </button>
          <input type="range" min={0} max={sky.sun.az.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label="Time" />
          <span className="num">{t?.toISOString().slice(0, 16).replace("T", " ")} UTC</span>
        </div>
      )}
      <p className="hint">Skyline from NASA LOLA terrain out to 300 km (1,440 directions). The Sun is drawn at its true size: the ridge hides exactly the part the numbers count as hidden. Dots show the Sun and Earth paths over the period (faint = behind terrain).</p>
    </div>
  );
}
