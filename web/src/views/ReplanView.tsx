import { memo, useEffect, useMemo, useRef, useState } from "react";
import { sitesClient, useSitesRev } from "../data/sitesClient";
import { NO_DATA, REGION_KM, distKm, nextPass, planB, reqLine } from "../engine/replan";
import type { SiteEntry } from "../engine/sites";
import { FAIL_BIT, REQ_KEYS, type PowerSystem, type ReqKey, type Requirements } from "../engine/windows";
import { LimitsStrip } from "../ui/LimitsStrip";
import { EarthIcon, SunIcon } from "../ui/icons";
import { fmtDate, fmtTime } from "../ui/time";
import { MULTI, OK, REQ_COLOR, REQ_LABEL, ReqFields } from "./WindowsView";
import { Status } from "../ui/Status";

/** Days evaluated around the planned landing (whole days at the planned time of day). */
const FROM = -30, TO = 150, D = TO - FROM + 1;
const LUNAR_MONTH_D = 29.53; // synodic month: the light pattern at a site roughly repeats after it

export interface Plan { site: string; iso: string; slip: number }
interface Row { id: string; fails: Uint8Array; m: Float32Array }
type M = { sun: number; dark: number; dte: number; blackout: number; batMin: number; batEmpty: number };

const unpack = (r: Row, k: number): M => {
  const o = k * 6, m = r.m;
  return { sun: m[o], dark: m[o + 1], dte: m[o + 2], blackout: m[o + 3], batMin: m[o + 4], batEmpty: m[o + 5] };
};
const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`);
const cellColor = (f: number) => {
  if (f === NO_DATA) return "transparent";
  if (f === 0) return OK;
  const keys = REQ_KEYS.filter((k) => f & FAIL_BIT[k]);
  return keys.length === 1 ? REQ_COLOR[keys[0]] : MULTI;
};

/** Why a landing fails (or how close it is): each requirement with its value and limit. */
function reasons(m: M, r: Requirements, fails: number): { key: ReqKey; text: string; bad: boolean }[] {
  const all: { key: ReqKey; text: string; on: boolean }[] = [
    { key: "sun", text: `Sunlight ${m.sun.toFixed(1)} % (needs ≥ ${r.minSunPct} %)`, on: true },
    { key: "dark", text: `Longest darkness ${fmtH(m.dark)} (max ${r.maxDarkH != null ? fmtH(r.maxDarkH) : "–"})`, on: r.maxDarkH != null },
    { key: "dte", text: `Link to Earth ${m.dte.toFixed(1)} % (needs ≥ ${r.minDtePct} %)`, on: true },
    { key: "blackout", text: `Longest blackout ${fmtH(m.blackout)} (max ${r.maxBlackoutH != null ? fmtH(r.maxBlackoutH) : "–"})`, on: r.maxBlackoutH != null },
    { key: "battery", text: m.batEmpty > 0 ? `Battery empty for ${fmtH(m.batEmpty)}` : `Battery low point ${m.batMin.toFixed(0)} %`, on: r.battery },
  ];
  return all.filter((x) => x.on).map((x) => ({ key: x.key, text: x.text, bad: !!(fails & FAIL_BIT[x.key]) }));
}

interface Props {
  req: Requirements; z: number; power: PowerSystem; plan: Plan;
  onPlan: (p: Plan) => void;
  onChange: (p: { req?: Requirements; z?: number; power?: PowerSystem }) => void;
  onExplore?: (site: string, landMs: number, days: number) => void;
  onAllLimits: () => void;
  /** S6: put the planned landing, the slipped one and Plan B side by side on the scenario board */
  onBoard?: (b: { site: string; iso: string; days: number }[]) => void;
}

/**
 * S3 — Replan: a launch slips; is the planned site still good on the new date, when is the next good date there, and
 * which other site works on the new date (nearest first)? Every site, every day from 30 days before to 150 after.
 */
export function ReplanView({ req, z, power, plan, onPlan, onChange, onExplore, onAllLimits, onBoard }: Props) {
  const client = sitesClient(), rev = useSitesRev();
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Record<string, Row> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { client.ready.then(() => setReady(true), (e) => setErr(String(e))); }, []);

  const plannedMs = Date.parse(plan.iso + ":00Z");
  useEffect(() => {
    if (!ready || Number.isNaN(plannedMs)) return;
    setBusy(true);
    const t = setTimeout(() => {
      client.call({ type: "slip", z, a0: client.stepAt(plan.iso + ":00Z"), from: FROM, to: TO, req, power })
        .then((r) => { setRows(Object.fromEntries(r.rows.map((x: Row) => [x.id, x]))); setBusy(false); }, (e) => { setErr(String(e)); setBusy(false); });
    }, 120);
    return () => clearTimeout(t);
  }, [ready, rev, plan.iso, z, JSON.stringify(req), JSON.stringify(power)]);

  const sites: SiteEntry[] = ready ? client.manifest.sites : [];
  const home = sites.find((s) => s.id === plan.site) ?? sites[0];
  const k = plan.slip - FROM;
  const dayMs = (i: number) => plannedMs + (FROM + i) * 86400e3;
  const setSlip = (slip: number) => onPlan({ ...plan, slip: Math.max(FROM, Math.min(TO, Math.round(slip))) });
  const ordered = useMemo(() => home ? [...sites].sort((a, b) => distKm(a, home) - distKm(b, home)) : [], [ready, rev, home?.id]);

  if (err) return <section className="sheet glass replan"><p className="error">Could not load site data: {err}</p></section>;
  const hr = rows && home ? rows[home.id] : null;
  const f = hr ? hr.fails[k] : NO_DATA, m = hr && f !== NO_DATA ? unpack(hr, k) : null;
  const next = hr ? nextPass(hr.fails, k) : null;
  const alts = rows && home ? planB(sites.map((s) => ({ ...s, fails: rows[s.id].fails })), home, k) : [];
  // every site fails that day on the link (DTE / blackout): Earth is low over the whole south pole, a monthly pattern
  const linkBits = FAIL_BIT.dte | FAIL_BIT.blackout;
  const linkWide = rows && !alts.length && sites.every((s) => { const x = rows[s.id].fails[k]; return x !== 0 && x !== NO_DATA && (x & linkBits); });
  // nothing passes that day anywhere: the nearest day (either side of the slip) when some site works
  const nearest = rows && !alts.length && f !== 0 ? (() => {
    for (let d = 1; d < D; d++) for (const i of [k + d, k - d]) {
      if (i < 0 || i >= D) continue;
      const s = ordered.find((x) => rows[x.id].fails[i] === 0 && distKm(x, home!) <= REGION_KM);
      if (s) return { i, s };
    }
    return null;
  })() : null;

  return (
    <section className="sheet glass replan" aria-label="Replan after a slip">
      <aside className="req">
        <div className="eyebrow">Replan</div>
        <h2>The launch slipped. Now what?</h2>
        <p className="dim lede">Pick the planned landing, then slide the delay: every site is re-checked for every day, instantly.</p>
        <label className="field-row">Planned site
          <select value={home?.id ?? ""} onChange={(e) => onPlan({ ...plan, site: e.target.value })}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field-row">Planned landing (UTC)
          <input type="datetime-local" value={plan.iso} min={ready ? client.manifest.start_utc.slice(0, 16) : undefined}
            onChange={(e) => e.target.value && onPlan({ ...plan, iso: e.target.value, slip: 0 })} />
        </label>
        <LimitsStrip ids={["comms", "power", "sites", "time"]} onAll={onAllLimits} />
        <ReqFields req={req} z={z} power={power} onChange={onChange} zs={ready ? client.manifest.z_m : null} />
      </aside>

      <div className="results">
        {!rows && <div className="loading-line">Checking every site for every day…</div>}
        {rows && home && hr && <>
          <div className="slip-bar">
            <div className="slip-read">
              <span className="dim">Slip</span>
              <b className="num">{plan.slip > 0 ? "+" : ""}{plan.slip} d</b>
              <span>→ lands <b>{fmtDate(dayMs(k), true)}</b> {fmtTime(dayMs(k))} UTC</span>
              {busy && <span className="dim">· updating…</span>}
              {onBoard && <button className="link inline-link board-link" onClick={() => {
                const slipped = new Date(dayMs(k)).toISOString().slice(0, 16);
                onBoard([{ site: home.id, iso: plan.iso, days: req.days }, ...(plan.slip ? [{ site: home.id, iso: slipped, days: req.days }] : []),
                  ...alts.slice(0, plan.slip ? 2 : 3).map((x) => ({ site: x.id, iso: slipped, days: req.days }))]);
              }}>Compare on the scenario board →</button>}
            </div>
            <input type="range" min={FROM} max={TO} value={plan.slip} onChange={(e) => setSlip(Number(e.target.value))} aria-label="Slip in days" />
            <div className="slip-quick" role="group" aria-label="Quick slips">
              {[[0, "On time"], [1, "+1 d"], [7, "+1 wk"], [14, "+2 wk"], [Math.round(LUNAR_MONTH_D), "+1 lunar month"], [60, "+2 months"]].map(([d, l]) => (
                <button key={l} className={plan.slip === d ? "on" : ""} onClick={() => setSlip(d as number)}>{l}</button>
              ))}
            </div>
          </div>

          <div className="answers">
            <div className={`answer ${f === 0 ? "go" : "nogo"}`}>
              <div className="answer-q">{plan.slip ? `Is ${home.name} still good on the new date?` : `Is ${home.name} good on the planned date?`}</div>
              <div className="answer-a"><Status kind={f === NO_DATA ? "none" : f === 0 ? "go" : "nogo"} size="lg" /></div>
              {m && <ul className="why">{reasons(m, req, f).map((r) => <li key={r.key} className={r.bad ? "bad" : "ok"}><i style={{ background: r.bad ? REQ_COLOR[r.key] : OK }} />{r.text}</li>)}</ul>}
            </div>
            <div className={`answer ${next === k ? "go" : next != null ? "warn" : "nogo"}`}>
              <div className="answer-q">Next good date at {home.name}</div>
              <div className="answer-a">{next == null ? "None in range" : next === k ? "This one" : `+${next - k} d later`}</div>
              {next != null && next !== k && <>
                <p>{fmtDate(dayMs(next), true)} · {fmtTime(dayMs(next))} UTC, slip {FROM + next > 0 ? "+" : ""}{FROM + next} d in total</p>
                <button className="cta ghost small" onClick={() => setSlip(FROM + next)}>Slip to that date</button>
              </>}
              {next == null && <p className="dim">Nothing meets every requirement here within {TO - plan.slip} days: relax a requirement, or change site.</p>}
              {next === k && <p className="dim">The new date meets every requirement at the planned site.</p>}
            </div>
            <div className={`answer ${alts.length ? "go" : "nogo"}`}>
              <div className="answer-q">Plan B: other sites within {REGION_KM} km, {plan.slip ? "on the new date" : "on that date"}</div>
              <div className="answer-a">{alts.length ? `${alts.length} site${alts.length > 1 ? "s" : ""}` : "None that day"}</div>
              {alts.map((a) => {
                const s = sites.find((x) => x.id === a.id)!, am = unpack(rows[a.id], k);
                return (
                  <div key={a.id} className="alt">
                    <div><b>{s.name}</b> <span className="dim num">{a.km.toFixed(0)} km away</span></div>
                    <div className="alt-num num"><SunIcon size={11} /> {am.sun.toFixed(0)} % <EarthIcon size={11} /> {am.dte.toFixed(0)} % · blackout {fmtH(am.blackout)}</div>
                    <div className="alt-go">
                      <button className="link inline-link" onClick={() => onPlan({ site: a.id, iso: new Date(dayMs(k)).toISOString().slice(0, 16), slip: 0 })}>Make it the plan</button>
                      {onExplore && <button className="link inline-link" onClick={() => onExplore(a.id, dayMs(k), req.days)}>See it in 3D →</button>}
                    </div>
                  </div>
                );
              })}
              {linkWide && <p className="insight">Every site fails on the link to Earth that day: Earth is low over the whole south pole
                for days at a time each month. Slipping about one lunar month ({LUNAR_MONTH_D} d) brings the good days back.</p>}
              {nearest && <p className="dim">Closest workable day: <b>{sites.find((x) => x.id === nearest.s.id)!.name}</b> on {fmtDate(dayMs(nearest.i))}{" "}
                ({nearest.i > k ? "+" : ""}{nearest.i - k} d). <button className="link inline-link" onClick={() => setSlip(FROM + nearest.i)}>Go there</button></p>}
            </div>
          </div>

          <SlipChart row={hr} req={req} k={k} onSlip={(i) => setSlip(FROM + i)} dayMs={dayMs} />
          <SiteGrid sites={ordered} home={home} rows={rows} k={k} onSlip={(i) => setSlip(FROM + i)} onSite={(id) => onPlan({ ...plan, site: id })} />
          <p className="hint">Same landing time of day, shifted by whole days; each day checked over the whole {req.days}-day stay ({reqLine(req)}).
            Light and link patterns roughly repeat every lunar month ({LUNAR_MONTH_D} d), so a slip of about one month often lands in similar conditions.</p>
        </>}
      </div>
    </section>
  );
}

/** The planned site day by day: sunlight and link (%) against their requirements, and the pass/fail strip. */
function SlipChart({ row, req, k, onSlip, dayMs }: { row: Row; req: Requirements; k: number; onSlip: (i: number) => void; dayMs: (i: number) => number }) {
  const W = 760, H = 170, top = 10, plotH = 100, stripY = top + plotH + 12;
  const x = (i: number) => (i + 0.5) * (W / D), y = (pct: number) => top + plotH - (pct / 100) * plotH;
  const ref = useRef<SVGSVGElement>(null);
  const pick = (e: React.PointerEvent) => {
    if (!(e.buttons & 1) || !ref.current) return;
    const b = ref.current.getBoundingClientRect();
    onSlip(Math.max(0, Math.min(D - 1, Math.floor(((e.clientX - b.left) / b.width) * D))));
  };
  const line = (o: number) => {
    let d = "";
    for (let i = 0; i < D; i++) { if (row.fails[i] === NO_DATA) continue; d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(row.m[i * 6 + o]).toFixed(1)}`; }
    return d;
  };
  const months: number[] = [];
  for (let i = 0; i < D; i++) if (new Date(dayMs(i)).getUTCDate() === 1) months.push(i);
  return (
    <figure className="slip-chart">
      <figcaption><span className="sun"><SunIcon size={12} /> sunlight %</span><span className="earth"><EarthIcon size={12} /> link to Earth %</span>
        <span className="dim">over the stay, for each landing day · drag to slip</span></figcaption>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="fig-svg drag-x" onPointerDown={(e) => { ref.current?.setPointerCapture(e.pointerId); pick(e); }} onPointerMove={pick}
        role="img" aria-label="Sunlight and link to Earth for each landing day around the plan">
        <rect x={0} y={top} width={W} height={plotH} className="sc-bg" />
        <line x1={0} x2={W} y1={y(req.minSunPct)} y2={y(req.minSunPct)} className="sc-req sun" />
        <line x1={0} x2={W} y1={y(req.minDtePct)} y2={y(req.minDtePct)} className="sc-req earth" />
        <path d={line(0)} className="sc-line sun" />
        <path d={line(2)} className="sc-line earth" />
        <g transform={`translate(0 ${stripY}) scale(${W / D} 14)`}><Cells fails={row.fails} /></g>
        {months.map((i) => <text key={i} x={x(i)} y={H - 6} className="sc-tick">{fmtDate(dayMs(i)).replace(/^1 /, "").replace(/ \d{4}$/, "")}</text>)}
        <line x1={x(-FROM)} x2={x(-FROM)} y1={top - 6} y2={stripY + 16} className="sc-plan" />
        <text x={x(-FROM) + 4} y={top + 2} className="sc-tick">planned</text>
        <line x1={x(k)} x2={x(k)} y1={top - 6} y2={stripY + 16} className="sc-cursor" />
      </svg>
    </figure>
  );
}

