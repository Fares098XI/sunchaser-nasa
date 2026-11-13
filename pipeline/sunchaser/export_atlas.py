"""Atlas sites into the web catalog (S4, docs/METHODS.md §19) and their checks (VALIDATION.md V9, V9b, V10, V10b).

Atlas site files carry horizons only. Their Sun/Earth tables are derived in the browser from the reference site's
shipped tables (`derive`, mirrored by web/src/engine/sites.ts deriveTables): the body's position seen from the
reference observer, re-expressed for the atlas observer. V9 checks the derived tables against SPICE computed directly
at each atlas site; the golden file pins browser == Python.

Run: python -m sunchaser.export_atlas      (after atlas; leaves the 10 catalog sites untouched)
"""
import hashlib
import json
from datetime import datetime, timedelta

import numpy as np

from .atlas import load_atlas
from .build_sites import N_AZ, OUT_DIR
from .ephem import az_el, utc_to_et
from .export import encode_horizon
from .export_sites import EARTH_RADIUS_M, WEB_SITES, times
from .frames import enu_basis, surface_vector_m
from .visibility import SUN_RADIUS_M

REF = "connecting-ridge"
GOLDEN = WEB_SITES.parent.parent.parent / "src" / "engine" / "golden" / "v5_atlas.json"
V9_EVERY = 36  # V9 compares every 6 h of 2026-11..2028 (3,168 times per site and body)
# LROC-published lander elevations (m) quoted on the same pages as the coordinates (atlas.json sources)
LROC_ELEV_M = {"change-3": -2630, "change-5": -2570, "change-6": -5256, "chandrayaan-3": 532, "slim": -912, "im-1": 2579}
# V10: ALSJ "Sun Angles" (B. W. Lawrence, rev. 2005; https://apollojournals.org/alsj//alsj-sunangles.html): EVA start/end
# in ground elapsed time (h) and Sun elevation (deg). Launch times (UTC) from the NASA mission reports; Apollo 14 and 17
# are left out because their mission clocks were updated in flight.
LAUNCH_UTC = {"apollo-11": "1969-07-16T13:32:00", "apollo-12": "1969-11-14T16:22:00", "apollo-15": "1971-07-26T13:34:00",
              "apollo-16": "1972-04-16T17:54:00"}
ALSJ_EVA = {"apollo-11": [(109.00, 14.0), (111.75, 15.4)],
            "apollo-12": [(115.25, 7.5), (119.25, 9.5), (131.50, 15.8), (135.50, 17.8)],
            "apollo-15": [(106.75, 13.0), (107.25, 13.3), (119.75, 19.6), (126.25, 22.9), (142.25, 31.0), (149.50, 34.7),
                          (163.25, 41.7), (168.25, 44.3)],
            "apollo-16": [(119.00, 22.2), (126.00, 25.7), (142.50, 34.1), (150.00, 37.9), (165.50, 45.8), (171.25, 48.7)]}


def decode_tables(blob, m):
    """Shipped site file -> decoded Sun/Earth tables, exactly as web/src/engine/sites.ts decodeSite."""
    hz_bytes = 2 * m["n_az"] * m["n_pts"] * len(m["z_m"])
    n, t = m["n"], m["tables"]

    def col(k):
        raw = np.frombuffer(blob, np.uint8, 2 * n, hz_bytes + k * 2 * n)
        d = (raw[:n].astype(np.uint32) | (raw[n:].astype(np.uint32) << 8)).astype(np.int64)
        return np.cumsum(d) % 65536

    def body(k, r0, ru):
        q_el = col(k + 1)
        return col(k) * t["az_unit_deg"], np.where(q_el >= 32768, q_el - 65536, q_el) * t["el_unit_deg"], r0 + col(k + 2) * ru

    return {"sun": body(0, t["sun_r0_deg"], t["sun_r_unit_deg"]), "earth": body(3, t["earth_r0_deg"], t["earth_r_unit_deg"])}


