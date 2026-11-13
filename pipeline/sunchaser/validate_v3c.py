"""V3c: hero-region any-part Sun visibility vs the PGDA 60 m map, compared in 120 m blocks (VALIDATION.md).

Run: python -m sunchaser.validate_v3c   (after build)
"""
import json
import os
from datetime import datetime, timedelta

import numpy as np

from . import PIPELINE_DIR
from .build import BUILD_DIR, OBS_Z_M
from .ephem import az_el
from .frames import grid_azimuth_deg, stereo_to_latlon
from .horizon import cell_centres
from .select_sites import ILLUM, ILLUM_SCALE
from .sites import CONNECTING_RIDGE_ROI4 as SITE
from .visibility import SUN_RADIUS_M, disc_fraction

START, STOP = datetime(2026, 11, 1), datetime(2029, 1, 1)
RESULT = PIPELINE_DIR / "tests" / "data" / "v3c_result.json"


def pgda_at(X, Y):
    import rasterio
    from rasterio.windows import from_bounds

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with rasterio.open("/vsicurl/" + ILLUM + "AVGVISIB_85S_060M_201608.TIF") as ds:
        win = from_bounds(X.min() - 120, Y.min() - 120, X.max() + 120, Y.max() + 120, ds.transform).round_offsets().round_lengths()
        dn = ds.read(1, window=win).astype(np.float64)
        t = ds.window_transform(win)
    v = dn[np.floor((Y - t.f) / t.e).astype(int), np.floor((X - t.c) / t.a).astype(int)]
    return np.where(v == -32768, np.nan, v * ILLUM_SCALE)


def blocks(a, k=3):
    r, c = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    return a[:r, :c].reshape(r // k, k, c // k, k).mean(axis=(1, 3))


def run():
    z = np.load(BUILD_DIR / f"horizon_{SITE['id']}_z{OBS_Z_M:g}.npz")
    hz = z["horizon_deg"].astype(np.float64)  # (n_az, rows, cols)
    n_az, rows, cols = hz.shape
    X, Y = cell_centres(float(z["x0_m"]), float(z["y0_m"]), float(z["cell_m"]), rows, cols)
    lat, lon = (float(v) for v in stereo_to_latlon(X.mean(), Y.mean()))
    n = int((STOP - START).total_seconds() // 3600)
    ts = [(START + timedelta(hours=i)).isoformat() for i in range(n)]
    az, el, dist = az_el("10", lat, lon, 1900.0, ts)
    az_g, r = grid_azimuth_deg(az, lon), np.degrees(np.arcsin(SUN_RADIUS_M / dist))
    flat = hz.reshape(n_az, -1)
    lit = np.zeros(flat.shape[1])
    for h in range(n):
        u = (az_g[h] % 360) * n_az / 360
        i, f = int(u) % n_az, u - int(u)
        horizon = flat[i] * (1 - f) + flat[(i + 1) % n_az] * f
        lit += disc_fraction(el[h], horizon, r[h]) > 0
    ours = 100 * (lit / n).reshape(rows, cols)
    ref = 100 * pgda_at(X, Y)
    a, b = blocks(ours).ravel(), blocks(ref).ravel()
    ok = np.isfinite(a) & np.isfinite(b)
    a, b = a[ok], b[ok]
    corr = float(np.corrcoef(a, b)[0, 1])
    med = float(np.median(a - b))
    within = float(np.mean(np.abs(a - b) <= 10))
    out = {"blocks": int(a.size), "pearson_r": round(corr, 4), "median_diff_pt": round(med, 2),
           "within_10pt": round(within, 4), "ours_mean": round(float(a.mean()), 2), "pgda_mean": round(float(b.mean()), 2),
           "hours": n, "PASS": corr >= 0.85 and abs(med) <= 5}
    RESULT.write_text(json.dumps(out, indent=1))
    print("V3c:", out)
    return out


if __name__ == "__main__":
    run()
