"""Global terrain tiles for "drop a pin anywhere" (S5, docs/METHODS.md §20).

NASA LOLA GDR LDEM_16 (1895 m/pix, PDS) cut into 15 x 15 degree tiles of 240 x 240 int16 (0.5 m units above the
1737.4 km sphere, the product's own values), zlib-compressed. The browser loads only the tiles within 300 km of a pin.
Tile (i, j): rows from 90 - 15 i degrees north, columns from 15 j degrees east; pixel centres as in the PDS label.

Run: python -m sunchaser.export_globalterrain [--golden]
"""
import hashlib
import json
import zlib

import math

import numpy as np
import requests

from . import DATA_DIR, REPO_DIR
from .atlas import GDR, OUT_DIR, PDS, _rows, load_atlas

OUT = REPO_DIR / "web" / "public" / "data" / "terrain16"
TILE_DEG = 15


def ldem16():
    path = DATA_DIR / "dem" / "global" / "ldem_16.img"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        r = requests.get(PDS + "ldem_16.img", timeout=600)
        r.raise_for_status()
        path.write_bytes(r.content)
    ppd, ns, nl = GDR["ldem_16"]
    raw = path.read_bytes()
    assert len(raw) == ns * nl * 2, "unexpected LDEM_16 size"
    return np.frombuffer(raw, dtype="<i2").reshape(nl, ns), hashlib.sha256(raw).hexdigest()


def export():
    dn, sha = ldem16()
    ppd = GDR["ldem_16"][0]
    n = TILE_DEG * ppd
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for i in range(180 // TILE_DEG):
        for j in range(360 // TILE_DEG):
            blob = zlib.compress(np.ascontiguousarray(dn[i * n:(i + 1) * n, j * n:(j + 1) * n]).astype("<i2").tobytes(), 9)
            (OUT / f"{i}_{j}.i16z").write_bytes(blob)
            total += len(blob)
    meta = {"product": "LOLA GDR LDEM_16 (PDS lrolol_1xxx, cylindrical/img/ldem_16.img)", "source_sha256": sha,
            "ppd": ppd, "tile_deg": TILE_DEG, "tile_px": n, "rows": 180 // TILE_DEG, "cols": 360 // TILE_DEG,
            "encoding": "zlib(int16 little-endian), value x 0.5 m = height above 1737.4 km; row 0 = north edge of the tile",
            "pixel_centres": "lat = 90 - (line + 0.5) / ppd, lon = (sample + 0.5) / ppd (east, 0-360)",
            "file": "{i}_{j}.i16z, i = 0 at 90N..75N, j = 0 at 0..15E"}
    (OUT / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{(180 // TILE_DEG) * (360 // TILE_DEG)} tiles, {total / 1e6:.1f} MB; heights {dn.min() * 0.5:.0f}..{dn.max() * 0.5:.0f} m")


# Near terrain for a pin (LDEM_64 to 30 km) comes from web/api/dem.ts, which crops the PDS map with this rule.
NEAR_HALF_DEG = 1.6  # > the 30 km layer's corner (44.9 km = 1.48 deg) + a pixel
NEAR_MAX_LAT = 86.0  # beyond, the crop spans most longitudes (> 2 MB); pins there use LDEM_16 near terrain


def near_crop(lat, lon):
    ppd, ns, nl = GDR["ldem_64"]
    r0 = max(0, math.floor((90 - (lat + NEAR_HALF_DEG)) * ppd))
    r1 = min(nl, math.ceil((90 - (lat - NEAR_HALF_DEG)) * ppd))
    d_lon = NEAR_HALF_DEG / math.cos(math.radians(abs(lat) + NEAR_HALF_DEG))
    c0 = math.floor((lon - d_lon) * ppd) % ns
    return r0, r1 - r0, c0, min(ns, math.ceil(2 * d_lon * ppd) + 2)


GOLDEN_SITES = ("apollo-15", "change-4", "slim")
GOLDEN_AZ_EVERY = 30


def golden():
    """V11: LDEM_64 crops (as the API serves them) + the pipeline's atlas horizons at a subset of azimuths."""
    ns = GDR["ldem_64"][1]
    gdir = REPO_DIR / "web" / "src" / "engine" / "golden"
    out = {"az_every": GOLDEN_AZ_EVERY, "sites": []}
    for s in load_atlas():
        if s["id"] not in GOLDEN_SITES:
            continue
        r0, nr, c0, nc = near_crop(s["lat_deg"], s["lon_deg"])
        dn = np.round(_rows("ldem_64", r0, r0 + nr) / 0.5).astype("<i2")[:, (c0 + np.arange(nc)) % ns]
        (gdir / f"v11_{s['id']}.i16z").write_bytes(zlib.compress(dn.tobytes(), 9))
        hz = np.load(OUT_DIR / f"{s['id']}.npz")["horizon_deg"]  # (pts, z, az)
        out["sites"].append({"id": s["id"], "lat": s["lat_deg"], "lon": s["lon_deg"], "r0": r0, "nr": nr, "c0": c0, "nc": nc,
                             "ground_m": float(np.load(OUT_DIR / f"{s['id']}.npz")["ground_m"]),
                             "hz": hz[:, :, ::GOLDEN_AZ_EVERY].astype(float).round(7).tolist()})
        print(s["id"], "crop", nr, "x", nc)
    (gdir / "v11_pin.json").write_text(json.dumps(out))


if __name__ == "__main__":
    import sys
    golden() if "--golden" in sys.argv else export()
