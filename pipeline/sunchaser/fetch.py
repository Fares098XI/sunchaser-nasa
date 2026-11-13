"""Download pinned SPICE kernels and read LOLA DEM windows with HTTP range requests.

Run: python -m sunchaser.fetch
"""
import hashlib
import os

import numpy as np
import requests

from . import DATA_DIR

# GDAL range reads: retry throttled/flaky responses (PGDA sometimes answers 403/429 under load).
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "8")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_CODES", "403,429,500,502,503,504")

KERNEL_DIR = DATA_DIR / "kernels"
DEM_DIR = DATA_DIR / "dem"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"

# SHA-256 pinned on first download (docs/DATA.md).
KERNELS = {
    "naif0012.tls": ("lsk/naif0012.tls", "678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b"),
    "pck00011.tpc": ("pck/pck00011.tpc", "3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1"),
    "moon_pa_de440_200625.bpc": ("pck/moon_pa_de440_200625.bpc", "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f"),
    "moon_de440_250416.tf": ("fk/satellites/moon_de440_250416.tf", "a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768"),
    "de440s.bsp": ("spk/planets/de440s.bsp", "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2"),
    # DSN stations (pinned): Earth orientation 1962-2126 (history + prediction), station positions, topo frames
    "earth_1962_260806_2126_combined.bpc": ("pck/earth_1962_260806_2126_combined.bpc",
                                            "cc87ad1a495cf598800ba403763d350f087ac0b97da9fec603278a3864c6a53e"),
    "earth_assoc_itrf93.tf": ("fk/planets/earth_assoc_itrf93.tf",
                              "aab7bbc19b8a69bad11988ee1b4812a3963812a03a029c2776863e680719b336"),
    "earthstns_itrf93_260814.bsp": ("spk/stations/earthstns_itrf93_260814.bsp",
                                    "007eb0aad5dd022c6d61bdbfb2395680bd1eb31c49a8637d0b0a1cfbea737c6b"),
    "earth_topo_260814.tf": ("fk/stations/earth_topo_260814.tf",
                             "4f40cd1e86718047bc8ea6ff6bd063c9fbf36102b63f0dca370c8e94fd282490"),
}

# PGDA LOLA south pole DEMs (Barker et al. 2023), cloud-optimized GeoTIFF, heights in m above R = 1737.4 km.
DEM_PRODUCTS = {
    "20mpp": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF",
    "40mpp": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_40MPP_ADJ.TIF",
    "80mpp": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF",
    "240mpp": "https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_60S_240MPP_ADJ.TIF",
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url, path, digest):
    """Download once (atomic rename), then verify the pinned SHA-256."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        tmp = path.with_suffix(path.suffix + ".part")
        with requests.get(url, stream=True, timeout=60) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        tmp.replace(path)
    got = sha256(path)
    if got != digest:
        raise RuntimeError(f"{path.name}: SHA-256 {got} != pinned {digest}; delete it and re-fetch, or update the pin in DATA.md")
    return path


def fetch_kernels():
    return [download(NAIF + rel, KERNEL_DIR / name, digest) for name, (rel, digest) in KERNELS.items()]


# Barker et al. 2021 5 m site products (PGDA product 78). SHA-256 pinned on first download.
PGDA5 = "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/"
SITE_FILES = {
    "Site01_final_adj_5mpp_surf.tif": ("Site01/Site01_final_adj_5mpp_surf.tif",
                                       "3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e"),
    "Site01_ROIs.tgz": ("Site01/Site01_ROIs.tgz", "40b961417a344ce0274aecbab522e171a22f658507d82e8fb4d7bc97526ffc4f"),
}


def fetch_site_file(name):
    rel, digest = SITE_FILES[name]
    return download(PGDA5 + rel, DEM_DIR / name, digest)


def read_site_dem(name):
    """Whole 5 m site LDEM as a layer-style dict (row 0 = north)."""
    import rasterio

    with rasterio.open(fetch_site_file(name)) as ds:
        dem = ds.read(1).astype(np.float32)
        x0, y0 = ds.transform * (0, 0)
        res = ds.res[0]
    if not np.isfinite(dem).all():
        raise ValueError(f"{name}: {np.count_nonzero(~np.isfinite(dem))} missing cells")
    return {"dem": dem, "x0_m": float(x0), "y0_m": float(y0), "res_m": float(res), "product": name}


def read_dem_window(product, cx_m, cy_m, half_m, allow_nan=False, cache=True):
    """Square DEM window centred on grid point (cx, cy), snapped to whole pixels. Cached as .npz.

    Reads a local full copy (DEM_DIR/<file>) when present, else HTTP range requests. Cells outside the product
    are NaN (boundless read); allow_nan=False rejects any NaN.
    Returns dict: dem (float32, row 0 = north/top, metres), x0_m/y0_m (top-left corner of the
    top-left pixel), res_m, product, url.
    """
    import rasterio
    from rasterio.windows import from_bounds

    DEM_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = DEM_DIR / f"{product}_{cx_m:.0f}_{cy_m:.0f}_{half_m:.0f}.npz"
    if cache and cache_path.exists():
        z = np.load(cache_path)
        return {k: (z[k] if k == "dem" else z[k].item()) for k in z.files}
    url = DEM_PRODUCTS[product]
    local = DEM_DIR / url.rsplit("/", 1)[1]
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with rasterio.open(local if local.exists() else "/vsicurl/" + url) as ds:
        win = from_bounds(cx_m - half_m, cy_m - half_m, cx_m + half_m, cy_m + half_m, ds.transform)
        win = win.round_offsets().round_lengths()
        dem = ds.read(1, window=win, boundless=True, fill_value=np.nan)
        x0, y0 = ds.transform * (win.col_off, win.row_off)
        res = ds.res[0]
    if not allow_nan and not np.isfinite(dem).all():
        raise ValueError(f"{product} window has {np.count_nonzero(~np.isfinite(dem))} missing cells")
    out = {"dem": dem.astype(np.float32), "x0_m": float(x0), "y0_m": float(y0), "res_m": float(res),
           "product": product, "url": url}
    if cache:
        np.savez_compressed(cache_path, **out)
    return out


def main():
    from .sites import CONNECTING_RIDGE_ROI4 as site

    for p in fetch_kernels():
        print(f"kernel ok  {p.name}")
    w = read_dem_window("20mpp", site["x_m"], site["y_m"], 5000)
    d = w["dem"]
    print(f"DEM 20mpp window {d.shape} at x0={w['x0_m']:.0f} y0={w['y0_m']:.0f}: "
          f"min {d.min():.1f} max {d.max():.1f} mean {d.mean():.1f} m")


if __name__ == "__main__":
    main()
