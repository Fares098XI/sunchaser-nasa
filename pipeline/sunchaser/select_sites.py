"""Select the site catalog by rule D-SITE (docs/DATA.md) and write sunchaser/sites.json.

Run: python -m sunchaser.select_sites
"""
import hashlib
import io
import json
import os
import tarfile

import numpy as np
import requests

from .fetch import DEM_DIR, PGDA5, read_dem_window
from .frames import stereo_to_latlon
from .sites import SITES_JSON

ILLUM = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/"
ILLUM_SCALE = 0.00004  # PDS label: AVERAGE_VISIBILITY = DN * 0.00004 (DN 25000 = 1)
ILLUM_85S_HALF_M = 151_740.0
INSET_M = 1_000.0
MAX_SLOPE_DEG = 10.0  # rule parameter (keeps the chosen pixel landable), not a physical constant

BARKER_RULE = "centroid of the largest RoI (by 5 m pixel count) in PGDA's {site} RoI shapefile (Barker et al. 2021)"
BARKER_SOURCE = "Barker et al. 2021, Planet. Space Sci. 203:105119; PGDA product 78 ({site}_ROIs.tgz)"
BARKER_SITES = [
    ("connecting-ridge", "Connecting Ridge", "Site01"),
    ("shackleton-rim", "Shackleton Rim", "Site04"),
    ("peak-near-shackleton", "Peak near Shackleton", "Site07"),
    ("de-gerlache-rim", "de Gerlache Rim", "Site11"),
]
ILLUM_RULE = ("highest PGDA average solar visibility ({product}) inside the PGDA 5 m {site} footprint inset 1 km, "
              "mean slope <= 10 deg over the pixel (20 m DEM); ties: higher Earth visibility")
ILLUM_SOURCE = "Mazarico et al. 2011, Icarus 211:1066; PGDA product 69 ({product}); PGDA product 78 ({site} footprint)"
ARTEMIS_5M = [  # NASA Artemis III candidate regions (Oct 2024) that have a PGDA 5 m site DEM
    ("malapert-massif", "Malapert Massif", "Site23"),
    ("nobile-rim-1", "Nobile Rim 1", "Site06"),
    ("nobile-rim-2", "Nobile Rim 2", "DM2"),
    ("haworth", "Haworth", "Haworth"),
]
LROC_SITES = [
    ("im2-athena", "IM-2 Athena (landed)", -84.7906, 29.1957,
     "LROC, 'IM-2 Athena Seen Obliquely', https://lroc.im-ldi.com/images/1408 (NASA/GSFC/ASU)",
     "published resting point of Intuitive Machines' Athena lander (on its side in a ~20 m crater)"),
    ("im2-target", "IM-2 target", -84.78, 29.13,
     "LROC, 'IM-2 Landing Region', https://lroc.im-ldi.com/images/1401 (NASA/GSFC/ASU)",
     "published intended landing site (2 decimals: +-0.005 deg, ~150 m in latitude)"),
]


def _get(url):
    """Small PGDA file, cached in DEM_DIR; retries throttling (403/429) with backoff."""
    import time

    path = DEM_DIR / url.rsplit("/", 1)[1]
    if path.exists():
        return path.read_bytes()
    for attempt in range(8):
        r = requests.get(url, timeout=120)
        if r.status_code not in (403, 429, 503):
            break
        time.sleep(5 * (attempt + 1))
    r.raise_for_status()
    if r.headers.get("content-type", "").startswith("text/html"):
        raise FileNotFoundError(url)  # PGDA answers 200 with an HTML page for missing files
    DEM_DIR.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    return r.content


def largest_roi(site):
    import shapefile
    from .validate_v2 import roi_pixels

    blob = _get(f"{PGDA5}{site}/{site}_ROIs.tgz")
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        files = {m.name.rsplit(".", 1)[1]: io.BytesIO(tar.extractfile(m).read())
                 for m in tar.getmembers() if m.isfile() and m.name.rsplit(".", 1)[-1] in ("shp", "shx", "dbf")}
    recs = shapefile.Reader(**files).shapeRecords()
    counts = [roi_pixels(np.array(r.shape.points))[0].size for r in recs]
    k = int(np.argmax(counts))
    x, y = (float(v) for v in recs[k].record)
    return x, y, {"roi_index": k + 1, "roi_pixels": counts[k], "roi_area_m2": counts[k] * 25.0, "n_rois": len(recs),
                  "rois_sha256": hashlib.sha256(blob).hexdigest()}


