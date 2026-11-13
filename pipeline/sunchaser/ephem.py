"""Topocentric Sun/Earth azimuth and elevation from a lunar surface point (SPICE).

Method (docs/METHODS.md §2): spkcpo with the observer fixed in MOON_ME, aberration 'CN+S'
(converged light time + stellar aberration), then rotate into the local east/north/up frame.
MOON_ME in moon_de440_250416.tf aliases MOON_ME_DE440_ME421, aligned with the LOLA DEM frame.
"""
from datetime import datetime

import numpy as np
import spiceypy as spice

from .fetch import fetch_kernels
from .frames import enu_basis, surface_vector_m

_loaded = False


def load_kernels():
    global _loaded
    if not _loaded:
        for p in fetch_kernels():
            spice.furnsh(str(p))
        _loaded = True


def utc_to_et(t_utc):
    load_kernels()
    return np.array([spice.str2et(t.isoformat() if isinstance(t, datetime) else str(t)) for t in t_utc])


def az_el(target, lat_deg, lon_deg, h_m, t_utc, ets=None):
    """Apparent azimuth (deg from north toward east), elevation (deg) and distance (m) of `target`.
    Pass `ets` (from utc_to_et) to skip re-parsing the same times."""
    load_kernels()
    obs_km = surface_vector_m(lat_deg, lon_deg, h_m) / 1000.0
    east, north, up = enu_basis(lat_deg, lon_deg)
    ets = utc_to_et(t_utc) if ets is None else ets
    vec = np.empty((len(ets), 3))
    for i, et in enumerate(ets):
        state, _ = spice.spkcpo(target, et, "MOON_ME", "OBSERVER", "CN+S", obs_km, "MOON", "MOON_ME")
        vec[i] = state[:3]
    dist = np.linalg.norm(vec, axis=1)
    e, n, u = vec @ east, vec @ north, vec @ up
    az_deg = np.degrees(np.arctan2(e, n)) % 360
    elev_deg = np.degrees(np.arcsin(u / dist))
    return az_deg, elev_deg, dist * 1000.0
