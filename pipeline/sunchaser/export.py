"""Write compact web data: terrain heights (.bin), packed horizons, PSR mask and manifest.json; then the
2020-2045 Sun/Earth tracks (export_tracks).

Run: python -m sunchaser.export
"""
import hashlib
import json
from datetime import datetime

import numpy as np

from . import REPO_DIR
from .fetch import read_dem_window
from .frames import enu_basis, stereo_to_latlon
from .sites import CONNECTING_RIDGE_ROI4

WEB_DATA = REPO_DIR / "web" / "public" / "data"


def export_region(site, half_m=5000.0, product="20mpp"):
    w = read_dem_window(product, site["x_m"], site["y_m"], half_m)
    dem = w["dem"]
    rows, cols = dem.shape
    cx = w["x0_m"] + cols * w["res_m"] / 2
    cy = w["y0_m"] - rows * w["res_m"] / 2
    lat, lon = (float(v) for v in stereo_to_latlon(cx, cy))
    h = float(dem[rows // 2, cols // 2])

    WEB_DATA.mkdir(parents=True, exist_ok=True)
    name = f"terrain_{site['id']}_{product}.bin"
    blob = dem.astype("<f4").tobytes()
    (WEB_DATA / name).write_bytes(blob)

    manifest_horizon = export_horizon(site)
    manifest_psr = export_psr(site, manifest_horizon)

    manifest = {
        "generated_utc": datetime.utcnow().replace(microsecond=0).isoformat(),
        "region": {
            "id": site["id"], "name": site["name"], "site_source": site["source"],
            "site_x_m": site["x_m"], "site_y_m": site["y_m"],
            "center_lat_deg": lat, "center_lon_deg": lon, "center_h_m": h,
        },
        "terrain": {
            "file": name, "dtype": "float32-le", "rows": rows, "cols": cols, "res_m": w["res_m"],
            "x0_m": w["x0_m"], "y0_m": w["y0_m"], "row0": "north (max y)",
            "h_min_m": float(dem.min()), "h_max_m": float(dem.max()),
            "units": "m above 1737.4 km sphere", "source": w["url"],
            "sha256": hashlib.sha256(blob).hexdigest(),
        },
        "horizon": manifest_horizon,
        "psr": manifest_psr,
    }
    (WEB_DATA / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    return manifest


def scene_from_me(lat_deg, lon_deg):
    """Rotation MOON_ME -> web scene axes (x = grid x, y = up, z = -grid y) at a site (docs/METHODS.md §1)."""
    east, north, up = enu_basis(lat_deg, lon_deg)
    c, s = np.cos(np.radians(lon_deg)), np.sin(np.radians(lon_deg))
    gx = c * east + s * north  # grid +x
    gy = -s * east + c * north  # grid +y
    return np.stack([gx, up, -gy])


# three.js SphereGeometry axes (+X lon 0, +Y north, +Z lon -90) -> Earth body-fixed (x lon 0, y lon 90E, z north)
EARTH_FROM_THREE = np.array([[1.0, 0, 0], [0, 0, -1.0], [0, 1.0, 0]])


def earth_orientation(lat_deg, lon_deg, times, ets=None):
    """Per time, quaternion [x, y, z, w] rotating a three.js Earth sphere into true orientation in the scene
    (SPICE IAU_EARTH from pck00011; light time ~1.3 s ignored, < 0.01 deg of Earth rotation)."""
    import spiceypy as spice
    from scipy.spatial.transform import Rotation

    from .ephem import utc_to_et

    m = scene_from_me(lat_deg, lon_deg)
    ets = utc_to_et(times) if ets is None else ets
    mats = [m @ spice.pxform("IAU_EARTH", "MOON_ME", et) @ EARTH_FROM_THREE for et in ets]
    return Rotation.from_matrix(np.array(mats)).as_quat()


HORIZON_QUANTUM_DEG = 1 / 256  # max rounding 0.002 deg; k/256 is exact in float16/32 for |h| < 8 deg


def encode_horizon(hz_deg):
    """[az][row][col] degrees -> int16 steps of 1/256 deg, delta-coded along azimuth (first azimuth absolute),
    byte-shuffled (all low bytes, then all high bytes). Returns (blob, decoded degrees)."""
    k = np.round(np.asarray(hz_deg, dtype=np.float64) / HORIZON_QUANTUM_DEG).astype(np.int32)
    if np.abs(k).max() >= 2**15:
        raise ValueError("horizon outside the int16 range")
    d = np.ascontiguousarray(np.diff(k, axis=0, prepend=0), dtype="<i2")  # inputs may be transposed views
    blob = np.ascontiguousarray(d.view(np.uint8).reshape(-1, 2).T).tobytes()
    return blob, k * HORIZON_QUANTUM_DEG


def export_horizon(site):
    """Packed horizons (encode_horizon) + a V5 golden file computed from the same decoded values."""
    from .build import BUILD_DIR, OBS_Z_M
    from .visibility import SUN_RADIUS_1AU_DEG, disc_fraction, horizon_at

    z = np.load(BUILD_DIR / f"horizon_{site['id']}_z{OBS_Z_M:g}.npz")
    blob, hz = encode_horizon(z["horizon_deg"])
    n_az, rows, cols = hz.shape
    name = f"horizon_{site['id']}_z{float(z['z_m']):g}.bin"
    for old in WEB_DATA.glob(f"horizon_{site['id']}_*.bin"):
        old.unlink()
    (WEB_DATA / name).write_bytes(blob)

    rng = np.random.default_rng(5)
    cases = []
    for _ in range(200):
        r, c = int(rng.integers(rows)), int(rng.integers(cols))
        az = float(rng.uniform(-30, 400))
        el = float(rng.uniform(-3, 3))
        h = float(horizon_at(hz[:, r, c], np.array([az]))[0])
        cases.append({"row": r, "col": c, "az_grid_deg": az, "elev_deg": el, "horizon_deg": h,
                      "frac": float(disc_fraction(el, h, SUN_RADIUS_1AU_DEG))})
    golden = REPO_DIR / "web" / "src" / "engine" / "golden" / "v5_visibility.json"
    golden.parent.mkdir(parents=True, exist_ok=True)
    golden.write_text(json.dumps({"horizon_file": name, "radius_deg": SUN_RADIUS_1AU_DEG, "cases": cases}, indent=0))

    return {
        "file": name, "encoding": "int16-le steps of quantum_deg, delta along azimuth, byte-shuffled (lo bytes, hi bytes)",
        "quantum_deg": HORIZON_QUANTUM_DEG, "layout": "[az][row][col]", "n_az": n_az, "rows": rows, "cols": cols,
        "cell_m": float(z["cell_m"]), "x0_m": float(z["x0_m"]), "y0_m": float(z["y0_m"]), "z_m": float(z["z_m"]),
        "azimuth": "grid bearing, bin k = k * 360 / n_az", "layers": [str(s) for s in z["layers"]],
        "method": "sunchaser.horizon (docs/METHODS.md §5)", "sha256": hashlib.sha256(blob).hexdigest(),
    }


PSR_URL = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_85S_060M_201608.TIF"
PSR_MIN_CELLS = 9  # 40 m cells (0.0144 km^2, ~4 PGDA 60 m pixels)


def export_psr(site, hm):
    """NASA permanent-shadow map (PGDA product 69, Mazarico et al. 2011, 60 m) sampled at each hero horizon cell
    centre (nearest 60 m pixel) -> uint8 0/1 on the horizon grid. PDS label: value = DN * 0.000025 + 0.5."""
    import os

    import rasterio
    from rasterio.windows import from_bounds

    from .horizon import cell_centres

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    X, Y = cell_centres(hm["x0_m"], hm["y0_m"], hm["cell_m"], hm["rows"], hm["cols"])
    with rasterio.open("/vsicurl/" + PSR_URL) as ds:
        win = from_bounds(X.min() - 120, Y.min() - 120, X.max() + 120, Y.max() + 120, ds.transform)
        win = win.round_offsets().round_lengths()
        dn = ds.read(1, window=win).astype(np.float64)
        t = ds.window_transform(win)
    col = np.floor((X - t.c) / t.a).astype(int)
    row = np.floor((Y - t.f) / t.e).astype(int)
    raw = dn[row, col] * 0.000025 + 0.5 > 0.5
    # Keep patches >= PSR_MIN_CELLS (~4 NASA 60 m pixels): near the pole the 60 m map has isolated pixel specks that
    # our 20 m engine finds sunlit (measured: 1-8-cell patches median 30 % sun in Jan 2027; >= 25-cell patches 94 % dark).
    from scipy import ndimage
    lab, n = ndimage.label(raw)
    sizes = ndimage.sum(raw, lab, range(1, n + 1))
    psr = np.isin(lab, np.flatnonzero(sizes >= PSR_MIN_CELLS) + 1).astype(np.uint8)
    name = f"psr_{site['id']}.bin"
    (WEB_DATA / name).write_bytes(psr.tobytes())
    print(f"PSR: {raw.mean():.1%} of the hero region in the NASA map; {psr.mean():.1%} kept in patches >= {PSR_MIN_CELLS} cells")
    return {"file": name, "dtype": "uint8 0/1", "rows": hm["rows"], "cols": hm["cols"], "grid": "same as horizon",
            "source": "PGDA product 69 LPSR_85S_060M_201608 (Mazarico et al. 2011), nearest 60 m pixel to each cell centre",
            "url": PSR_URL, "fraction": float(psr.mean()), "raw_fraction": float(raw.mean()),
            "min_patch_cells": PSR_MIN_CELLS}


def main():
    from . import export_tracks

    m = export_region(CONNECTING_RIDGE_ROI4)
    t = m["terrain"]
    print(f"wrote {t['file']} {t['rows']}x{t['cols']} @ {t['res_m']} m, h {t['h_min_m']:.0f}..{t['h_max_m']:.0f} m")
    export_tracks.export()


if __name__ == "__main__":
    main()
