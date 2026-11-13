"""V1: Sun and Earth apparent az/el vs JPL Horizons (criterion in docs/VALIDATION.md)."""
import re

import numpy as np
import pytest

from sunchaser.ephem import az_el
from sunchaser.horizons import REF_DIR, V1_BODIES

PASS_DEG = 0.01


def load_ref(name, tag="2027"):
    path = REF_DIR / f"horizons_{name}_{tag}.csv"
    header = path.read_text().splitlines()[0]
    meta = dict(re.findall(r"\b(lon|lat|h_m) (-?[\d.]+)", header))
    data = np.genfromtxt(path, delimiter=",", skip_header=2, dtype=None, encoding="utf-8")
    t = [r[0] for r in data]
    return t, np.array([r[1] for r in data]), np.array([r[2] for r in data]), meta


def unit(az, el):
    az, el = np.radians(az), np.radians(el)
    return np.stack([np.cos(el) * np.sin(az), np.cos(el) * np.cos(az), np.sin(el)], -1)


@pytest.mark.parametrize("name", list(V1_BODIES))
def test_v1(name):
    t, ref_az, ref_el, meta = load_ref(name)
    assert len(t) == 8760
    az, el, _ = az_el(V1_BODIES[name], float(meta["lat"]), float(meta["lon"]), float(meta["h_m"]), t)
    sep = np.degrees(np.arccos(np.clip((unit(az, el) * unit(ref_az, ref_el)).sum(-1), -1, 1)))
    print(f"\nV1 {name}: n={len(t)} max sep {sep.max():.2e} deg, rms {np.sqrt((sep**2).mean()):.2e} deg, "
          f"max |d_el| {np.abs(el - ref_el).max():.2e} deg, elev range [{ref_el.min():.3f}, {ref_el.max():.3f}]")
    assert sep.max() < PASS_DEG


@pytest.mark.parametrize("name", list(V1_BODIES))
def test_v1c(name):
    """V1c: the same check over the whole Explore range 2020-2045, daily."""
    t, ref_az, ref_el, meta = load_ref(name, "2020_2045_daily")
    assert len(t) == 9497 and t[0] == "2020-01-01T00:00:00" and t[-1] == "2045-12-31T00:00:00"
    az, el, _ = az_el(V1_BODIES[name], float(meta["lat"]), float(meta["lon"]), float(meta["h_m"]), t)
    sep = np.degrees(np.arccos(np.clip((unit(az, el) * unit(ref_az, ref_el)).sum(-1), -1, 1)))
    print(f"\nV1c {name}: n={len(t)} max sep {sep.max():.2e} deg, rms {np.sqrt((sep**2).mean()):.2e} deg, "
          f"max |d_el| {np.abs(el - ref_el).max():.2e} deg, elev range [{ref_el.min():.3f}, {ref_el.max():.3f}]")
    assert sep.max() < PASS_DEG
