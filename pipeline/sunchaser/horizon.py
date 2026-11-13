"""Terrain horizons: highest elevation angle of the terrain in each grid azimuth (docs/METHODS.md §5).

Rays are marched outward from each observer along straight lines in the stereographic grid through
nested DEM layers (20 m near, 80 m mid, 240 m far, out to 300 km). Each sample is turned into an exact
body-fixed 3D point on the sphere (no flat-Earth or parabolic curvature approximation) and its elevation
angle is measured from the observer's local horizontal.
"""
import numpy as np
from numba import njit, prange

from .fetch import read_dem_window
from .frames import R_MOON_M

# (product, start distance, end distance) in metres from the observer. Widened after V4 run 1 failed with
# 12 km / 60 km boundaries (VALIDATION.md).
LAYERS = (("20mpp", 0.0, 25_000.0), ("80mpp", 25_000.0, 150_000.0), ("240mpp", 150_000.0, 300_000.0))


@njit(cache=True, inline="always")
def _point(x, y, h):
    """Grid (x, y) + height -> body-fixed position (m). Closed-form inverse stereographic, no trig."""
    t2 = (x * x + y * y) / (4.0 * R_MOON_M * R_MOON_M)
    f = (R_MOON_M + h) / (1.0 + t2)
    return f * y / R_MOON_M, f * x / R_MOON_M, -f * (1.0 - t2)


@njit(cache=True, inline="always")
def _bilinear(dem, x0, y0, res, x, y):
    """Bilinear height at grid (x, y); NaN outside. Pixel centres at x0 + (c + 0.5) res, y0 - (r + 0.5) res."""
    fc = (x - x0) / res - 0.5
    fr = (y0 - y) / res - 0.5
    c = int(np.floor(fc))
    r = int(np.floor(fr))
    if r < 0 or c < 0 or r >= dem.shape[0] - 1 or c >= dem.shape[1] - 1:
        return np.nan
    a = fc - c
    b = fr - r
    return (dem[r, c] * (1 - a) + dem[r, c + 1] * a) * (1 - b) + (dem[r + 1, c] * (1 - a) + dem[r + 1, c + 1] * a) * b


@njit(parallel=True, cache=True)
def _march(ox, oy, oh, sin_a, cos_a, dem, x0, y0, res, s0, s1, step_min, step_max, frac, best):
    """Update best[a, n] = max sin(elevation) over samples s0 < s <= s1.

    Step = clamp(frac * s, step_min, step_max): a height miss dh at distance s costs dh/s radians, so samples
    are dense near the observer and one per pixel far away.
    """
    n_obs = ox.shape[0]
    for n in prange(n_obs):
        px, py, pz = _point(ox[n], oy[n], oh[n])
        norm = np.sqrt(px * px + py * py + pz * pz)
        ux, uy, uz = px / norm, py / norm, pz / norm
        s_first = max(s0, step_min) if s0 > 0 else step_min
        for a in range(sin_a.shape[0]):
            b = best[a, n]
            s = s_first
            while s <= s1:
                x = ox[n] + s * sin_a[a]
                y = oy[n] + s * cos_a[a]
                h = _bilinear(dem, x0, y0, res, x, y)
                if h == h:  # not NaN
                    qx, qy, qz = _point(x, y, h)
                    vx, vy, vz = qx - px, qy - py, qz - pz
                    v = (vx * ux + vy * uy + vz * uz) / np.sqrt(vx * vx + vy * vy + vz * vz)
                    if v > b:
                        b = v
                s += min(max(frac * s, step_min), step_max)
            best[a, n] = b


@njit(cache=True, inline="always")
def _sin_elev(ox, oy, sa, ca, s, h, px, py, pz, ux, uy, uz):
    qx, qy, qz = _point(ox + s * sa, oy + s * ca, h)
    vx, vy, vz = qx - px, qy - py, qz - pz
    return (vx * ux + vy * uy + vz * uz) / np.sqrt(vx * vx + vy * vy + vz * vz)


@njit(cache=True, inline="always")
def _height(dem, x0, y0, res, fb, fx0, fy0, fres, x, y):
    """Height from this layer, or from the fallback (next coarser) layer where this one has no data.
    Returns (h, from_fallback)."""
    h = _bilinear(dem, x0, y0, res, x, y)
    if h == h:
        return h, False
    return _bilinear(fb, fx0, fy0, fres, x, y), True


