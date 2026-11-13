"""V1b: Moon elevation at DSS-14/43/63 vs JPL Horizons (criterion in docs/VALIDATION.md)."""
import re

import numpy as np
import pytest

from sunchaser.dsn import MIN_ELEV_DEG, STATIONS, moon_elevation_deg
from sunchaser.horizons import REF_DIR


@pytest.mark.parametrize("station", list(STATIONS))
def test_v1b(station):
    path = REF_DIR / f"horizons_moon_from_{station}_2027.csv"
    if not path.exists():
        pytest.skip("Horizons reference not fetched yet (python -m sunchaser.horizons)")
    data = np.genfromtxt(path, delimiter=",", skip_header=2, dtype=None, encoding="utf-8")
    t = [r[0] for r in data]
    ref = np.array([r[2] for r in data])
    assert len(t) == 8760
    el = moon_elevation_deg(station, t)
    d = np.abs(el - ref)
    near = (np.abs(el - MIN_ELEV_DEG) < 0.01) & (np.abs(ref - MIN_ELEV_DEG) < 0.01)
    flag_mismatch = ((el >= MIN_ELEV_DEG) != (ref >= MIN_ELEV_DEG)) & ~near
    print(f"\nV1b {station}: max |d_el| {d.max():.2e} deg, rms {np.sqrt((d**2).mean()):.2e}; "
          f"6-deg flag mismatches {int(flag_mismatch.sum())}; visible {np.mean(ref >= MIN_ELEV_DEG):.1%} of hours")
    assert d.max() < 0.01
    assert not flag_mismatch.any()
