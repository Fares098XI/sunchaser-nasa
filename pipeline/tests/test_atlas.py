"""Atlas oblique grid (docs/METHODS.md §19): the site is the grid centre, grid +y is true north, +x is east."""
import numpy as np

from sunchaser.atlas import grid_to_latlon, load_atlas, rotation
from sunchaser.frames import R_MOON_M


def test_grid_centre_north_and_east():
    for lat, lon in ((0.67416, 23.47314), (-45.457, 177.589), (-80.13, 1.44), (44.1214, 340.4883)):
        rot = rotation(lat, lon)
        la, lo = grid_to_latlon(np.array(0.0), np.array(0.0), rot)
        assert abs(la - lat) < 1e-9 and abs(((lo - lon + 180) % 360) - 180) < 1e-9
        d = 1000.0  # 1 km north / east
        la_n, lo_n = grid_to_latlon(np.array(0.0), np.array(d), rot)
        assert abs((la_n - lat) - np.degrees(d / R_MOON_M)) < 1e-6 and abs(((lo_n - lon + 180) % 360) - 180) < 1e-6
        la_e, lo_e = grid_to_latlon(np.array(d), np.array(0.0), rot)
        # a great circle heading east drifts toward the equator by d^2 tan|lat| / (2 R^2)
        drift = np.degrees(d * d * np.tan(np.radians(abs(lat))) / (2 * R_MOON_M**2))
        assert abs(abs(la_e - lat) - drift) < 1e-7 and ((lo_e - lon) % 360) < 1  # a little east


def test_atlas_entries_are_sourced():
    for s in load_atlas():
        assert -90 <= s["lat_deg"] <= 90 and s["source"].count("http") >= 1 and s["status"] in ("landed", "planned")