@njit(parallel=True, cache=True)
def _march_dda(ox, oy, oh, sin_a, cos_a, dem, x0, y0, res, s0, s1, fb, fx0, fy0, fres, best):
    """Exact for the bilinear DEM surface. The ray is cut at every crossing with a grid line through pixel centres
    (fc = (x - x0)/res - 0.5 or fr = (y0 - y)/res - 0.5 integer). Inside each cell the height along the ray is a
    quadratic h(s) = A + B s + C s^2 (bilinear twist), fitted from the two crossings and the midpoint. With the
    curvature drop s^2/2R folded into C, tan(elevation) ~ (A - h_obs)/s + B + C s, so besides the crossings the
    only possible maximum is at s* = sqrt((A - h_obs)/C) when both are negative; it is evaluated if inside."""
    inv2r = 1.0 / (2.0 * R_MOON_M)
    n_obs = ox.shape[0]
    for n in prange(n_obs):
        px, py, pz = _point(ox[n], oy[n], oh[n])
        norm = np.sqrt(px * px + py * py + pz * pz)
        ux, uy, uz = px / norm, py / norm, pz / norm
        fc0 = (ox[n] - x0) / res - 0.5
        fr0 = (y0 - oy[n]) / res - 0.5
        for a in range(sin_a.shape[0]):
            b = best[a, n]
            sa = sin_a[a]
            ca = cos_a[a]
            sp = s0
            hp, fp = _height(dem, x0, y0, res, fb, fx0, fy0, fres, ox[n] + s0 * sa, oy[n] + s0 * ca)
            dc = sin_a[a] / res  # d(fc)/ds
            dr = -cos_a[a] / res  # d(fr)/ds
            # distance between successive crossings of each family, and the first crossing at s > s0
            if abs(dc) > 1e-12:
                tc = 1.0 / abs(dc)
                fc_s0 = fc0 + dc * s0
                kc = np.floor(fc_s0) + 1.0 if dc > 0 else np.ceil(fc_s0) - 1.0
                sc = s0 + (kc - fc_s0) / dc
            else:
                tc = 1e30
                sc = 1e30
            if abs(dr) > 1e-12:
                tr = 1.0 / abs(dr)
                fr_s0 = fr0 + dr * s0
                kr = np.floor(fr_s0) + 1.0 if dr > 0 else np.ceil(fr_s0) - 1.0
                sr = s0 + (kr - fr_s0) / dr
            else:
                tr = 1e30
                sr = 1e30
            if s0 > 0.0 and hp == hp:  # the layer's own surface at its start distance
                v = _sin_elev(ox[n], oy[n], sa, ca, s0, hp, px, py, pz, ux, uy, uz)
                if v > b:
                    b = v
            done = False
            while not done:
                if sc <= sr:
                    s = sc
                    sc += tc
                else:
                    s = sr
                    sr += tr
                if s >= s1:  # close the last partial cell exactly at the layer end
                    s = s1
                    done = True
                h, f = _height(dem, x0, y0, res, fb, fx0, fy0, fres, ox[n] + s * sa, oy[n] + s * ca)
                if h == h:
                    v = _sin_elev(ox[n], oy[n], sa, ca, s, h, px, py, pz, ux, uy, uz)
                    if v > b:
                        b = v
                    # in-cell maximum only when all three points lie on this layer's own surface
                    if hp == hp and not f and not fp and s - sp > 1e-9:
                        sm = 0.5 * (sp + s)
                        hm = _bilinear(dem, x0, y0, res, ox[n] + sm * sa, oy[n] + sm * ca)
                        if hm == hm:
                            ln = s - sp
                            c = 2.0 * (h - 2.0 * hm + hp) / (ln * ln)
                            bb = (h - hp) / ln - c * ln
                            a0 = hp - bb * sp + c * sp * sp - oh[n]  # intercept relative to the observer
                            cc = c - inv2r
                            if a0 < 0.0 and cc < 0.0:
                                st = np.sqrt(a0 / cc)
                                if sp < st < s:
                                    ht = hp + bb * (st - sp) + c * (st - sp) * (st - sp)
                                    v = _sin_elev(ox[n], oy[n], sa, ca, st, ht, px, py, pz, ux, uy, uz)
                                    if v > b:
                                        b = v
                sp = s
                hp = h
                fp = f
            best[a, n] = b


