"""Explorable 3D regions for every catalogued site (docs/METHODS.md §14).

Each site gets 5 x 5 km of LOLA 20 m terrain, horizons on 40 m cells x 180 azimuths from the same exact ray walk and
layers as the hero region (§5), NASA's permanent-shadow mask and far-field rings. Sun/Earth tracks are not duplicated:
the browser derives each site's directions from the hero region's SPICE tracks (checked by V5d in tests/test_regions.py).
Output: web/public/data/regions/<id>/{manifest.json, terrain.bin, horizon.bin, psr.bin, farfield.bin} + regions/index.json.
Run: python -m sunchaser.export_regions [site ids]   (default: every site except the hero, ~4 min each)
"""
import hashlib
import json
import sys
import time
from datetime import datetime

import numpy as np

from .export import WEB_DATA, PSR_MIN_CELLS, PSR_URL, encode_horizon, scene_from_me

PSR_URL_75S = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_75S_120M_201608.TIF"
PSR_85S_RHO_M = 151_740.0  # the 60 m product covers 85 S and poleward
from .fetch import read_dem_window
from .frames import stereo_to_latlon, surface_vector_m
from .horizon import cell_centres, compute, load_layers
from .sites import load_sites

HALF_M = 2_500.0
CELL_M = 40.0
OBS_Z_M = 2.0
N_AZ = 180
HERO_SITE = "connecting-ridge"  # explored with the original 10 km region (web/public/data)
OUT = WEB_DATA / "regions"


def psr_mask(X, Y, url=PSR_URL):
    """PGDA product 69 LPSR (Mazarico et al. 2011; 60 m to 85 S, else the 120 m product to 75 S), nearest pixel to
    each cell centre, specks < PSR_MIN_CELLS removed (same rule as the hero region)."""
    import os

    import rasterio
    from rasterio.windows import from_bounds
    from scipy import ndimage

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with rasterio.open("/vsicurl/" + url) as ds:
        win = from_bounds(X.min() - 120, Y.min() - 120, X.max() + 120, Y.max() + 120, ds.transform).round_offsets().round_lengths()
        dn = ds.read(1, window=win, boundless=True, fill_value=0).astype(np.float64)
        t = ds.window_transform(win)
    col = np.clip(np.floor((X - t.c) / t.a).astype(int), 0, dn.shape[1] - 1)
    row = np.clip(np.floor((Y - t.f) / t.e).astype(int), 0, dn.shape[0] - 1)
    raw = dn[row, col] * 0.000025 + 0.5 > 0.5
    lab, n = ndimage.label(raw)
    sizes = ndimage.sum(raw, lab, range(1, n + 1))
    return np.isin(lab, np.flatnonzero(sizes >= PSR_MIN_CELLS) + 1).astype(np.uint8), float(raw.mean())


def far_rings(cx, cy, hole_km=HALF_M / 1000):
    """Far-field rings centred on (cx, cy) (also used for the hero region by export_assets.farfield): +-8 km at the
    LOLA 80 m product's own spacing around the region (hole = the region), +-25 km at 250 m, +-150 km at 1 km.
    Beyond the 80 m product (304 km from the pole) the LOLA 240 m product fills in."""
    import rasterio
    from scipy import ndimage

    from .fetch import DEM_DIR

    rings, blobs = [], []
    with rasterio.open(DEM_DIR / "LDEM_80S_80MPP_ADJ.TIF") as ds:
        for half_km, step_m, hole in ((8, 80, hole_km), (25, 250, 8), (150, 1000, 25)):
            pad = 4 * step_m
            win = rasterio.windows.from_bounds(cx - half_km * 1e3 - pad, cy - half_km * 1e3 - pad,
                                               cx + half_km * 1e3 + pad, cy + half_km * 1e3 + pad, ds.transform)
            win = win.round_offsets().round_lengths()
            dem = ds.read(1, window=win, boundless=True, fill_value=np.nan).astype(np.float64)
            tr = ds.window_transform(win)
            if not np.isfinite(dem).all():
                with rasterio.open(DEM_DIR / "LDEM_60S_240MPP_ADJ.TIF") as wide:
                    w2 = rasterio.windows.from_bounds(*rasterio.windows.bounds(win, ds.transform), wide.transform)
                    fill = wide.read(1, window=w2, out_shape=dem.shape, boundless=True, fill_value=np.nan,
                                     resampling=rasterio.enums.Resampling.bilinear).astype(np.float64)
                dem = np.where(np.isfinite(dem), dem, fill)
            dem = np.where(np.isfinite(dem), dem, np.nanmean(dem))
            dem = ndimage.gaussian_filter(dem, sigma=0.5 * step_m / tr.a)
            n = int(round(2 * half_km * 1e3 / step_m)) + 1
            xs = cx + (np.arange(n) - (n - 1) / 2) * step_m
            ys = cy - (np.arange(n) - (n - 1) / 2) * step_m
            Xg, Yg = np.meshgrid(xs, ys)
            h = ndimage.map_coordinates(dem, [(Yg - tr.f) / tr.e - 0.5, (Xg - tr.c) / tr.a - 0.5], order=1)
            blobs.append(np.round(h).astype("<i2").tobytes())
            rings.append({"half_km": half_km, "step_m": step_m, "hole_km": hole, "n": n,
                          "h_min_m": float(h.min()), "h_max_m": float(h.max())})
    return rings, b"".join(blobs)


