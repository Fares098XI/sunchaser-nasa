import { useEffect, useMemo, useRef, useState } from "react";
import { LimitsStrip } from "../ui/LimitsStrip";
import { sitesClient, useSitesRev } from "../data/sitesClient";
import type { SiteEntry } from "../engine/sites";
import {
  FAIL_BIT, PASS_DAY, REQ_KEYS, candidateMetrics, margins, minRelMargin, type Metrics, type PowerSystem, type Relaxation, type ReqKey, type Requirements,
} from "../engine/windows";
import { PowerFields } from "../ui/PowerFields";
import { CheckIcon } from "../ui/icons";
import { Status } from "../ui/Status";

interface SiteResult { id: string; starts: Int32Array; m: Float32Array; fails: Uint8Array; pass: number; cal: Uint8Array }
interface Pick { site: string; c: number }

export const REQ_LABEL: Record<ReqKey, string> = { sun: "Sunlight", dark: "Darkness", dte: "DTE link", blackout: "Blackout", battery: "Battery" };
// Syzygy: Sun antique gold, darkness prominence red, link deep ocean, blackout violet, battery flare orange
export const REQ_COLOR: Record<ReqKey, string> = { sun: "#c8892b", dark: "#f0533f", dte: "#1f6fd1", blackout: "#8a6cff", battery: "#ff7a3d" };
export const OK = "#6be6a6";
export const MULTI = "#3a3f4a";
const EVERY = 6; // candidate landing every hour (6 x 10 min)

const unpack = (r: SiteResult, c: number): Metrics => candidateMetrics(r as never, c);

function failNames(bits: number) {
  return REQ_KEYS.filter((k) => bits & FAIL_BIT[k]).map((k) => REQ_LABEL[k]);
}

function dayColor(v: number) {
  if (v === PASS_DAY) return OK;
  if (v === 0) return "transparent";
  const keys = REQ_KEYS.filter((k) => v & FAIL_BIT[k]);
  return keys.length === 1 ? REQ_COLOR[keys[0]] : MULTI;
}


