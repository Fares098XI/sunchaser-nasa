"""V2c: Barker's DEM-error ensemble at Connecting Ridge RoI 4 (criterion in docs/VALIDATION.md).

Horizon = max over layers, so the layers beyond the 5 m near field (identical for every clone) are computed once
and cached; each clone then only re-walks its own 5 m near field. Resumable: one JSON line per finished clone.

Run: python -m sunchaser.validate_v2c [--n 100] [--keep]   (each clone is a 41 MB download)
"""
import argparse
import json
import time
from datetime import timedelta

import numpy as np
import requests

from . import DATA_DIR, PIPELINE_DIR
from .ephem import az_el
from .fetch import read_site_dem
from .frames import grid_azimuth_deg, stereo_to_latlon
from .horizon import _bilinear, compute, load_layers
from .validate_v2 import N_AZ, NEAR_5M_M, START, STOP, longest_run, roi_pixels, roi_polygon
from .visibility import disc_fraction, horizon_at, sun_radius_deg

CLONE_URL = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site01/Clones/Site01_final_adj_5mpp_{:04d}_err.tif"
CLONE_DIR = DATA_DIR / "clones"
LOG = PIPELINE_DIR / "tests" / "data" / "v2c_clones.jsonl"
Z_M = 5.0
P1_REF, LCSP99_REF = 88.12, 4.00


def far_horizon(px, py, site5):
    """Horizon of everything beyond the 5 m near field, observer heights from Barker's best-estimate 5 m DEM
    (exactly as in V2)."""
    cache = DATA_DIR / "build" / "v2c_far.npy"
    if cache.exists():
        return np.load(cache)
    far = load_layers(-11287.5, -12167.5, 5_000.0)
    far[0] = {**far[0], "s0_m": NEAR_5M_M}
    ground = [_bilinear(site5["dem"], site5["x0_m"], site5["y0_m"], 5.0, x, y) for x, y in zip(px, py)]
    hz = compute(px, py, Z_M, far, N_AZ, ground_m=ground)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, hz)
    return hz


def clone_layer(i, keep):
    import rasterio

    CLONE_DIR.mkdir(parents=True, exist_ok=True)
    path = CLONE_DIR / f"clone_{i:04d}.tif"
    if not path.exists():
        tmp = path.with_suffix(".part")
        for attempt in range(8):  # PGDA throttles bursts with 403/429/503
            try:
                with requests.get(CLONE_URL.format(i), stream=True, timeout=120) as r:
                    if r.status_code in (403, 429, 503):
                        raise requests.HTTPError(f"HTTP {r.status_code}")
                    r.raise_for_status()
                    if r.headers.get("content-type", "").startswith("text/html"):
                        raise FileNotFoundError(CLONE_URL.format(i))  # PGDA's "not found" page
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                break
            except requests.RequestException:  # incl. a connection broken mid-file (ChunkedEncodingError)
                if attempt == 7:
                    raise
                time.sleep(10 * (attempt + 1))
        tmp.replace(path)
    with rasterio.open(path) as ds:
        dem = ds.read(1).astype(np.float32)
        x0, y0 = ds.transform * (0, 0)
    if not keep:
        path.unlink()
    if not np.isfinite(dem).all():
        raise ValueError(f"clone {i}: missing cells")
    return {"dem": dem, "x0_m": float(x0), "y0_m": float(y0), "res_m": 5.0, "s0_m": 0.0, "s1_m": NEAR_5M_M}


def run(n=100, keep=False):
    poly, (cx, cy) = roi_polygon()
    px, py = roi_pixels(poly)
    lat, lon = (float(v) for v in stereo_to_latlon(cx, cy))
    site5 = read_site_dem("Site01_final_adj_5mpp_surf.tif")
    ground = float(_bilinear(site5["dem"], site5["x0_m"], site5["y0_m"], site5["res_m"], cx, cy))
    n_h = int((STOP - START).total_seconds() // 3600)
    times = [(START + timedelta(hours=i)).isoformat() for i in range(n_h)]
    az, el, dist = az_el("10", lat, lon, ground + Z_M, times)
    az_g, r_sun = grid_azimuth_deg(az, lon), sun_radius_deg(dist)
    far = far_horizon(px, py, site5)

    LOG.parent.mkdir(parents=True, exist_ok=True)  # absent in the Kaggle package (tests/ is not shipped)
    done = {json.loads(l)["clone"] for l in LOG.read_text().splitlines()} if LOG.exists() else set()
    for i in range(1, n + 1):
        if i in done:
            continue
        t0 = time.time()
        L = clone_layer(i, keep)
        # shortcut: far horizon keeps the best-estimate observer height; a clone's ~0.3-0.5 m height error moves
        # terrain beyond 7.5 km by <= dz/s ~ 0.004 deg. Upgrade: re-walk far layers per clone (3x cost) if V2c is close.
        hz = np.maximum(compute(px, py, Z_M, [L], N_AZ), far)
        f = disc_fraction(el[:, None], horizon_at(hz, az_g), r_sun[:, None])
        roi = f.mean(axis=1)
        rec = {"clone": i, "z5_avg": float(roi.mean() * 100), "z5_lcsp_d": longest_run(roi == 0) / 24,
               "s": round(time.time() - t0)}
        with open(LOG, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
        print(rec, flush=True)
    recs = [json.loads(l) for l in LOG.read_text().splitlines()]
    avg = np.array([r["z5_avg"] for r in recs])
    lcsp = np.array([r["z5_lcsp_d"] for r in recs])
    p1, l99 = np.percentile(avg, 1), np.percentile(lcsp, 99)
    ok = abs(p1 - P1_REF) <= 1.5 and abs(l99 - LCSP99_REF) <= 1.0
    print(f"V2c: N={len(recs)} clones; 1st pct avg {p1:.2f} % (Barker {P1_REF}); 99th pct LCSP {l99:.2f} d "
          f"(Barker {LCSP99_REF}); PASS={ok}")
    return p1, l99, ok


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100)
    ap.add_argument("--keep", action="store_true", help="keep downloaded clones")
    a = ap.parse_args()
    run(a.n, a.keep)
