"""V3b: do the V3 Sun outliers come from terrain resolution? Re-run them on 60 m terrain (criterion in VALIDATION.md).

Run: python -m sunchaser.validate_v3b
"""
import json

import numpy as np

from . import PIPELINE_DIR
from .build_sites import LAYERS
from .ephem import az_el, utc_to_et
from .export_sites import times
from .fetch import read_dem_window
from .frames import grid_azimuth_deg
from .horizon import coarsen, compute
from .sites import load_sites
from .validate_v3 import pgda_value
from .visibility import SUN_RADIUS_M, disc_fraction, horizon_at

OUTLIERS = ("connecting-ridge", "shackleton-rim", "peak-near-shackleton")
PGDA60_EDGE_M = -151_740.0  # left/bottom edge of the PGDA 85S 60 m grid
RESULT = PIPELINE_DIR / "tests" / "data" / "v3b_result.json"


def layers_60m(x, y):
    """20 m near field trimmed onto PGDA's 60 m pixel grid and block-averaged x3; 80/240 m layers as built."""
    w = read_dem_window("20mpp", x, y, LAYERS[0][1] + 900.0, allow_nan=True, cache=False)
    dc = int(round(((PGDA60_EDGE_M - w["x0_m"]) % 60.0) / 20.0)) % 3
    dr = int(round(((w["y0_m"] - PGDA60_EDGE_M) % 60.0) / 20.0)) % 3
    near = {"dem": w["dem"][dr:, dc:], "x0_m": w["x0_m"] + 20.0 * dc, "y0_m": w["y0_m"] - 20.0 * dr, "res_m": 20.0,
            "s0_m": 0.0, "s1_m": LAYERS[0][1]}
    out = [coarsen(near, 3)]
    s0 = LAYERS[0][1]
    for product, s1 in LAYERS[1:]:
        v = read_dem_window(product, x, y, s1 + 600.0, allow_nan=True, cache=False)
        out.append({"dem": v["dem"], "x0_m": v["x0_m"], "y0_m": v["y0_m"], "res_m": v["res_m"], "s0_m": s0, "s1_m": s1})
        s0 = s1
    assert abs(((out[0]["x0_m"] - PGDA60_EDGE_M) / 60.0) % 1) < 1e-9, "near field must sit on the PGDA 60 m grid"
    return out


def run():
    ts = times()
    ets = utc_to_et(ts)
    rows = []
    for site in (s for s in load_sites() if s["id"] in OUTLIERS):
        x, y = site["x_m"], site["y_m"]
        L = layers_60m(x, y)
        hz = compute(np.array([x]), np.array([y]), 1.0, L, 1440)[:, 0]
        az, el, dist = az_el("10", site["lat_deg"], site["lon_deg"], 0.0, ts, ets)  # observer height: < 1e-4 deg effect
        f = disc_fraction(el, horizon_at(hz, grid_azimuth_deg(az, site["lon_deg"])), np.degrees(np.arcsin(SUN_RADIUS_M / dist)))
        ours60 = 100 * float(np.mean(f > 0))
        ref = 100 * pgda_value("AVGVISIB_85S_060M_201608.TIF", x, y)
        rows.append({"site": site["id"], "ours_60m": round(ours60, 2), "pgda": round(ref, 2), "diff": round(ours60 - ref, 2)})
        print(rows[-1], flush=True)
    ok = all(abs(r["diff"]) <= 10 for r in rows)
    RESULT.write_text(json.dumps({"rows": rows, "PASS": ok}, indent=1))
    print(f"V3b PASS={ok}")


if __name__ == "__main__":
    run()
