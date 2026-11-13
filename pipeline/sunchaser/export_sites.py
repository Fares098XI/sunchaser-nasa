"""Web data for the site catalog: per-site horizons + 10-minute Sun/Earth tables, shared DSN mask, golden cases.

Run: python -m sunchaser.export_sites      (after select_sites and build_sites)
Layout and encodings: docs/METHODS.md §7. Writes web/public/data/sites/.
"""
import hashlib
import json
from datetime import datetime, timedelta

import numpy as np

from . import REPO_DIR
from .build_sites import DISPERSION_M, N_AZ, OUT_DIR, Z_M
from .dsn import MIN_ELEV_DEG, STATIONS, dsn_mask
from .ephem import az_el, utc_to_et
from .export import encode_horizon
from .frames import grid_azimuth_deg
from .sites import load_sites
from .visibility import SUN_RADIUS_M, disc_fraction, horizon_at
from .windows import EXAMPLE_POWER, battery, metrics

WEB_SITES = REPO_DIR / "web" / "public" / "data" / "sites"
GOLDEN = REPO_DIR / "web" / "src" / "engine" / "golden" / "v5_sites.json"
START, STOP, STEP_S = datetime(2026, 11, 1), datetime(2029, 1, 1), 600
EARTH_RADIUS_M = 6_371_008.8  # IUGG mean Earth radius
AZ_UNIT = 360 / 65536  # deg per uint16 step (~0.0055 deg)
EL_UNIT = 0.001
SUN_R0, SUN_R_UNIT = 0.25, 1e-6
EARTH_R0, EARTH_R_UNIT = 0.85, 1e-5