def derive(az_true, el, r, radius_m, ref, site):
    """Direction (true az, el, angular radius; deg) of a body from `site`, given it from `ref` (dicts: lat, lon, h_m)."""
    a, e = np.radians(az_true), np.radians(el)
    dist = radius_m / np.sin(np.radians(r))
    E0, N0, U0 = enu_basis(ref["lat"], ref["lon"])
    v = (np.outer(np.sin(a) * np.cos(e), E0) + np.outer(np.cos(a) * np.cos(e), N0) + np.outer(np.sin(e), U0)) * dist[:, None]
    w = v + surface_vector_m(ref["lat"], ref["lon"], ref["h_m"]) - surface_vector_m(site["lat"], site["lon"], site["h_m"])
    E1, N1, U1 = enu_basis(site["lat"], site["lon"])
    x, y, z = w @ E1, w @ N1, w @ U1
    d = np.sqrt(x * x + y * y + z * z)
    return np.degrees(np.arctan2(x, y)) % 360, np.degrees(np.arcsin(z / d)), np.degrees(np.arcsin(radius_m / d))


def ang_diff(a, b):
    return (np.asarray(a) - np.asarray(b) + 180) % 360 - 180


def export():
    m = json.loads((WEB_SITES / "manifest.json").read_text())
    ref_entry = next(s for s in m["sites"] if s["id"] == REF)
    ref = {"lat": ref_entry["lat_deg"], "lon": ref_entry["lon_deg"], "h_m": ref_entry["ground_m"] + 2.0}
    tab = decode_tables((WEB_SITES / ref_entry["file"]).read_bytes(), m)
    true_ref = {b: ((tab[b][0] - ref["lon"]) % 360, tab[b][1], tab[b][2]) for b in tab}  # grid bearing -> true azimuth
    ts = times()
    sub = np.arange(0, m["n"], V9_EVERY)
    ets = utc_to_et([ts[i] for i in sub])
    rng = np.random.default_rng(19)
    golden, v9, entries = {"ref": REF, "cases": []}, [], []
    radius = {"sun": SUN_RADIUS_M, "earth": EARTH_RADIUS_M}
    for s in load_atlas():
        b = np.load(OUT_DIR / f"{s['id']}.npz")
        hz = b["horizon_deg"]
        n_pts, n_z, _ = hz.shape
        blob, _ = encode_horizon(hz.reshape(n_pts * n_z, N_AZ).T)
        ground = float(b["ground_m"])
        site = {"lat": s["lat_deg"], "lon": s["lon_deg"], "h_m": ground + 2.0}
        worst = {}
        for body, naif in (("sun", "10"), ("earth", "399")):
            a, e, r = derive(*(x[sub] for x in true_ref[body]), radius[body], ref, site)
            sa, se, sd = az_el(naif, s["lat_deg"], s["lon_deg"], ground + 2.0, None, ets)
            sr = np.degrees(np.arcsin(radius[body] / sd))
            # azimuth error as an angle on the sky (azimuth differences shrink by cos(el))
            worst[body] = float(max(np.abs(ang_diff(a, sa) * np.cos(np.radians(se))).max(), np.abs(e - se).max(), np.abs(r - sr).max()))
            for i in rng.integers(0, m["n"], 6):
                da, de, dr = derive(*(np.array([x[i]]) for x in true_ref[body]), radius[body], ref, site)
                golden["cases"].append({"site": s["id"], "body": body, "i": int(i), "az": float(da[0]), "el": float(de[0]), "r": float(dr[0])})
        v9.append((s["id"], worst["sun"], worst["earth"]))
        name = f"{s['id']}.bin"
        (WEB_SITES / name).write_bytes(blob)
        entries.append({"id": s["id"], "name": s["name"], "lat_deg": s["lat_deg"], "lon_deg": s["lon_deg"], "x_m": None, "y_m": None,
                        "rule": "published landing coordinates (atlas)", "source": s["source"], "dem5": None, "kind": "atlas",
                        "tables": "derived", "azimuth": "true", **{k: s[k] for k in ("agency", "country", "landed_utc", "status", "group", "note")},
                        "ground_m": ground, "file": name, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest(),
                        "layers": [str(x) for x in b["layers"]]})
        print(f"{s['id']:16s} {len(blob) / 1e3:5.0f} kB  V9 worst: Sun {worst['sun']:.5f} deg, Earth {worst['earth']:.5f} deg", flush=True)

    m["sites"] = [x for x in m["sites"] if x.get("kind") != "atlas"] + entries
    m["atlas"] = {"reference_site": REF, "tables": "derived in the browser from the reference site (METHODS §19)",
                  "terrain": "LOLA LDEM_64 (474 m) to 30 km, LDEM_16 (1895 m) to 300 km, oblique stereographic grid"}
    (WEB_SITES / "manifest.json").write_text(json.dumps(m, indent=1))
    GOLDEN.write_text(json.dumps(golden))

    worst = max(max(w[1], w[2]) for w in v9)
    print(f"V9 derived vs direct SPICE, {len(v9)} sites x {len(sub)} times: worst {worst:.5f} deg -> {'PASS' if worst < 0.01 else 'FAIL'} (< 0.01)")
    d = {k: next(e for e in entries if e["id"] == k)["ground_m"] - v for k, v in LROC_ELEV_M.items()}
    print("V9b ground vs LROC elevation (m):", {k: round(v) for k, v in d.items()}, f"worst {max(abs(v) for v in d.values()):.0f} m")
    rows = []
    for k, evas in ALSJ_EVA.items():
        s = next(x for x in load_atlas() if x["id"] == k)
        t0 = datetime.fromisoformat(LAUNCH_UTC[k])
        tt = [(t0 + timedelta(hours=g)).isoformat() for g, _ in evas]
        _, el, _ = az_el("10", s["lat_deg"], s["lon_deg"], 2.0, tt)
        rows += [(k, g, v, float(x)) for (g, v), x in zip(evas, el)]
    worst8 = max(abs(r[3] - r[2]) for r in rows)
    for r in rows:
        print(f"  V10 {r[0]} GET {r[1]:6.2f} h: ALSJ {r[2]:5.1f} deg, Sunchaser {r[3]:6.2f} deg (diff {r[3] - r[2]:+.2f})")
    print(f"V10 Sun elevation vs ALSJ, {len(rows)} EVA times: worst {worst8:.2f} deg -> {'PASS' if worst8 <= 0.3 else 'FAIL'} (<= 0.3)")


def v10b():
    """V10b: our Sun elevation at the same Apollo EVA times vs JPL Horizons (network), every ALSJ time of V10."""
    from .horizons import fetch
    worst = 0.0
    for k, evas in ALSJ_EVA.items():
        s = next(x for x in load_atlas() if x["id"] == k)
        for g, _ in evas:
            t = datetime.fromisoformat(LAUNCH_UTC[k]) + timedelta(hours=g)
            _, _, hel, _ = fetch("10", s["lat_deg"], s["lon_deg"], 2.0, t.strftime("%Y-%m-%d %H:%M"),
                                 (t + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M"), step="1 m")
            _, el, _ = az_el("10", s["lat_deg"], s["lon_deg"], 2.0, [t.isoformat()])
            worst = max(worst, abs(float(el[0]) - float(hel[0])))
            print(f"  V10b {k} GET {g:6.2f}: Horizons {hel[0]:7.3f}  Sunchaser {float(el[0]):7.3f}")
    print(f"V10b Sun elevation vs JPL Horizons: worst {worst:.4f} deg -> {'PASS' if worst < 0.01 else 'FAIL'} (< 0.01)")


if __name__ == "__main__":
    import sys
    v10b() if "--v10b" in sys.argv else export()
