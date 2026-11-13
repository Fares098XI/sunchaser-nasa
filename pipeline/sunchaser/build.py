"""Precompute horizons for a hero region (40 m cells, 180 grid azimuths) and run V4.

Run: python -m sunchaser.build [--v4]
"""
import argparse
import time

import numpy as np

from . import DATA_DIR
from .horizon import cell_centres, coarsen, compute, load_layers
from .sites import CONNECTING_RIDGE_ROI4

BUILD_DIR = DATA_DIR / "build"
REGION_HALF_M = 5_000.0
CELL_M = 40.0
OBS_Z_M = 2.0  # observer (panel/mast) height above the surface for region maps, docs/METHODS.md §5
N_AZ = 180


def region_grid(site):
    """40 m cell centres covering the same 10 x 10 km window as the exported 20 m terrain."""
    from .fetch import read_dem_window
    w = read_dem_window("20mpp", site["x_m"], site["y_m"], REGION_HALF_M)
    rows, cols = (int(round(n * w["res_m"] / CELL_M)) for n in w["dem"].shape)
    return w["x0_m"], w["y0_m"], rows, cols


def build(site=CONNECTING_RIDGE_ROI4, v4=False):
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    x0, y0, rows, cols = region_grid(site)
    X, Y = cell_centres(x0, y0, CELL_M, rows, cols)
    layers = load_layers(site["x_m"], site["y_m"], REGION_HALF_M)
    t = time.time()
    hz = compute(X, Y, OBS_Z_M, layers, N_AZ).astype(np.float32).reshape(N_AZ, rows, cols)
    print(f"horizons {hz.shape} in {time.time() - t:.0f}s; deg min {hz.min():.2f} median {np.median(hz):.2f} max {hz.max():.2f}")
    out = BUILD_DIR / f"horizon_{site['id']}_z{OBS_Z_M:g}.npz"
    np.savez_compressed(out, horizon_deg=hz, x0_m=x0, y0_m=y0, cell_m=CELL_M, z_m=OBS_Z_M,
                        layers=np.array([f"{L['product']}:{L['s0_m']:.0f}-{L['s1_m']:.0f}" for L in layers]))
    print(f"wrote {out.name}")
    if v4:
        far = [layers[0]] + [coarsen(L, 2) for L in layers[1:]]
        t = time.time()
        hz2 = compute(X, Y, OBS_Z_M, far, N_AZ).astype(np.float32).reshape(N_AZ, rows, cols)
        d = np.abs(hz2 - hz)
        print(f"V4 (far layers coarsened 2x, {time.time() - t:.0f}s): max {d.max():.4f} deg, p99 {np.percentile(d, 99):.4f}, "
              f"p99.9 {np.percentile(d, 99.9):.4f}, mean {d.mean():.5f}; PASS={d.max() < 0.05}")
        # Where the Sun can actually be (|horizon| < 2.4 deg) is what matters for power; report it separately.
        m = np.abs(hz) < 2.4
        print(f"V4 within Sun band |h|<2.4 deg: max {d[m].max():.4f}, p99 {np.percentile(d[m], 99):.4f} ({m.mean():.0%} of samples)")
        np.save(BUILD_DIR / "v4_absdiff.npy", d.max(axis=0))
    return out


def v4b(site=CONNECTING_RIDGE_ROI4, n_cells=1000):
    """V4b: production (exact grid walk) vs dense stepping, 1,000 random cells (VALIDATION.md)."""
    x0, y0, rows, cols = region_grid(site)
    X, Y = cell_centres(x0, y0, CELL_M, rows, cols)
    pick = np.random.default_rng(2026).choice(X.size, n_cells, replace=False)
    ox, oy = X.ravel()[pick], Y.ravel()[pick]
    layers = load_layers(site["x_m"], site["y_m"], REGION_HALF_M)
    t = time.time()
    prod = compute(ox, oy, OBS_Z_M, layers, N_AZ)
    t_prod = time.time() - t
    excess = []
    for name, frac, div in (("R1", 0.0003, 64), ("R2", 0.0001, 128)):
        t = time.time()
        ref = compute(ox, oy, OBS_Z_M, layers, N_AZ, frac=frac, min_div=div)
        d = prod - ref
        excess.append(d.max())
        print(f"{name} (frac {frac}, res/{div}, {time.time() - t:.0f}s): |d| max {np.abs(d).max():.5f} p99 "
              f"{np.percentile(np.abs(d), 99):.5f}; production above ref by up to {d.max():.5f}; "
              f"ref above production by up to {-d.min():.5f}", flush=True)
        if name == "R2":
            ok = d.min() > -0.002 and excess[1] < excess[0]
    print(f"V4b/V4c: production {t_prod:.0f}s; V4c PASS={ok}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--v4", action="store_true")
    ap.add_argument("--v4b", action="store_true", help="only run the V4b sampling-convergence check")
    args = ap.parse_args()
    if args.v4b:
        v4b()
    else:
        build(v4=args.v4)
