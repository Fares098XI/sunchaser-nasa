import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sitesClient, useSitesRev } from "../data/sitesClient";
import { explain, phase, type Change, type ScenarioRun } from "../engine/scenario";
import type { SiteEntry } from "../engine/sites";
import { FAIL_BIT, REQ_KEYS, type Metrics, type PowerSystem, type Requirements } from "../engine/windows";
import { LimitsStrip } from "../ui/LimitsStrip";
import { EarthIcon, SunIcon } from "../ui/icons";
import { fmtDate, fmtTime } from "../ui/time";
import { REQ_COLOR, REQ_LABEL, ReqFields } from "./WindowsView";
import { Status } from "../ui/Status";

/**
 * S6 — Scenario board: up to four landings (site + date + stay) side by side, on one synchronized mission clock, with
 * what changed between them and why (the date or the site), and a printable one-page mission brief.
 */
export interface Scenario { site: string; iso: string; days: number }
export const LETTERS = ["A", "B", "C", "D"];
const TINT = ["#f3f1ec", "#b49cff", "#a8e66b", "#ff8fb1"];
const LUNAR_DAY_D = 29.53;

/** sc=site,iso,days;site,iso,days... */
export function readBoard(q: URLSearchParams, fallback: Scenario[]): Scenario[] {
  const v = (q.get("sc") ?? "").split(";").map((p) => p.split(",")).filter((p) => p.length === 3 && /^[a-z0-9-]+$/.test(p[0])
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p[1]) && Number(p[2]) >= 1 && Number(p[2]) <= 60);
  return v.length ? v.slice(0, 4).map(([site, iso, d]) => ({ site, iso, days: Math.round(Number(d)) })) : fallback;
}
export const writeBoard = (b: Scenario[]) => b.map((s) => `${s.site},${s.iso},${s.days}`).join(";");
const shiftIso = (iso: string, days: number) => new Date(Date.parse(iso + ":00Z") + days * 86400e3).toISOString().slice(0, 16);
const msOf = (iso: string) => Date.parse(iso + ":00Z");
const fmtH = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(0)} h`);

interface Props {
  board: Scenario[]; onBoard: (b: Scenario[]) => void;
  title: string; onTitle: (t: string) => void;
  req: Requirements; z: number; power: PowerSystem;
  onChange: (p: { req?: Requirements; z?: number; power?: PowerSystem }) => void;
  onExplore?: (site: string, landMs: number, days: number) => void;
  onAllLimits: () => void;
}

type Runs = { runs: (ScenarioRun | null)[]; changes: (Change | null)[] };

export function ScenarioBoard({ board, onBoard, title, onTitle, req, z, power, onChange, onExplore, onAllLimits }: Props) {
  const client = sitesClient(), rev = useSitesRev();
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Runs | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [align, setAlign] = useState<"mission" | "calendar">("mission");
  const [brief, setBrief] = useState(false);
  useEffect(() => { client.ready.then(() => setReady(true), (e) => setErr(String(e))); }, []);
  const sites: SiteEntry[] = ready ? client.manifest.sites : [];
  const byId = useMemo(() => Object.fromEntries(sites.map((s) => [s.id, s])), [ready, rev]);

  // every scenario over its stay, and for B..D against A the two crossed cases that split the change into date and site
  useEffect(() => {
    if (!ready) return;
    setBusy(true);
    let live = true;
    const run = (s: Scenario): Promise<ScenarioRun | null> => {
      if (!byId[s.site]) return Promise.resolve(null);
      const a = client.stepAt(s.iso + ":00Z");
      return client.call({ type: "scenario", site: s.site, a, b: a + Math.round((s.days * 86400) / client.manifest.step_s), z, power, req })
        .then((r) => r.run as ScenarioRun, () => null);
    };
    const t = setTimeout(async () => {
      const runs = await Promise.all(board.map(run));
      const A = board[0], RA = runs[0];
      const changes = await Promise.all(board.map(async (B, i) => {
        const RB = runs[i];
        if (i === 0 || !RA || !RB) return null;
        const sameSite = A.site === B.site, sameDate = A.iso === B.iso && A.days === B.days;
        let cross;
        if (!sameSite && !sameDate) {
          const [x, y] = await Promise.all([run({ ...A, site: B.site }), run({ ...B, site: A.site })]);
          if (x && y) cross = { bSiteAtADate: x.m, aSiteAtBDate: y.m };
        }
        const side = (k: number, s: Scenario, r: ScenarioRun) => ({ name: `${LETTERS[k]} · ${byId[s.site].name}`, lat: byId[s.site].lat_deg, run: r });
        return explain(side(0, A, RA), side(i, B, RB), sameSite, sameDate, power, cross);
      }));
      if (live) { setData({ runs, changes }); setBusy(false); }
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [ready, rev, writeBoard(board), z, JSON.stringify(power), JSON.stringify(req)]);

  const set = (i: number, p: Partial<Scenario>) => onBoard(board.map((s, k) => (k === i ? { ...s, ...p } : s)));
  const minIso = ready ? client.manifest.start_utc.slice(0, 16) : undefined;
  const maxIso = ready ? client.timeAt(client.manifest.n - 1).toISOString().slice(0, 16) : undefined;
  const A = board[0];
  const nameOf = (id: string) => byId[id]?.name ?? id, month = fmtDate(msOf(A.iso)).replace(/^\d+ /, "");
  const presets: [string, string, () => Scenario[], string][] = [
    ["Launch slips 2 weeks", "the same site, landing 14 days late", () => [A, { ...A, iso: shiftIso(A.iso, 14) }], `${nameOf(A.site)}: what a two-week slip does`],
    ["One lunar day later", "29.5 days: the light comes back", () => [A, { ...A, iso: shiftIso(A.iso, 14) }, { ...A, iso: shiftIso(A.iso, LUNAR_DAY_D) }],
      `${nameOf(A.site)}: slip by half and by one lunar day`],
    ["Ridge vs rim, same day", "two south-pole sites, same landing", () => [A, { ...A, site: A.site === "connecting-ridge" ? "nobile-rim-1" : "connecting-ridge" }],
      `Two south-pole sites, same landing, ${month}`],
    ["Pole vs Apollo 15", "polar ridge against an equatorial plain and the far side", () => [A, { ...A, site: "apollo-15" }, { ...A, site: "change-4" }],
      `South pole vs Apollo 15 vs the far side, ${month}`],
  ];

  if (err) return <section className="sheet glass board"><p className="error">Could not load site data: {err}</p></section>;
  return (
    <section className="sheet glass board" aria-label="Scenario board">
      <header className="board-head">
        <div>
          <div className="eyebrow">Scenario board</div>
          <input className="board-title" value={title} onChange={(e) => onTitle(e.target.value)} aria-label="Board title" maxLength={80} />
          <p className="dim">Up to four landings on one mission clock. Change a site, a date or the stay: every number, ribbon and
            explanation updates. B, C and D are explained against A{busy ? " · updating…" : ""}.</p>
          <LimitsStrip ids={["comms", "power", "sites", "atlas", "time"]} onAll={onAllLimits} />
        </div>
        <div className="board-actions">
          <button className="cta" onClick={() => setBrief(true)} disabled={!data}>Mission brief ⎙</button>
          <CopyLink />
        </div>
      </header>

      <div className="presets" role="group" aria-label="Story starters">
        <span className="dim">Story starters:</span>
        {presets.map(([l, tip, f, t]) => <button key={l} className="chip-btn" title={tip} disabled={!ready} onClick={() => { onBoard(f().slice(0, 4)); onTitle(t); }}>{l}</button>)}
      </div>

      <div className="cards" style={{ gridTemplateColumns: `repeat(${Math.min(4, board.length + (board.length < 4 ? 1 : 0))}, minmax(0, 1fr))` }}>
        {board.map((s, i) => (
          <ScenarioCard key={i} i={i} s={s} sites={sites} run={data?.runs[i] ?? null} base={i ? data?.runs[0] ?? null : null} req={req}
            minIso={minIso} maxIso={maxIso} onSet={(p) => set(i, p)} onRemove={board.length > 1 ? () => onBoard(board.filter((_, k) => k !== i)) : undefined}
            onExplore={onExplore && byId[s.site] && !byId[s.site].kind ? () => onExplore(s.site, msOf(s.iso), s.days) : undefined} />
        ))}
        {board.length < 4 && (
          <div className="sc-card add">
            <button className="sc-add" onClick={() => onBoard([...board, { ...board[board.length - 1], iso: shiftIso(board[board.length - 1].iso, 7) }])}>
              <b>+</b> Add scenario {LETTERS[board.length]}</button>
            <span className="dim">starts as a copy of {LETTERS[board.length - 1]}, one week later</span>
          </div>
        )}
      </div>

      {data && <>
        <div className="sync-head">
          <h3>Mission clock</h3>
          <div className="seg" role="radiogroup" aria-label="Align the timelines">
            {([["mission", "by mission day"], ["calendar", "by calendar date"]] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={align === k} className={align === k ? "on" : ""} onClick={() => setAlign(k)}>{l}</button>))}
          </div>
        </div>
        <SyncTimeline board={board} runs={data.runs} names={board.map((s) => byId[s.site]?.name ?? s.site)} align={align} />

        {board.length > 1 && <h3 className="wc-title">What changed, and why</h3>}
        <div className="changes">
          {data.changes.map((c, i) => c && <ChangeCard key={i} i={i} c={c} />)}
        </div>
      </>}
      {!data && <div className="loading-line">Running every scenario over its stay…</div>}

      <details className="power-box">
        <summary>Requirements and power system (shared by every scenario): {req.days} d check · sunlight ≥ {req.minSunPct} % · link ≥ {req.minDtePct} %
          · {power.panelM2} m² panel · {power.loadW} W · {power.batteryWh} Wh</summary>
        <ReqFields req={req} z={z} power={power} onChange={onChange} zs={ready ? client.manifest.z_m : null} />
      </details>
      <p className="hint">Each scenario is computed at its site's centre, {ready ? client.manifest.z_m[z] : "?"} m above ground, every 10 minutes of its own stay
        (the requirement fields set GO / NO-GO; the stay of each scenario is its own). "What changed" splits a change between the date and the site by
        computing the two crossed cases (B's site on A's date, A's site on B's date) and averaging the two orders.</p>

      {brief && data && <MissionBrief title={title} board={board} sites={byId} data={data} req={req} power={power}
        zM={client.manifest.z_m[z]} onClose={() => setBrief(false)} />}
    </section>
  );
}

function CopyLink() {
  const [ok, setOk] = useState(false);
  return <button className="cta ghost" onClick={() => navigator.clipboard?.writeText(location.href).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); }, () => undefined)}>
    {ok ? "Link copied" : "Copy link"}</button>;
}

const KPIS: { key: keyof Metrics; label: string; better: 1 | -1; fmt: (v: number) => string; icon?: "sun" | "earth" }[] = [
  { key: "sunPct", label: "Sunlight", better: 1, fmt: (v) => `${v.toFixed(0)} %`, icon: "sun" },
  { key: "darkH", label: "Longest night", better: -1, fmt: fmtH },
  { key: "dtePct", label: "Link to Earth", better: 1, fmt: (v) => `${v.toFixed(0)} %`, icon: "earth" },
  { key: "blackoutH", label: "Longest blackout", better: -1, fmt: fmtH },
  { key: "batteryMinPct", label: "Lowest battery", better: 1, fmt: (v) => `${v.toFixed(0)} %` },
];

function ScenarioCard({ i, s, sites, run, base, req, minIso, maxIso, onSet, onRemove, onExplore }: {
  i: number; s: Scenario; sites: SiteEntry[]; run: ScenarioRun | null; base: ScenarioRun | null; req: Requirements;
  minIso?: string; maxIso?: string; onSet: (p: Partial<Scenario>) => void; onRemove?: () => void; onExplore?: () => void;
}) {
  const groups: [string, SiteEntry[]][] = [["South pole", sites.filter((x) => !x.kind)], ["Whole Moon", sites.filter((x) => x.kind === "atlas")], ["Yours", sites.filter((x) => x.kind === "pin")]];
  const go = run && run.fails === 0;
  const failed = run ? REQ_KEYS.filter((k) => run.fails & FAIL_BIT[k]) : [];
  return (
    <article className={`sc-card ${run ? (go ? "go" : "nogo") : ""}`} style={{ "--tint": TINT[i] } as React.CSSProperties}>
      <header>
        <span className="sc-letter">{LETTERS[i]}</span>
        <select value={s.site} onChange={(e) => onSet({ site: e.target.value })} aria-label={`Scenario ${LETTERS[i]} site`}>
          {groups.map(([g, list]) => list.length ? <optgroup key={g} label={g}>{list.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup> : null)}
          {!sites.some((x) => x.id === s.site) && <option value={s.site}>{s.site === "pin" ? "Your pin (drop it first)" : s.site}</option>}
        </select>
        {onRemove && <button className="pc-x" onClick={onRemove} aria-label={`Remove scenario ${LETTERS[i]}`}>×</button>}
      </header>
      <div className="sc-when">
        <input type="datetime-local" value={s.iso} min={minIso} max={maxIso} onChange={(e) => e.target.value && onSet({ iso: e.target.value })} aria-label="Landing (UTC)" />
        <label className="sc-stay"><input type="number" min={1} max={60} value={s.days} onChange={(e) => onSet({ days: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })} /> d</label>
        <div className="sc-nudge" role="group" aria-label="Move the landing">
          {[[-7, "−1 wk"], [-1, "−1 d"], [1, "+1 d"], [7, "+1 wk"]].map(([d, l]) => <button key={l} onClick={() => onSet({ iso: shiftIso(s.iso, d as number) })}>{l}</button>)}
        </div>
      </div>
      {!run ? <div className="dim sc-wait">{sites.some((x) => x.id === s.site) ? "…" : "This site is not loaded (a pin must be dropped first)."}</div> : <>
        <div className={`sc-verdict ${go ? "go" : "nogo"}`}><Status kind={go ? "go" : "nogo"} />
          {!go && <span>{failed.map((k) => <i key={k} style={{ background: REQ_COLOR[k] }} title={REQ_LABEL[k]}>{REQ_LABEL[k]}</i>)}</span>}</div>
        <p className="sc-phase">{phase(run).replace(/^./, (c) => c.toUpperCase())}.</p>
        <dl className="sc-kpis">
          {KPIS.map((k) => {
            const v = run.m[k.key], d = base ? v - base.m[k.key] : 0, better = d * k.better > 0;
            return (
              <div key={k.key}>
                <dt>{k.icon === "sun" && <SunIcon size={11} />}{k.icon === "earth" && <EarthIcon size={11} />}{k.label}</dt>
                <dd className="num">{k.fmt(v)}{k.key === "batteryMinPct" && run.m.batteryEmptyH > 0 && <small className="bad"> short {fmtH(run.m.batteryEmptyH)}</small>}
                  {base && Math.abs(d) >= (k.key.endsWith("H") ? 1 : 0.5) && <small className={`delta ${better ? "up" : "down"}`}>{d > 0 ? "▲" : "▼"} {k.fmt(Math.abs(d)).replace(" %", "")}</small>}</dd>
              </div>
            );
          })}
        </dl>
        {onExplore && <button className="link inline-link" onClick={onExplore}>See it in 3D →</button>}
        <span className="sc-need dim">GO needs ≥ {req.minSunPct} % sun, ≥ {req.minDtePct} % link{req.maxBlackoutH != null ? `, blackout ≤ ${req.maxBlackoutH} h` : ""}{req.battery ? ", battery never empty" : ""} (first {req.days} d)</span>
      </>}
    </article>
  );
}

/**
 * Every scenario's Sun (amber), link to Earth (green) and battery (line) on one clock, aligned by mission day or by
 * date, with a shared cursor (drag, or play) and each scenario's state at the cursor.
 */
export function SyncTimeline({ board, runs, names, align, print }: {
  board: Scenario[]; runs: (ScenarioRun | null)[]; names: string[]; align: "mission" | "calendar"; print?: boolean;
}) {
  const W = 1000, L = print ? 150 : 0, ROW = print ? 44 : 60, top = 22, H = top + board.length * ROW + 8;
  const t0 = align === "mission" ? 0 : Math.min(...board.map((s) => msOf(s.iso)));
  const spanH = align === "mission" ? Math.max(...board.map((s) => s.days * 24))
    : (Math.max(...board.map((s) => msOf(s.iso) + s.days * 86400e3)) - t0) / 3600e3;
  const off = (i: number) => (align === "mission" ? 0 : (msOf(board[i].iso) - t0) / 3600e3); // hours from the clock start
  const x = (h: number) => L + (h / spanH) * (W - L);
  const [cur, setCur] = useState(0);
  const [play, setPlay] = useState(false);
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!play) return;
    let raf = 0, last = performance.now();
    const step = (now: number) => {
      setCur((c) => { const n = c + ((now - last) / 1000) * (spanH / 14); if (n >= spanH) { setPlay(false); return spanH; } return n; });
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [play, spanH]);
  useEffect(() => setCur(0), [align]);
  const pick = (e: React.PointerEvent) => {
    if (!(e.buttons & 1) || !ref.current) return;
    const b = ref.current.getBoundingClientRect(), px = ((e.clientX - b.left) / b.width) * W;
    setPlay(false);
    setCur(Math.max(0, Math.min(spanH, ((px - L) / (W - L)) * spanH)));
  };
  // ticks: every day in mission mode (labels every few), month days in calendar mode
  const ticks: [number, string][] = [];
  const every = spanH / 24 > 30 ? 7 : spanH / 24 > 12 ? 2 : 1;
  for (let d = 0; d * 24 <= spanH; d++) {
    const ms = t0 + d * 86400e3;
    if (d % every === 0) ticks.push([d * 24, align === "mission" ? `day ${d}` : fmtDate(ms).replace(/ \d{4}$/, "")]);
  }
  const band = (v: Float32Array, i: number, y: number, h: number, color: string) => {
    const out: React.ReactNode[] = [];
    let s = 0;
    for (let k = 1; k <= v.length; k++) {
      // merge equal hours into one rect (fewer nodes, crisp print)
      if (k < v.length && Math.abs(v[k] - v[s]) < 0.02) continue;
      if (v[s] > 0.02) out.push(<rect key={k} x={x(off(i) + s)} y={y} width={Math.max(0.6, x(off(i) + k) - x(off(i) + s))} height={h} fill={color} opacity={0.2 + 0.8 * v[s]} />);
      s = k;
    }
    return out;
  };
  const at = (i: number) => {
    const r = runs[i], k = Math.floor(cur - off(i));
    if (!r || k < 0 || k >= r.sun.length) return null;
    return { sun: r.sun[k], link: r.dte[k], soc: r.soc[k] };
  };
  const curLabel = align === "mission" ? `day ${Math.floor(cur / 24)} + ${String(Math.floor(cur % 24)).padStart(2, "0")} h`
    : `${fmtDate(t0 + cur * 3600e3)} ${fmtTime(t0 + cur * 3600e3)} UTC`;
  return (
    <figure className={`sync ${print ? "print" : ""}`}>
      {!print && <div className="sync-bar">
        <button className="play" onClick={() => { if (cur >= spanH) setCur(0); setPlay((p) => !p); }} aria-label={play ? "Pause" : "Play the missions"}>{play ? "❚❚" : "▶"}</button>
        <b className="num">{curLabel}</b>
        <div className="sync-read">{board.map((_, i) => {
          const v = at(i);
          return <span key={i} className="num"><i className="sc-dot" style={{ background: TINT[i] }} />{LETTERS[i]}{" "}
            {v ? <><SunIcon size={11} /> {Math.round(v.sun * 100)}% <EarthIcon size={11} /> {v.link > 0.5 ? "link" : "no link"} · battery {Math.round(v.soc)}%</> : <span className="dim">—</span>}</span>;
        })}</div>
      </div>}
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="fig-svg drag-x" role="img" aria-label="Synchronized mission timelines"
        onPointerDown={(e) => { if (print) return; ref.current?.setPointerCapture(e.pointerId); pick(e); }} onPointerMove={print ? undefined : pick}>
        {ticks.map(([h, l]) => <g key={h}><line x1={x(h)} x2={x(h)} y1={top - 6} y2={H - 6} className="st-grid" /><text x={x(h) + 2} y={top - 9} className="st-tick">{l}</text></g>)}
        {board.map((s, i) => {
          const r = runs[i], y = top + i * ROW;
          return (
            <g key={i}>
              {print && <text x={0} y={y + 16} className="st-name">{LETTERS[i]} · {names[i].slice(0, 22)}</text>}
              {!print && <text x={x(off(i)) + 3} y={y + 9} className="st-name" style={{ fill: TINT[i] }}>{LETTERS[i]}</text>}
              <rect x={x(off(i))} y={y + 12} width={x(off(i) + s.days * 24) - x(off(i))} height={ROW - 18} className="st-bg" />
              {r && <>
                {band(r.sun, i, y + 13, 11, "#f5c451")}
                {band(r.dte, i, y + 26, 6, "#6be6a6")}
                {/* battery lane: charge 0-100 % as a filled area, red where the load goes unmet */}
                <polygon className="st-soc-fill" points={`${x(off(i))},${y + ROW - 7} ${Array.from(r.soc, (v, k) => `${x(off(i) + k + 1).toFixed(1)},${(y + ROW - 7 - (v / 100) * (ROW - 42)).toFixed(1)}`).join(" ")} ${x(off(i) + r.soc.length)},${y + ROW - 7}`} />
                <polyline className="st-soc" points={Array.from(r.soc, (v, k) => `${x(off(i) + k + 1).toFixed(1)},${(y + ROW - 7 - (v / 100) * (ROW - 42)).toFixed(1)}`).join(" ")} />
                {band(Float32Array.from(r.soc, (v) => (v <= 0.01 ? 1 : 0)), i, y + ROW - 9, 3, "#f0533f")}
                {r.events.filter((e) => e.kind === "sunset" || e.kind === "empty").map((e, k) => (
                  <text key={k} x={x(off(i) + e.h)} y={y + 10} className={`st-ev ${e.kind}`} textAnchor="middle">{e.kind === "sunset" ? "☾" : "!"}</text>))}
              </>}
            </g>
          );
        })}
        {!print && <line x1={x(cur)} x2={x(cur)} y1={top - 4} y2={H} className="st-cursor" />}
      </svg>
      <figcaption className="dim"><span className="sw sun" /> Sun visible (brighter = more of the disc) · <span className="sw link" /> link to Earth ·
        <span className="sw bat" /> battery charge 0–100 % (<span className="sw empty" /> empty) · ☾ sunset · ! battery runs out</figcaption>
    </figure>
  );
}

function ChangeCard({ i, c }: { i: number; c: Change }) {
  const s = c.split?.sunPct, max = s ? Math.max(1, Math.abs(s.date), Math.abs(s.site)) : 1;
  const bar = (v: number, label: string) => (
    <div className="wc-bar"><span>{label}</span><i><b className={v < 0 ? "neg" : "pos"} style={{ width: `${(Math.abs(v) / max) * 50}%`, [v < 0 ? "right" : "left"]: "50%" }} /></i>
      <em className="num">{v > 0 ? "+" : v < 0 ? "−" : ""}{Math.abs(v).toFixed(0)}</em></div>
  );
  return (
    <article className="wc-card" style={{ "--tint": TINT[i] } as React.CSSProperties}>
      <header><span className="sc-letter">{LETTERS[i]}</span> vs <span className="sc-letter a">A</span>
        <b className={c.verdict.to ? "go" : "nogo"}>{c.verdict.from === c.verdict.to ? (c.verdict.to ? "still GO" : "still NO-GO") : c.verdict.to ? "becomes GO" : "becomes NO-GO"}</b></header>
      {s && Number.isFinite(s.date) && Math.abs(s.total) >= 1 && <div className="wc-split" aria-label="Sunlight change split between date and site">
        <span className="dim">Sunlight change, points</span>{bar(s.date, "date")}{bar(s.site, "site")}</div>}
      <ul>{c.lines.map((l, k) => <li key={k}>{l}</li>)}</ul>
    </article>
  );
}

/** A one-page brief for science and engineering teams: on screen as paper, printed (or saved as PDF) alone. */
function MissionBrief({ title, board, sites, data, req, power, zM, onClose }: {
  title: string; board: Scenario[]; sites: Record<string, SiteEntry>; data: Runs; req: Requirements; power: PowerSystem; zM: number; onClose: () => void;
}) {
  useEffect(() => { document.body.classList.add("printing-brief"); return () => document.body.classList.remove("printing-brief"); }, []);
  // printed on exactly one A4 page: the brief measures itself and the print stylesheet scales it down if it is taller
  const page = useRef<HTMLElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => { const h = page.current?.offsetHeight ?? 0; setFit(h ? Math.min(1, (297 * 96) / 25.4 / h) : 1); }, [data, board.length]);
  const ll = (s?: SiteEntry) => s ? `${Math.abs(s.lat_deg).toFixed(2)}° ${s.lat_deg < 0 ? "S" : "N"}, ${Math.abs(((s.lon_deg + 540) % 360) - 180).toFixed(2)}° ${((s.lon_deg + 540) % 360) - 180 < 0 ? "W" : "E"}` : "";
  const evName = { sunset: "sunset", sunrise: "sunrise", linkdown: "link lost", linkup: "link back", empty: "battery empty", recharged: "battery recovers" };
  // a portal on <body>: printing hides the whole app (#root) and lays out the brief alone, one A4 page
  return createPortal(
    <div className="brief-wrap" role="dialog" aria-label="Mission brief">
      <div className="brief-tools no-print">
        <button className="cta" onClick={() => window.print()}>Print / save as PDF</button>
        <button className="cta ghost" onClick={onClose}>Close</button>
      </div>
      <article className="brief" ref={page} style={{ "--fit": fit } as React.CSSProperties}>
        <header>
          <div><div className="b-kicker">SUNCHASER · MISSION BRIEF</div><h1>{title}</h1></div>
          <div className="b-meta">Generated {new Date().toISOString().slice(0, 16).replace("T", " ")} UTC<br />NASA Space Apps 2026 · Lunar Landing Site Navigator</div>
        </header>

        <h2>1 · Scenarios</h2>
        <table>
          <thead><tr><th></th><th>Site</th><th>Landing (UTC)</th><th>Stay</th><th>Verdict</th><th>Sunlight</th><th>Longest night</th><th>Link</th><th>Longest blackout</th><th>Lowest battery</th><th>Solar kWh/m²/d</th></tr></thead>
          <tbody>{board.map((s, i) => {
            const r = data.runs[i], e = sites[s.site];
            return <tr key={i}><td><b>{LETTERS[i]}</b></td><td>{e?.name ?? s.site} <small>{ll(e)}</small></td><td>{s.iso.replace("T", " ")}</td><td>{s.days} d</td>
              <td className={r?.fails === 0 ? "go" : "nogo"}>{r ? (r.fails === 0 ? "GO" : "NO-GO") : "–"}</td>
              {r ? <><td>{r.m.sunPct.toFixed(0)} %</td><td>{fmtH(r.m.darkH)}</td><td>{r.m.dtePct.toFixed(0)} %</td><td>{fmtH(r.m.blackoutH)}</td>
                <td>{r.m.batteryMinPct.toFixed(0)} %{r.m.batteryEmptyH > 0 ? ` (short ${fmtH(r.m.batteryEmptyH)})` : ""}</td><td>{(r.m.energyWhM2Day / 1000).toFixed(1)}</td></> : <td colSpan={6}>–</td>}</tr>;
          })}</tbody>
        </table>

        <h2>2 · Mission clock</h2>
        <SyncTimeline board={board} runs={data.runs} names={board.map((s) => sites[s.site]?.name ?? s.site)} align="mission" print />

        <div className="b-cols">
          <section>
            <h2>3 · What changed, and why</h2>
            {data.changes.map((c, i) => c && <div key={i} className="b-change"><b>{LETTERS[i]} vs A — {c.verdict.from === c.verdict.to ? (c.verdict.to ? "still GO" : "still NO-GO") : c.verdict.to ? "becomes GO" : "becomes NO-GO"}.</b> {c.lines.slice(0, 4).join(" ")}</div>)}
            {board.length < 2 && <p>Add a second scenario to compare.</p>}
          </section>
          <section>
            <h2>4 · Key events (UTC)</h2>
            {board.map((s, i) => {
              const r = data.runs[i];
              if (!r) return null;
              const t0 = msOf(s.iso), ev = r.events.filter((e) => e.kind !== "linkup" && e.kind !== "linkdown" || r.m.dtePct < 99).slice(0, 5);
              return <p key={i}><b>{LETTERS[i]}</b> {phase(r).replace(/^lands/, "lands")}. {ev.length ? ev.map((e) => `${evName[e.kind]} ${fmtDate(t0 + e.h * 3600e3).replace(/ \d{4}$/, "")} ${fmtTime(t0 + e.h * 3600e3)}`).join(" · ") : "No change of Sun, link or battery during the stay."}</p>;
            })}
          </section>
        </div>

        <div className="b-cols">
          <section>
            <h2>5 · Engineering assumptions</h2>
            <p>Power: {power.panelM2} m² Sun-tracking panel at {Math.round(power.efficiency * 100)} % efficiency, {power.loadW} W continuous load,
              {" "}{power.batteryWh} Wh battery starting full (carries {fmtH(power.batteryWh / power.loadW)} of darkness). Panel and antenna {zM} m above ground.
              GO requires, over the first {req.days} days: sunlight ≥ {req.minSunPct} %{req.maxDarkH != null ? `, darkness ≤ ${req.maxDarkH} h` : ""}, link to Earth ≥ {req.minDtePct} %
              {req.maxBlackoutH != null ? `, blackout ≤ ${req.maxBlackoutH} h` : ""}{req.battery ? ", battery never empty" : ""}. Link = Earth's centre above the local terrain and a
              DSN 70 m antenna (Goldstone, Canberra, Madrid) seeing the Moon above 6°; geometric, no scheduling or link budget.</p>
          </section>
          <section>
            <h2>6 · Science and method</h2>
            <p>Sun and Earth from NASA/JPL SPICE, checked against JPL Horizons (V1, V10b). Terrain horizons in 1,440 directions from NASA LOLA maps
              (20 m south-pole; 474 m / 1.9 km elsewhere; your pin in the browser, V11), out to 300 km; sunlight is the visible fraction of the solar disc.
              South-pole sites checked against Barker et al. 2021 (V2) and NASA Goddard visibility maps (V3). Limits: no boulders or craters smaller than the
              map cell; ideal panel; comms geometric; 10-minute steps.</p>
          </section>
        </div>
        <footer>Data: NASA LRO LOLA (PDS, PGDA), SLDEM2015 (LOLA + SELENE), NASA/JPL NAIF SPICE, NASA DSN station kernels; site coordinates from NASA NSSDCA,
          LROC and mission publications. Open validation record in the app (Validation). Live version: <span className="b-url">{location.origin}{location.pathname}?mode=scenarios&amp;sc={writeBoard(board)}</span></footer>
      </article>
    </div>, document.body);
}
