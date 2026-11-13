import numpy as np
from pyproj import Transformer

from sunchaser.frames import (STEREO_SOUTH_PROJ4, enu_basis, grid_azimuth_deg, latlon_to_stereo,
                              stereo_to_latlon, surface_vector_m)

rng = np.random.default_rng(0)
LAT = rng.uniform(-90, -80, 200)
LON = rng.uniform(0, 360, 200)


def test_stereo_matches_pyproj_dem_crs():
    t = Transformer.from_crs("+proj=longlat +R=1737400 +no_defs", STEREO_SOUTH_PROJ4, always_xy=True)
    px, py = t.transform(LON, LAT)
    x, y = latlon_to_stereo(LAT, LON)
    assert np.abs(x - px).max() < 1e-6 and np.abs(y - py).max() < 1e-6


def test_stereo_round_trip():
    lat, lon = stereo_to_latlon(*latlon_to_stereo(LAT, LON))
    assert np.abs(lat - LAT).max() < 1e-9
    assert np.abs((lon - LON + 180) % 360 - 180).max() < 1e-9


def test_enu_is_orthonormal_right_handed():
    e, n, u = enu_basis(-89.4, 222.9)
    assert np.allclose([e @ e, n @ n, u @ u], 1) and np.allclose([e @ n, e @ u, n @ u], 0)
    assert np.allclose(np.cross(e, n), u)


def test_grid_azimuth_by_finite_steps():
    # Step 1 m toward local azimuth a; the grid bearing of the step must equal grid_azimuth_deg(a, lon).
    lat, lon, h = -89.3, 137.0, 0.0
    e, n, u = enu_basis(lat, lon)
    p0 = surface_vector_m(lat, lon, h)
    x0, y0 = latlon_to_stereo(lat, lon)
    for a in (0, 37, 90, 200, 315):
        p = p0 + 1.0 * (np.sin(np.radians(a)) * e + np.cos(np.radians(a)) * n)
        lat1 = np.degrees(np.arcsin(p[2] / np.linalg.norm(p)))
        lon1 = np.degrees(np.arctan2(p[1], p[0]))
        x1, y1 = latlon_to_stereo(lat1, lon1)
        bearing = np.degrees(np.arctan2(x1 - x0, y1 - y0)) % 360
        assert abs((bearing - grid_azimuth_deg(a, lon) + 180) % 360 - 180) < 1e-3
