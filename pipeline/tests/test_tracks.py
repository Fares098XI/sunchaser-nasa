"""V1c (part 2): shipped 2020-2045 track files decode to the SPICE values within half their quantum."""
import json

import numpy as np
import pytest

from sunchaser.export import WEB_DATA
from sunchaser.export_tracks import AZ_CHANNELS, CHANNELS, compute, hours

M = json.loads((WEB_DATA / "manifest.json").read_text())


def decode(year):
    """Python mirror of web/src/engine/tracks.ts decodeTrackYear."""
    y = next(y for y in M["tracks"]["years"] if y["year"] == year)
    n, c = y["n"], len(CHANNELS)
    b = np.frombuffer((WEB_DATA / y["file"]).read_bytes(), np.uint8)
    d2 = np.ascontiguousarray(b.reshape(4, -1).T).view("<i4").reshape(c, n - 2).astype(np.int64)
    out = []
    for ch, ((k0, d1), (_, q)) in enumerate(zip(y["head"], CHANNELS)):
        k = k0 + np.concatenate([[0], np.cumsum(d1 + np.concatenate([[0], np.cumsum(d2[ch])]))])
        x = k * q
        out.append(((x % 360) + 360) % 360 if ch in AZ_CHANNELS else x)
    return out


def test_layout():
    t = M["tracks"]
    assert [y["year"] for y in t["years"]] == list(range(2020, 2046))
    assert t["n"] == sum(y["n"] for y in t["years"]) == len(hours(2020, 2046))
    assert all(y["first_hour"] == sum(z["n"] for z in t["years"][:i]) for i, y in enumerate(t["years"]))


@pytest.mark.parametrize("year,first,n", [(2027, 0, 720), (2020, 8784 - 48, 48), (2045, 8760 - 48, 48)])
def test_decode_matches_spice(year, first, n):
    """January 2027 (the previous 720 h track) plus the ends of the range."""
    r = M["region"]
    times = hours(year, year + 1)[first:first + n]
    ref = compute(r["center_lat_deg"], r["center_lon_deg"], r["center_h_m"], times)
    dec = [d[first:first + n] for d in decode(year)]
    for ch, (name, q) in enumerate(CHANNELS):
        a, b = dec[ch], np.asarray(ref[ch])
        if ch in AZ_CHANNELS:
            err = np.abs((a - b + 180) % 360 - 180)
        elif ch >= 6:  # quaternions are compared up to sign (q and -q are the same rotation)
            g = slice(6, 10) if ch < 10 else slice(10, 14)
            sign = np.sign(np.sum(np.stack(dec[g]) * np.stack(ref[g]), axis=0))
            err = np.abs(a - b * sign)
        else:
            err = np.abs(a - b)
        assert err.max() <= q / 2 + 1e-12, (name, err.max())
