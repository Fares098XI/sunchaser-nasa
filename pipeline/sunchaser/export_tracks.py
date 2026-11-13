"""Hourly Sun/Earth tracks and sky orientation, 2020-2045, for Explore (docs/METHODS.md §10).

One file per year, web/public/data/tracks/<region>_<year>.bin, and the index in manifest.json "tracks".
Each channel is quantised to integers, second-differenced (int32) and all channels byte-shuffled (byte planes);
the first value and first difference of every channel are in the index. Decoder: web/src/engine/tracks.ts.
Run after sunchaser.export: python -m sunchaser.export_tracks
"""
import hashlib
import json
from datetime import datetime, timedelta

import numpy as np

from .export import WEB_DATA, earth_orientation, scene_from_me
from .frames import grid_azimuth_deg

START_YEAR, STOP_YEAR = 2020, 2046  # [2020-01-01, 2046-01-01)
CHANNELS = [  # (name, quantum); azimuths are unwrapped within each year before quantising
    ("sun_az_grid_deg", 1e-6), ("sun_elev_deg", 1e-6), ("sun_dist_km", 0.1),
    ("earth_az_grid_deg", 1e-6), ("earth_elev_deg", 1e-6), ("earth_dist_km", 0.1),
    ("earth_qx", 1e-7), ("earth_qy", 1e-7), ("earth_qz", 1e-7), ("earth_qw", 1e-7),
    ("sky_qx", 1e-7), ("sky_qy", 1e-7), ("sky_qz", 1e-7), ("sky_qw", 1e-7),
]
AZ_CHANNELS = (0, 3)