/** One row of day cells; memoised so dragging the slip only moves the cursor (2,000 cells on screen) */
const Cells = memo(function Cells({ fails }: { fails: Uint8Array }) {
  return <>{Array.from({ length: D }, (_, i) => <rect key={i} x={i} y={0} width={1.04} height={1} fill={cellColor(fails[i])} />)}</>;
});

/** Every site (nearest to the planned one first) × every landing day: green = meets everything. */
function SiteGrid({ sites, home, rows, k, onSlip, onSite }: {
  sites: SiteEntry[]; home: SiteEntry; rows: Record<string, Row>; k: number; onSlip: (i: number) => void; onSite: (id: string) => void;
}) {
  const pick = (e: React.MouseEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    onSlip(Math.max(0, Math.min(D - 1, Math.floor(((e.clientX - b.left) / b.width) * D))));
  };
  return (
    <figure className="site-grid">
      <figcaption>All sites, every landing day <span className="dim">· nearest to {home.name} first · click a day to slip there, a name to plan there</span></figcaption>
      {sites.map((s) => (
        <div key={s.id} className={`sg-row ${s.id === home.id ? "is-plan" : ""}`}>
          <button onClick={() => onSite(s.id)} title={`Plan the landing at ${s.name}`}>
            {s.name}<small className="num">{s.id === home.id ? "planned" : `${distKm(s, home).toFixed(0)} km`}</small>
          </button>
          <svg viewBox={`0 0 ${D} 1`} preserveAspectRatio="none" onClick={pick} role="img" aria-label={`${s.name}: pass or fail for each landing day`}>
            <Cells fails={rows[s.id].fails} />
            <rect x={k - 0.15} y={0} width={1.3} height={1} className="sg-cursor" />
            <rect x={-FROM} y={0} width={0.25} height={1} className="sg-plan" />
          </svg>
        </div>
      ))}
      <div className="sg-legend">{REQ_KEYS.map((key) => <span key={key}><i style={{ background: REQ_COLOR[key] }} />fails {REQ_LABEL[key].toLowerCase()}</span>)}
        <span><i style={{ background: MULTI }} />fails several</span><span><i style={{ background: OK }} />meets all</span></div>
    </figure>
  );
}
