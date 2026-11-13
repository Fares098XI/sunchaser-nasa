"""Landing safety and science access per site (docs/METHODS.md §15): the two NASA Artemis site criteria Sunchaser's
lighting/comms numbers do not cover.

- Slope over the landing site: NASA treats a landing site as a ~100 m radius circle inside a candidate region; we report
  the slope of every LOLA 20 m cell in that circle (central differences over 40 m): median, 95th percentile, maximum
  and the share below a few common lander limits. Slopes below 20 m (boulders, small craters) are not seen.
- Nearest permanently shadowed region (water-ice science): distance and grid bearing from the site to the nearest PSR
  pixel of PGDA product 69 (LPSR 60 m to 85 S, else 120 m), isolated specks removed with the same rule as the 3D view.
Writes sites[i].terrain into web/public/data/sites/manifest.json.  Run: python -m sunchaser.site_terrain
"""
import json
import os

import numpy as np

from .export import PSR_MIN_CELLS, PSR_URL, WEB_DATA
from .export_regions import PSR_85S_RHO_M, PSR_URL_75S
from .fetch import read_dem_window

LANDING_R_M = 100.0
LIMITS_DEG = (5, 8, 10, 15)
PSR_SEARCH_M = 40_000.0


def slope_deg(dem, res_m):
    gy, gx = np.gradient(dem, res_m)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def landing_slopes(x_m, y_m):
    w = read_dem_window("20mpp", x_m, y_m, LANDING_R_M + 200)
    s = slope_deg(w["dem"].astype(np.float64), w["res_m"])
    rows, cols = s.shape
    xs = w["x0_m"] + (np.arange(cols) + 0.5) * w["res_m"]
    ys = w["y0_m"] - (np.arange(rows) + 0.5) * w["res_m"]
    X, Y = np.meshgrid(xs, ys)
    v = s[np.hypot(X - x_m, Y - y_m) <= LANDING_R_M]
    return {"median_deg": round(float(np.median(v)), 2), "p95_deg": round(float(np.percentile(v, 95)), 2),
            "max_deg": round(float(v.max()), 2), "cells": int(v.size),
            "share_below": {str(k): round(float((v < k).mean()), 3) for k in LIMITS_DEG}}


def psr_mask_window(x_m, y_m, half_m):
    """PSR 0/1 window around a point, specks < PSR_MIN_CELLS removed. Returns mask, x0, y0, res, product url."""
    import rasterio
    from rasterio.windows import from_bounds
    from scipy import ndimage

    url = PSR_URL if np.hypot(abs(x_m) + half_m, abs(y_m) + half_m) < PSR_85S_RHO_M else PSR_URL_75S
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with rasterio.open("/vsicurl/" + url) as ds:
        win = from_bounds(x_m - half_m, y_m - half_m, x_m + half_m, y_m + half_m, ds.transform).round_offsets().round_lengths()
        dn = ds.read(1, window=win, boundless=True, fill_value=0).astype(np.float64)
        x0, y0 = ds.transform * (win.col_off, win.row_off)
        res = ds.res[0]
    raw = dn * 0.000025 + 0.5 > 0.5
    lab, n = ndimage.label(raw)
    sizes = ndimage.sum(raw, lab, range(1, n + 1))
    return np.isin(lab, np.flatnonzero(sizes >= PSR_MIN_CELLS) + 1), float(x0), float(y0), float(res), url


def nearest_psr(mask, x0, y0, res, x_m, y_m):
    """Distance (m) and grid bearing (deg clockwise from grid +y) from (x, y) to the nearest PSR cell centre, or None."""
    if not mask.any():
        return None
    rr, cc = np.nonzero(mask)
    px = x0 + (cc + 0.5) * res
    py = y0 - (rr + 0.5) * res
    d = np.hypot(px - x_m, py - y_m)
    i = int(np.argmin(d))
    return float(d[i]), float(np.degrees(np.arctan2(px[i] - x_m, py[i] - y_m)) % 360)


def main():
    path = WEB_DATA / "sites" / "manifest.json"
    m = json.loads(path.read_text())
    for s in m["sites"]:
        if s.get("kind") == "atlas":  # no 20 m polar terrain there (METHODS §19)
            continue
        mask, x0, y0, res, url = psr_mask_window(s["x_m"], s["y_m"], PSR_SEARCH_M)
        near = nearest_psr(mask, x0, y0, res, s["x_m"], s["y_m"])
        s["terrain"] = {
            "landing_circle_r_m": LANDING_R_M, "slope": landing_slopes(s["x_m"], s["y_m"]),
            "psr_km": None if near is None else round(near[0] / 1000, 3),
            "psr_bearing_grid_deg": None if near is None else round(near[1], 1),
            "psr_product": url.rsplit("/", 1)[1][:-4], "psr_res_m": res,
        }
        sl = s["terrain"]["slope"]
        print(f"{s['id']:22s} slope median {sl['median_deg']:5.1f} p95 {sl['p95_deg']:5.1f} max {sl['max_deg']:5.1f} deg; "
              f"nearest PSR {s['terrain']['psr_km']} km", flush=True)
    m["terrain_method"] = ("slope: LOLA 20 m (LDEM_80S_20MPP_ADJ), central differences, every cell within 100 m of the "
                           "site; PSR: PGDA product 69 LPSR, specks < %d cells removed, nearest cell centre within %d km "
                           "(docs/METHODS.md §15)" % (PSR_MIN_CELLS, PSR_SEARCH_M / 1000))
    path.write_text(json.dumps(m, separators=(",", ":")))


if __name__ == "__main__":
    main()
