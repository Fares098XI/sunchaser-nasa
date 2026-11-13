"""Site horizons for the catalog: 1,440 azimuths, 4 observer heights, 19 landing-dispersion points per site.

Run: python -m sunchaser.build_sites [--only id ...]
"""
import argparse
import os
import time

import numpy as np

from . import DATA_DIR
from .fetch import PGDA5, read_dem_window
from .horizon import _bilinear, compute
from .sites import load_sites

OUT_DIR = DATA_DIR / "build" / "sites"
N_AZ = 1440
Z_M = (1.0, 2.0, 5.0, 10.0)
NEAR_5M_M = 3_000.0  # Barker 5 m site DEM out to 3 km (20 m beyond); V2 used 7.5 km, the difference is < V4 scale
LAYERS = (("20mpp", 25_000.0), ("80mpp", 150_000.0), ("240mpp", 300_000.0))
DISPERSION_M = (125.0, 250.0)  # rings of 6 and 12 points: IM-2 landed ~250 m from its target


def dispersion_points(x, y):
    pts = [(x, y)]
    for r, n in zip(DISPERSION_M, (6, 12)):
        for k in range(n):
            a = 2 * np.pi * k / n
            pts.append((x + r * np.sin(a), y + r * np.cos(a)))
    return np.array(pts)


def near_5m_layer(site_name, x, y):
    import rasterio
    from rasterio.windows import from_bounds

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    half = NEAR_5M_M + 500.0
    with rasterio.open(f"/vsicurl/{PGDA5}{site_name}/{site_name}_final_adj_5mpp_surf.tif") as ds:
        win = from_bounds(x - half, y - half, x + half, y + half, ds.transform).round_offsets().round_lengths()
        dem = ds.read(1, window=win, boundless=True, fill_value=np.nan).astype(np.float32)
        x0, y0 = ds.transform * (win.col_off, win.row_off)
    return {"dem": dem, "x0_m": float(x0), "y0_m": float(y0), "res_m": 5.0, "s0_m": 0.0, "s1_m": NEAR_5M_M,
            "product": f"{site_name} 5 m"}


def site_layers(site):
    x, y = site["x_m"], site["y_m"]
    layers = []
    s0 = 0.0
    if site["dem5"]:
        layers.append(near_5m_layer(site["dem5"], x, y))
        s0 = NEAR_5M_M
    for product, s1 in LAYERS:
        w = read_dem_window(product, x, y, s1 + max(DISPERSION_M) + 600.0, allow_nan=True, cache=False)
        layers.append({"dem": w["dem"], "x0_m": w["x0_m"], "y0_m": w["y0_m"], "res_m": w["res_m"], "s0_m": s0,
                       "s1_m": s1, "product": product})
        s0 = s1
    return layers


def build_site(site):
    t = time.time()
    layers = site_layers(site)
    pts = dispersion_points(site["x_m"], site["y_m"])
    hz = np.stack([compute(pts[:, 0], pts[:, 1], z, layers, N_AZ).T for z in Z_M], axis=1)  # (pts, z, az)
    L0 = layers[0]
    ground = _bilinear(L0["dem"], L0["x0_m"], L0["y0_m"], L0["res_m"], site["x_m"], site["y_m"])
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT_DIR / f"{site['id']}.npz", horizon_deg=hz.astype(np.float32), points_xy=pts,
                        ground_m=float(ground),
                        z_m=np.array(Z_M), layers=np.array([f"{L['product']}:{L['s0_m']:.0f}-{L['s1_m']:.0f}" for L in layers]))
    c = hz[0, 1]
    print(f"{site['id']:22s} {time.time() - t:5.0f}s  centre z=2 m horizon min {c.min():6.2f} median {np.median(c):6.2f} "
          f"max {c.max():6.2f} deg; NaN-free {np.isfinite(hz).all()}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    only = ap.parse_args().only
    for site in load_sites():
        if not only or site["id"] in only:
            build_site(site)


if __name__ == "__main__":
    main()