def azimuths_deg(n_az):
    return np.arange(n_az) * 360.0 / n_az


def compute(obs_x, obs_y, z_m, layers, n_az=180, frac=None, min_div=1, ground_m=None):
    """Horizon elevation (deg) for observers at grid points, z_m above the terrain. Returns (n_az, N) float64.

    layers: list of dicts with dem (2D, row 0 = north), x0_m, y0_m (top-left corner), res_m, s0_m, s1_m.
    Default: exact grid-line crossings (_march_dda). With frac given, fixed stepping for references/tests:
    step = clamp(frac * s, res_m / min_div, res_m); frac=0, min_div=k gives a uniform res_m / k step.
    The observer's ground height comes from the first layer unless ground_m gives it per observer.
    """
    ox = np.ascontiguousarray(obs_x, dtype=np.float64).ravel()
    oy = np.ascontiguousarray(obs_y, dtype=np.float64).ravel()
    l0 = layers[0]
    ground = (np.asarray(ground_m, dtype=np.float64).ravel() if ground_m is not None else
              np.array([_bilinear(l0["dem"], l0["x0_m"], l0["y0_m"], l0["res_m"], x, y) for x, y in zip(ox, oy)]))
    if not np.isfinite(ground).all():
        raise ValueError("observer outside the first DEM layer (or on missing data)")
    oh = ground + z_m
    az = np.radians(azimuths_deg(n_az))
    best = np.full((n_az, ox.size), -1.0)
    no_fb = np.full((2, 2), np.nan, dtype=np.float32)
    for i, L in enumerate(layers):
        dem = np.ascontiguousarray(L["dem"], dtype=np.float32)
        res = L["res_m"]
        if frac is None:
            F = layers[i + 1] if i + 1 < len(layers) else {"dem": no_fb, "x0_m": 0.0, "y0_m": 0.0, "res_m": 1.0}
            _march_dda(ox, oy, oh, np.sin(az), np.cos(az), dem, L["x0_m"], L["y0_m"], res, L["s0_m"], L["s1_m"],
                       np.ascontiguousarray(F["dem"], dtype=np.float32), F["x0_m"], F["y0_m"], F["res_m"], best)
        else:
            step_max = res if frac > 0 else res / min_div
            _march(ox, oy, oh, np.sin(az), np.cos(az), dem, L["x0_m"], L["y0_m"], res, L["s0_m"], L["s1_m"],
                   res / min_div, step_max, frac, best)
    return np.degrees(np.arcsin(best))


def coarsen(layer, k):
    """Block-average a layer by k x k (used by V4)."""
    d = layer["dem"]
    r, c = (d.shape[0] // k) * k, (d.shape[1] // k) * k
    out = d[:r, :c].reshape(r // k, k, c // k, k).mean(axis=(1, 3))
    return {**layer, "dem": out.astype(np.float32), "res_m": layer["res_m"] * k}


def load_layers(cx_m, cy_m, region_half_m, layers=LAYERS, allow_nan=False):
    """Real PGDA DEM windows covering every observer within region_half_m of (cx, cy) out to each layer's reach.
    allow_nan: cells beyond a product's coverage stay NaN and the march reads the next, wider layer there
    (as build_sites does for sites far from the pole)."""
    out = []
    for product, s0, s1 in layers:
        w = read_dem_window(product, cx_m, cy_m, region_half_m + s1 + 2 * 240.0, allow_nan=allow_nan)
        out.append({"dem": w["dem"], "x0_m": w["x0_m"], "y0_m": w["y0_m"], "res_m": w["res_m"], "s0_m": s0, "s1_m": s1,
                    "product": product})
    return out


def cell_centres(x0_m, y0_m, res_m, rows, cols):
    """Grid coordinates of cell centres, row 0 = north. Returns (X, Y) of shape (rows, cols)."""
    xs = x0_m + (np.arange(cols) + 0.5) * res_m
    ys = y0_m - (np.arange(rows) + 0.5) * res_m
    return np.meshgrid(xs, ys)
