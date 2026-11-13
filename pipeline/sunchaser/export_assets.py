"""Visual assets for the 3D scene (docs/DATA.md "Imagery", docs/METHODS.md §11). Visual only: no number depends on them.

stars     Hipparcos (ESA 1997, CDS I/239) V <= 7.5 -> web/public/data/stars.bin (J2000 unit vectors, colour, magnitude)
milkyway  NASA SVS Deep Star Maps 2020 (Milky Way without Hipparcos/Tycho stars) -> textures/milkyway_4k.jpg
earth     NASA Blue Marble NG (Dec 2004), Black Marble 2016 night lights, Blue Marble clouds -> textures/earth_*.jpg
moon      NASA SVS CGI Moon Kit: LROC WAC colour (2025) + LOLA ldem_16 normals; LOLA 80 m polar cap normals
moontiles LOLA ldem_64 (474 m) normals in 8 x 4 tiles of 2048^2 (loaded where the camera looks) + a 104 m south cap
farfield  LOLA 80 m (PGDA LDEM_80S_80MPP_ADJ) rings around the hero region -> data/farfield_<region>.bin

Run: python -m sunchaser.export_assets [stars milkyway earth moon farfield]   (default: all)
"""
import hashlib
import json
import os
import sys

import numpy as np
import requests

from . import DATA_DIR, REPO_DIR

os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"  # must precede the cv2 import
import cv2  # noqa: E402

ASSETS = DATA_DIR / "assets"
TEX = REPO_DIR / "web" / "public" / "textures"
WEB_DATA = REPO_DIR / "web" / "public" / "data"
SVS = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/"
EO = "https://eoimages.gsfc.nasa.gov/images/imagerecords/"
SOURCES = {
    "milkyway_2020_4k.exr": SVS.replace("a004700", "a004800") + "a004851/milkyway_2020_4k.exr",
    "world.topo.bathy.200412.3x5400x2700.jpg": EO + "73000/73909/world.topo.bathy.200412.3x5400x2700.jpg",
    "BlackMarble_2016_01deg.jpg": EO + "144000/144898/BlackMarble_2016_01deg.jpg",
    "cloud_combined_2048.jpg": EO + "57000/57747/cloud_combined_2048.jpg",
    "lroc_color_16bit_srgb_4k.tif": SVS + "a004720/lroc_color_16bit_srgb_4k.tif",
    "ldem_16.tif": SVS + "a004720/ldem_16.tif",
    "ldem_64_uint.tif": SVS + "a004720/ldem_64_uint.tif",
    "lroc_color_poles_16k.tif": SVS + "a004720/lroc_color_poles_16k.tif",
}
HIP_URL = ("https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=I/239/hip_main&-out=HIP,Vmag,RAICRS,DEICRS,pmRA,pmDE,B-V"
           "&Vmag=%3C7.5&-out.max=unlimited")
R_MOON_KM = 1737.4


