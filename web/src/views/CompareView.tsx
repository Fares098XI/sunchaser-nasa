import { useEffect, useMemo, useRef, useState } from "react";
import { LimitsStrip } from "../ui/LimitsStrip";
import { sitesClient, useSitesRev } from "../data/sitesClient";
import { parseLatLon, type PinState } from "../data/pin";
import { PinPct } from "../ui/PinCard";
import type { SiteEntry } from "../engine/sites";
import type { Metrics, PowerSystem } from "../engine/windows";
import { PowerFields } from "../ui/PowerFields";
import { fmtDuration } from "../engine/clock";
import { EarthIcon, SunIcon } from "../ui/icons";
import { SkyPanorama } from "./SkyPanorama";

type Col = { key: keyof Metrics; label: string; unit: string; better: "high" | "low"; tip: string; fmt: (v: number) => string };

const COLS: Col[] = [
  { key: "sunPct", label: "Sunlight", unit: "%", better: "high", fmt: (v) => v.toFixed(1),
    tip: "Average visible fraction of the solar disc over the period (power). Below: how long the Sun stays up (or down) from the landing time." },
  { key: "darkH", label: "Longest darkness", unit: "", better: "low", fmt: fmtH,
    tip: "Longest stretch with no part of the Sun visible (battery must last this long)." },
  { key: "earthPct", label: "Earth in view", unit: "%", better: "high", fmt: (v) => v.toFixed(1),
    tip: "Share of time Earth's centre is above the terrain horizon." },
  { key: "dtePct", label: "DTE link", unit: "%", better: "high", fmt: (v) => v.toFixed(1),
    tip: "Share of time with a direct-to-Earth link: Earth above the terrain AND a DSN 70 m antenna (Goldstone, Canberra, Madrid) sees the Moon at >= 6 deg." },
  { key: "blackoutH", label: "Longest blackout", unit: "", better: "low", fmt: fmtH,
    tip: "Longest stretch without a direct-to-Earth link." },
  { key: "energyWhM2Day", label: "Solar energy", unit: "kWh/m²/d", better: "high", fmt: (v) => (v / 1000).toFixed(1),
    tip: "Sunlight energy reaching 1 m^2 of a Sun-tracking panel per day, at the true Sun distance (TSI 1361 W/m^2; multiply by panel efficiency)." },
  { key: "batteryMinPct", label: "Battery low", unit: "%", better: "high", fmt: (v) => v.toFixed(0),
    tip: "Lowest battery charge over the stay for the power system shown (starts full). 0 % means the load could not always be met — see the hours below the value." },
];

function fmtH(h: number) {
  return h === 0 ? "0 h" : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
}

const tag = (s: SiteEntry) => s.kind === "pin" ? "your pin · computed in your browser" : s.kind === "atlas" ? `${s.agency?.split(" / ")[0]} · ${s.landed_utc ? s.landed_utc.slice(0, 4) : "planned"}`
  : s.id.startsWith("im2") ? "IM-2 · LROC" : s.artemis_iii_region ? "Artemis III region" : "Barker 2021 RoI";
/** 0.67° N · 23.5° E (east longitudes above 180° shown as west) */
const latLon = (s: SiteEntry) => {
  const lon = ((s.lon_deg + 540) % 360) - 180;
  return `${Math.abs(s.lat_deg).toFixed(2)}° ${s.lat_deg < 0 ? "S" : "N"} · ${Math.abs(lon).toFixed(1)}° ${lon < 0 ? "W" : "E"}`;
};
const srcUrl = (s: SiteEntry) => s.source.match(/https?:\/\/\S+/)?.[0];
type Scope = "all" | "pole" | "moon";
const SCOPES: [Scope, string][] = [["all", "All sites"], ["pole", "South pole"], ["moon", "Whole Moon (Apollo, CLPS, other nations)"]];

interface Props {
  start: string; days: number; z: number; power: PowerSystem;
  onChange: (p: { start?: string; days?: number; z?: number; power?: PowerSystem }) => void;
  /** open a site in 3D at the landing date: site id, landing time (ms UTC), stay in days */
  onExplore?: (site: string, landMs: number, days: number) => void;
  onAllLimits: () => void;
  /** open this site's horizon view and mission card (from the globe) */
  focus?: string | null;
  onFocused?: () => void;
  /** S5: the user's own point (state) and dropping one by coordinates */
  pin?: PinState | null;
  onPin?: (lat: number, lon: number) => void;
  /** show the pin on the globe (fly there) */
  onShowGlobe?: () => void;
  /** S7: open the mission story about this site */
  onStory?: (id: "apollo" | "farside") => void;
}

