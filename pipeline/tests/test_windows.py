import numpy as np

from sunchaser.windows import longest_zero_run, metrics


def test_window_metrics_hand_computed():
    sun = np.array([1, 0.5, 0, 0, 0, 1], float)
    earth = np.array([0.6, 0.4, 0.5, 1, 0, 0], float)
    dte = np.array([1, 0, 0, 1, 0, 0], np.uint8)
    r_1au = np.degrees(np.arcsin(695_700 / 149_597_870.7))
    m = metrics(sun, earth, dte, np.full(6, r_1au), 600)
    assert abs(m["sunPct"] - 250 / 6) < 1e-12
    assert m["darkH"] == 0.5 and m["blackoutH"] == 2 * 600 / 3600
    assert abs(m["earthPct"] - 50) < 1e-12 and abs(m["dtePct"] - 100 / 3) < 1e-12
    # 1 au: 1361 W/m^2 * 2.5 visible-equivalent steps * 1/6 h over 1 h of window -> per day x24
    assert abs(m["energyWhM2Day"] / (1361 * 2.5 / 6 * 24) - 1) < 1e-12


def test_battery_by_hand():
    from sunchaser.windows import battery
    r_1au = np.degrees(np.arcsin(695_700 / 149_597_870.7))
    # 1 h steps; panel gives 1361*0.5*1*1 = 680.5 Wh when lit; load 1000 W; 2000 Wh battery starting full
    sun = np.array([0, 0, 0, 1, 1], float)
    low, empty_h, end = battery(sun, np.full(5, r_1au), 3600, 0.5, 1.0, 1000.0, 2000.0)
    # 2000 -> 1000 -> 0 (load met exactly) -> empty -> empty (680.5 - 1000 < 0) -> empty ; end 0
    assert low == 0 and empty_h == 3 and end == 0


def test_longest_zero_run():
    assert longest_zero_run([0, 0, 1, 0, 0, 0]) == 3 and longest_zero_run([1, 1]) == 0