def build_region(site):
    t0 = time.time()
    d = OUT / site["id"]
    d.mkdir(parents=True, exist_ok=True)
    w = read_dem_window("20mpp", site["x_m"], site["y_m"], HALF_M)
    dem = w["dem"]
    rows, cols = dem.shape
    cx, cy = w["x0_m"] + cols * w["res_m"] / 2, w["y0_m"] - rows * w["res_m"] / 2
    lat, lon = (float(v) for v in stereo_to_latlon(cx, cy))
    hc = float(dem[rows // 2, cols // 2])
    terrain = dem.astype("<f4").tobytes()
    (d / "terrain.bin").write_bytes(terrain)

    hr, hcols = int(round(rows * w["res_m"] / CELL_M)), int(round(cols * w["res_m"] / CELL_M))
    X, Y = cell_centres(w["x0_m"], w["y0_m"], CELL_M, hr, hcols)
    layers = load_layers(site["x_m"], site["y_m"], HALF_M, allow_nan=True)
    hz = compute(X, Y, OBS_Z_M, layers, N_AZ).astype(np.float32).reshape(N_AZ, hr, hcols)
    blob, _ = encode_horizon(hz)
    (d / "horizon.bin").write_bytes(blob)

    psr_url = PSR_URL if np.hypot(np.abs(X).max(), np.abs(Y).max()) < PSR_85S_RHO_M else PSR_URL_75S
    psr, raw = psr_mask(X, Y, psr_url)
    (d / "psr.bin").write_bytes(psr.tobytes())
    rings, far = far_rings(cx, cy)
    (d / "farfield.bin").write_bytes(far)

    m = {
        "generated_utc": datetime.utcnow().replace(microsecond=0).isoformat(),
        "region": {"id": site["id"], "name": site["name"], "site_source": site["source"], "site_x_m": site["x_m"],
                   "site_y_m": site["y_m"], "center_lat_deg": lat, "center_lon_deg": lon, "center_h_m": hc},
        "terrain": {"file": "terrain.bin", "dtype": "float32-le", "rows": rows, "cols": cols, "res_m": w["res_m"],
                    "x0_m": w["x0_m"], "y0_m": w["y0_m"], "row0": "north (max y)", "h_min_m": float(dem.min()),
                    "h_max_m": float(dem.max()), "units": "m above 1737.4 km sphere", "source": w["url"],
                    "sha256": hashlib.sha256(terrain).hexdigest()},
        "horizon": {"file": "horizon.bin", "encoding": "as the hero region (export.encode_horizon)", "quantum_deg": 1 / 256,
                    "layout": "[az][row][col]", "n_az": N_AZ, "rows": hr, "cols": hcols, "cell_m": CELL_M,
                    "x0_m": w["x0_m"], "y0_m": w["y0_m"], "z_m": OBS_Z_M,
                    "layers": [f"{L['product']}:{L['s0_m']:.0f}-{L['s1_m']:.0f}" for L in layers],
                    "method": "sunchaser.horizon (docs/METHODS.md §5)", "sha256": hashlib.sha256(blob).hexdigest()},
        "psr": {"file": "psr.bin", "dtype": "uint8 0/1", "rows": hr, "cols": hcols, "grid": "same as horizon",
                "source": f"PGDA product 69 {psr_url.rsplit('/', 1)[1][:-4]} (Mazarico et al. 2011)", "url": psr_url,
                "fraction": float(psr.mean()), "raw_fraction": raw, "min_patch_cells": PSR_MIN_CELLS},
        "farfield": {"file": "farfield.bin", "rings": rings, "dtype": "int16-le metres above 1737.4 km, row 0 = north",
                     "source": "PGDA LDEM_80S_80MPP_ADJ.TIF (LOLA 80 m)", "centre_x_m": cx, "centre_y_m": cy,
                     "use": "visual context only"},
        "scene_from_me": np.asarray(scene_from_me(lat, lon)).round(12).tolist(),
        "tracks": "derived in the browser from the hero region's tracks (docs/METHODS.md §14, V5d)",
    }
    (d / "manifest.json").write_text(json.dumps(m, separators=(",", ":")))
    print(f"{site['id']}: {rows}x{cols} terrain, horizons {hz.shape} ({hz.min():.2f}..{hz.max():.2f} deg), "
          f"PSR {psr.mean():.1%}, {time.time() - t0:.0f} s", flush=True)
    return m


def frame(m):
    """(scene_from_me, observer position km in MOON_ME) of a region manifest."""
    r = m["region"]
    return np.asarray(m["scene_from_me"]), surface_vector_m(r["center_lat_deg"], r["center_lon_deg"], r["center_h_m"]) / 1000


def derive(az_deg, el_deg, dist_km, src, dst):
    """Direction seen from region `src` re-expressed at region `dst` (frames from `frame`), vectorised.
    Same arithmetic as web/src/engine/regiontracks.ts deriveDirection."""
    (M, P), (N, Q) = src, dst
    az, el = np.radians(az_deg), np.radians(el_deg)
    s = np.stack([np.sin(az) * np.cos(el), np.sin(el), -np.cos(az) * np.cos(el)], -1)
    v = (s @ M) * np.asarray(dist_km)[..., None] + P - Q
    d = np.linalg.norm(v, axis=-1)
    x, y, z = ((v @ N.T) / d[..., None]).T
    return np.degrees(np.arctan2(x, -z)) % 360, np.degrees(np.arcsin(np.clip(y, -1, 1))), d


def rotate_quats(q, src, dst):
    """Orientation quaternions [x, y, z, w] at `src` -> at `dst` (left-multiplied by N M^T)."""
    from scipy.spatial.transform import Rotation

    r = Rotation.from_matrix(dst[0] @ src[0].T)
    return (r * Rotation.from_quat(q)).as_quat()


def golden():
    """V5d (b): hero track samples and their Python-derived values at three regions, for regiontracks.test.ts."""
    from . import REPO_DIR

    hero = json.loads((WEB_DATA / "manifest.json").read_text())
    rng = np.random.default_rng(11)
    ids = sorted(p.name for p in OUT.iterdir() if (p / "manifest.json").exists())[:3]
    src = frame(hero)
    cases = []
    for rid in ids:
        m = json.loads((OUT / rid / "manifest.json").read_text())
        dst = frame(m)
        az = rng.uniform(0, 360, 40)
        el = rng.uniform(-10, 30, 40)
        dist = np.where(np.arange(40) % 2, rng.uniform(1.46e8, 1.53e8, 40), rng.uniform(3.6e5, 4.06e5, 40))
        q = rng.normal(size=(40, 4))
        q /= np.linalg.norm(q, axis=1)[:, None]
        daz, delv, dd = derive(az, el, dist, src, dst)
        cases.append({"region": {k: m["region"][k] for k in ("id", "center_lat_deg", "center_lon_deg", "center_h_m")},
                      "scene_from_me": m["scene_from_me"], "az": az.tolist(), "el": el.tolist(), "dist": dist.tolist(),
                      "q": q.tolist(), "out_az": daz.tolist(), "out_el": delv.tolist(), "out_dist": dd.tolist(),
                      "out_q": rotate_quats(q, src, dst).tolist()})
    hero_r = {k: hero["region"][k] for k in ("id", "center_lat_deg", "center_lon_deg", "center_h_m")}
    path = REPO_DIR / "web" / "src" / "engine" / "golden" / "v5_regions.json"
    path.write_text(json.dumps({"hero": {"region": hero_r, "scene_from_me": hero["scene_from_me"]}, "cases": cases}))
    print(f"golden: {len(cases)} regions -> {path.name}")


def write_index():
    sites = load_sites()
    out = []
    for s in sites:
        if s["id"] == HERO_SITE:
            out.append({"id": s["id"], "name": s["name"], "base": "/data/", "extent_km": 10})
        elif (OUT / s["id"] / "manifest.json").exists():
            out.append({"id": s["id"], "name": s["name"], "base": f"/data/regions/{s['id']}/", "extent_km": 2 * HALF_M / 1000})
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.json").write_text(json.dumps({"regions": out}, indent=1))
    print(f"index: {len(out)} regions")


def refresh_farfield():
    """Rewrite farfield.bin and its manifest entry for every built region (far_rings is visual only)."""
    for p in sorted(OUT.glob("*/manifest.json")):
        m = json.loads(p.read_text())
        f = m["farfield"]
        rings, far = far_rings(f["centre_x_m"], f["centre_y_m"])
        (p.parent / "farfield.bin").write_bytes(far)
        m["farfield"]["rings"] = rings
        p.write_text(json.dumps(m, separators=(",", ":")))
        print(f"{p.parent.name}: far field rewritten")


if __name__ == "__main__":
    if sys.argv[1:] in (["--golden"], ["--index"], ["--farfield"]):
        {"--golden": golden, "--index": write_index, "--farfield": refresh_farfield}[sys.argv[1]]()
        sys.exit()
    ids = sys.argv[1:]
    for s in load_sites():
        if s["id"] == HERO_SITE or (ids and s["id"] not in ids):
            continue
        if not ids and (OUT / s["id"] / "manifest.json").exists():
            print(f"{s['id']}: exists, skipped")
            continue
        build_region(s)
    write_index()
    golden()
