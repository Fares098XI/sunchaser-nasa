"""Deep Space Network visibility of the Moon (docs/METHODS.md §6).

A direct-to-Earth (DTE) link needs Earth above the lander's terrain horizon AND a DSN antenna that sees the Moon
at or above its 6 deg elevation motion limit (DSN 810-005, module 302 Rev. C, Table 1: 70 m antennas 6-89.5 deg).
Geometric only: no station terrain masks (module 301), scheduling or link budget.
"""
import numpy as np
import spiceypy as spice

from .ephem import load_kernels, utc_to_et

STATIONS = {"DSS-14": "Goldstone", "DSS-43": "Canberra", "DSS-63": "Madrid"}  # the three 70 m antennas
MIN_ELEV_DEG = 6.0


def moon_elevation_deg(station, t_utc):
    """Apparent elevation of the Moon's centre above the station's local horizontal (topocentric frame,
    +Z zenith; CN+S; no refraction)."""
    load_kernels()
    out = np.empty(len(t_utc))
    for i, et in enumerate(utc_to_et(t_utc)):
        v, _ = spice.spkpos("MOON", et, f"{station}_TOPO", "CN+S", station)
        out[i] = np.degrees(np.arcsin(v[2] / np.linalg.norm(v)))
    return out


def dsn_mask(t_utc):
    """Bit k set when station k (STATIONS order) sees the Moon >= MIN_ELEV_DEG."""
    mask = np.zeros(len(t_utc), dtype=np.uint8)
    for k, st in enumerate(STATIONS):
        mask |= (moon_elevation_deg(st, t_utc) >= MIN_ELEV_DEG).astype(np.uint8) << k
    return mask
