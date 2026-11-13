"""V4 at site points (like-for-like with point-based convergence tests): RoI 4 pixels, 1,440 azimuths, z = 5 m,
V2 layer stack, far layers (all but the 5 m near field) coarsened 2x.

Run: python -m sunchaser.validate_v4_site
"""
import numpy as np

from .fetch import read_site_dem
from .horizon import coarsen, compute, load_layers
from .validate_v2 import N_AZ, NEAR_5M_M, roi_pixels, roi_polygon


def run():
    px, py = roi_pixels(roi_polygon()[0])
    site5 = {**read_site_dem("Site01_final_adj_5mpp_surf.tif"), "s0_m": 0.0, "s1_m": NEAR_5M_M}
    far = load_layers(-11287.5, -12167.5, 5_000.0)
    far[0] = {**far[0], "s0_m": NEAR_5M_M}
    base = compute(px, py, 5.0, [site5] + far, N_AZ)
    coarse = compute(px, py, 5.0, [site5] + [coarsen(L, 2) for L in far], N_AZ)
    d = np.abs(coarse - base)
    print(f"V4-site: {px.size} RoI 4 pixels x {N_AZ} az: max {d.max():.4f} deg, p99 {np.percentile(d, 99):.4f}, "
          f"mean {d.mean():.5f}; at the centroid pixel max {d[:, np.argmin(np.hypot(px + 11287.5, py + 12167.5))].max():.4f}")


if __name__ == "__main__":
    run()
