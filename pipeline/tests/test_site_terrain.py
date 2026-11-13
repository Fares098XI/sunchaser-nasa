"""Landing slope and nearest-PSR helpers (docs/METHODS.md §15) on cases with known answers, and the shipped fields."""
import json

import numpy as np

from sunchaser.export import WEB_DATA
from sunchaser.site_terrain import nearest_psr, slope_deg


def test_slope_of_a_plane():
    res = 20.0
    y, x = np.mgrid[0:50, 0:50] * res
    dem = 0.1 * x  # 10 % grade -> atan(0.1) = 5.71 deg
    assert np.allclose(slope_deg(dem, res), np.degrees(np.arctan(0.1)), atol=1e-9)


def test_nearest_psr_brute_force():
    rng = np.random.default_rng(3)
    mask = rng.random((60, 60)) < 0.01
    x0, y0, res = -1200.0, 900.0, 40.0
    for _ in range(20):
        x, y = rng.uniform(-1200, 1200), rng.uniform(-1500, 900)
        d, b = nearest_psr(mask, x0, y0, res, x, y)
        rr, cc = np.nonzero(mask)
        ref = np.hypot(x0 + (cc + 0.5) * res - x, y0 - (rr + 0.5) * res - y).min()
        assert abs(d - ref) < 1e-9 and 0 <= b < 360
    assert nearest_psr(np.zeros((5, 5), bool), 0, 0, 1, 0, 0) is None


def test_every_site_has_terrain_fields():
    m = json.loads((WEB_DATA / "sites" / "manifest.json").read_text())
    for s in m["sites"]:
        if s.get("kind") == "atlas":  # atlas sites: global terrain only, no slope / PSR fields (METHODS §19)
            assert "terrain" not in s
            continue
        t = s["terrain"]
        sl = t["slope"]
        assert 0 <= sl["median_deg"] <= sl["p95_deg"] <= sl["max_deg"] < 45 and sl["cells"] > 50
        assert t["psr_km"] is None or 0 <= t["psr_km"] < 40
