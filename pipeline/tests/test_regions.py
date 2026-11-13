"""V5d (a): Sun/Earth directions derived from the shipped hero tracks match SPICE at every built site region."""
import json

import numpy as np
import pytest
from scipy.spatial.transform import Rotation

from sunchaser.export import WEB_DATA
from sunchaser.export_regions import OUT, derive, frame, rotate_quats
from sunchaser.export_tracks import compute, hours
from test_tracks import M, decode

REGIONS = sorted(p.name for p in OUT.glob("*/manifest.json") and OUT.iterdir() if (p / "manifest.json").exists()) \
    if OUT.exists() else []
RNG = np.random.default_rng(5)
HOURS = np.sort(RNG.integers(0, M["tracks"]["n"], 200))


def sep_deg(az1, el1, az2, el2):
    a1, e1, a2, e2 = (np.radians(v) for v in (az1, el1, az2, el2))
    c = np.sin(e1) * np.sin(e2) + np.cos(e1) * np.cos(e2) * np.cos(a1 - a2)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


@pytest.fixture(scope="module")
def hero():
    years = {y["year"]: decode(y["year"]) for y in M["tracks"]["years"]}
    allc = [np.concatenate([years[y["year"]][c] for y in M["tracks"]["years"]]) for c in range(14)]
    return [c[HOURS] for c in allc]


@pytest.mark.skipif(not REGIONS, reason="no site regions built (python -m sunchaser.export_regions)")
@pytest.mark.parametrize("rid", REGIONS)
def test_v5d_derived_matches_spice(hero, rid):
    m = json.loads((OUT / rid / "manifest.json").read_text())
    r = m["region"]
    t_all = hours(2020, 2046)
    ref = compute(r["center_lat_deg"], r["center_lon_deg"], r["center_h_m"], [t_all[i] for i in HOURS])
    src, dst = frame(M), frame(m)
    for iaz, iel, idist in ((0, 1, 2), (3, 4, 5)):
        az, el, _ = derive(hero[iaz], hero[iel], hero[idist], src, dst)
        err = sep_deg(az, el, ref[iaz], ref[iel])
        print(f"V5d {rid} {'sun' if iaz == 0 else 'earth'}: max sep {err.max():.2e} deg")
        assert err.max() < 1e-3, (rid, iaz, err.max())
    for g in (slice(6, 10), slice(10, 14)):  # orientations: rotation angle between derived and direct
        q = rotate_quats(np.stack(hero[g], -1), src, dst)
        ang = (Rotation.from_quat(q).inv() * Rotation.from_quat(np.stack(ref[g], -1))).magnitude()
        print(f"V5d {rid} {'earth_q' if g.start == 6 else 'sky_q'}: max {np.degrees(ang).max():.2e} deg")
        assert np.degrees(ang).max() < 1e-3, (rid, g, np.degrees(ang).max())


def test_derive_identity():
    """Deriving the hero region onto itself returns the input (frame shift of zero)."""
    src = frame(M)
    az, el, d = derive(np.array([10.0, 250.0]), np.array([1.5, -3.0]), np.array([1.5e8, 3.9e5]), src, src)
    assert np.allclose(az, [10, 250]) and np.allclose(el, [1.5, -3]) and np.allclose(d, [1.5e8, 3.9e5])


def test_index_lists_built_regions():
    idx = json.loads((OUT / "index.json").read_text())
    ids = [r["id"] for r in idx["regions"]]
    assert "connecting-ridge" in ids
    assert set(REGIONS) <= set(ids)
    assert all((WEB_DATA / r["base"].removeprefix("/data/") / "manifest.json").exists() for r in idx["regions"])