export function CompareView({ start, days, z, power, onChange, onExplore, onAllLimits, focus, onFocused, pin, onPin, onStory, onShowGlobe }: Props) {
  const client = sitesClient(), rev = useSitesRev();
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<{ id: string; m: Metrics }[] | null>(null);
  const [strips, setStrips] = useState<Record<string, { sun: Float32Array; earth: Float32Array; dte: Float32Array }>>({});
  const [sort, setSort] = useState<{ key: keyof Metrics; dir: 1 | -1 }>({ key: "sunPct", dir: -1 });
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [scope, setScope] = useState<Scope>("all");
  useEffect(() => { if (focus) { setOpen(focus); setScope("all"); onFocused?.(); } }, [focus]);
  const [range, setRange] = useState<[number, number] | null>(null);
  type Ch = { up: boolean; steps: number | null };
  const [clock, setClock] = useState<{ stepH: number; by: Record<string, { sun: Ch; dte: Ch }> } | null>(null);

  useEffect(() => { client.ready.then(() => setReady(true), (e) => setErr(String(e))); }, []);

  useEffect(() => {
    if (!ready) return;
    const a = client.stepAt(start + "T00:00:00Z");
    const b = Math.min(client.manifest.n, a + Math.round((days * 86400) / client.manifest.step_s));
    setRange([a, b]);
    client.call({ type: "compare", z, a, b, power }).then((r) => setRows(r.rows), (e) => setErr(String(e)));
    client.call({ type: "clock", z, a }).then((r) => setClock({ stepH: r.stepH, by: Object.fromEntries(r.rows.map((x: { id: string }) => [x.id, x])) }), () => undefined);
    client.call({ type: "strips", z, a, b, width: 240 }).then(
      (r) => setStrips(Object.fromEntries(r.strips.map((s: any) => [s.id, s]))), (e) => setErr(String(e)));
  }, [ready, rev, start, days, z, JSON.stringify(power)]);
  // a pin dropped from here opens its horizon view when it is ready
  const [wantPin, setWantPin] = useState(false);
  useEffect(() => { if (wantPin && pin?.stage === "done" && rows?.some((r) => r.id === "pin")) { setOpen("pin"); setScope("all"); setWantPin(false); } }, [wantPin, pin?.stage, rows]);

  const sites = ready ? client.manifest.sites : [];
  const byId = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s])), [ready, rev]);
  const best = useMemo(() => {
    if (!rows) return {} as Record<string, number>;
    return Object.fromEntries(COLS.map((c) => {
      const vals = rows.map((r) => r.m[c.key]);
      return [c.key, c.better === "high" ? Math.max(...vals) : Math.min(...vals)];
    }));
  }, [rows]);
  const inScope = (id: string) => scope === "all" || byId[id]?.kind === "pin" || (scope === "moon") === (byId[id]?.kind === "atlas");
  const sorted = rows ? rows.filter((r) => inScope(r.id)).sort((p, q) => sort.dir * (p.m[sort.key] - q.m[sort.key])) : [];
  const minDate = ready ? client.manifest.start_utc.slice(0, 10) : undefined;
  const maxDate = ready ? client.timeAt(client.manifest.n - 1).toISOString().slice(0, 10) : undefined;

  return (
    <section className="sheet glass" aria-label="Compare sites">
      <header className="sheet-head">
        <div>
          <div className="eyebrow">Compare</div>
          <h2>Every site, same period</h2>
          <p className="dim">Power and direct-to-Earth comms side by side, from each site's real terrain horizon (1,440 directions).
            No blended score: each column is one requirement.</p>
          <LimitsStrip ids={["terrain", "comms", "power", "sites", "atlas", "pin", "time"]} onAll={onAllLimits} />
          <div className="seg scope" role="group" aria-label="Which sites">{SCOPES.map(([k, l]) => (
            <button key={k} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>{l}</button>))}</div>
          {onPin && <PinForm pin={pin} onPin={(la, lo) => { setWantPin(true); onPin(la, lo); }} onShowGlobe={onShowGlobe} />}
        </div>
        <div className="controls">
          <label>Landing <input type="date" value={start} min={minDate} max={maxDate} onChange={(e) => e.target.value && onChange({ start: e.target.value })} /></label>
          <label>Stay <input type="range" min={1} max={60} value={days} onChange={(e) => onChange({ days: Number(e.target.value) })} />
            <span className="num">{days} d</span></label>
          <label>Panel / antenna
            <select value={z} onChange={(e) => onChange({ z: Number(e.target.value) })}>
              {(ready ? client.manifest.z_m : [1, 2, 5, 10]).map((h, i) => <option key={h} value={i}>{h} m</option>)}
            </select>
          </label>
        </div>
      </header>

      <details className="power-box">
        <summary>Power system for the battery column: {power.panelM2} m² panel · {Math.round(power.efficiency * 100)}% · {power.loadW} W load · {power.batteryWh} Wh</summary>
        <PowerFields power={power} onChange={(pw) => onChange({ power: pw })} />
      </details>
      {err && <p className="error">Could not load site data: {err}</p>}
      {open && (byId[open]?.kind === "atlas" || byId[open]?.kind === "pin") && <MissionCard s={byId[open]} m={rows?.find((r) => r.id === open)?.m} start={start} days={days} onStory={onStory} />}
      {open && range && (
        <SkyPanorama siteId={open} siteName={byId[open]?.name ?? open} z={z} a={range[0]} b={range[1]} onClose={() => setOpen(null)} />
      )}
      {!rows && !err && <div className="loading-line">Loading site horizons and 2026–2028 ephemerides…</div>}
      {rows && sorted.length > 1 && <Insights rows={sorted} byId={byId} days={days} onOpen={(id) => setOpen(id)} />}
      {rows && (
        <div className="table-wrap">
          <table className="compare">
            <thead>
              <tr>
                <th className="site-col">Site</th>
                {COLS.map((c) => (
                  <th key={c.key} title={c.tip} aria-sort={sort.key === c.key ? (sort.dir < 0 ? "descending" : "ascending") : "none"}>
                    <button onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (-s.dir as 1 | -1) : (c.better === "high" ? -1 : 1) }))}>
                      {c.key === "sunPct" && <SunIcon size={12} />}{(c.key === "earthPct" || c.key === "dtePct") && <EarthIcon size={12} />}
                      {c.label}{c.unit && <small> {c.unit}</small>}{sort.key === c.key ? (sort.dir < 0 ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                ))}
                <th title="Slope of the LOLA 20 m ground over the 100 m landing circle: steepest 5 % (median in small type). Lower is safer for a lander.">Landing slope</th>
                <th title="Distance to the nearest permanently shadowed region (NASA Goddard PSR map): where water ice may be. Closer is better for science.">Nearest PSR</th>
                <th title="Each strip spans the period. Top: Sun visible (power). Middle: Earth in view. Bottom: DTE link.">Timeline</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(({ id, m }) => {
                const s = byId[id];
                return (
                  <tr key={id} className={`${open === id ? "selected" : ""} ${s.kind === "pin" ? "is-pin" : ""}`} onClick={() => setOpen(open === id ? null : id)}
                    tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(open === id ? null : id)}
                    aria-label={`${s.name}: open horizon view`}>
                    <th className="site-col" title={`${s.rule}\nSource: ${s.source}`}>
                      <span className="site-name">{s.name}</span>
                      <span className="site-meta num">{latLon(s)} · <i>{tag(s)}</i>
                        {onExplore && (!s.kind || (s.kind === "pin" && pin?.stage === "done")) && <> · <button className="link inline-link" aria-label={`Open ${s.name} in 3D`}
                          onClick={(e) => { e.stopPropagation(); onExplore(id, Date.parse(start + "T00:00:00Z"), days); }}>3D →</button></>}</span>
                    </th>
                    {COLS.map((c) => (
                      <td key={c.key} className={`num ${m[c.key] === best[c.key] ? "best" : ""} ${c.unit === "%" ? "barcell" : ""}`}
                        style={c.unit === "%" ? { "--v": `${Math.max(0, Math.min(100, m[c.key]))}%`, "--bc": c.key === "sunPct" ? "255,179,71" : c.key === "batteryMinPct" ? "91,228,155" : "90,209,255" } as React.CSSProperties : undefined}>
                        {c.fmt(m[c.key])}
                        {c.key === "batteryMinPct" && m.batteryEmptyH > 0 && <small className="short">short {fmtH(m.batteryEmptyH)}</small>}
                        {c.key === "sunPct" && clock?.by[id] && <Lasts c={clock.by[id].sun} stepH={clock.stepH} on="sets in" off="dark · rises in" />}
                        {c.key === "dtePct" && clock?.by[id] && <Lasts c={clock.by[id].dte} stepH={clock.stepH} on="ends in" off="none · starts in" />}
                      </td>
                    ))}
                    <td className="num">{s.terrain ? <>{s.terrain.slope.p95_deg.toFixed(1)}°<small className="short"> median {s.terrain.slope.median_deg.toFixed(1)}°</small></>
                      : <span className="dim" title="Polar sites only: 100 m landing slopes need the 20 m polar terrain">–</span>}</td>
                    <td className="num">{!s.terrain ? <span className="dim" title="Polar sites only (needs the 20 m polar terrain and the permanent-shadow map)">–</span>
                      : s.terrain.psr_km != null ? `${s.terrain.psr_km.toFixed(1)} km` : "> 40 km"}</td>
                    <td><Strip data={strips[id]} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Computed at each site's centre point, {ready ? client.manifest.z_m[z] : "?"} m above ground, every 10 minutes. DTE is geometric (no DSN scheduling or link budget).
        With all three 70 m antennas, at least one sees the Moon above 6° for 99.97 % of 2026–2028 (32 gaps of 10–20 min, from the DSN table), so the DTE link is limited mainly by Earth's visibility over the local terrain — that is why the two columns nearly match. Hover a site for its selection rule and source; click it for its 360° horizon view.</p>
    </section>
  );
}

/** S1 at landing: how long the current state (Sun up / link up) lasts from the landing time */
function Lasts({ c, stepH, on, off }: { c: { up: boolean; steps: number | null }; stepH: number; on: string; off: string }) {
  return <small className={`lasts ${c.up ? "up" : "down"}`}>{c.up ? on : off} {c.steps == null ? "> 90 d" : fmtDuration(c.steps * stepH)}</small>;
}

/** Atlas site (S4): who landed there, when, the source of the coordinates, and what the numbers say about it. */
function MissionCard({ s, m, start, days, onStory }: { s: SiteEntry; m?: Metrics; start: string; days: number; onStory?: (id: "apollo" | "farside") => void }) {
  const farSide = m && m.earthPct === 0, mine = s.kind === "pin";
  const story = s.id.startsWith("apollo-") ? ["apollo", "Why Apollo landed at dawn"] as const : farSide ? ["farside", "The side that never sees Earth"] as const : null;
  return (
    <div className={`mission-card glass ${mine ? "mine" : ""}`}>
      <div>
        <div className="eyebrow">{mine ? "Your pin · anywhere on the Moon" : <>{s.group} · {s.agency} · {s.country}</>}</div>
        <h3>{s.name}</h3>
        <p className="dim">{mine ? "Your own point" : s.status === "planned" ? "Planned" : `Landed ${s.landed_utc?.slice(0, 10)}`} · {latLon(s)} · ground {Math.round(s.ground_m)} m</p>
        <p>{mine ? "Its 109,440 terrain horizons were just computed in your browser with the same exact ray walk as every site in this table (validation V11), from NASA LOLA height maps"
          : s.note}.</p>
        {story && onStory && <button className="link inline-link mc-story" onClick={() => onStory(story[0])}>Read the story: {story[1]} →</button>}
      </div>
      {m && <div className="mc-facts">
        <div><span className="dim">Sunlight</span><b className="num">{m.sunPct.toFixed(0)} %</b></div>
        <div><span className="dim">Earth in view</span><b className="num">{m.earthPct.toFixed(0)} %</b></div>
        <div><span className="dim">Longest night</span><b className="num">{m.darkH >= 48 ? `${(m.darkH / 24).toFixed(1)} d` : `${m.darkH.toFixed(0)} h`}</b></div>
        <p className="dim">Landing on {start}, {days}-day stay.{farSide && <> <b className="mc-far">Earth never rises here: no direct link to Earth is possible from the far side.</b></>}</p>
      </div>}
      {mine ? <p className="mc-src">Terrain: {s.layers[0].split(":")[0]} to 30 km, LOLA LDEM_16 (1.9 km) to 300 km: coarser than the 20 m polar sites; slope and permanent shadow need the polar maps</p>
      : <p className="mc-src">Coordinates: {s.source.split(", http")[0]}{srcUrl(s) && <> · <a href={srcUrl(s)} target="_blank" rel="noreferrer">source</a></>}
        {" "}· terrain: NASA LOLA global maps (474 m and 1.9 km), coarser than the 20 m polar sites</p>}
    </div>
  );
}

function Strip({ data }: { data?: { sun: Float32Array; earth: Float32Array; dte: Float32Array } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const rows: [Float32Array, string][] = [[data.sun, "255,179,71"], [data.earth, "90,209,255"], [data.dte, "91,228,155"]];
    rows.forEach(([v, rgb], k) => {
      const y = k * 7;
      g.fillStyle = "rgba(30,42,64,0.9)";
      g.fillRect(0, y, w, 4);
      for (let x = 0; x < w; x++) {
        const val = v[Math.floor((x / w) * v.length)];
        if (val > 0) { g.fillStyle = `rgba(${rgb},${0.25 + 0.75 * val})`; g.fillRect(x, y, 1, 4); }
      }
    });
  }, [data]);
  return <canvas className="strip" ref={ref} />;
}

