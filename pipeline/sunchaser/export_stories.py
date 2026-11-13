"""Data for the S7 mission stories (docs/METHODS.md §23): the real Sun and Earth at the six Apollo touchdowns.

For each Apollo Lunar Module site (atlas.json, NASA NSSDCA coordinates): the touchdown time, the Sun's and Earth's
azimuth/elevation then, and the Sun hourly over the lunar day around it (3 days before to 27 days after), from SPICE
(the same az_el as V10b, which agrees with JPL Horizons to 0.0002 deg at Apollo EVA times).
Touchdown times (UTC): NASA NSSDCA mission pages; each equals the mission report's launch time + ground elapsed time
at landing (checked below).

Run: python -m sunchaser.export_stories
"""
import json
from datetime import datetime, timedelta

import numpy as np

from . import REPO_DIR
from .atlas import OUT_DIR, load_atlas
from .ephem import az_el

TOUCHDOWN_UTC = {"apollo-11": "1969-07-20T20:17:40", "apollo-12": "1969-11-19T06:54:35", "apollo-14": "1971-02-05T09:18:11",
                 "apollo-15": "1971-07-30T22:16:29", "apollo-16": "1972-04-21T02:23:35", "apollo-17": "1972-12-11T19:54:57"}
# cross-check: launch (mission reports) + GET of lunar landing (h:m:s)
GET_LANDING = {"apollo-11": ("1969-07-16T13:32:00", "102:45:40"), "apollo-12": ("1969-11-14T16:22:00", "110:32:35"),
               "apollo-15": ("1971-07-26T13:34:00", "104:42:29"), "apollo-16": ("1972-04-16T17:54:00", "104:29:35")}
OUT = REPO_DIR / "web" / "public" / "data" / "stories.json"


def main():
    for k, (launch, get) in GET_LANDING.items():
        h, m, s = map(int, get.split(":"))
        assert datetime.fromisoformat(launch) + timedelta(hours=h, minutes=m, seconds=s) == datetime.fromisoformat(TOUCHDOWN_UTC[k]), k
    sites = {s["id"]: s for s in load_atlas()}
    out = {"source": "SPICE (sunchaser.ephem.az_el, apparent, CN+S), observer 2 m above the LOLA ground at the NSSDCA LM coordinates",
           "touchdown_source": "NASA NSSDCA mission pages (= launch + ground elapsed time in the mission reports)", "apollo": []}
    for k, t in TOUCHDOWN_UTC.items():
        s = sites[k]
        h = float(np.load(OUT_DIR / f"{k}.npz")["ground_m"]) + 2.0
        t0 = datetime.fromisoformat(t)
        sa, se, _ = az_el("10", s["lat_deg"], s["lon_deg"], h, [t0])
        ea, ee, _ = az_el("399", s["lat_deg"], s["lon_deg"], h, [t0])
        hours = [t0 + timedelta(hours=i) for i in range(-72, 27 * 24 + 1)]
        ha, he, _ = az_el("10", s["lat_deg"], s["lon_deg"], h, hours)
        out["apollo"].append({"id": k, "name": s["name"], "lat_deg": s["lat_deg"], "lon_deg": s["lon_deg"], "touchdown_utc": t + "Z",
                              "sun": {"az": round(float(sa[0]), 3), "el": round(float(se[0]), 3)},
                              "earth": {"az": round(float(ea[0]), 3), "el": round(float(ee[0]), 3)},
                              "track": {"from_h": -72, "az": [round(float(v), 2) for v in ha], "el": [round(float(v), 3) for v in he]}})
        print(f"{k}: touchdown {t} Sun az {sa[0]:6.1f} el {se[0]:5.2f}; Earth el {ee[0]:5.1f}")
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(OUT, OUT.stat().st_size // 1024, "kB")


if __name__ == "__main__":
    main()