def times():
    n = int((STOP - START).total_seconds() // STEP_S)
    return [(START + timedelta(seconds=STEP_S * i)).isoformat() for i in range(n)]


def shuffle(a):
    """Little-endian 16-bit array -> all low bytes, then all high bytes."""
    return np.ascontiguousarray(a.astype("<u2").view(np.uint8).reshape(-1, 2).T).tobytes()


def delta_u16(a):
    """Delta along time, modulo 2^16 (azimuths wrap naturally; decode = cumulative sum mod 2^16)."""
    a = a.astype(np.int64)
    return (np.diff(a, prepend=0) % 65536).astype(np.uint16)


def quantize(az_g, el, r, r0, r_unit):
    q_az = np.round(np.asarray(az_g) / AZ_UNIT).astype(np.int64) % 65536
    q_el = np.round(np.asarray(el) / EL_UNIT).astype(np.int64)
    q_r = np.round((np.asarray(r) - r0) / r_unit).astype(np.int64)
    assert np.abs(q_el).max() < 32768 and 0 <= q_r.min() and q_r.max() < 65536
    return q_az, q_el, q_r


def export():
    WEB_SITES.mkdir(parents=True, exist_ok=True)
    ts = times()
    n = len(ts)
    ets = utc_to_et(ts)
    mask = dsn_mask(ts)
    (WEB_SITES / "dsn.bin").write_bytes(mask.tobytes())
    print(f"DSN mask: {n} steps, any station {np.mean(mask > 0):.1%}", flush=True)

    rng = np.random.default_rng(11)
    golden = {"cases": []}
    entries = []
    for site in load_sites():
        b = np.load(OUT_DIR / f"{site['id']}.npz")
        hz = b["horizon_deg"]  # (pts, z, az)
        n_pts, n_z, _ = hz.shape
        blob_h, hz_dec = encode_horizon(hz.reshape(n_pts * n_z, N_AZ).T)  # [az][pt*z]
        lon = site["lon_deg"]
        ground = float(b["ground_m"])
        cols = []
        tracks = {}
        for body, naif, r0, ru, radius in (("sun", "10", SUN_R0, SUN_R_UNIT, SUN_RADIUS_M),
                                           ("earth", "399", EARTH_R0, EARTH_R_UNIT, EARTH_RADIUS_M)):
            az, el, dist = az_el(naif, site["lat_deg"], lon, ground + 2.0, ts, ets)
            r = np.degrees(np.arcsin(radius / dist))
            q_az, q_el, q_r = quantize(grid_azimuth_deg(az, lon), el, r, r0, ru)
            cols += [delta_u16(q_az), delta_u16(q_el), delta_u16(q_r)]
            tracks[body] = (q_az * AZ_UNIT, q_el * EL_UNIT, r0 + q_r * ru)  # decoded values used for golden
        blob_e = b"".join(shuffle(c) for c in cols)
        name = f"{site['id']}.bin"
        blob = blob_h + blob_e
        (WEB_SITES / name).write_bytes(blob)

        # golden: random point/height/time, fractions from the decoded values (V5)
        hz3 = hz_dec.T.reshape(n_pts, n_z, N_AZ)
        for _ in range(40):
            p, k, i = int(rng.integers(n_pts)), int(rng.integers(n_z)), int(rng.integers(n))
            case = {"site": site["id"], "pt": p, "z": k, "i": i}
            for body in ("sun", "earth"):
                a, e, r = (v[i] for v in tracks[body])
                h = float(horizon_at(hz3[p, k], np.array([a]))[0])
                case[body] = {"az": float(a), "el": float(e), "r": float(r), "h": h, "frac": float(disc_fraction(e, h, r))}
            golden["cases"].append(case)

        # golden windows: full series at centre / z index 0, metrics over 3 random windows (V5, windows.ts)
        series = {b: disc_fraction(tracks[b][1], horizon_at(hz3[0, 0], tracks[b][0]), tracks[b][2]) for b in tracks}
        dte = ((series["earth"] >= 0.5) & (mask != 0)).astype(np.uint8)
        for days in (6, 14, 30):
            a = int(rng.integers(0, n - days * 144))
            b_ = a + days * 144
            low, empty_h, end = battery(series["sun"][a:b_], tracks["sun"][2][a:b_], STEP_S,
                                        *(EXAMPLE_POWER[k] for k in ("panel_m2", "efficiency", "load_w", "battery_wh")))
            golden.setdefault("windows", []).append({
                "site": site["id"], "a": a, "b": b_,
                **metrics(series["sun"][a:b_], series["earth"][a:b_], dte[a:b_], tracks["sun"][2][a:b_], STEP_S),
                "batteryMinPct": low, "batteryEmptyH": empty_h, "batteryEndPct": end, "power": EXAMPLE_POWER})
        sun_frac = disc_fraction(tracks["sun"][1], horizon_at(hz3[0, 1], tracks["sun"][0]), tracks["sun"][2])
        entries.append({**{k: site[k] for k in ("id", "name", "x_m", "y_m", "lat_deg", "lon_deg", "rule", "source", "dem5")},
                        **{k: site[k] for k in ("artemis_iii_region", "region", "sun_visibility", "earth_visibility",
                                                "slope_deg", "illum_product", "roi_area_m2") if k in site},
                        "ground_m": ground, "file": name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                        "layers": [str(s) for s in b["layers"]]})
        print(f"{site['id']:22s} {len(blob) / 1e6:5.2f} MB; Sun visible (centre, 2 m) {sun_frac.mean():.1%} of 2026-11..2028",
              flush=True)

    manifest = {
        "generated_utc": datetime.utcnow().replace(microsecond=0).isoformat(),
        "start_utc": START.isoformat(), "step_s": STEP_S, "n": n,
        "z_m": list(Z_M), "n_az": N_AZ, "dispersion_m": list(DISPERSION_M), "n_pts": 1 + 6 + 12,
        "horizon": {"encoding": "int16 steps of quantum_deg, delta along azimuth, byte-shuffled; layout [az][pt][z]",
                    "quantum_deg": 1 / 256},
        "tables": {"order": ["sun_az", "sun_el", "sun_r", "earth_az", "earth_el", "earth_r"],
                   "encoding": "uint16 each, delta along time mod 2^16, byte-shuffled, concatenated after the horizon block",
                   "az_unit_deg": AZ_UNIT, "el_unit_deg": EL_UNIT, "sun_r0_deg": SUN_R0, "sun_r_unit_deg": SUN_R_UNIT,
                   "earth_r0_deg": EARTH_R0, "earth_r_unit_deg": EARTH_R_UNIT,
                   "azimuth": "grid bearing at the site centre", "observer": "site centre, 2 m above ground"},
        "dsn": {"file": "dsn.bin", "stations": list(STATIONS), "names": list(STATIONS.values()), "min_elev_deg": MIN_ELEV_DEG,
                "encoding": "uint8 per step, bit k = station k sees the Moon >= min_elev_deg"},
        "earth_visible_rule": "Earth disc fraction >= 0.5 (centre above the terrain horizon)",
        "sites": entries,
    }
    (WEB_SITES / "manifest.json").write_text(json.dumps(manifest, indent=1))
    GOLDEN.write_text(json.dumps(golden))
    print(f"wrote {len(entries)} sites, manifest, {len(golden['cases'])} golden cases")


if __name__ == "__main__":
    export()
