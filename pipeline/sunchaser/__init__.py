"""Sunchaser precompute pipeline: SPICE ephemerides, LOLA terrain, visibility."""
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = PIPELINE_DIR / "data"
REPO_DIR = PIPELINE_DIR.parent
