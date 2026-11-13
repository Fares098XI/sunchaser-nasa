import numpy as np

from sunchaser.frames import R_MOON_M, latlon_to_stereo, stereo_to_latlon, surface_vector_m
from sunchaser.horizon import compute

R = R_MOON_M


def flat_layer(half_m, res_m, s0, s1, cx=-11_000.0, cy=-12_000.0, height=0.0):
    n = int(2 * half_m / res_m)
    return {"dem": np.full((n, n), height, np.float32), "x0_m": cx - half_m, "y0_m": cy + half_m, "res_m": res_m,
            "s0_m": s0, "s1_m": s1}


def test_bare_sphere_dip_matches_geometry():
    # Observer 1737 m above a smooth sphere: true horizon dip = acos(R / (R + z)), tangent at ~78 km.
    z = 1737.0
    layers = [flat_layer(15_000, 20, 0, 12_000), flat_layer(65_000, 80, 12_000, 60_000), flat_layer(305_000, 240, 60_000, 300_000)]
    hz = compute(np.array([-11_000.0]), np.array([-12_000.0]), z, layers, n_az=36)
    dip = -np.degrees(np.arccos(R / (R + z)))
    assert np.abs(hz - dip).max() < 0.005, (hz.min(), hz.max(), dip)


def test_wall_elevation_is_exact_3d():
    # A 2 km tall square block 5 km grid-north of the observer; compare with an independent 3D calculation.
    L = flat_layer(15_000, 20, 0, 12_000)
    cx, cy = -11_000.0, -12_000.0
    d = L["dem"]
    r_wall = int(round((L["y0_m"] - (cy + 5_000)) / 20))
    d[r_wall - 2:r_wall + 3, 740:760] = 2_000.0
    hz = compute(np.array([cx]), np.array([cy]), 2.0, [L], n_az=360, frac=0.0)  # uniform 20 m steps
    # Independent: same 20 m sample points straight north, geometry via frames.py (bilinear ramps over one pixel).
    lat0, lon0 = stereo_to_latlon(cx, cy)
    p0 = surface_vector_m(lat0, lon0, 2.0)
    up = p0 / np.linalg.norm(p0)
    best = -1.0
    for s in np.arange(4_800, 5_200, 20.0):
        y = cy + s
        row = (L["y0_m"] - y) / 20 - 0.5
        frac = np.clip(np.interp(row, [r_wall - 3, r_wall - 2, r_wall + 2, r_wall + 3], [0, 1, 1, 0]), 0, 1)
        lat, lon = stereo_to_latlon(cx, y)
        q = surface_vector_m(lat, lon, 2_000.0 * frac)
        v = q - p0
        best = max(best, v @ up / np.linalg.norm(v))
    ref = np.degrees(np.arcsin(best))
    assert abs(hz[0, 0] - ref) < 1e-6, (hz[0, 0], ref)
    assert hz[0, 0] > 20  # ~21.8 deg: atan(2000 / 5000)
    assert hz[90, 0] < 0  # nothing to the grid east


def test_grid_walk_matches_dense_sampling_on_rough_terrain():
    # Lunar-like relief (random sinusoids, slopes up to ~32 deg): exact crossings == limit of denser sampling.
    rng = np.random.default_rng(3)
    L = flat_layer(4_000, 20, 0, 3_500)
    n = L["dem"].shape[0]
    yy, xx = np.mgrid[0:n, 0:n] * 20.0
    dem = np.zeros((n, n))
    for _ in range(12):
        k = rng.uniform(2 * np.pi / 800, 2 * np.pi / 150)
        th = rng.uniform(0, 2 * np.pi)
        dem += rng.uniform(5, 15) / (k * 150) * np.sin(k * (xx * np.cos(th) + yy * np.sin(th)) + rng.uniform(0, 6.3))
    L["dem"] = dem.astype(np.float32)
    ox = -11_000 + rng.uniform(-300, 300, 25)
    oy = -12_000 + rng.uniform(-300, 300, 25)
    exact = compute(ox, oy, 2.0, [L], n_az=72)
    dense = compute(ox, oy, 2.0, [L], n_az=72, frac=0.0, min_div=800)  # 2.5 cm steps
    coarse = compute(ox, oy, 2.0, [L], n_az=72, frac=0.0, min_div=1)
    assert np.abs(exact - dense).max() < 0.01
    assert np.abs(exact - coarse).max() > 50 * np.abs(exact - dense).max()


def test_ridge_at_layer_boundary_is_not_lost():
    # Regression (V4c run 1): terrain rising up to a layer's end distance must count, even between grid crossings.
    cx, cy = -11_000.0, -12_000.0
    fine = flat_layer(3_000, 20, 0, 1_005.0)  # last row crossing at 990 m
    coarse = flat_layer(6_000, 80, 1_005.0, 5_000)
    n = fine["dem"].shape[0]
    yy = fine["y0_m"] - (np.arange(n) + 0.5) * 20 - cy  # grid-north distance of each row centre
    fine["dem"][:] = np.where(yy[:, None] > 0, np.clip(yy[:, None] - 900, 0, None) * 0.9, 0).astype(np.float32)
    exact = compute(np.array([cx]), np.array([cy]), 2.0, [fine, coarse], n_az=4)
    dense = compute(np.array([cx]), np.array([cy]), 2.0, [fine, coarse], n_az=4, frac=0.0, min_div=200)
    assert exact[0, 0] >= dense[0, 0] - 1e-6  # nothing the dense sampling sees is missed


def test_missing_fine_data_falls_back_to_coarse_layer():
    # A wall that exists only in the coarse layer, in a region where the fine layer has NaN, must still be seen.
    cx, cy = -11_000.0, -12_000.0
    fine = flat_layer(3_000, 20, 0, 2_500)
    coarse = flat_layer(6_000, 80, 2_500, 5_000)
    n = fine["dem"].shape[0]
    fine["dem"][: n // 2 - 25] = np.nan  # no fine data beyond ~500 m grid-north
    ys = coarse["y0_m"] - (np.arange(coarse["dem"].shape[0]) + 0.5) * 80 - cy
    coarse["dem"][(ys > 1_000) & (ys < 1_400)] = 500.0
    hz = compute(np.array([cx]), np.array([cy]), 2.0, [fine, coarse], n_az=4)
    assert hz[0, 0] > 15  # atan(498 / ~1000 m)
    assert hz[2, 0] < 0   # nothing grid-south


def test_closed_form_point_matches_frames():
    from sunchaser.horizon import _point
    x, y = latlon_to_stereo(-88.7, 301.0)
    lat, lon = stereo_to_latlon(x, y)
    assert np.allclose(_point(x, y, 1234.0), surface_vector_m(lat, lon, 1234.0), atol=1e-6)
