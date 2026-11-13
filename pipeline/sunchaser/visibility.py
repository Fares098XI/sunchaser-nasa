"""Visible solar-disc fraction over a terrain horizon (docs/METHODS.md §3). Twin: web/src/engine/sky.ts."""
import numpy as np

SUN_RADIUS_M = 695_700_000.0  # IAU 2015 nominal solar radius
AU_M = 149_597_870_700.0
SUN_RADIUS_1AU_DEG = float(np.degrees(np.arcsin(SUN_RADIUS_M / AU_M)))


def sun_radius_deg(dist_m):
    return np.degrees(np.arcsin(SUN_RADIUS_M / np.asarray(dist_m, dtype=float)))


def disc_fraction(elev_deg, horizon_deg, radius_deg=SUN_RADIUS_1AU_DEG):
    """f = 1 - (acos d - d sqrt(1 - d^2)) / pi, d = (elev - horizon) / r clamped to [-1, 1]."""
    d = np.clip((np.asarray(elev_deg) - np.asarray(horizon_deg)) / radius_deg, -1.0, 1.0)
    return 1.0 - (np.arccos(d) - d * np.sqrt(1.0 - d * d)) / np.pi


def horizon_at(horizon_deg, az_grid_deg):
    """Linear interpolation of horizon (n_az, ...) at grid azimuth(s), periodic in azimuth.

    az_grid_deg broadcasts against the trailing dims (one azimuth per time step: shape (T,) with horizon (n_az,)
    gives (T,); with horizon (n_az, N) gives (T, N)).
    """
    n_az = horizon_deg.shape[0]
    u = (np.asarray(az_grid_deg) % 360.0) * n_az / 360.0
    i = np.floor(u).astype(int) % n_az
    f = u - np.floor(u)
    if horizon_deg.ndim > 1:
        f = f[..., None]
    return horizon_deg[i] * (1 - f) + horizon_deg[(i + 1) % n_az] * f
