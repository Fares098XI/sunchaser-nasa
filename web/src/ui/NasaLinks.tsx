import { useState } from "react";
import { R_MOON_M } from "../engine/frames";

// The challenge's NASA resources, opened at the selected point. Link formats were tested by hand.
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** QuickMap (LROC, now at im-ldi.com): a lat/lon box. Its link format cannot open the poles (|lat| > ~85.5): null there. */
export function quickmapUrl(lat: number, lon: number): string | null {
  if (Math.abs(lat) > 85) return null;
  const dLat = 0.3, dLon = Math.min(10, dLat / Math.cos((lat * Math.PI) / 180)), l = wrap(lon);
  const e = [l - dLon, lat - dLat, l + dLon, lat + dLat].map((v) => v.toFixed(4)).join(",");
  return `https://quickmap.lroc.im-ldi.com/?extent=${e}&proj=10`;
}

/** Moon Trek: south of 80° S its polar stereographic map (x, y in metres from the pole), else the global map in lat/lon. */
export function moonTrekUrl(lat: number, lon: number): string {
  if (lat < -80) {
    const rho = 2 * R_MOON_M * Math.tan(((90 + lat) * Math.PI) / 360), a = (lon * Math.PI) / 180;
    const x = rho * Math.sin(a), y = rho * Math.cos(a);
    return `https://trek.nasa.gov/moon/#v=0.1&x=${x.toFixed(0)}&y=${y.toFixed(0)}&z=9&p=urn%3Aogc%3Adef%3Acrs%3AIAU2000%3A%3A30120&d=`;
  }
  return `https://trek.nasa.gov/moon/#v=0.1&x=${wrap(lon).toFixed(4)}&y=${lat.toFixed(4)}&z=9&p=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A104903&d=`;
}

/** JPL Horizons API, the same query as pipeline/sunchaser/horizons.py (check V1): az/el seen from this point, hourly, one day.
 *  Horizons' elevation is above the flat horizon: Sunchaser's terrain horizon is the extra step. */
export function horizonsUrl(target: "10" | "399", lat: number, lon: number, h_m: number, dayStartMs: number): string {
  const t = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const q = (s: string) => `'${s}'`;
  const p = new URLSearchParams({
    format: "text", COMMAND: q(target), CENTER: q("coord@301"), COORD_TYPE: q("GEODETIC"),
    SITE_COORD: q(`${wrap(lon).toFixed(6)},${lat.toFixed(6)},${(h_m / 1000).toFixed(4)}`), MAKE_EPHEM: q("YES"),
    EPHEM_TYPE: q("OBSERVER"), START_TIME: q(t(dayStartMs)), STOP_TIME: q(t(dayStartMs + 86_400_000)), STEP_SIZE: q("1 h"),
    QUANTITIES: q("4"), ANG_FORMAT: q("DEG"), EXTRA_PREC: q("YES"),
  });
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${p}`;
}

export function NasaLinks({ lat, lon, h_m, tMs }: { lat: number; lon: number; h_m: number; tMs: number }) {
  const [copied, setCopied] = useState(false);
  const qm = quickmapUrl(lat, lon), day = Math.floor(tMs / 86_400_000) * 86_400_000;
  const ext = { target: "_blank", rel: "noopener noreferrer", className: "link inline-link" } as const;
  const copy = () => {
    navigator.clipboard?.writeText(`${lat.toFixed(4)},${wrap(lon).toFixed(4)}`).then(() => setCopied(true), () => {});
  };
  return (
    <p className="source nasa-links">
      <a {...ext} href={qm ?? "https://quickmap.lroc.im-ldi.com/"} onClick={qm ? undefined : copy}>QuickMap</a> ·{" "}
      <a {...ext} href={moonTrekUrl(lat, lon)}>Moon Trek</a> ·{" "}
      <a {...ext} href={horizonsUrl("10", lat, lon, h_m, day)}>Sun in JPL Horizons</a> ·{" "}
      <a {...ext} href={horizonsUrl("399", lat, lon, h_m, day)}>Earth in JPL Horizons</a>
      <br />
      {copied ? "Coordinates copied: paste them into QuickMap's search box (its links can't open the pole)."
        : `Horizons lists the height above a flat horizon for ${isoDate(day)}, hourly. Sunchaser adds the real terrain.`}
    </p>
  );
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
