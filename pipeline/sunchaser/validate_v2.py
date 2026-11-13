"""V2: illumination at Connecting Ridge RoI 4 vs Barker et al. 2021 Table 2 (criterion in docs/VALIDATION.md).

Run: python -m sunchaser.validate_v2
"""
import io
import json
import tarfile
import time
from datetime import datetime, timedelta

import numpy as np

from . import PIPELINE_DIR
from .ephem import az_el
from .fetch import fetch_site_file, read_site_dem
from .frames import grid_azimuth_deg, stereo_to_latlon
from .horizon import LAYERS, _bilinear, compute, load_layers
from .visibility import disc_fraction, horizon_at, sun_radius_deg

ROI_INDEX = 3  # record 4 of Site01_ROIs (centroid -11287.5, -12167.5 = Table 2 RoI 4)
EXPECTED_PIXELS = 532  # 13,300 m^2 / 25 m^2
NEAR_5M_M = 7_500.0
N_AZ = 1440
START, STOP = datetime(2024, 1, 1), datetime(2026, 1, 1)
CRITERIA = {"z5_avg": (85.12, 94.11), "z5_lcsp_d": (2.5, 5.0), "z1_avg": (66.61, 89.81)}
RESULT = PIPELINE_DIR / "tests" / "data" / "v2_result.json"


def roi_polygon():
    import shapefile

    with tarfile.open(fetch_site_file("Site01_ROIs.tgz")) as tar:
        files = {m.name.rsplit(".", 1)[1]: io.BytesIO(tar.extractfile(m).read())
                 for m in tar.getmembers() if m.isfile() and m.name.rsplit(".", 1)[-1] in ("shp", "shx", "dbf")}
    rec = shapefile.Reader(**files).shapeRecords()[ROI_INDEX]
    return np.array(rec.shape.points), tuple(rec.record)


def roi_pixels(poly, res=5.0):
    """Pixel centres (on the 5 m grid, centres at 2.5 m offsets) inside or on the polygon."""
    from matplotlib.path import Path

    xmin, ymin = poly.min(0)
    xmax, ymax = poly.max(0)
    xs = np.arange(np.floor(xmin / res) * res - res / 2, xmax + res, res)
    ys = np.arange(np.floor(ymin / res) * res - res / 2, ymax + res, res)
    gx, gy = np.meshgrid(xs, ys)
    pts = np.column_stack([gx.ravel(), gy.ravel()])
    inside = Path(poly).contains_points(pts)
    a, b = poly[:-1], poly[1:]  # boundary: distance to any edge < 1 mm
    ab = b - a
    t = np.clip(((pts[:, None, :] - a) * ab).sum(-1) / (ab**2).sum(-1).clip(1e-12), 0, 1)
    dist = np.linalg.norm(pts[:, None, :] - (a + t[..., None] * ab), axis=-1).min(1)
    keep = inside | (dist < 1e-3)
    return pts[keep, 0], pts[keep, 1]


def longest_run(mask):
    best = run = 0
    for m in mask:
        run = run + 1 if m else 0
        best = max(best, run)
    return best


def run():
    t0 = time.time()
    poly, centroid = roi_polygon()
    px, py = roi_pixels(poly)
    if px.size != EXPECTED_PIXELS:
        raise AssertionError(f"RoI 4 has {px.size} pixels, expected {EXPECTED_PIXELS}")
    cx, cy = centroid
    site5 = {**read_site_dem("Site01_final_adj_5mpp_surf.tif"), "s0_m": 0.0, "s1_m": NEAR_5M_M}
    far = load_layers(-11287.5, -12167.5, 5_000.0)  # same cached windows as the hero-region build
    far[0] = {**far[0], "s0_m": NEAR_5M_M}
    layers = [site5] + far
    lat, lon = (float(v) for v in stereo_to_latlon(cx, cy))
    ground = float(_bilinear(site5["dem"], site5["x0_m"], site5["y0_m"], site5["res_m"], cx, cy))
    n_h = int((STOP - START).total_seconds() // 3600)
    times = [(START + timedelta(hours=i)).isoformat() for i in range(n_h)]
    az, el, dist = az_el("10", lat, lon, ground + 5.0, times)
    az_g, r_sun = grid_azimuth_deg(az, lon), sun_radius_deg(dist)

    out = {"pixels": int(px.size), "n_hours": n_h, "n_az": N_AZ,
           "layers": [f"{L['product']}:{L['s0_m']:.0f}-{L['s1_m']:.0f}" for L in layers]}
    for z in (5.0, 1.0):
        hz = compute(px, py, z, layers, N_AZ)
        f = disc_fraction(el[:, None], horizon_at(hz, az_g), r_sun[:, None])  # (T, N)
        roi = f.mean(axis=1)
        key = f"z{z:g}"
        out[f"{key}_avg"] = float(roi.mean() * 100)
        out[f"{key}_best_pixel_avg"] = float(f.max(axis=1).mean() * 100)
        out[f"{key}_lcsp_d"] = longest_run(roi == 0) / 24
        out[f"{key}_lcip_d"] = longest_run(roi > 0) / 24
        out[f"{key}_pixel_range"] = [float(f.mean(0).min() * 100), float(f.mean(0).max() * 100)]
    out["pass"] = {k: lo <= out[k] <= hi for k, (lo, hi) in CRITERIA.items()}
    out["PASS"] = all(out["pass"].values())
    out["warning_below_p1"] = out["z5_avg"] < 88.12
    out["run_s"] = round(time.time() - t0)
    out["date"] = datetime.now().strftime("%Y-%m-%d")
    RESULT.write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    run()