def site_footprint(site):
    import rasterio

    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with rasterio.open(f"/vsicurl/{PGDA5}{site}/{site}_final_adj_5mpp_surf.tif") as ds:
        if ds.crs is None or abs(ds.res[0] - 5.0) > 1e-6:  # guard against an unreadable/ungeoreferenced file
            raise ValueError(f"{site}: 5 m DEM has no georeferencing")
        return ds.bounds


def read_illum(name, b):
    import rasterio
    from rasterio.windows import from_bounds

    with rasterio.open("/vsicurl/" + ILLUM + name) as ds:
        win = from_bounds(b[0], b[1], b[2], b[3], ds.transform).round_offsets().round_lengths()
        a = ds.read(1, window=win).astype(np.float64)
        x0, y0 = ds.transform * (win.col_off, win.row_off)
        res = ds.res[0]
    a[a == -32768] = np.nan
    return a * ILLUM_SCALE, x0, y0, res


def brightest_pixel(site):
    b = site_footprint(site)
    bb = (b.left + INSET_M, b.bottom + INSET_M, b.right - INSET_M, b.top - INSET_M)
    inside_85 = max(abs(v) for v in bb) < ILLUM_85S_HALF_M
    sun_name = "AVGVISIB_85S_060M_201608.TIF" if inside_85 else "AVGVISIB_75S_120M_201608.TIF"
    sun, x0, y0, res = read_illum(sun_name, bb)
    earth = read_illum(sun_name.replace(".TIF", "_EARTH.TIF"), bb)[0]
    # mean slope over each illumination pixel from the 20 m DEM (20 m cells nest exactly in 60/120 m pixels)
    cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
    half = max(bb[2] - bb[0], bb[3] - bb[1]) / 2 + 2 * res
    w = read_dem_window("20mpp", cx, cy, half)
    gy, gx = np.gradient(w["dem"].astype(np.float64), w["res_m"])
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    k = int(round(res / w["res_m"]))
    r0 = int(round((w["y0_m"] - y0) / w["res_m"]))
    c0 = int(round((x0 - w["x0_m"]) / w["res_m"]))
    rows, cols = sun.shape
    sl = slope[r0:r0 + rows * k, c0:c0 + cols * k].reshape(rows, k, cols, k).mean(axis=(1, 3))
    ok = np.isfinite(sun) & (sl <= MAX_SLOPE_DEG)
    score = np.where(ok, sun * 1e6 + np.nan_to_num(earth), -np.inf)  # lexicographic: Sun, then Earth
    i, j = np.unravel_index(int(np.argmax(score)), score.shape)
    x, y = x0 + (j + 0.5) * res, y0 - (i + 0.5) * res
    return x, y, {"illum_product": sun_name, "sun_visibility": round(float(sun[i, j]), 4),
                  "earth_visibility": round(float(earth[i, j]), 4), "slope_deg": round(float(sl[i, j]), 2),
                  "candidates": int(ok.sum())}


def entry(id_, name, x, y, rule, source, dem5=None, **extra):
    lat, lon = (float(v) for v in stereo_to_latlon(x, y))
    return {"id": id_, "name": name, "x_m": round(x, 2), "y_m": round(y, 2), "lat_deg": round(lat, 6),
            "lon_deg": round(lon, 6), "rule": rule, "source": source, "dem5": dem5, **extra}


def main():
    from .frames import latlon_to_stereo

    sites = []
    for id_, name, site in BARKER_SITES:
        x, y, extra = largest_roi(site)
        try:
            site_footprint(site)
            dem5 = site
        except ValueError:  # no usable 5 m DEM: the 20 m layer becomes the near field
            dem5 = None
        sites.append(entry(id_, name, x, y, BARKER_RULE.format(site=site), BARKER_SOURCE.format(site=site), dem5, **extra))
        print(sites[-1], flush=True)
    for id_, name, site in ARTEMIS_5M:
        x, y, extra = brightest_pixel(site)
        sites.append(entry(id_, name, x, y, ILLUM_RULE.format(product=extra["illum_product"], site=site),
                           ILLUM_SOURCE.format(product=extra["illum_product"], site=site), site,
                           artemis_iii_region=True, **extra))
        print(sites[-1], flush=True)
    for id_, name, lat, lon, source, rule in LROC_SITES:
        x, y = (float(v) for v in latlon_to_stereo(lat, lon))
        sites.append(entry(id_, name, x, y, rule, source, None, region="Mons Mouton"))
        print(sites[-1], flush=True)
    cr = sites[0]
    assert (cr["x_m"], cr["y_m"]) == (-11287.5, -12167.5), "rule must reproduce Barker's RoI 4 for Connecting Ridge"
    SITES_JSON.write_text(json.dumps(sites, indent=1))
    print(f"wrote {SITES_JSON.name}: {len(sites)} sites")


if __name__ == "__main__":
    main()
