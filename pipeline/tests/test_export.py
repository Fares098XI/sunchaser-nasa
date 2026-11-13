import numpy as np

from sunchaser.export import EARTH_FROM_THREE, HORIZON_QUANTUM_DEG, encode_horizon, scene_from_me
from sunchaser.frames import enu_basis, grid_azimuth_deg


def test_scene_frame_matches_sky_direction():
    # A MOON_ME vector at local az/el must land where web skyDirection(az_grid, el) puts it.
    lat, lon = -89.45, 222.85
    e, n, u = enu_basis(lat, lon)
    m = scene_from_me(lat, lon)
    assert np.isclose(np.linalg.det(m), 1) and np.isclose(np.linalg.det(EARTH_FROM_THREE), 1)
    for az, el in [(0, 0), (37, 1.5), (250, -3)]:
        a, h = np.radians(az), np.radians(el)
        v = np.cos(h) * (np.sin(a) * e + np.cos(a) * n) + np.sin(h) * u
        ag = np.radians(grid_azimuth_deg(az, lon))
        sky = [np.sin(ag) * np.cos(h), np.sin(h), -np.cos(ag) * np.cos(h)]  # web/src/engine/sky.ts
        assert np.allclose(m @ v, sky, atol=1e-12)


def test_horizon_codec_round_trip():
    rng = np.random.default_rng(0)
    hz = rng.uniform(-8, 30, (12, 5, 7))
    blob, dec = encode_horizon(hz)
    assert len(blob) == hz.size * 2
    assert np.abs(dec - hz).max() <= HORIZON_QUANTUM_DEG / 2 + 1e-12
    # Independent decode: unshuffle, int16, cumulative sum along azimuth.
    b = np.frombuffer(blob, np.uint8).reshape(2, -1)
    d = (b[0].astype(np.int32) | (b[1].astype(np.int32) << 8)).astype(np.uint16).view(np.int16).reshape(hz.shape)
    assert np.array_equal(np.cumsum(d.astype(np.int32), axis=0) * HORIZON_QUANTUM_DEG, dec)
    # Values below 8 deg are exact in float16, so GPU and CPU see identical numbers there.
    small = dec[np.abs(dec) < 8]
    assert np.array_equal(small.astype(np.float16).astype(np.float64), small)
    # transposed (non-contiguous) input encodes identically to its contiguous copy
    t = hz.reshape(12, -1).T.T
    assert encode_horizon(np.asfortranarray(t))[0] == encode_horizon(np.ascontiguousarray(t))[0]
