"""Lunar surface geometry in MOON_ME and the LOLA south polar stereographic grid.

Conventions (docs/METHODS.md §1):
- Heights are relative to the LOLA reference sphere R = 1737.4 km.
- Grid x/y follow the PGDA DEM CRS: +proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400,
  so x = rho sin(lon), y = rho cos(lon), rho = 2R tan(pi/4 + lat/2).
- Azimuth is measured clockwise from local north (toward east), like JPL Horizons.
"""
import numpy as np

R_MOON_M = 1737400.0  # LOLA reference sphere radius (CRS of LDEM_80S_20MPP_ADJ.TIF)
STEREO_SOUTH_PROJ4 = "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs"


def latlon_to_stereo(lat_deg, lon_deg):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    rho = 2 * R_MOON_M * np.tan(np.pi / 4 + lat / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def stereo_to_latlon(x_m, y_m):
    rho = np.hypot(x_m, y_m)
    lat = 2 * np.arctan(rho / (2 * R_MOON_M)) - np.pi / 2
    lon = np.arctan2(x_m, y_m)
    return np.degrees(lat), np.degrees(lon) % 360


def surface_vector_m(lat_deg, lon_deg, h_m):
    """Body-fixed (MOON_ME) position of a surface point, metres."""
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    r = R_MOON_M + np.asarray(h_m, dtype=float)
    return np.stack([r * np.cos(lat) * np.cos(lon), r * np.cos(lat) * np.sin(lon), r * np.sin(lat)], -1)


def enu_basis(lat_deg, lon_deg):
    """Local east, north, up unit vectors (MOON_ME) for a point on the sphere."""
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    east = np.array([-np.sin(lon), np.cos(lon), 0.0])
    north = np.array([-np.sin(lat) * np.cos(lon), -np.sin(lat) * np.sin(lon), np.cos(lat)])
    up = np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
    return east, north, up


def grid_azimuth_deg(az_deg, lon_deg):
    """Local azimuth -> azimuth clockwise from grid +y. Local north points along grid bearing = lon."""
    return (np.asarray(az_deg) + np.asarray(lon_deg)) % 360
