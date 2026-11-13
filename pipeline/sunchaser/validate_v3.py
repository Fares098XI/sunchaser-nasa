"""V3: catalog sites' any-part visibility vs PGDA average-visibility maps (criterion in docs/VALIDATION.md).

Run: python -m sunchaser.validate_v3   (after build_sites)
"""
import json

import numpy as np

from . import PIPELINE_DIR
from .build_sites import OUT_DIR
from .ephem import az_el, utc_to_et
from .export_sites import times
from .frames import grid_azimuth_deg
from .select_sites import ILLUM_85S_HALF_M
from .sites import load_sites
from .visibility import SUN_RADIUS_M, disc_fraction, horizon_at

EARTH_RADIUS_M = 6_371_008.8
RESULT = PIPELINE_DIR / "tests" / "data" / "v3_result.json"


def pgda_value(name, x, y):
    """Value of the PGDA map pixel containing grid point (x, y)."""
    import rasterio
    from rasterio.windows import Window

    from .select_sites import ILLUM, ILLUM_SCALE

    with rasterio.open("/vsicurl/" + ILLUM + name) as ds:
        col, row = (int(v) for v in ~ds.transform * (x, y))
        v = float(ds.read(1, window=Window(col, row, 1, 1))[0, 0])
    return np.nan if v == -32768 else v * ILLUM_SCALE


def run():
    ts = times()
    ets = utc_to_et(ts)
    rows = []
    for site in load_sites():
        b = np.load(OUT_DIR / f"{site['id']}.npz")
        hz = b["horizon_deg"][0, 0]  # centre point, z = 1 m
        x, y = site["x_m"], site["y_m"]
        name = "AVGVISIB_85S_060M_201608.TIF" if max(abs(x), abs(y)) < ILLUM_85S_HALF_M - 100 else "AVGVISIB_75S_120M_201608.TIF"
        row = {"site": site["id"], "product": name}
        for body, naif, radius in (("sun", "10", SUN_RADIUS_M), ("earth", "399", EARTH_RADIUS_M)):
            az, el, dist = az_el(naif, site["lat_deg"], site["lon_deg"], float(b["ground_m"]) + 1.0, ts, ets)
            f = disc_fraction(el, horizon_at(hz, grid_azimuth_deg(az, site["lon_deg"])), np.degrees(np.arcsin(radius / dist)))
            ours = 100 * float(np.mean(f > 0))
            ref = 100 * pgda_value(name if body == "sun" else name.replace(".TIF", "_EARTH.TIF"), x, y)
            row[body] = {"ours": round(ours, 2), "pgda": round(ref, 2), "diff": round(ours - ref, 2)}
        rows.append(row)
        print(row, flush=True)
    ok = {b: sum(abs(r[b]["diff"]) <= 10 for r in rows) for b in ("sun", "earth")}
    out = {"rows": rows, "within_10pt": ok, "PASS": ok["sun"] >= 8 and ok["earth"] >= 8}
    RESULT.write_text(json.dumps(out, indent=1))
    print(f"V3: within 10 points — Sun {ok['sun']}/10, Earth {ok['earth']}/10; PASS={out['PASS']}")
    return out


if __name__ == "__main__":
    run()