/** S5: drop a pin by coordinates ("12.5 S, 33 E", "-12.5, 33"), with the computation's progress. */
function PinForm({ pin, onPin, onShowGlobe }: { pin?: PinState | null; onPin: (lat: number, lon: number) => void; onShowGlobe?: () => void }) {
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const busy = pin && pin.stage !== "done" && pin.stage !== "error";
  return (
    <form className="pin-form" onSubmit={(e) => { e.preventDefault(); const p = parseLatLon(text); setBad(!p); if (p) onPin(p.lat, p.lon); }}>
      <label htmlFor="pin-in">Your own landing point</label>
      <input id="pin-in" value={text} onChange={(e) => { setText(e.target.value); setBad(false); }} placeholder="e.g. 26.13 N, 3.63 E" aria-invalid={bad} spellCheck={false} />
      <button className="cta" type="submit" disabled={!text.trim()}>Compute</button>
      <span className={`pf-status ${bad ? "bad" : ""}`} role="status">
        {bad ? "Latitude, longitude in degrees: 12.5 S, 33 E or −12.5, 33"
          : busy ? (pin!.stage === "horizon" ? <>Computing 109,440 horizons… <PinPct /></> : pin!.stage === "terrain" ? "Loading NASA LOLA terrain…" : "Sun and Earth…")
          : pin?.stage === "error" ? `Failed: ${pin.error}` : "or tap the Moon on the home screen"}
      </span>
      {pin?.stage === "done" && onShowGlobe && <button type="button" className="link inline-link" onClick={onShowGlobe}>Show it on the globe →</button>}
    </form>
  );
}

