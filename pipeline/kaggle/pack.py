"""Build the private Kaggle dataset folder for V2c: <out>/pipeline.zip + dataset-metadata.json.

Contents: the sunchaser package, pyproject, the precomputed far horizon (data/build/v2c_far.npy) and the RoI
shapefile. No logs or caches by default (a stale v2c_clones.jsonl would make the run skip clones); --resume ships the
current tests/data/v2c_clones.jsonl so an interrupted run continues where it stopped.
Run: python kaggle/pack.py <out_dir> [--resume]
"""
import json
import sys
import zipfile
from pathlib import Path

PIPE = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
files = [p for p in (PIPE / "sunchaser").rglob("*") if p.is_file() and "__pycache__" not in p.parts]
files += [PIPE / "pyproject.toml", PIPE / "data/build/v2c_far.npy", PIPE / "data/dem/Site01_ROIs.tgz"]
if "--resume" in sys.argv:
    files.append(PIPE / "tests/data/v2c_clones.jsonl")
with zipfile.ZipFile(out / "pipeline.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for p in files:
        z.write(p, "pipeline/" + p.relative_to(PIPE).as_posix())
(out / "dataset-metadata.json").write_text(json.dumps(
    {"title": "sunchaser-pipeline", "id": "faressherif/sunchaser-pipeline", "licenses": [{"name": "other"}]}, indent=1))
print(f"{out / 'pipeline.zip'}: {len(files)} files, {(out / 'pipeline.zip').stat().st_size / 1e6:.1f} MB")
