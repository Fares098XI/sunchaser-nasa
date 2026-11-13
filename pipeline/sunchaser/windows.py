"""Mission-window metrics (docs/METHODS.md §8). Twin of web/src/engine/windows.ts; V5 golden compares them."""
import numpy as np

TSI_W_M2 = 1361.0  # total solar irradiance at 1 au (Kopp & Lean 2011)
SUN_RADIUS_KM = 695_700.0
AU_KM = 149_597_870.7


def longest_zero_run(x):
    best = run = 0
    for v in x:
        run = run + 1 if v == 0 else 0
        best = max(best, run)
    return best


EXAMPLE_POWER = {"panel_m2": 2.0, "efficiency": 0.3, "load_w": 150.0, "battery_wh": 3000.0}  # user-editable example


def battery(sun, sun_r_deg, step_s, panel_m2, efficiency, load_w, battery_wh):
    """Battery state of charge over a stay, starting full: each step adds solar energy on a Sun-tracking panel
    (TSI at the true Sun distance x visible disc fraction x area x efficiency) and removes the load, clamped to
    [0, capacity]. Returns (lowest charge %, hours with unmet load, final charge %)."""
    step_h = step_s / 3600
    au_over_d = np.sin(np.radians(sun_r_deg)) * AU_KM / SUN_RADIUS_KM
    e_in = TSI_W_M2 * au_over_d**2 * np.asarray(sun) * step_h * panel_m2 * efficiency
    soc, low, empty = battery_wh, battery_wh, 0
    for e in e_in:
        soc = min(battery_wh, soc + e - load_w * step_h)
        if soc < 0:  # load not fully met this step
            soc = 0.0
            empty += 1
        low = min(low, soc)
    return 100 * low / battery_wh, empty * step_h, 100 * soc / battery_wh


def metrics(sun, earth, dte, sun_r_deg, step_s):
    """sun/earth: visible disc fractions; dte: 0/1 flags; all over one window."""
    step_h = step_s / 3600
    au_over_d = np.sin(np.radians(sun_r_deg)) * AU_KM / SUN_RADIUS_KM
    n = len(sun)
    return {
        "sunPct": 100 * float(np.mean(sun)),
        "darkH": longest_zero_run(sun) * step_h,
        "earthPct": 100 * float(np.mean(earth >= 0.5)),
        "dtePct": 100 * float(np.mean(dte)),
        "blackoutH": longest_zero_run(dte) * step_h,
        "energyWhM2Day": float(np.sum(TSI_W_M2 * au_over_d**2 * sun * step_h)) / (n * step_h / 24),
    }