/** The answer before the table: which site wins each requirement over this period, and how many keep their light. */
function Insights({ rows, byId, days, onOpen }: { rows: { id: string; m: Metrics }[]; byId: Record<string, SiteEntry>; days: number; onOpen: (id: string) => void }) {
  const pick = (k: keyof Metrics, hi: boolean) => rows.reduce((a, b) => ((hi ? b.m[k] > a.m[k] : b.m[k] < a.m[k]) ? b : a));
  const cards: [string, React.ReactNode, { id: string; m: Metrics }, string][] = [
    ["Most sunlight", <SunIcon size={14} />, pick("sunPct", true), `${pick("sunPct", true).m.sunPct.toFixed(1)} % of the time`],
    ["Best link to Earth", <EarthIcon size={14} />, pick("dtePct", true), `${pick("dtePct", true).m.dtePct.toFixed(1)} % of the time`],
    ["Shortest blackout", <EarthIcon size={14} />, pick("blackoutH", false), `longest gap ${fmtH(pick("blackoutH", false).m.blackoutH)}`],
    ["Most energy", <SunIcon size={14} />, pick("energyWhM2Day", true), `${(pick("energyWhM2Day", true).m.energyWhM2Day / 1000).toFixed(1)} kWh/m² a day`],
  ];
  const lit = rows.filter((r) => r.m.darkH === 0).length, deaf = rows.filter((r) => r.m.earthPct === 0).length;
  return (
    <div className="insights">
      {cards.map(([t, icon, r, v]) => (
        <button key={t} className="insight" onClick={() => onOpen(r.id)} title="Open its horizon view">
          <span className="dim">{icon} {t}</span><b>{byId[r.id]?.name}</b><span className="num">{v}</span>
        </button>
      ))}
      <p className="insight-note dim">Over these {days} days: <b>{lit}</b> of {rows.length} sites never lose the Sun{deaf ? <>, <b>{deaf}</b> never see Earth (far side)</> : null}.
        Click a card for its horizon view.</p>
    </div>
  );
}
