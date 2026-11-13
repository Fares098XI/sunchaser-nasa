"""Kaggle runner for V2c (Barker's 100 DEM clones). Private CPU notebook with internet.

Input dataset faressherif/sunchaser-pipeline holds pipeline.zip (code + v2c_far.npy + RoI shapefile).
Output: /kaggle/working/pipeline/tests/data/v2c_clones.jsonl (one line per clone) + the summary line.
"""
import os
import subprocess
import sys
import zipfile

N_CLONES = 100  # full run (a 2-clone smoke run passed first)

# Kaggle may mount the dataset with pipeline.zip unpacked (pipeline/sunchaser/...) or as the zip itself
import glob  # noqa: E402
import shutil  # noqa: E402

found = glob.glob("/kaggle/input/**/pipeline/sunchaser/validate_v2c.py", recursive=True)
if found:
    shutil.copytree(os.path.dirname(os.path.dirname(found[0])), "/kaggle/working/pipeline", dirs_exist_ok=True)
else:
    zipfile.ZipFile(glob.glob("/kaggle/input/**/pipeline.zip", recursive=True)[0]).extractall("/kaggle/working")
print("pipeline from", found[0] if found else "zip", flush=True)
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "spiceypy", "rasterio", "pyshp"], check=True)
os.chdir("/kaggle/working/pipeline")
sys.path.insert(0, os.getcwd())
print("python", sys.version.split()[0], "cpus", os.cpu_count(), flush=True)

import numpy as np  # noqa: E402

from sunchaser.validate_v2c import run  # noqa: E402

far = np.load("data/build/v2c_far.npy")
print("far horizon", far.shape, "deg range", float(far.min()), float(far.max()), "finite", bool(np.isfinite(far).all()), flush=True)
run(n=N_CLONES)