const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`);
const isoMin = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " UTC";

interface Props {
  req: Requirements; z: number; power: PowerSystem;
  onChange: (p: { req?: Requirements; z?: number; power?: PowerSystem }) => void;
  /** open the picked landing in Explore: site id, landing time (ms UTC), stay in days */
  onExplore?: (site: string, landMs: number, days: number) => void;
  onAllLimits: () => void;
}

export function WindowsView({ req, z, power, onChange, onExplore, onAllLimits }: Props) {
  const client = sitesClient(), rev = useSitesRev();
  const [ready, setReady] = useState(false);
  const [res, setRes] = useState<{ sites: SiteResult[]; relax: Relaxation[]; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [robust, setRobust] = useState<{ pass: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { client.ready.then(() => setReady(true), (e) => setErr(String(e))); }, []);

  useEffect(() => {
    if (!ready) return;
    setBusy(true);
    const t = setTimeout(() => {
      client.call({ type: "search", req, z, every: EVERY, power }).then((r) => { setRes(r); setBusy(false); setPick(null); setRobust(null); },
        (e) => { setErr(String(e)); setBusy(false); });
    }, 150); // debounce slider drags
    return () => clearTimeout(t);
  }, [ready, rev, JSON.stringify(req), z, JSON.stringify(power)]);

  const sites: SiteEntry[] = ready ? client.manifest.sites : [];
  const byId = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s])), [ready, rev]);
  // landings before now are history, not options (the tables start before today)
  const nowStep = ready ? client.stepAt(new Date().toISOString()) : 0;
  const open = (s: SiteResult, c: number) => s.fails[c] === 0 && s.starts[c] >= nowStep;
  const passes = (s: SiteResult) => { let n = 0; for (let c = 0; c < s.fails.length; c++) if (open(s, c)) n++; return n; };
  const totalPass = res ? res.sites.reduce((n, s) => n + passes(s), 0) : 0;
  const goSites = res ? res.sites.filter((s) => passes(s) > 0).length : 0;

  const top = useMemo(() => {
    if (!res) return [];
    const all: { site: string; c: number; score: number }[] = [];
    for (const s of res.sites) {
      for (let c = 0; c < s.fails.length; c++) if (open(s, c)) all.push({ site: s.id, c, score: minRelMargin(unpack(s, c), req) });
    }
    all.sort((a, b) => b.score - a.score);
    // the best landing at each site first (ranked), then the next-best days overall
    const out: typeof all = [], seenSite = new Set<string>(), seenDay = new Set<string>();
    const dayKey = (w: (typeof all)[number]) => `${w.site}|${Math.floor(res.sites.find((x) => x.id === w.site)!.starts[w.c] / 144)}`;
    for (const w of all) if (!seenSite.has(w.site)) { seenSite.add(w.site); seenDay.add(dayKey(w)); out.push(w); }
    for (const w of all) {
      if (out.length >= 14) break;
      if (!seenDay.has(dayKey(w))) { seenDay.add(dayKey(w)); out.push(w); }
    }
    return out;
  }, [res]);

  useEffect(() => { if (!pick && top[0]) setPick({ site: top[0].site, c: top[0].c }); }, [top]);
  const stayLen = ready ? Math.round((req.days * 86400) / client.manifest.step_s) : 0;
  const picked = pick && res ? (() => {
    const s = res.sites.find((x) => x.id === pick.site)!;
    const m = unpack(s, pick.c);
    return { s, m, start: s.starts[pick.c], g: margins(m, req), fails: s.fails[pick.c] };
  })() : null;

  const runRobust = () => {
    if (!picked) return;
    setRobust(null);
    client.call({ type: "robust", site: picked.s.id, z, a: picked.start, b: picked.start + stayLen, req, power }).then((r) => {
      setRobust({ pass: r.pts.filter((p: any) => p.fails === 0).length, total: r.pts.length });
    });
  };

  const exportIcs = () => {
    if (!res) return;
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sunchaser//Window Finder//EN"];
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    for (const w of top) {
      const s = res.sites.find((x) => x.id === w.site)!, m = unpack(s, w.c);
      const a = client.timeAt(s.starts[w.c]), b = client.timeAt(s.starts[w.c] + stayLen);
      const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
      lines.push("BEGIN:VEVENT", `UID:${w.site}-${s.starts[w.c]}@sunchaser`, `DTSTAMP:${stamp}`, `DTSTART:${f(a)}`, `DTEND:${f(b)}`,
        `SUMMARY:Landing window - ${byId[w.site].name}`,
        `DESCRIPTION:Sunlight ${m.sunPct.toFixed(1)}%\\, longest darkness ${fmtH(m.darkH)}\\, DTE ${m.dtePct.toFixed(1)}%\\, longest blackout ${fmtH(m.blackoutH)} (Sunchaser\\, geometric)`,
        "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    download("sunchaser_windows.ics", lines.join("\r\n"), "text/calendar");
  };

  const exportCsv = () => {
    if (!res) return;
    const rows = ["site,landing_utc,stay_days,sun_pct,longest_dark_h,earth_pct,dte_pct,longest_blackout_h,energy_wh_m2_day,battery_min_pct,battery_empty_h,fails"];
    for (const s of res.sites) {
      for (let c = 0; c < s.fails.length; c++) {
        const m = unpack(s, c);
        rows.push([s.id, client.timeAt(s.starts[c]).toISOString(), req.days, m.sunPct.toFixed(2), m.darkH.toFixed(2), m.earthPct.toFixed(2),
          m.dtePct.toFixed(2), m.blackoutH.toFixed(2), m.energyWhM2Day.toFixed(0), Number.isNaN(m.batteryMinPct) ? "" : m.batteryMinPct.toFixed(1),
          Number.isNaN(m.batteryEmptyH) ? "" : m.batteryEmptyH.toFixed(2), failNames(s.fails[c]).join("|")].join(","));
      }
    }
    download("sunchaser_windows.csv", rows.join("\n"), "text/csv");
  };

  const set = (p: Partial<Requirements>) => onChange({ req: { ...req, ...p } });

  return (
    <section className="sheet glass windows" aria-label="Window Finder">
      <aside className="req">
        <div className="eyebrow">Window Finder</div>
        <h2>What does the mission need?</h2>
        <LimitsStrip ids={["comms", "power", "sites", "time"]} onAll={onAllLimits} />
        <ReqFields req={req} z={z} power={power} onChange={onChange} zs={ready ? client.manifest.z_m : null} />
        <p className="hint">Every landing hour from today to Dec 2028 at {sites.length} sites, checked against the whole stay.</p>
      </aside>

      <div className="results">
        {err && <p className="error">{err}</p>}
        {!res && !err && <div className="loading-line">Searching every landing hour…</div>}
        {res && (
          <>
            <div className={`verdict ${totalPass ? "go" : "nogo"}`} aria-live="polite">
              <Status kind={totalPass ? "go" : "nogo"} size="lg" />
              <div>
                <strong>{totalPass ? `${goSites} of ${sites.length} sites can host this mission` : "No site meets every requirement"}</strong>
                <span className="dim"> · {totalPass.toLocaleString()} landing hours pass · searched {res.sites.reduce((n, s) => n + s.fails.length, 0).toLocaleString()} in {Math.round(res.ms)} ms{busy ? " · updating…" : ""}</span>
                <Relaxations relax={res.relax} go={totalPass > 0} />
              </div>
            </div>

            <Heatmap sites={sites} res={res.sites} onPick={(site, day) => {
              const s = res.sites.find((x) => x.id === site)!;
              let best = -1, bestScore = -Infinity, fewest = 99;
              for (let c = 0; c < s.starts.length; c++) {
                if (Math.floor(s.starts[c] / 144) !== day) continue;
                const f = s.fails[c], k = failNames(f).length;
                const score = f === 0 ? minRelMargin(unpack(s, c), req) : -k;
                if (k < fewest || (k === fewest && score > bestScore)) { fewest = k; bestScore = score; best = c; }
              }
              if (best >= 0) { setPick({ site, c: best }); setRobust(null); }
            }} timeAt={(d) => client.timeAt(d * 144)} />

            <div className="lower">
              {picked ? (
                <div className="detail">
                  <div className="eyebrow">{byId[picked.s.id].name}</div>
                  <h3>Land {isoMin(client.timeAt(picked.start))}</h3>
                  {onExplore && <button className="cta small explore-go" onClick={() => onExplore(picked.s.id, client.timeAt(picked.start).getTime(), req.days)}>
                    View this landing in 3D →</button>}
                  <table className="margins">
                    <tbody>
                      <MarginRow label="Sunlight" value={`${picked.m.sunPct.toFixed(1)}%`} need={`≥ ${req.minSunPct}%`} margin={picked.g.sun} unit="pt" />
                      <MarginRow label="Longest darkness" value={fmtH(picked.m.darkH)} need={req.maxDarkH == null ? "—" : `≤ ${fmtH(req.maxDarkH)}`} margin={picked.g.dark} unit="h" />
                      <MarginRow label="DTE link" value={`${picked.m.dtePct.toFixed(1)}%`} need={`≥ ${req.minDtePct}%`} margin={picked.g.dte} unit="pt" />
                      <MarginRow label="Longest blackout" value={fmtH(picked.m.blackoutH)} need={req.maxBlackoutH == null ? "—" : `≤ ${fmtH(req.maxBlackoutH)}`} margin={picked.g.blackout} unit="h" />
                      {req.battery && <MarginRow label="Battery" value={picked.m.batteryEmptyH > 0 ? `empty ${fmtH(picked.m.batteryEmptyH)}` : `low ${picked.m.batteryMinPct.toFixed(0)}%`}
                        need="never empty" margin={picked.g.battery} unit={picked.m.batteryEmptyH > 0 ? "h" : "% left"} />}
                    </tbody>
                  </table>
                  <p className="dim small">Earth in view {picked.m.earthPct.toFixed(1)}% · solar energy {(picked.m.energyWhM2Day / 1000).toFixed(1)} kWh/m²/day (Sun-tracking panel, before efficiency)</p>
                  <button className="btn" onClick={runRobust}>Check 250 m landing error (19 points)</button>
                  {robust && <p className={robust.pass === robust.total ? "ok" : "warn"}>
                    Passes at {robust.pass} of {robust.total} landing points within 250 m.</p>}
                </div>
              ) : <div className="detail empty dim">Click a day in the calendar to see the best landing that day, its margins and its robustness to landing error.</div>}

              <div className="toplist">
                <div className="toplist-head">
                  <div className="eyebrow">Best window per site</div>
                  <div className="exports">
                    <button className="btn ghost" onClick={exportIcs} disabled={!top.length}>.ics</button>
                    <button className="btn ghost" onClick={exportCsv}>CSV</button>
                  </div>
                </div>
                {top.length ? (
                  <ol>
                    {top.map((w) => {
                      const s = res.sites.find((x) => x.id === w.site)!, m = unpack(s, w.c);
                      return (
                        <li key={`${w.site}${w.c}`}>
                          <button onClick={() => { setPick({ site: w.site, c: w.c }); setRobust(null); }}>
                            <span className="tl-site">{byId[w.site].name}<small className="num">{isoMin(client.timeAt(s.starts[w.c]))}</small></span>
                            <span className="num tl-m">{m.sunPct.toFixed(0)}% sun<small>{m.dtePct.toFixed(0)}% DTE</small></span>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                ) : <p className="dim small">No passing windows yet — see the smallest change above.</p>}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** The mission requirements (shared by the Window Finder and Replan). */
export function ReqFields({ req, z, power, onChange, zs }: {
  req: Requirements; z: number; power: PowerSystem; zs: number[] | null;
  onChange: (p: { req?: Requirements; z?: number; power?: PowerSystem }) => void;
}) {
  const set = (p: Partial<Requirements>) => onChange({ req: { ...req, ...p } });
  return (
    <>
        <Field label="Surface stay" value={`${req.days} d`}>
          <input type="range" aria-label="Surface stay, days" min={1} max={60} value={req.days} onChange={(e) => set({ days: Number(e.target.value) })} />
        </Field>
        <Field label="Min. sunlight on panels" value={`${req.minSunPct}%`} tip="Average visible fraction of the solar disc over the stay.">
          <input type="range" aria-label="Minimum sunlight, percent" min={0} max={100} value={req.minSunPct} onChange={(e) => set({ minSunPct: Number(e.target.value) })} />
        </Field>
        <Field label="Longest darkness" value={req.maxDarkH == null ? "no limit" : fmtH(req.maxDarkH)} tip="Battery: longest stretch with no Sun.">
          <label className="inline"><input type="checkbox" aria-label="Limit the longest darkness" checked={req.maxDarkH != null}
            onChange={(e) => set({ maxDarkH: e.target.checked ? 48 : null })} /> limit</label>
          {req.maxDarkH != null && <input type="range" aria-label="Longest darkness, hours" min={1} max={240} value={req.maxDarkH} onChange={(e) => set({ maxDarkH: Number(e.target.value) })} />}
        </Field>
        <Field label="Min. time with DTE link" value={`${req.minDtePct}%`} tip="Earth above the terrain and a DSN 70 m antenna seeing the Moon >= 6 deg.">
          <input type="range" aria-label="Minimum time with a link to Earth, percent" min={0} max={100} value={req.minDtePct} onChange={(e) => set({ minDtePct: Number(e.target.value) })} />
        </Field>
        <Field label="Longest blackout" value={req.maxBlackoutH == null ? "no limit" : fmtH(req.maxBlackoutH)} tip="Longest stretch without a DTE link.">
          <label className="inline"><input type="checkbox" aria-label="Limit the longest blackout" checked={req.maxBlackoutH != null}
            onChange={(e) => set({ maxBlackoutH: e.target.checked ? 24 : null })} /> limit</label>
          {req.maxBlackoutH != null && <input type="range" aria-label="Longest blackout, hours" min={1} max={240} value={req.maxBlackoutH} onChange={(e) => set({ maxBlackoutH: Number(e.target.value) })} />}
        </Field>
        <Field label="Battery never runs out" value={req.battery ? "required" : "off"}
          tip="Simulates the battery over the stay with the power system below (starts full).">
          <label className="inline"><input type="checkbox" aria-label="Require that the battery never runs out" checked={req.battery} onChange={(e) => set({ battery: e.target.checked })} /> require</label>
          {req.battery && <PowerFields power={power} onChange={(pw) => onChange({ power: pw })} />}
        </Field>
        <Field label="Panel / antenna height" value={`${zs ? zs[z] : "?"} m`}>
          <select value={z} onChange={(e) => onChange({ z: Number(e.target.value) })}>
            {(zs ?? [1, 2, 5, 10]).map((h, i) => <option key={h} value={i}>{h} m</option>)}
          </select>
        </Field>
    </>
  );
}

function Field({ label, value, tip, children }: { label: string; value: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="field" title={tip}>
      <div className="field-head"><span>{label}</span><span className="num">{value}</span></div>
      {children}
    </div>
  );
}

function MarginRow({ label, value, need, margin, unit }: { label: string; value: string; need: string; margin: number; unit: string }) {
  const ok = margin >= 0;
  return (
    <tr className={ok ? "ok" : "bad"}>
      <th>{ok ? <CheckIcon /> : "✕"} {label}</th>
      <td className="num">{value}</td>
      <td className="num dim">{need}</td>
      <td className="num">{Number.isFinite(margin) ? `${margin >= 0 ? "+" : ""}${margin.toFixed(1)} ${unit}` : ""}</td>
    </tr>
  );
}

function Relaxations({ relax, go }: { relax: Relaxation[]; go: boolean }) {
  if (go || !relax.length) return null;
  const fmt = (r: Relaxation) => r.key === "sun" || r.key === "dte"
    ? `${REQ_LABEL[r.key]} ${r.from}% → ${Math.floor(r.to * 10) / 10}%`
    : `${REQ_LABEL[r.key]} ${fmtH(r.from)} → ${fmtH(Math.ceil(r.to * 10) / 10)}`;
  return <p className="relax">Smallest single change that opens a window: {relax.map(fmt).join(" · or ")}</p>;
}

function Heatmap({ sites, res, onPick, timeAt }: { sites: SiteEntry[]; res: SiteResult[]; onPick: (site: string, day: number) => void; timeAt: (day: number) => Date }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const days = res[0]?.cal.length ?? 0;
  const LABEL_W = 150, ROW_H = 18, TOP = 18;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(devicePixelRatio, 2), w = c.clientWidth, h = TOP + res.length * ROW_H;
    c.width = w * dpr; c.height = h * dpr; c.style.height = `${h}px`;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const cw = (w - LABEL_W) / days;
    g.font = "12px Inter, sans-serif";
    g.textBaseline = "middle";
    // month ticks; labels only where they fit
    g.fillStyle = "#8e8a82";
    let lastLabel = -Infinity;
    for (let d = 0; d < days; d++) {
      const t = timeAt(d);
      if (t.getUTCDate() === 1) {
        const x = LABEL_W + d * cw;
        g.globalAlpha = t.getUTCMonth() === 0 ? 0.9 : 0.35;
        g.fillRect(x, TOP - 4, 1, res.length * ROW_H + 4);
        g.globalAlpha = 1;
        const label = t.getUTCMonth() === 0 ? String(t.getUTCFullYear()) : t.toISOString().slice(5, 7);
        if (x - lastLabel > (label.length > 2 ? 40 : 24)) { g.fillText(label, x + 3, 8); lastLabel = x; }
      }
    }
    res.forEach((r, k) => {
      const y = TOP + k * ROW_H;
      g.fillStyle = "#e6e3dc";
      g.fillText(sites.find((s) => s.id === r.id)!.name, 0, y + ROW_H / 2);
      for (let d = 0; d < days; d++) {
        const col = dayColor(r.cal[d]);
        if (col === "transparent") continue;
        g.fillStyle = col;
        g.fillRect(LABEL_W + d * cw, y + 3, Math.max(cw - 0.3, 0.8), ROW_H - 6);
      }
    });
  }, [res]);

  const locate = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const k = Math.floor((y - TOP) / ROW_H), d = Math.floor(((x - LABEL_W) / (rect.width - LABEL_W)) * days);
    if (k < 0 || k >= res.length || d < 0 || d >= days) return null;
    return { k, d, x, y };
  };

  return (
    <div className="heatmap">
      <canvas ref={ref}
        onMouseMove={(e) => {
          const p = locate(e);
          if (!p) return setHover(null);
          const v = res[p.k].cal[p.d];
          const status = v === 16 ? "a landing this day meets every requirement" : v === 0 ? "stay runs past the data" : `closest landing fails: ${failNames(v).join(", ")}`;
          setHover({ x: p.x, y: p.y, text: `${sites.find((s) => s.id === res[p.k].id)!.name} · ${timeAt(p.d).toISOString().slice(0, 10)} — ${status}` });
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { const p = locate(e); if (p) onPick(res[p.k].id, p.d); }} />
      {hover && <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 10 }}>{hover.text}</div>}
      <div className="legend-row">
        <span><i style={{ background: OK }} /> meets everything</span>
        {REQ_KEYS.map((k) => <span key={k}><i style={{ background: REQ_COLOR[k] }} /> {REQ_LABEL[k]} fails</span>)}
        <span><i style={{ background: MULTI }} /> several fail</span>
      </div>
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