def fetch(name):
    """Download once into pipeline/data/assets; prints the SHA-256 for docs/DATA.md."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    path = ASSETS / name
    if not path.exists():
        url = SOURCES[name]
        with requests.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            if r.headers.get("content-type", "").startswith("text/html"):
                raise FileNotFoundError(url)
            tmp = path.with_suffix(".part")
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
            tmp.replace(path)
    print(f"{name}: {path.stat().st_size:,} B sha256 {hashlib.sha256(path.read_bytes()).hexdigest()}")
    return path


def save_jpg(img_rgb_u8, name, quality=88):
    TEX.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(TEX / name), cv2.cvtColor(img_rgb_u8, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    print(f"  -> textures/{name} {(TEX / name).stat().st_size / 1e6:.2f} MB")


# ---------- stars ----------

def _g(lam, mu, s1, s2):
    s = np.where(lam < mu, s1, s2)
    return np.exp(-0.5 * ((lam - mu) / s) ** 2)


def blackbody_rgb(t_k):
    """Chromaticity of a blackbody as linear sRGB scaled to max 1 (CIE 1931 2-deg CMF, Wyman et al. 2013 fit)."""
    lam = np.arange(380.0, 781.0, 5.0)
    xb = 1.056 * _g(lam, 599.8, 37.9, 31.0) + 0.362 * _g(lam, 442.0, 16.0, 26.7) - 0.065 * _g(lam, 501.1, 20.4, 26.2)
    yb = 0.821 * _g(lam, 568.8, 46.9, 40.5) + 0.286 * _g(lam, 530.9, 16.3, 31.1)
    zb = 1.217 * _g(lam, 437.0, 11.8, 36.0) + 0.681 * _g(lam, 459.0, 26.0, 13.8)
    l_m = lam * 1e-9
    planck = 1.0 / (l_m[None, :] ** 5 * (np.exp(1.438777e-2 / (l_m[None, :] * np.asarray(t_k)[:, None])) - 1.0))
    xyz = np.stack([planck @ xb, planck @ yb, planck @ zb], -1)
    m = np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]])
    rgb = np.clip(xyz @ m.T, 0, None)
    return rgb / rgb.max(axis=1, keepdims=True)


def stars():
    path = ASSETS / "hip_main_v7.5.tsv"
    if not path.exists():
        ASSETS.mkdir(parents=True, exist_ok=True)
        r = requests.get(HIP_URL, timeout=300)
        r.raise_for_status()
        path.write_text(r.text, encoding="utf-8")
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        c = line.split("\t")
        if line.startswith("#") or len(c) != 7 or not c[0].strip().isdigit():
            continue
        v, ra, de, pmra, pmde, bv = (float(x) if x.strip() else np.nan for x in c[1:])
        rows.append((v, ra, de, pmra, pmde, bv))
    a = np.array(rows)
    a = a[np.isfinite(a[:, :3]).all(1)]
    a = a[np.argsort(a[:, 0])]
    v, ra, de, pmra, pmde, bv = a.T
    dt = 2030.0 - 1991.25  # Hipparcos epoch -> mid Explore range; pmRA is mu_alpha* (includes cos dec)
    de2 = de + np.nan_to_num(pmde) * dt / 3.6e6
    ra2 = ra + np.nan_to_num(pmra) * dt / 3.6e6 / np.cos(np.radians(de))
    d, r = np.radians(de2), np.radians(ra2)
    xyz = np.stack([np.cos(d) * np.cos(r), np.cos(d) * np.sin(r), np.sin(d)], -1)
    bv = np.clip(np.nan_to_num(bv, nan=0.6), -0.4, 2.0)
    t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))  # Ballesteros 2012
    rgb = blackbody_rgb(t)
    rec = np.zeros(len(v), dtype=[("p", "<i2", 3), ("c", "u1", 3), ("m", "u1")])
    rec["p"] = np.round(xyz * 32767)
    rec["c"] = np.round(rgb * 255)
    rec["m"] = np.clip(np.round((v + 2) * 20), 0, 255)
    (WEB_DATA / "stars.bin").write_bytes(rec.tobytes())
    print(f"stars: {len(v)} Hipparcos stars V <= {v.max():.2f} -> data/stars.bin {rec.nbytes / 1e3:.0f} kB "
          f"(record: int16 x,y,z * 32767 J2000; uint8 r,g,b linear; uint8 (V + 2) * 20)")
    return {"file": "stars.bin", "n": int(len(v)), "v_max": float(v.max()), "epoch": 2030.0}


# ---------- Milky Way ----------

def milkyway():
    import OpenEXR  # pip install OpenEXR (OpenCV's EXR reader rejects this file)

    img = OpenEXR.File(str(fetch("milkyway_2020_4k.exr"))).parts[0].channels["RGB"].pixels.astype(np.float64)
    lum = img @ [0.2126, 0.7152, 0.0722]
    p = np.percentile(lum, 99.5)
    out = 1 - np.exp(-img * (np.log(2) / p))  # 99.5th percentile -> 0.5, soft shoulder above
    srgb = np.where(out <= 0.0031308, 12.92 * out, 1.055 * np.power(out, 1 / 2.4) - 0.055)
    save_jpg(np.round(np.clip(srgb, 0, 1) * 255).astype(np.uint8), "milkyway_4k.jpg", 90)
    # orientation check: the brightest smoothed region must be near the galactic centre (RA 266.4, Dec -28.9)
    blur = cv2.GaussianBlur(lum, (0, 0), 25)
    r, c = np.unravel_index(np.argmax(blur), blur.shape)
    ra = (0.5 - (c + 0.5) / blur.shape[1]) * 360 % 360
    dec = 90 - (r + 0.5) / blur.shape[0] * 180
    print(f"  brightest region RA {ra:.1f} Dec {dec:.1f} (galactic centre RA 266.4 Dec -28.9)")


# ---------- Earth ----------

def earth():
    day = cv2.imread(str(fetch("world.topo.bathy.200412.3x5400x2700.jpg")))[:, :, ::-1]
    save_jpg(cv2.resize(day, (4096, 2048), interpolation=cv2.INTER_AREA), "earth_day_4k.jpg", 86)
    night = cv2.imread(str(fetch("BlackMarble_2016_01deg.jpg")))[:, :, ::-1]
    save_jpg(cv2.resize(night, (2048, 1024), interpolation=cv2.INTER_AREA), "earth_night_2k.jpg", 85)
    cl = cv2.imread(str(fetch("cloud_combined_2048.jpg")))[:, :, ::-1]
    save_jpg(cl, "earth_clouds_2k.jpg", 82)


# ---------- Moon ----------

def normals_equirect(h_km, exaggeration):
    """Tangent-space normals (east, north, up) of an equirectangular height map (rows 90N -> 90S, cols 180W -> 180E)."""
    rows, cols = h_km.shape
    lat = np.radians(90 - (np.arange(rows) + 0.5) * 180 / rows)[:, None]
    dlat, dlon = np.pi / rows, 2 * np.pi / cols
    hp = np.pad(h_km, ((1, 1), (0, 0)), mode="edge")
    dh_n = (hp[:-2] - hp[2:]) / (2 * R_MOON_KM * dlat)  # row 0 is north
    dh_e = (np.roll(h_km, -1, 1) - np.roll(h_km, 1, 1)) / (2 * R_MOON_KM * dlon * np.maximum(np.cos(lat), 0.02))
    n = np.stack([-dh_e * exaggeration, -dh_n * exaggeration, np.ones_like(h_km)], -1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True)


def to_u8(n):
    return np.round((n * 0.5 + 0.5) * 255).astype(np.uint8)


def moon():
    import rasterio
    from rasterio.enums import Resampling

    col = cv2.imread(str(fetch("lroc_color_16bit_srgb_4k.tif")), cv2.IMREAD_UNCHANGED)[:, :, ::-1]
    col8 = np.round(col.astype(np.float64) / 257).astype(np.uint8)
    save_jpg(cv2.resize(col8, (4096, 2048), interpolation=cv2.INTER_AREA), "moon_color_4k.jpg", 88)
    left, mid = col8[:, : col8.shape[1] // 8].mean(), col8[:, 7 * col8.shape[1] // 16: 9 * col8.shape[1] // 16].mean()
    print(f"  near-side check: centre strip mean {mid:.1f} vs left edge {left:.1f} (maria darken the near side)")

    with rasterio.open(fetch("ldem_16.tif")) as ds:
        h = ds.read(1, out_shape=(2048, 4096), resampling=Resampling.average).astype(np.float64)
    save_jpg(to_u8(normals_equirect(h, 1.5)), "moon_normal_4k.jpg", 90)

    # South polar cap (lat < -80): LOLA 80 m -> 2048^2 grid normals in (grid x, grid y, up)
    from .fetch import DEM_DIR

    with rasterio.open(DEM_DIR / "LDEM_80S_80MPP_ADJ.TIF") as ds:
        b = ds.bounds
        hc = ds.read(1, out_shape=(2048, 2048), resampling=Resampling.average).astype(np.float64)
    res = (b.right - b.left) / 2048
    gy, gx = np.gradient(hc, res)  # rows go south (-y): d/dy = -d/drow
    n = np.stack([-gx * 1.5, gy * 1.5, np.ones_like(hc)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    save_jpg(to_u8(n), "moon_southcap_normal_2k.jpg", 90)
    print(f"  south cap: half-width {b.right / 1000:.1f} km, {res:.0f} m/px")
    return {"cap_half_km": b.right / 1000}


COLOR_TILE_PX = 1024


def colortiles():
    """LRO WAC colour at 16384 x 8192 (SVS 4720 lroc_color_poles_16k) cut into the same 8 x 4 tiles as the relief
    (1024^2, ~4.6 km/px at the equator: twice the 4k map; native 2048^2 was too heavy for the T495). That version is darker than the 4k map the globe uses (another tone
    curve), so each channel is remapped through a lookup table fitted on co-located pixels: the tiles fade in over the
    4k map without a jump in brightness."""
    big = cv2.imread(str(fetch("lroc_color_poles_16k.tif")), cv2.IMREAD_COLOR)[:, :, ::-1]
    ref = cv2.imread(str(fetch("lroc_color_16bit_srgb_4k.tif")), cv2.IMREAD_UNCHANGED)[:, :, ::-1]
    ref = cv2.resize(np.round(ref.astype(np.float64) / 257).astype(np.uint8), (4096, 2048), interpolation=cv2.INTER_AREA)
    small = cv2.resize(big, (4096, 2048), interpolation=cv2.INTER_AREA)
    rows = slice(228, 1820)  # within +-70 deg: the polar fill differs between versions
    lut = np.zeros((3, 256), np.uint8)
    for ch in range(3):
        s, r = small[rows, :, ch].ravel(), ref[rows, :, ch].ravel().astype(np.float64)
        cnt = np.bincount(s, minlength=256)
        mean = np.bincount(s, weights=r, minlength=256) / np.maximum(cnt, 1)
        v = np.arange(256)
        ok = cnt > 50
        curve = np.interp(v, v[ok], mean[ok])
        lut[ch] = np.clip(np.round(np.maximum.accumulate(curve)), 0, 255)  # monotone
    print(f"  tone match: 16k mean {small[rows].mean():.1f} -> "
          f"{np.stack([lut[c][small[rows, :, c]] for c in range(3)], -1).mean():.1f} (4k map {ref[rows].mean():.1f})")
    out = TEX / "moon_tiles"
    out.mkdir(parents=True, exist_ok=True)
    th, tw = big.shape[0] // TILE_ROWS, big.shape[1] // TILE_COLS
    for j in range(TILE_ROWS):
        for i in range(TILE_COLS):
            t = big[j * th:(j + 1) * th, i * tw:(i + 1) * tw]
            # 1024^2 (~4.6 km/px): a 2048^2 tile per patch, next to its relief tile, cost the T495 10-20 fps while zooming
            t = cv2.resize(t, (COLOR_TILE_PX, COLOR_TILE_PX), interpolation=cv2.INTER_AREA)
            t = np.stack([lut[c][t[:, :, c]] for c in range(3)], -1)
            cv2.imwrite(str(out / f"c_{i}_{j}.jpg"), cv2.cvtColor(t, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 84])
    print(f"colour tiles: {TILE_COLS}x{TILE_ROWS} of {COLOR_TILE_PX}^2 from {tw}x{th} ({sum(f.stat().st_size for f in out.glob('c_*.jpg')) / 1e6:.1f} MB)")


# ---------- Moon detail tiles ----------

TILE_COLS, TILE_ROWS, TILE_PX = 8, 4, 2048  # 45 x 45 deg each


def moontiles():
    """Relief normals at 16384 x 8192 (from LOLA ldem_64, 64 px/deg) cut into 8 x 4 tiles, plus a 4096^2 cap of
    the south pole (+-212 km at ~104 m from LOLA 80 m) covering every catalogued site. Same exaggeration (1.5) and
    conventions as moon() so the globe can swap levels without a jump."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import Window

    from .fetch import DEM_DIR

    out = TEX / "moon_tiles"
    out.mkdir(parents=True, exist_ok=True)
    with rasterio.open(fetch("ldem_64_uint.tif")) as ds:
        w, h = ds.width // TILE_COLS, ds.height // TILE_ROWS
        for j in range(TILE_ROWS):
            for i in range(TILE_COLS):
                d = ds.read(1, window=Window(i * w, j * h, w, h), out_shape=(TILE_PX, TILE_PX),
                            resampling=Resampling.average).astype(np.float64) / 2000.0  # half-metres -> km
                lat_top = 90 - 45 * j
                lat = np.radians(lat_top - (np.arange(TILE_PX) + 0.5) * 45 / TILE_PX)[:, None]
                step = np.radians(45 / TILE_PX)
                dn, de = np.gradient(d, step * R_MOON_KM)  # axis 0 runs south
                de = de / np.maximum(np.cos(lat), 0.02)
                n = np.stack([-de * 1.5, dn * 1.5, np.ones_like(d)], -1)
                n /= np.linalg.norm(n, axis=-1, keepdims=True)
                cv2.imwrite(str(out / f"n_{i}_{j}.jpg"), cv2.cvtColor(to_u8(n), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 86])
        print(f"moon tiles: {TILE_COLS}x{TILE_ROWS} of {TILE_PX}^2 from {ds.width}x{ds.height} "
              f"({sum(f.stat().st_size for f in out.glob('n_*.jpg')) / 1e6:.1f} MB)")

    half = 212_000.0
    with rasterio.open(DEM_DIR / "LDEM_80S_80MPP_ADJ.TIF") as ds:
        win = rasterio.windows.from_bounds(-half, -half, half, half, ds.transform)
        hc = ds.read(1, window=win, out_shape=(4096, 4096), resampling=Resampling.average).astype(np.float64)
    res = 2 * half / 4096
    gy, gx = np.gradient(hc, res)
    n = np.stack([-gx * 1.5, gy * 1.5, np.ones_like(hc)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    save_jpg(to_u8(n), "moon_southcap_hi_4k.jpg", 88)
    print(f"  south cap (hi): half-width {half / 1000:.0f} km, {res:.0f} m/px")


def polecaps():
    """South-pole caps for the globe: normals over +-460 km (to 75 S) from LOLA 240 m at 2048^2 (450 m/px), and
    heights over +-304 km from LOLA 80 m at 1024^2 (594 m/px) packed as 16-bit (R = high byte, G = low byte,
    value = (h_m + 8192) * 4) for the globe's cast shadows."""
    import rasterio
    from rasterio.enums import Resampling

    from .fetch import DEM_DIR

    half = 460_000.0
    with rasterio.open(DEM_DIR / "LDEM_60S_240MPP_ADJ.TIF") as ds:
        win = rasterio.windows.from_bounds(-half, -half, half, half, ds.transform)
        hw = ds.read(1, window=win, out_shape=(2048, 2048), resampling=Resampling.average).astype(np.float64)
    if not np.isfinite(hw).all():
        raise ValueError("wide cap has missing cells")
    res = 2 * half / 2048
    gy, gx = np.gradient(hw, res)
    n = np.stack([-gx * 1.5, gy * 1.5, np.ones_like(hw)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    save_jpg(to_u8(n), "moon_southcap_wide_2k.jpg", 90)
    print(f"  wide cap: half-width {half / 1000:.0f} km, {res:.0f} m/px")

    with rasterio.open(DEM_DIR / "LDEM_80S_80MPP_ADJ.TIF") as ds:
        h = ds.read(1, out_shape=(1024, 1024), resampling=Resampling.average).astype(np.float64)
    save_heights(h, "moon_southcap_height_1k.png")


def polenear():
    """Native LOLA 80 m heights over +-81.92 km around the pole (2048^2; Connecting Ridge, Shackleton, Peak near
    Shackleton, de Gerlache), same packing, for sharp globe shadows and relief below ~500 km (loaded on demand)."""
    import rasterio

    from .fetch import DEM_DIR

    half = 81_920.0  # 1024 pixels of 80 m each side of the pole: the window falls on the DEM's own pixel edges
    with rasterio.open(DEM_DIR / "LDEM_80S_80MPP_ADJ.TIF") as ds:
        win = rasterio.windows.from_bounds(-half, -half, half, half, ds.transform)
        h = ds.read(1, window=win).astype(np.float64)
    if h.shape != (2048, 2048) or not np.isfinite(h).all():
        raise ValueError(f"near-pole window {h.shape} or missing cells")
    save_heights(h, "moon_southcap_height_near_2k.png")


def save_heights(h, name):
    """16-bit packing for the browser: R = high byte, G = low byte of (h_m + 8192) * 4 (0.25 m steps)."""
    v = np.round((h + 8192.0) * 4.0)
    if v.min() < 0 or v.max() > 65535:
        raise ValueError("heights outside the 16-bit packing range")
    v = v.astype(np.uint16)
    rgb = np.stack([(v >> 8).astype(np.uint8), (v & 255).astype(np.uint8), np.zeros_like(v, dtype=np.uint8)], -1)
    TEX.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(TEX / name), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    back = ((rgb[..., 0].astype(np.int32) << 8) | rgb[..., 1]) / 4.0 - 8192.0
    print(f"  {name}: {h.min():.0f}..{h.max():.0f} m, packing error {np.abs(back - h).max():.3f} m, "
          f"{(TEX / name).stat().st_size / 1e6:.2f} MB")


# ---------- far field ----------

def farfield():
    """Far-field rings around the hero region (curvature is applied in the browser): the same three rings as every site
    region (export_regions.far_rings: +-8 km at 80 m, +-25 km at 250 m, +-150 km at 1 km), int16 metres."""
    from .export_regions import far_rings

    m = json.loads((WEB_DATA / "manifest.json").read_text())
    t = m["terrain"]
    cx, cy = t["x0_m"] + t["cols"] * t["res_m"] / 2, t["y0_m"] - t["rows"] * t["res_m"] / 2
    rings, blob = far_rings(cx, cy, hole_km=t["cols"] * t["res_m"] / 2000)
    name = f"farfield_{m['region']['id']}.bin"
    (WEB_DATA / name).write_bytes(blob)
    m["farfield"] = {"file": name, "rings": rings, "dtype": "int16-le metres above 1737.4 km, row 0 = north",
                     "source": "PGDA LDEM_80S_80MPP_ADJ.TIF (LOLA 80 m), Gaussian pre-filter + bilinear",
                     "centre_x_m": cx, "centre_y_m": cy, "use": "visual context only (no statistic reads it)"}
    (WEB_DATA / "manifest.json").write_text(json.dumps(m, separators=(",", ":")))
    print(f"farfield: {[r['n'] for r in rings]} vertices per side -> data/{name}")

if __name__ == "__main__":
    jobs = sys.argv[1:] or ["stars", "milkyway", "earth", "moon", "moontiles", "colortiles", "polecaps", "polenear", "farfield"]
    for j in jobs:
        print(f"== {j}")
        globals()[j]()
