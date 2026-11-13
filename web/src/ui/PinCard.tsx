import { useEffect, useRef, useState } from "react";
import { fmtLatLon, usePinFrac, type PinState } from "../data/pin";
import { sitesClient, useSitesRev } from "../data/sitesClient";
import { fmtDuration } from "../engine/clock";
import { distKm, type SitePos } from "../engine/replan";
import type { Metrics } from "../engine/windows";
import { CheckIcon, EarthIcon, PinIcon, SunIcon } from "./icons";

/**
 * S5 — "Drop a pin anywhere": the pin's own card on the globe. While it computes, the steps the browser is running;
 * then the answer for the landing period: power, Earth contact, the Sun and Earth over its real horizon.
 */
interface Props {
  pin: PinState; start: string; days: number; z: number;
  known: (SitePos & { name: string })[];
  onOpen: () => void; onPlan: () => void; onRemove: () => void; onRetry: () => void;
  /** S5b: fly into the pin's own 3D region; its build progress while it is being made */
  onFly: () => void; fly: { stage: "terrain" | "shadows"; frac: number } | { stage: "error"; error: string } | null;
}

const STEPS: { stage: PinState["stage"]; title: string; text: (p: PinState) => string }[] = [
  { stage: "terrain", title: "Terrain", text: () => "NASA LOLA height maps around your point: 474 m near, 1.9 km out to 300 km" },
  { stage: "horizon", title: "Horizon", text: () => "109,440 terrain horizons: 1,440 directions × 19 landing points × 4 heights, the exact ray walk of our pipeline" },
  { stage: "sky", title: "Sun and Earth", text: () => "Where the Sun and Earth stand above that horizon, every 10 minutes of 2026–2028" },
];
const ORDER = ["terrain", "horizon", "sky", "done"];
const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`);
const ord = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

export function PinCard({ pin, start, days, z, known, onOpen, onPlan, onRemove, onRetry, onFly, fly }: Props) {
  const client = sitesClient(), rev = useSitesRev();
  const ready = pin.stage === "done";
  const [res, setRes] = useState<{ m: Metrics; sunRank: number; dteRank: number; n: number } | null>(null);
  const [clock, setClock] = useState<{ sun: { up: boolean; steps: number | null }; stepH: number } | null>(null);
  const [sky, setSky] = useState<{ horizon: Float64Array; sun: { az: Float64Array; el: Float64Array }; earth: { az: Float64Array; el: Float64Array } } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setRes(null); setSky(null); setClock(null);
    if (!ready || !client.manifest?.sites.some((s) => s.id === "pin")) return;
    const a = client.stepAt(start + "T00:00:00Z"), b = Math.min(client.manifest.n, a + Math.round((days * 86400) / client.manifest.step_s));
    client.call({ type: "compare", z, a, b }).then((r) => {
      const rows: { id: string; m: Metrics }[] = r.rows, me = rows.find((x) => x.id === "pin");
      if (!me) return;
      const rank = (k: keyof Metrics) => 1 + rows.filter((x) => x.m[k] > me.m[k]).length;
      setRes({ m: me.m, sunRank: rank("sunPct"), dteRank: rank("dtePct"), n: rows.length });
    }, () => undefined);
    client.call({ type: "clock", z, a }).then((r) => { const me = r.rows.find((x: { id: string }) => x.id === "pin"); if (me) setClock({ sun: me.sun, stepH: r.stepH }); }, () => undefined);
    client.call({ type: "sky", site: "pin", z, a, b }).then(setSky, () => undefined);
  }, [ready, rev, start, days, z]);

  const near = known.length ? known.map((s) => ({ s, km: distKm(s, { id: "pin", lat_deg: pin.lat, lon_deg: pin.lon }) })).sort((p, q) => p.km - q.km)[0] : null;
  const entry = ready ? client.manifest.sites.find((s) => s.id === "pin") : undefined;
  const coarse = pin.near?.includes("LDEM_16");
  const copy = () => navigator.clipboard?.writeText(location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => undefined);
  const earthLine = res && (res.m.earthPct === 0 ? "Far side: Earth never rises here, so no direct radio link"
    : res.m.earthPct >= 99.95 ? "Earth stays above the horizon the whole stay"
    : `Earth rises and sets: in view ${res.m.earthPct.toFixed(0)} % of the stay`);

  return (
    <aside className="pin-card glass" aria-label="Your pin" aria-live="polite">
      <header>
        <span className="pc-icon" aria-hidden><PinIcon size={16} /></span>
        <div>
          <div className="eyebrow">Your pin · anywhere on the Moon</div>
          <h3 className="num">{fmtLatLon(pin.lat, pin.lon)}</h3>
          <p className="dim">{entry ? <>ground {Math.round(entry.ground_m).toLocaleString("en").replace("-", "−")} m · </> : null}
            {near && <>nearest known site: {near.s.name}, {near.km < 10 ? near.km.toFixed(1) : Math.round(near.km).toLocaleString()} km</>}</p>
        </div>
        <button className="pc-x" onClick={onRemove} aria-label="Remove the pin" title="Remove the pin">×</button>
      </header>

      {!ready && pin.stage !== "error" && (
        <ol className="pc-steps">
          {STEPS.map((st) => {
            const k = ORDER.indexOf(st.stage), cur = ORDER.indexOf(pin.stage), state = cur > k ? "done" : cur === k ? "on" : "todo";
            return (
              <li key={st.stage} className={state}>
                <span className="pc-dot" aria-hidden>{state === "done" ? <CheckIcon size={12} /> : null}</span>
                <div><b>{st.title}</b> <span className="dim">{st.text(pin)}</span>
                  {state === "on" && st.stage === "horizon" && <Bar />}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {pin.stage === "error" && <p className="error">Could not compute this point: {pin.error} <button className="link" onClick={onRetry}>try again</button></p>}

      {ready && (
        <>
          <MiniSky sky={sky} />
          {res && (
            <div className="pc-facts">
              <div><span className="dim"><SunIcon size={12} /> Sunlight</span><b className="num">{res.m.sunPct.toFixed(0)} %</b><small className="dim">{ord(res.sunRank)} of {res.n} sites</small></div>
              <div><span className="dim">Longest night</span><b className="num">{fmtH(res.m.darkH)}</b>
                {clock && <small className={`lasts ${clock.sun.up ? "up" : "down"}`}>{clock.sun.up ? "Sun up · sets in" : "dark · Sun rises in"} {clock.sun.steps == null ? "> 90 d" : fmtDuration(clock.sun.steps * clock.stepH)}</small>}</div>
              <div><span className="dim"><EarthIcon size={12} /> Link to Earth</span><b className="num">{res.m.dtePct.toFixed(0)} %</b><small className="dim">{ord(res.dteRank)} of {res.n} sites</small></div>
              <p className="pc-earth">{earthLine}.</p>
            </div>
          )}
          <p className="dim pc-period">Landing {start}, {days}-day stay, {client.manifest.z_m[z]} m above ground.
            {pin.ms != null && <> Computed in your browser in {(pin.ms / 1000).toFixed(1)} s
              {pin.steps && <> (terrain {(pin.steps.terrain / 1000).toFixed(1)} s, horizons {(pin.steps.horizon / 1000).toFixed(1)} s, Sun and Earth {(pin.steps.sky / 1000).toFixed(1)} s)</>}.</>}</p>
          {fly && fly.stage !== "error" ? (
            <div className="pc-fly" role="status">
              <b>{fly.stage === "terrain" ? "Loading 59 m NASA terrain…" : `Casting shadows on your GPU… ${Math.round(fly.frac * 100)} %`}</b>
              <span className="dim">{fly.stage === "terrain" ? "SLDEM2015 (LOLA + Kaguya stereo) for 24 km around your pin, LOLA out to 300 km"
                : "7.2 million terrain horizons: 40,000 points × 180 directions, out to 300 km"}</span>
              <div className="pc-bar"><i style={{ width: `${fly.stage === "terrain" ? 4 : Math.round(4 + fly.frac * 96)}%` }} /></div>
            </div>
          ) : (
            <button className="cta pc-fly-btn" onClick={onFly}>Fly there in 3D →</button>
          )}
          {fly?.stage === "error" && <p className="error">Could not build the 3D view: {fly.error}</p>}
          <div className="pc-actions">
            <button className="cta ghost" onClick={onOpen}>Horizon view and all sites</button>
            <button className="cta ghost" onClick={onPlan}>Find landing dates</button>
            <button className="cta ghost" onClick={copy}>{copied ? "Link copied" : "Copy link"}</button>
          </div>
        </>
      )}
      <p className="pc-src">{coarse ? <b>Near terrain at 1.9 km (the 474 m map was not reachable{Math.abs(pin.lat) > 86 ? " this close to a pole" : ""}): horizons are coarser. </b> : null}
        Terrain: NASA LOLA global maps · method validated against our pipeline (V11) · tap the Moon anywhere to move the pin</p>
    </aside>
  );
}

/** 360° skyline at the pin with the Sun's and Earth's paths over the stay. Elevation axis asinh-scaled so a 2° ridge
 * and a Sun 60° up both fit. */
function MiniSky({ sky }: { sky: { horizon: Float64Array; sun: { az: Float64Array; el: Float64Array }; earth: { az: Float64Array; el: Float64Array } } | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const f = (el: number) => Math.asinh(el / 3), lo = f(-3), hi = f(90), base = h - 14;
    const Y = (el: number) => base - ((f(el) - lo) / (hi - lo)) * (base - 4);
    const X = (az: number) => ((((az + 180) % 360) + 360) % 360) / 360 * w; // north in the middle
    // elevation guides
    g.font = "12px 'JetBrains Mono', monospace"; g.textBaseline = "middle";
    for (const el of [0, 10, 45]) {
      g.strokeStyle = el === 0 ? "rgba(230,227,220,0.25)" : "rgba(230,227,220,0.08)";
      g.beginPath(); g.moveTo(0, Y(el)); g.lineTo(w, Y(el)); g.stroke();
      g.fillStyle = "rgba(142,138,130,0.9)"; g.fillText(`${el}°`, 3, Y(el) - 6);
    }
    if (!sky) return;
    const dots = (t: { az: Float64Array; el: Float64Array }, rgb: string) => {
      g.fillStyle = `rgba(${rgb},0.55)`;
      for (let i = 0; i < t.az.length; i += 3) if (t.el[i] > -3) g.fillRect(X(t.az[i]) - 0.75, Y(t.el[i]) - 0.75, 1.5, 1.5);
    };
    dots(sky.sun, "255,179,71");
    dots(sky.earth, "90,209,255");
    // terrain silhouette (drawn over the paths: what is behind the ridge is hidden)
    const n = sky.horizon.length;
    g.beginPath(); g.moveTo(0, base + 14);
    for (let x = 0; x <= w; x++) { const az = (x / w) * 360 - 180; g.lineTo(x, Y(sky.horizon[Math.floor((((az % 360) + 360) % 360) / 360 * n) % n])); }
    g.lineTo(w, base + 14); g.closePath();
    g.fillStyle = "#0b111c"; g.fill();
    g.strokeStyle = "rgba(255,233,166,0.7)"; g.lineWidth = 1; g.stroke();
    g.fillStyle = "rgba(230,227,220,0.75)"; g.textBaseline = "alphabetic"; g.textAlign = "center";
    ([["S", 0], ["W", 0.25], ["N", 0.5], ["E", 0.75], ["S", 1]] as const).forEach(([l, u]) => g.fillText(l, Math.min(w - 5, Math.max(5, u * w)), h - 2));
  }, [sky]);
  return (
    <figure className="pc-sky">
      <canvas ref={ref} aria-label="Skyline at the pin: terrain horizon in every direction, with the Sun (amber) and Earth (blue) paths over the stay" />
      <figcaption className="dim"><span className="sw sun" /> Sun · <span className="sw earth" /> Earth over the stay, above the real horizon (north centre)</figcaption>
    </figure>
  );
}

/** Horizon progress of the pin being computed (its own render: the rest of the page stays still). */
export function PinPct() { return <>{Math.round(usePinFrac() * 100)} %</>; }
function Bar() { return <div className="pc-bar"><i style={{ width: `${Math.round(usePinFrac() * 100)}%` }} /></div>; }