def hours(year0, year1):
    t0, t1 = datetime(year0, 1, 1), datetime(year1, 1, 1)
    return [(t0 + timedelta(hours=i)).isoformat() for i in range(int((t1 - t0).total_seconds() // 3600))]


def continuous(q):
    """Flip quaternion signs so consecutive samples lie in the same hemisphere (slerp takes the short way)."""
    q = q.copy()
    for i in range(1, len(q)):
        if q[i] @ q[i - 1] < 0:
            q[i] = -q[i]
    return q


def sky_orientation(lat_deg, lon_deg, ets):
    """Quaternion [x, y, z, w] rotating J2000 (ICRF) directions into scene axes at the site, per time."""
    import spiceypy as spice
    from scipy.spatial.transform import Rotation

    m = scene_from_me(lat_deg, lon_deg)
    return Rotation.from_matrix(np.array([m @ spice.pxform("J2000", "MOON_ME", et) for et in ets])).as_quat()


def compute(lat, lon, h, times):
    """All channels as float64 arrays (azimuths in [0, 360), quaternions sign-continuous)."""
    from .ephem import az_el, utc_to_et

    ets = utc_to_et(times)
    cols = []
    for naif in ("10", "399"):
        az, el, dist = az_el(naif, lat, lon, h, times, ets=ets)
        cols += [grid_azimuth_deg(az, lon), el, dist / 1000]
    cols += list(continuous(np.array(earth_orientation(lat, lon, times, ets=ets))).T)
    cols += list(continuous(sky_orientation(lat, lon, ets)).T)
    return cols


def unwrap_deg(az):
    d = (np.diff(az) + 180) % 360 - 180
    return np.concatenate([[az[0]], az[0] + np.cumsum(d)])


def encode(cols):
    """-> (blob, head [[k0, d1], ...], decoded channels). Decoded = exactly what tracks.ts reconstructs."""
    d2s, head, dec = [], [], []
    for c, ((name, q), v) in enumerate(zip(CHANNELS, cols)):
        v = unwrap_deg(v) if c in AZ_CHANNELS else v
        k = np.round(np.asarray(v, dtype=np.float64) / q).astype(np.int64)
        d1 = np.diff(k)
        d2 = np.diff(d1)
        if np.abs(d2).max() >= 2**31:
            raise ValueError(f"{name}: second difference outside int32")
        head.append([int(k[0]), int(d1[0])])
        d2s.append(d2.astype("<i4"))
        x = k * q
        dec.append(((x % 360) + 360) % 360 if c in AZ_CHANNELS else x)
    planes = np.ascontiguousarray(np.stack(d2s).view(np.uint8).reshape(-1, 4).T)
    return planes.tobytes(), head, dec


def export(manifest_path=WEB_DATA / "manifest.json"):
    m = json.loads(manifest_path.read_text())
    reg = m["region"]
    lat, lon, h = reg["center_lat_deg"], reg["center_lon_deg"], reg["center_h_m"]
    out = WEB_DATA / "tracks"
    out.mkdir(parents=True, exist_ok=True)
    years, first, decoded = [], 0, {}
    for year in range(START_YEAR, STOP_YEAR):
        times = hours(year, year + 1)
        blob, head, dec = encode(compute(lat, lon, h, times))
        name = f"tracks/{reg['id']}_{year}.bin"
        (WEB_DATA / name).write_bytes(blob)
        years.append({"year": year, "file": name, "first_hour": first, "n": len(times), "head": head,
                      "sha256": hashlib.sha256(blob).hexdigest()})
        decoded[year] = dec
        first += len(times)
        print(f"{year}: {len(times)} h, {len(blob) / 1e3:.0f} kB")
    m["tracks"] = {
        "start_utc": f"{START_YEAR}-01-01T00:00:00", "stop_utc": f"{STOP_YEAR}-01-01T00:00:00", "step_s": 3600,
        "n": first, "channels": [{"name": n, "quantum": q} for n, q in CHANNELS], "years": years,
        "encoding": "per channel: integer k = round(value / quantum) (azimuth unwrapped within the year), "
                    "int32-le second differences k[i]-2k[i-1]+k[i-2] for i >= 2, channels in order, byte planes "
                    "(all byte 0, then byte 1, 2, 3); head = [k0, k1 - k0] per channel; azimuth decoded mod 360",
        "frame": "azimuth clockwise from grid +y (stereographic north), elevation from local horizontal at region "
                 "centre; earth_q rotates a three.js sphere into Earth's true orientation in scene axes (IAU_EARTH); "
                 "sky_q rotates J2000 (ICRF) directions into scene axes",
        "method": "SPICE spkcpo MOON_ME CN+S (docs/METHODS.md §2, §10), validated V1, V1c",
    }
    m["scene_from_me"] = np.asarray(scene_from_me(lat, lon)).round(12).tolist()
    m["dsn_stations"] = dsn_stations()
    manifest_path.write_text(json.dumps(m, separators=(",", ":")))
    golden(m, decoded)


def dsn_stations():
    """The three DSN 70 m antennas, geodetic (WGS-84) from the pinned SPICE station kernel, for drawing on Earth."""
    from .dsn import MIN_ELEV_DEG, STATIONS
    from .horizons import dsn_station_geodetic

    out = []
    for sid, name in STATIONS.items():
        lat, lon, h = dsn_station_geodetic(sid)
        out.append({"id": sid, "name": name, "lat_deg": round(lat, 6), "lon_deg": round(lon, 6), "h_m": round(h, 1),
                    "min_elev_deg": MIN_ELEV_DEG, "source": "earthstns_itrf93_260814.bsp (docs/DATA.md)"})
    return out


def golden(m, decoded):
    """V5c golden: decoded values at random hours + period stats at an integer horizon cell."""
    from . import REPO_DIR
    from .export import WEB_DATA as WD
    from .visibility import disc_fraction, horizon_at

    hm = m["horizon"]
    hz = decode_horizon((WD / hm["file"]).read_bytes(), hm["n_az"], hm["rows"], hm["cols"], hm["quantum_deg"])
    years = m["tracks"]["years"]
    allc = [np.concatenate([decoded[y["year"]][c] for y in years]) for c in range(len(CHANNELS))]
    rng = np.random.default_rng(7)
    cases = [{"hour": int(i), "values": [float(c[i]) for c in allc]}
             for i in rng.integers(0, m["tracks"]["n"], 300)]
    row, col = hm["rows"] // 2, hm["cols"] // 2
    cell = hz[:, row, col]
    periods = []
    for start, n in [(rng.integers(0, 200000), 1 * 24), (8760 - 100, 30 * 24), (rng.integers(0, 200000), 7 * 24),
                     (rng.integers(0, 200000), 366 * 24), (m["tracks"]["n"] - 29 * 24, 29 * 24)]:
        s = slice(int(start), int(start) + n)
        stats = {}
        for body, (iaz, iel, idist), r_km in (("sun", (0, 1, 2), 695700.0), ("earth", (3, 4, 5), 6371.0088)):
            f = disc_fraction(allc[iel][s], horizon_at(cell, allc[iaz][s]),
                              np.degrees(np.arcsin(r_km / allc[idist][s])))
            stats[body] = {"mean_pct": float(100 * f.mean()), "any_pct": float(100 * (f > 0).mean()),
                           "longest_zero_h": longest_zero(f)}
        periods.append({"start": int(start), "hours": n, **stats})
    path = REPO_DIR / "web" / "src" / "engine" / "golden" / "v5_tracks.json"
    path.write_text(json.dumps({"row": row, "col": col, "cases": cases, "periods": periods}, indent=0))
    print(f"golden: {len(cases)} hours, {len(periods)} periods -> {path.name}")


def longest_zero(f):
    run = best = 0
    for v in f:
        run = 0 if v > 0 else run + 1
        best = max(best, run)
    return best


def decode_horizon(blob, n_az, rows, cols, quantum):
    """Inverse of export.encode_horizon (same arithmetic as engine/horizon.ts decodeHorizon)."""
    n = n_az * rows * cols
    b = np.frombuffer(blob, np.uint8)
    d = (b[:n].astype(np.int32) | (b[n:].astype(np.int32) << 8)).astype(np.uint16).view(np.int16)
    return np.cumsum(d.reshape(n_az, rows, cols).astype(np.int64), axis=0) * quantum


if __name__ == "__main__":
    export()
