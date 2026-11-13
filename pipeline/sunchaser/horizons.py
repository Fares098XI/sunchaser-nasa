"""JPL Horizons reference ephemerides (validation only, V1).

Run: python -m sunchaser.horizons   -> writes pipeline/tests/data/horizons_*.csv
"""
from datetime import datetime

import numpy as np
import requests

from . import PIPELINE_DIR

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
REF_DIR = PIPELINE_DIR / "tests" / "data"


def fetch(target, lat_deg, lon_deg, h_m, start, stop, step="1 h", center_body="301"):
    """Apparent airless az/el from a surface site on `center_body` (301 Moon, 399 Earth).
    Returns (t_utc ISO list, az_deg, elev_deg, raw text)."""
    q = lambda s: f"'{s}'"
    params = {
        "format": "text", "COMMAND": q(target), "CENTER": q(f"coord@{center_body}"), "COORD_TYPE": q("GEODETIC"),
        "SITE_COORD": q(f"{lon_deg:.10f},{lat_deg:.10f},{h_m / 1000:.6f}"), "MAKE_EPHEM": q("YES"),
        "EPHEM_TYPE": q("OBSERVER"), "START_TIME": q(start), "STOP_TIME": q(stop), "STEP_SIZE": q(step),
        "QUANTITIES": q("4"), "ANG_FORMAT": q("DEG"), "CSV_FORMAT": q("YES"), "EXTRA_PREC": q("YES"),
    }
    r = requests.get(API, params=params, timeout=300)
    r.raise_for_status()
    return parse(r.text) + (r.text,)


def parse(text):
    if "$$SOE" not in text:
        raise ValueError("Horizons response has no ephemeris:\n" + text[:2000])
    rows = text.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    t, az, el = [], [], []
    for row in rows:
        c = [s.strip() for s in row.split(",")]
        t.append(datetime.strptime(c[0], "%Y-%b-%d %H:%M").strftime("%Y-%m-%dT%H:%M:%S"))
        az.append(float(c[3]))
        el.append(float(c[4]))
    return t, np.array(az), np.array(el)


def v1_site():
    """V1 site: Connecting Ridge RoI 4 centroid, height from the 20 m DEM (nearest cell)."""
    from .fetch import read_dem_window
    from .frames import stereo_to_latlon
    from .sites import CONNECTING_RIDGE_ROI4 as s

    w = read_dem_window("20mpp", s["x_m"], s["y_m"], 5000)
    col = int((s["x_m"] - w["x0_m"]) // w["res_m"])
    row = int((w["y0_m"] - s["y_m"]) // w["res_m"])
    lat, lon = stereo_to_latlon(s["x_m"], s["y_m"])
    return float(lat), float(lon), float(w["dem"][row, col])


V1_BODIES = {"sun": "10", "earth": "399"}
V1_START, V1_STOP = "2027-01-01 00:00", "2027-12-31 23:00"
V1C_START, V1C_STOP = "2020-01-01 00:00", "2045-12-31 00:00"  # V1c: the whole Explore range, daily


def dsn_station_geodetic(station):
    """Station lon/lat (deg) and height (m) on the WGS-84 spheroid from the SPICE station kernel."""
    import spiceypy as spice
    from .ephem import load_kernels, utc_to_et

    load_kernels()
    pos, _ = spice.spkpos(station, utc_to_et([V1_START.replace(" ", "T")])[0], "ITRF93", "NONE", "EARTH")
    a, b = 6378.137, 6356.752314245  # WGS-84
    lon, lat, alt = spice.recgeo(pos, a, (a - b) / a)
    return float(np.degrees(lat)), float(np.degrees(lon)), float(alt * 1000)


def main_dsn():
    from .dsn import STATIONS

    for st in STATIONS:
        lat, lon, h = dsn_station_geodetic(st)
        t, az, el, raw = fetch("301", lat, lon, h, V1_START, V1_STOP, center_body="399")
        out = REF_DIR / f"horizons_moon_from_{st}_2027.csv"
        with open(out, "w", newline="\n") as f:
            f.write(f"# JPL Horizons {datetime.utcnow():%Y-%m-%d}, target 301, coord@399 geodetic lon {lon:.10f} "
                    f"lat {lat:.10f} h_m {h:.3f} ({st}), apparent airless az/el\n")
            f.write("t_utc,az_deg,elev_deg\n")
            for row in zip(t, az, el):
                f.write(f"{row[0]},{row[1]:.9f},{row[2]:.9f}\n")
        radii = [l for l in raw.splitlines() if l.startswith("Center radii")]
        print(f"{out.name}: {len(t)} rows; {radii[0] if radii else ''}")


def main(v1c_only=False):
    REF_DIR.mkdir(parents=True, exist_ok=True)
    if not v1c_only:
        main_dsn()
    lat, lon, h = v1_site()
    print(f"V1 site lat {lat:.6f} lon {lon:.6f} h {h:.1f} m")
    runs = [] if v1c_only else [(V1_START, V1_STOP, "1 h", "2027")]
    for (start, stop, step, tag), (name, cmd) in [(r, b) for r in runs + [(V1C_START, V1C_STOP, "1 d", "2020_2045_daily")]
                                                  for b in V1_BODIES.items()]:
        t, az, el, raw = fetch(cmd, lat, lon, h, start, stop, step=step)
        out = REF_DIR / f"horizons_{name}_{tag}.csv"
        with open(out, "w", newline="\n") as f:
            f.write(f"# JPL Horizons {datetime.utcnow():%Y-%m-%d}, target {cmd}, coord@301 geodetic "
                    f"lon {lon:.10f} lat {lat:.10f} h_m {h:.3f}, apparent airless az/el\n")
            f.write("t_utc,az_deg,elev_deg\n")
            for row in zip(t, az, el):
                f.write(f"{row[0]},{row[1]:.9f},{row[2]:.9f}\n")
        print(f"{out.name}: {len(t)} rows")


if __name__ == "__main__":
    import sys

    main(v1c_only="--v1c" in sys.argv)
