"""V2 vs Barker et al. 2021. Fast path checks the recorded result against the fixed criteria;
SUNCHASER_SLOW=1 recomputes it (~10 min, needs the cached DEMs)."""
import json
import os

import pytest

from sunchaser.validate_v2 import CRITERIA, EXPECTED_PIXELS, RESULT, run


def test_v2():
    if os.environ.get("SUNCHASER_SLOW") == "1":
        r = run()
    elif RESULT.exists():
        r = json.loads(RESULT.read_text())
    else:
        pytest.skip("no recorded V2 result; run python -m sunchaser.validate_v2")
    assert r["pixels"] == EXPECTED_PIXELS
    for key, (lo, hi) in CRITERIA.items():
        assert lo <= r[key] <= hi, (key, r[key])
