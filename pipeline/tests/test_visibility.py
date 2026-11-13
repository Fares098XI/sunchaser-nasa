import numpy as np

from sunchaser.visibility import SUN_RADIUS_1AU_DEG, disc_fraction, horizon_at


def test_disc_fraction_limits_and_symmetry():
    r = SUN_RADIUS_1AU_DEG
    assert disc_fraction(-1, 0) == 0 and disc_fraction(1, 0) == 1
    assert abs(disc_fraction(0, 0) - 0.5) < 1e-15
    e = np.linspace(-r, r, 101)
    assert np.allclose(disc_fraction(e, 0) + disc_fraction(-e, 0), 1)  # f(d) + f(-d) = 1
    # Numerical area of a disc above a straight edge at d = 0.3
    d, n = 0.3, 2001
    yy, xx = np.mgrid[-1:1:n * 1j, -1:1:n * 1j]
    inside = xx**2 + yy**2 <= 1
    assert abs((inside & (yy > -d)).sum() / inside.sum() - disc_fraction(d * r, 0, r)) < 2e-3


def test_horizon_interpolation_wraps():
    h = np.array([0.0, 10.0, 20.0, 30.0])  # 4 azimuth bins: 0, 90, 180, 270
    assert np.allclose(horizon_at(h, [45, 315, 360, 405]), [5, 15, 0, 5])
    h2 = np.stack([h, 2 * h], -1)
    assert horizon_at(h2, np.array([45.0])).shape == (1, 2)
