"""Lunar atlas (S4, docs/METHODS.md §19): horizons at landing sites anywhere on the Moon.

The horizon engine (horizon.py) works on a south-polar stereographic grid. For a site at any latitude we use the
same projection after a rotation that puts the site at the "pole" (an oblique stereographic grid centred on it), so
the validated ray walk runs unchanged and its grid bearings are true azimuths at the site. Terrain: NASA LOLA global
GDR maps (PDS) — LDEM_64 (474 m) to 30 km, LDEM_16 (1895 m) to 300 km — resampled onto that grid.

Run: python -m sunchaser.atlas [--only id ...]     (then python -m sunchaser.export_atlas)
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import requests

from . import DATA_DIR
from .build_sites import N_AZ, OUT_DIR, Z_M, dispersion_points
from .frames import R_MOON_M, enu_basis
from .horizon import _bilinear, compute

ATLAS_JSON = Path(__file__).with_name("atlas.json")
PDS = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
GDR = {"ldem_64": (64, 23040, 11520), "ldem_16": (16, 5760, 2880)}  # pix/deg, samples, lines (labels, checked)
CACHE = DATA_DIR / "dem" / "global"
NEAR_M, FAR_M = 30_000.0, 300_000.0
MARGIN_M = 250.0 + 1500.0  # dispersion radius + a cell


def load_atlas():
    return json.loads(ATLAS_JSON.read_text(encoding="utf-8"))["sites"]


def rotation(lat_deg, lon_deg):
    """Rows N, E, -U: ME -> frame where the site is the south pole, its north grid +y (ME x), east grid +x (ME y)."""
    e, n, u = enu_basis(lat_deg, lon_deg)
    return np.stack([n, e, -u])


def grid_to_latlon(x, y, rot):
    """Oblique stereographic grid (m) -> planetocentric lat, east lon (deg). Inverse of horizon._point at h = 0."""
    t2 = (x * x + y * y) / (4.0 * R_MOON_M * R_MOON_M)
    v = np.stack([y / R_MOON_M / (1 + t2), x / R_MOON_M / (1 + t2), -(1 - t2) / (1 + t2)], -1)  # rotated frame
    me = v @ rot  # rot is orthonormal: ME = rot^T v
    return np.degrees(np.arcsin(np.clip(me[..., 2], -1, 1))), np.degrees(np.arctan2(me[..., 1], me[..., 0])) % 360


def _rows(name, r0, r1):
    """Rows r0..r1-1 of a global GDR (int16, 0.5 m) as heights in metres, cached on disk."""
    ppd, ns, nl = GDR[name]
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{name}_{r0}_{r1}.npy"
    if path.exists():
        return np.load(path)
    r = requests.get(PDS + f"{name}.img", headers={"Range": f"bytes={r0 * ns * 2}-{r1 * ns * 2 - 1}"}, timeout=300)
    r.raise_for_status()
    a = np.frombuffer(r.content, dtype="<i2").reshape(r1 - r0, ns).astype(np.float32) * 0.5
    np.save(path, a)
    return a


def sample(name, lat, lon):
    """Bilinear height (m above 1737.4 km) from a global GDR at the given points (pixel centres per the label)."""
    ppd, ns, nl = GDR[name]
    fr = (90.0 - lat) * ppd - 0.5
    fc = (lon % 360) * ppd - 0.5
    r0 = max(0, int(np.floor(fr.min())) - 1)
    r1 = min(nl, int(np.floor(fr.max())) + 3)
    a = _rows(name, r0, r1)
    r = np.clip(np.floor(fr).astype(int), r0, r1 - 2)
    b = np.clip(fr - r, 0, 1)
    c = np.floor(fc).astype(int)
    f = fc - c
    c0, c1 = c % ns, (c + 1) % ns  # longitude wraps
    rr = r - r0
    top = a[rr, c0] * (1 - f) + a[rr, c1] * f
    bot = a[rr + 1, c0] * (1 - f) + a[rr + 1, c1] * f
    return (top * (1 - b) + bot * b).astype(np.float32)


def layer(site, name, res_m, s0, s1):
    rot = rotation(site["lat_deg"], site["lon_deg"])
    half = s1 + MARGIN_M
    n = int(np.ceil(2 * half / res_m))
    x0 = y0 = -n * res_m / 2
    xs = x0 + (np.arange(n) + 0.5) * res_m
    ys = -y0 - (np.arange(n) + 0.5) * res_m  # row 0 = north
    X, Y = np.meshgrid(xs, ys)
    lat, lon = grid_to_latlon(X, Y, rot)
    return {"dem": sample(name, lat, lon), "x0_m": x0, "y0_m": -y0, "res_m": res_m, "s0_m": s0, "s1_m": s1,
            "product": f"LOLA {name.upper()} ({'474' if name == 'ldem_64' else '1895'} m)"}


def build(site):
    t = time.time()
    layers = [layer(site, "ldem_64", 400.0, 0.0, NEAR_M), layer(site, "ldem_16", 1500.0, NEAR_M, FAR_M)]
    pts = dispersion_points(0.0, 0.0)
    hz = np.stack([compute(pts[:, 0], pts[:, 1], z, layers, N_AZ).T for z in Z_M], axis=1)  # (pts, z, az)
    L0 = layers[0]
    ground = float(_bilinear(L0["dem"], L0["x0_m"], L0["y0_m"], L0["res_m"], 0.0, 0.0))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(OUT_DIR / f"{site['id']}.npz", horizon_deg=hz.astype(np.float32), points_xy=pts, ground_m=ground,
                        z_m=np.array(Z_M), layers=np.array([f"{L['product']}:{L['s0_m']:.0f}-{L['s1_m']:.0f}" for L in layers]))
    c = hz[0, 1]
    print(f"{site['id']:16s} {time.time() - t:5.0f}s ground {ground:7.0f} m; centre z=2 m horizon min {c.min():5.2f} "
          f"median {np.median(c):5.2f} max {c.max():5.2f} deg; finite {np.isfinite(hz).all()}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    only = ap.parse_args().only
    for s in load_atlas():
        if not only or s["id"] in only:
            build(s)


if __name__ == "__main__":
    main()
