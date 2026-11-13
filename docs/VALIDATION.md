# Validation — Sunchaser

Rule: each check's **pass criterion is written here before the check is run**. A failing check outranks every feature.
Results are appended below the criterion with their numbers; criteria are never edited after a run (a new version gets a new ID suffix, e.g. V2b).

| ID | Status |
|---|---|
| V1 | **PASS** |
| V1b | **PASS** — DSN Moon elevation max 0.00046°, 0 flag mismatches |
| V1c | **PASS** — 2020–2045 daily: Sun 1.48e-6°, Earth 1.71e-6°; track files within half a quantum |
| V2 | **PASS** — 88.53 %, LCSP 3.71 d; row C matches Barker within 0.15 pt / 1 h |
| V2c | **PASS** — 100 clones: 1st pct 88.18 % (Barker 88.12 %), 99th pct LCSP 3.71 d (Barker 4.0 d) |
| V3 | **FAIL** — Sun 7/10, Earth 10/10 within 10 pt; outliers are near-pole crests |
| V3b | **FAIL** — 60 m terrain explains 1 of 3 outliers; reference map noisy at pixel scale near the pole → V3c (map-level) |
| V3c | **PASS** — r = 0.965 over 6,889 blocks, median +2.7 pt, 92.8 % within 10 pt |
| V4 | run 1 FAIL (0.066°), run 2 PASS (0.038°), **run 3 PASS (exact walk): max 0.035°, p99 0.004° over 11.25 M values** |
| V4b | run 1 FAIL — reference coarser than the method; superseded by V4c |
| V4c | run 1 FAIL (layer-boundary gap, 0.003°) → fixed; **run 2 PASS (≤ 0.00001°)** |
| V5 | **PASS** |
| V5c | **PASS** — tracks 5.7e-14, period statistics 1.1e-13 |
| V5d | **PASS** — derived Sun/Earth at all nine site regions vs SPICE: max 1.2e-6° / 3.3e-6°; TS ≡ Python |
| V6 | **PASS** — 133/133 routes verified, 125/125 broken routes rejected, 40/40 = exhaustive search |
| V7 | criterion fixed, not run |
| V9 | **PASS** — atlas Sun/Earth tables derived in the browser vs SPICE at each of 15 sites: worst 0.0028° (quantization); browser ≡ Python 5.7e-13° |
| V9b | sanity (rule set after a first look) — atlas ground vs LROC-published lander elevations, 6 sites: worst 27 m |
| V10 | **FAIL** — Apollo EVA Sun elevations vs the ALSJ table: Apollo 11/12 within 0.12°, Apollo 15 up to 4.3°, Apollo 16 up to 0.8° → V10b |
| V10b | **PASS** — the same 20 Apollo times vs JPL Horizons: worst 0.0002° (the ALSJ table advances the Sun at a constant 0.509°/h) |
| V11 | **PASS** — "drop a pin" horizons computed in the browser vs the pipeline's atlas build, 3 sites × 109,440 horizons: worst 5.2e-7° |
| V12 | sanity (rule set after a first look) — a pin's 3D shadows: GPU horizon grid vs the same march on the CPU in double precision: 0.012° (Apollo 15), 0.032° (Tycho) |

---

## V1 — Sun and Earth direction vs JPL Horizons

**Criterion fixed before the first run.**

- **What:** apparent topocentric azimuth/elevation of the Sun (NAIF 10) and Earth (399) from a lunar surface point, computed by `sunchaser.ephem.az_el` (SPICE `spkcpo`, `MOON_ME`, `CN+S`).
- **Reference:** JPL Horizons API, observer `coord@301`, `COORD_TYPE=GEODETIC`, `QUANTITIES=4` (apparent az/el, airless), `EXTRA_PREC=YES`. Horizons reports its lunar frame as `MEAN_ME (high precision)` on a 1737.4 km sphere, ephemeris DE441. Responses cached in `pipeline/tests/data/` so the test runs offline.
- **Site:** Connecting Ridge RoI 4 centroid (Barker et al. 2021 Table 2: x = −11.2875 km, y = −12.1675 km, south polar stereographic), height = nearest cell of `LDEM_80S_20MPP_ADJ`.
- **Samples:** 2027-01-01 00:00 to 2027-12-31 23:00 UTC, hourly = 8,760 per body.
- **Metric:** angular separation between our direction and Horizons' direction (combines azimuth and elevation correctly).
- **Pass:** maximum separation **< 0.01°** for both bodies (the Sun's radius is ~0.27°). Also reported: RMS, max |Δelevation|.
- **Run:** `cd pipeline && python -m pytest tests/test_v1_horizons.py -s`; refresh the reference with `python -m sunchaser.horizons`.

## V1c — Sun and Earth direction over 2020–2045 vs JPL Horizons

**Criterion fixed before the first run.** Explore covers any hour from 2020-01-01 to 2045-12-31, so V1 is
repeated over the whole range.
- **What / reference / site / metric:** as V1 (same site and height, same Horizons settings).
- **Samples:** 2020-01-01 00:00 to 2045-12-31 00:00 UTC, every 24 h (9,497 per body; daily sampling walks through
  every phase of the lunar month and the 18.6-year nodal cycle without hourly volume).
- **Pass:** maximum separation **< 0.01°** for both bodies.
- **Also checked (unit test, same run):** the shipped yearly track files decode to the SPICE values within half their
  quantum (az/el 5e-7°, distance 0.05 km, quaternion components 5e-8), and the 2027 file reproduces the previous
  720-hour January 2027 track within the same bounds.

## V1b — Moon elevation at the DSN antennas vs JPL Horizons

**Criterion fixed before the first run.**
- **What:** apparent elevation of the Moon's centre above the local horizontal of DSS-14 (Goldstone), DSS-43 (Canberra) and DSS-63 (Madrid), computed by `sunchaser.dsn.moon_elevation_deg` (SPICE `spkpos` in the station's `_TOPO` frame, `CN+S`, ITRF93 Earth orientation from `earth_1962_260806_2126_combined.bpc`).
- **Reference:** JPL Horizons, target 301, observer `coord@399` geodetic at each station's coordinates (derived from the station kernel on the WGS-84 spheroid), `QUANTITIES=4`, airless. Cached in `pipeline/tests/data/`.
- **Samples:** 2027-01-01 00:00 → 2027-12-31 23:00 UTC hourly, 8,760 per station.
- **Pass:** max |Δelevation| **< 0.01°** at every station, and the ≥ 6° visibility flag agrees in **every** hour where the two elevations are not both within 0.01° of 6°.

## V2 — Sunlight at Connecting Ridge vs Barker et al. 2021

**Criterion fixed before the first run** (revised the same day, still before any run, once PGDA's RoI polygons and 5 m DEM were found; the earlier draft approximated the RoI by a disc).

- **Reference values:** Barker et al. 2021, Table 2, Site 1, RoI 4, 2024-01-01 → 2026-01-01 hourly, row A (RoI-averaged, percentile over 100 DEM error clones):
  - z = 5 m: average illumination 1st pct **88.12 %**; longest continuous shadow (LCSP) 99th pct **4.00 d**; row C (best pixel each hour) 91.11 %.
  - z = 1 m: average illumination 1st pct **69.61 %**; row C 86.81 %.
- **RoI:** polygon 4 of PGDA `LOLA_5mpp/Site01/Site01_ROIs.tgz` (record centroid −11,287.5 / −12,167.5 m = Table 2). RoI pixels = 5 m pixel centres inside or on the polygon; expected 532 pixels = 13,300 m² (Table 2 area). The pixel count is checked before any illumination is computed.
- **Terrain:** Barker's own Site01 5 m LDEM (`Site01_final_adj_5mpp_surf.tif`) within 7.5 km, then PGDA 20 m to 25 km, 80 m to 150 km, 240 m to 300 km. 1,440 azimuths (0.25°).
- **Our quantity:** for each RoI pixel, mean visible solar-disc fraction (true solar radius per hour) at z above the surface; RoI average = mean over pixels. LCSP = longest run of hours in which the RoI-averaged fraction is 0.
- **Pass (all must hold):**
  1. z = 5 m RoI average in **[85.12 %, 94.11 %]** (88.12 − 3 to 91.11 + 3). A best-estimate DEM should sit at or above the clones' 1st percentile, so < 88.12 % is reported as a warning.
  2. z = 5 m LCSP in **[2.5 d, 5.0 d]** (99th pct 4.00 d is an upper reference; ±1 d resolution margin).
  3. z = 1 m RoI average in **[66.61 %, 89.81 %]** (69.61 − 3 to 86.81 + 3).
- **Record with the result:** DEM layers, azimuths, pixel count, run time.

## V2c — DEM-error ensemble (clones)

**Criterion fixed before any run.** Run the V2 pipeline on N of Barker's Site01 DEM clones (N fixed when the run starts and recorded; all 100 if possible, at least 20). **Pass:** the 1st percentile across clones of the z = 5 m RoI average lies within **±1.5 points of 88.12 %**, and the 99th percentile of LCSP within **±1.0 d of 4.00 d**.

## V3 — Site visibility vs PGDA average-visibility maps

**Criterion fixed before the first run.**
- **Reference:** PGDA product 69 (Mazarico et al. 2011), `AVGVISIB_85S_060M_201608` (or `_75S_120M_` north of 85°S) and the `_EARTH` maps: fraction of hourly time steps over the product's long averaging period in which *any part* of the Sun (Earth) disc is visible, from the 60 m (120 m) LDEM. Value at the pixel containing each catalog site's centre.
- **Ours:** share of 10-minute steps from 2026-11-01 to 2029-01-01 with any part of the disc visible, site centre, z = 1 m (lowest height in the catalog), from our 5–20 m horizons.
- **Expected differences** (why the band is wide): 26 months vs a multi-year average (seasonal swings of a few points), 5–20 m vs 60/120 m terrain, unknown exact observer height in the PGDA product.
- **Pass:** |ours − PGDA| ≤ **10 points** for the Sun at ≥ 8 of 10 sites, and for Earth at ≥ 8 of 10 sites. Every site's value is reported.

## V3b — Resolution diagnosis for V3 Sun outliers

**Criterion fixed after V3 run 1 and before V3b runs.** For the three V3 Sun outliers (Connecting Ridge, Shackleton Rim, Peak near Shackleton — all narrow crests within 1.2° of the pole), recompute the same quantity with the near field (0–25 km) block-averaged from 20 m to 60 m on PGDA's 60 m pixel grid (approximating the `LDEM_85S_060M` input of the PGDA map; 80/240 m layers unchanged, no 5 m layer), observer 1 m above the 60 m surface at the site point. **Pass:** |ours₆₀ − PGDA| ≤ 10 points at all three sites (i.e. terrain resolution explains the V3 gap).

## V3c — Map-level visibility vs PGDA

**Criterion fixed before the first run** (replaces the single-pixel V3 test, which failed on pixel-scale noise in the reference near the pole).
- **Ours:** share of hours (2026-11-01 → 2029-01-01, hourly; Sun direction at the region centre) with any part of the solar disc above each 40 m cell's horizon, hero region (Connecting Ridge 10 × 10 km, z = 2 m, 180 azimuths).
- **Reference:** PGDA `AVGVISIB_85S_060M_201608` (value at the 60 m pixel containing each 40 m cell centre).
- **Comparison:** both averaged over 3 × 3 cells (120 m blocks, 6,889 blocks).
- **Pass:** Pearson **r ≥ 0.85** and **|median(ours − PGDA)| ≤ 5 points**. Also reported: the fraction of blocks within ±10 points.

## V4 — Horizon convergence

**Criterion fixed.** Recompute horizons with the far-field layers coarsened 2×. **Pass:** max horizon change < 0.05° over all cells and azimuths of the hero region; 99th percentile reported.

## V4b — Ray sampling convergence

**Criterion fixed before the first run of the production method.** Added after a diagnostic showed that sampling rays once per DEM pixel misses ridge crests near the observer (up to 2.7° on 1,500 random cells; V4 cannot see this because both of its runs share the sampling).
- **Reference:** the same DEM layers sampled densely: step = clamp(0.0003·s, res/64, res).
- **Test:** production horizons for 1,000 random hero-region cells × 180 azimuths, z = 2 m.
- **Pass:** max |Δ| **< 0.01°** and p99 **< 0.002°**.

## V4c — Exactness of the ray walk

**Criterion fixed after V4b run 1 and before V4c runs.** The production walk evaluates only points on the DEM surface (grid-line crossings plus the analytic in-cell maximum), so it can never exceed the true maximum; the only possible error is *missing* a higher point. Test: for 1,000 random hero cells × 180 azimuths, compare against two dense references, R1 (step clamp(0.0003·s, res/64, res)) and R2 (clamp(0.0001·s, res/128, res)).
**Pass:** (1) no reference finds a point higher than production by more than **0.002°** (min(prod − ref) > −0.002°); (2) production's excess over the reference shrinks from R1 to R2 (the references converge toward production, not away).

## V5 — Python ≡ browser

**Criterion fixed.** For each golden file (inputs + Python outputs), the TypeScript engine's outputs differ by **max |Δ| < 1e-6** (in each quantity's unit).

**V5c (criterion fixed before the first run):** the same rule for the 2020–2045 yearly tracks: the TS
decoder reproduces Python's decoded Sun/Earth azimuth, elevation, distance and both orientation quaternions at 300
random hours, and the period statistics at the site (mean Sun %, Earth any %, longest Sun-zero and Earth-zero run) for
5 random periods of 1–366 days, including periods that cross a year boundary. **Pass:** max |Δ| < 1e-6.

**V5d (criterion fixed before the first run):** Explore at the other nine sites uses Sun/Earth directions
*derived* from the hero region's SPICE tracks (rotate into MOON_ME, shift the observer to the site centre, rotate into
the site's frame; Earth and sky orientations by the same rotation). Check: (a) at 200 random hours 2020–2045 and every
built site region, the derived azimuth/elevation of the Sun and Earth vs direct SPICE (`ephem.az_el` at the site
centre): max angular separation **< 0.001°**; (b) the TS derivation reproduces the Python derivation on a golden file
(max |Δ| < 1e-6°).

**V5d result: PASS.** (a) All nine site regions, 200 random hours 2020–2045 (`tests/test_regions.py`):
Sun max separation 1.21e-6°, Earth 3.31e-6° (Nobile Rim 2, the farthest site, 206 km from Connecting Ridge) —
about the tracks' own 1e-6° quantum; Earth and sky orientations (not part of the criterion) within 1.03e-5°.
(b) `web/src/engine/regiontracks.test.ts` on `golden/v5_regions.json` (three regions × 40 directions and
orientations): max |Δ| < 1e-6, PASS.

## V6 — Light Path constraints

**Criterion fixed.** An independent checker (not sharing code with the planner) re-verifies every route in the test suite: each step ≤ speed limit, every traversed cell slope < limit, battery never below 0, waits only where allowed. **Pass:** 100 % of routes.

**Detail fixed before the planner was written.** Checker: `web/src/engine/routecheck.ts`, importing nothing
from the planner. From the raw inputs (drivable mask, per-hour visible solar-disc fraction, Sun distance, rover
parameters) it re-simulates each route and requires: (1) it starts at the start cell at the start hour and ends at the
target; (2) every sub-step stays or moves to a 4-neighbour; (3) per hour, moves × cell size ≤ speed × 1 h; (4) every
cell entered is drivable (DEM slope < limit); (5) the battery — generation = panel W × disc fraction × (1 au / d)²,
minus the drive or idle load, capped at capacity — never drops below the reserve; (6) the reported arrival and
battery series equal the re-simulation (|Δ| < 1e-3 Wh). Suite: ≥ 300 routes on the real Connecting Ridge data (random
start, target, start hour and parameters) plus synthetic grids. **Pass:** 100 % of found routes verified; the checker
rejects 100 % of deliberately broken routes (teleport, steep cell, overdrawn battery, too fast); and on small synthetic
grids the planner's arrival equals an exhaustive search's earliest arrival in 100 % of cases.

## V7 — IM-2 replay inputs

**Criterion fixed.** Target and actual landing points and mission dates each have a primary source (NASA, Intuitive Machines or LROC) cited in DATA.md; no claim beyond what the computed lighting shows. **Pass:** all three cited, wording reviewed against that rule.

---

# Results

### V1 — PASS
Site lat −89.452675°, lon 222.851347°, h 1956.5 m. Horizons reference from JPL, DE441, `MEAN_ME`.

| Body | n | max separation | RMS | max \|Δel\| | elevation range seen |
|---|---|---|---|---|---|
| Sun | 8,760 | 1.48e-6° | 4.8e-7° | 1.5e-7° | −2.07° … +2.06° |
| Earth | 8,760 | 1.48e-6° | 5.9e-7° | 5.6e-8° | −7.54° … +6.22° |

Criterion 0.01° → margin ≈ 6,700×. The remaining difference is at the level of Horizons' printed precision (1e-9° steps) and DE440s vs DE441.

### V1c — **PASS**
Same site as V1; Horizons fetched with `python -m sunchaser.horizons --v1c`, 9,497 daily samples per body.

| Body | n | max separation | RMS | max \|Δel\| | elevation range seen |
|---|---|---|---|---|---|
| Sun | 9,497 | 1.48e-6° | 4.8e-7° | 1.5e-7° | −2.13° … +2.11° |
| Earth | 9,497 | 1.71e-6° | 6.2e-7° | 8.7e-8° | −7.54° … +6.24° |

Track files (`tests/test_tracks.py`): layout 2020–2045 contiguous (227,928 h); January 2027 (720 h) and the last 48 h
of 2020 and 2045 decode to fresh SPICE values within half a quantum on all 14 channels.

### V1b — **PASS**
(First attempt the same day could not run: JPL Horizons returned an internal error for every query; retried after it recovered.) Horizons reports the Earth observer spheroid as WGS-84 (6378.137 / 6356.752 km).

| Station | n | max \|Δel\| | RMS | 6° flag mismatches | Moon ≥ 6° |
|---|---|---|---|---|---|
| DSS-14 Goldstone | 8,760 | 4.5e-4° | 3.5e-4° | 0 | 44.1 % of hours |
| DSS-43 Canberra | 8,760 | 4.6e-4° | 3.5e-4° | 0 | 45.4 % |
| DSS-63 Madrid | 8,760 | 4.3e-4° | 3.3e-4° | 0 | 43.5 % |

Criterion 0.01° → margin ≈ 22×. The small systematic offset is consistent with different Earth-orientation (UT1/polar motion) predictions for 2027 in Horizons' EOP file vs NAIF's combined PCK.

### V3 run 1 — **FAIL** (Sun 7/10, Earth 10/10)
Share of time with any part of the disc visible, 2026-11 → 2028, z = 1 m, vs the PGDA pixel containing the site:

| Site | Sun ours / PGDA (Δ) | Earth ours / PGDA (Δ) |
|---|---|---|
| Connecting Ridge | 88.5 / 68.5 (**+20.0**) | 58.1 / 57.5 (+0.6) |
| Shackleton Rim | 77.0 / 66.2 (**+10.7**) | 49.5 / 45.2 (+4.3) |
| Peak near Shackleton | 83.4 / 58.2 (**+25.2**) | 55.4 / 46.0 (+9.4) |
| de Gerlache Rim | 86.0 / 79.4 (+6.7) | 62.0 / 61.4 (+0.6) |
| Malapert Massif | 84.0 / 81.9 (+2.1) | 60.2 / 58.7 (+1.5) |
| Nobile Rim 1 | 85.4 / 83.2 (+2.2) | 62.9 / 59.9 (+3.1) |
| Nobile Rim 2 (120 m map) | 54.7 / 53.9 (+0.8) | 77.3 / 71.8 (+5.5) |
| Haworth | 75.3 / 70.5 (+4.8) | 62.3 / 60.1 (+2.2) |
| IM-2 Athena | 46.9 / 45.1 (+1.8) | 94.2 / 92.1 (+2.2) |
| IM-2 target | 46.7 / 46.2 (+0.4) | 94.2 / 92.8 (+1.4) |

Earth agrees within 10 points everywhere (mostly < 5); Sun agrees within 5 points at 7 sites. The three misses are narrow crests within 1.2° of the pole.

### V3b — **FAIL**
Same three sites on 60 m terrain aligned to PGDA's grid: Connecting Ridge 88.9 vs 68.5 (+20.4), Shackleton Rim 67.9 vs 66.2 (**+1.6**, resolution explains it), Peak near Shackleton 84.1 vs 58.2 (+25.9). Resolution explains one of three.
**Further diagnosis (not a pass/fail check):** the PGDA map is correctly oriented (Shackleton floor = 0 %, its mirror image 38 %), but near the pole it varies wildly between adjacent 60 m pixels: along the Connecting Ridge column 21 → 67 → 68 → 86 → 0 → 26 %; the site pixel is 68 % next to an 86 % crest pixel; Peak near Shackleton is 58 % next to 86 %. A single-pixel comparison there measures the reference's pixel-scale variability, not our engine; our 88.5 % matches the crest pixel and Barker's 5 m study (V2). **Planned V3c** (criterion to be written before running): a map-level comparison over the hero region (our 40 m any-part map vs the PGDA 60 m map, binned to 120 m: correlation and median difference).

### V3c — **PASS**
Hero region (Connecting Ridge 10 × 10 km), our any-part Sun share 2026-11 → 2028 (19,008 hours, z = 2 m) vs PGDA `AVGVISIB_85S_060M`, both averaged in 120 m blocks: **Pearson r = 0.9645** over 6,889 blocks (criterion ≥ 0.85), **median difference +2.68 points** (criterion |·| ≤ 5), 92.8 % of blocks within ±10 points. Region means: ours 32.4 %, PGDA 28.7 %. The single-pixel V3 misses come from pixel-scale noise in the reference; at map level the two agree closely.

### V4 run 1 — **FAIL**
Layers 20 m 0–12 km / 80 m 12–60 km / 240 m 60–300 km; hero region 250 × 250 cells × 180 azimuths, z = 2 m. Far layers (80 m, 240 m) block-averaged 2×.
Max |Δh| **0.0658°** (criterion 0.05°); p99 0.0133°, p99.9 0.0289°, mean 0.0011°. 734 of 62,500 cells exceed 0.05°, spread over the whole region (not an edge effect).
Diagnosis: mid-range ridges 12–25 km away are resolved too coarsely at 80 m. Test on the failing cells + 300 random cells: boundaries 20/100 km → max 0.045° (too close); **25/150 km → max 0.034°**. Method changed to 25/150 km (`horizon.LAYERS`); criterion unchanged. Re-run as run 2.

### V4 run 2 — PASS
Layers 20 m 0–25 km / 80 m 25–150 km / 240 m 150–300 km, sampling 1 per pixel. Max |Δh| 0.0382°, p99 0.0055°, p99.9 0.0153°, mean 0.00045°. Passes, but a follow-up diagnostic found the sampling itself unconverged (next entry), so V4 is re-run with the exact walk.

### V4b run 1 — FAIL (reference too coarse)
Diagnostic first (1,500 random cells): sampling once per pixel differed from a dense reference by up to 2.7° (p99 0.27°) — ridge crests between samples are missed near the observer. Fix: exact grid walk (`horizon._march_dda`: every grid-line crossing + analytic in-cell maximum of the bilinear surface); on synthetic 30° relief it matches 2.5 cm stepping within 0.004°.
Run as specified: max |Δ| 0.0270° (criterion 0.01°), p99 0.0034°. Every large difference has production *above* the reference; since production evaluates only points on the DEM surface it cannot overshoot, so the dense reference (step up to 30 m at 100 km) is what misses crests. Recorded as FAIL; replaced by V4c, whose criterion tests exactly that.

### V4c run 1 — FAIL
R1: production above reference by up to 0.0270°, reference above production by up to **0.00298°** (criterion −0.002°); R2: 0.0158° / 0.00298°. Convergence condition met (0.0270 → 0.0158). Tracing the eight worst rays: every miss lies exactly at a layer boundary (s = 25 km or 150 km) — each layer stopped at its last grid crossing, so the partial cell up to the boundary was never evaluated on the finer DEM. Fixed: each layer now evaluates its start point and closes its final partial cell at s1.

### V4c run 2 — **PASS**
1,000 random hero cells × 180 azimuths. R1 (step clamp(0.0003 s, res/64, res)): reference above production by at most **0.00001°**; production above reference by up to 0.0270° (crests the reference steps over). R2 (clamp(0.0001 s, res/128, res)): **0.00001°** / 0.0158°. The references converge toward production and never beat it: the walk is exact for the bilinear DEM surface. Production 26 s vs 86 s for R2.

### V4 run 3 — **PASS** (exact ray walk)
Hero region 250 × 250 cells × 180 azimuths (11.25 M horizon values), z = 2 m, layers 20/80/240 m to 25/150/300 km, far layers block-averaged 2×: max |Δh| **0.0352°**, p99 **0.0043°**, p99.9 0.0115°, mean 0.00034°; within the Sun band (|h| < 2.4°): max 0.0352°, p99 0.0058°. Run 791 s (coarsened) after a 1,466 s production build.

**Same test at the site points**: RoI 4's 532 pixels × 1,440 azimuths, z = 5 m, V2 layer stack with everything beyond the 5 m near field coarsened 2× (`python -m sunchaser.validate_v4_site`): max 0.0319°, p99 0.0107°, mean 0.0012°; centroid pixel max 0.0259°. Further improvement means carrying 20 m data beyond 25 km (RAM-bound on the laptop; Kaggle option).

### V2 — **PASS**
RoI 4 = 532 pixels (13,300 m², = Table 2). Layers: Site01 5 m 0–7.5 km, 20 m to 25 km, 80 m to 150 km, 240 m to 300 km; 1,440 azimuths; exact ray walk; 17,544 hourly samples 2024-01-01 → 2026-01-01; true solar radius per hour. Run time 345 s. Result file `pipeline/tests/data/v2_result.json`.

| Criterion | Result | Band | |
|---|---|---|---|
| z = 5 m RoI average | **88.53 %** | 85.12–94.11 % | PASS (above the clones' 1st percentile 88.12 %, as a best-estimate DEM should be) |
| z = 5 m LCSP | **3.71 d** | 2.5–5.0 d | PASS |
| z = 1 m RoI average | **77.45 %** | 66.61–89.81 % | PASS |

Like-for-like with Table 2 row C. Our LCSP/LCIP are computed on the RoI-averaged fraction, i.e. "no pixel / any pixel sees the Sun", which is exactly row C's definition; "best pixel" is the hourly maximum over the RoI, also row C:

| Row C quantity | Barker 2021 (clone percentile) | Sunchaser (best-estimate DEM) | Difference |
|---|---|---|---|
| z = 5 m avg illumination, best pixel | 91.11 % | 91.26 % | +0.15 pt |
| z = 1 m avg illumination, best pixel | 86.81 % | 86.83 % | +0.02 pt |
| z = 5 m LCSP | 3.71 d | 3.71 d (89 h) | < 1 h |
| z = 1 m LCSP | 4.58 d | 4.54 d | −1 h |
| z = 5 m LCIP | 233.40 d | 233.42 d | +0.4 h |
| z = 1 m LCIP | 232.50 d | 232.54 d | +1 h |

Barker's values are percentiles over 100 DEM clones (1st for illumination, 99th for LCSP, 1st for LCIP); for the best-pixel row the clone spread is small, so agreement within 0.15 points and ~1 hour is the expected signature of the same terrain, method and ephemeris.

### V5 — PASS
200 golden cases (random cells, azimuths −30…400°, elevations ±3°) from the exported float16 horizon file: max |Δhorizon| 3.1e-14°, max |Δfraction| 1.4e-14 (criterion 1e-6). Python `visibility.horizon_at` + `disc_fraction` vs TypeScript `horizonAt` + `visibleDiscFraction`.

### V5c — **PASS**
`web/src/engine/v5_tracks.test.ts` against `golden/v5_tracks.json` (written by `python -m sunchaser.export_tracks`):
300 random hours, all 14 channels: max |Δ| 5.7e-14. Five periods (1 d, 30 d across the 2020→2021 boundary, 7 d,
366 d, and the last 29 d of 2045) at horizon cell (125, 125): mean Sun %, Earth any %, longest Sun-zero and Earth-zero
runs, max |Δ| 1.1e-13.

### V2c — **PASS**
Kaggle (CPU, 4 cores; `pipeline/kaggle/v2c`), Barker's 100 DEM clones of Site 1 at 5 m, RoI 4, 2024-01-01 → 2026-01-01
hourly, z = 5 m, 1,440 azimuths; far horizon (beyond 7.5 km) computed once from the best-estimate DEM. Run 1 stopped
after 84 clones on a broken PGDA download (retry list missed `ChunkedEncodingError`); fixed (`requests.RequestException`)
and resumed from the saved log (`pipeline/tests/data/v2c_clones.jsonl`, all 100 clones, ~55–85 s each).

| | ours (100 clones) | Barker et al. 2021, Table 2 | rule | |
|---|---|---|---|---|
| 1st percentile of the RoI-average visibility | **88.18 %** | 88.12 % | ±1.5 pt | pass |
| 99th percentile of the longest continuous shadow | **3.71 d** | 4.0 d | ±1.0 d | pass |

Spread over the clones: average 88.17–88.48 % (median 88.31 %); longest shadow 3.29–3.71 d.

### V6 — **PASS**
`web/src/engine/lightpath.test.ts`. Real Connecting Ridge data, 10 random 7-day windows in 2027, 310 random start/target/
parameter sets (speed 90–720 m/h, slope limit 10–25°, battery 1.5–7.5 kWh, reserve 5–45 %, loads varied): 133 routes
found, **133/133 pass** the independent checker (`routecheck.ts`); the other 177 have no route that keeps the battery
above the reserve within 7 days (reported as such). Mutations (teleport, steep cell, ×3 loads, speed below one cell per
hour, wrong end) on 25 routes: **125/125 rejected**. Small synthetic grids (5 × 5, 5 h): planner arrival = exhaustive
search in **40/40** cases (32 reachable). Slowest plan 0.41 s (no-route case, full 7 days); typical re-plan 3–15 ms once the
window's lighting is built (~1 s, once per departure).

## V9 — Atlas sites: derived Sun/Earth tables (METHODS §19)
- **Question:** atlas sites ship horizons only; their 10-minute Sun/Earth tables are derived in the browser from the
  reference site's shipped tables. Are they as good as SPICE run at the site itself?
- **Pass rule (fixed before running):** worst angular difference (azimuth × cos elevation, elevation, angular radius)
  < 0.01° over every 6 h of 2026-11 to 2028 at every atlas site; browser ≡ Python < 1e-6 on golden cases.
- **Result — PASS:** 15 sites × 3,168 times: worst 0.0028° (the reference tables' own quantization, az unit
  0.0055°); browser vs Python 5.7e-13° (`v5_atlas.test.ts`). `python -m sunchaser.export_atlas`.

## V9b — Atlas terrain: ground height vs LROC (sanity check)
- Ground height at the site centre from the global maps vs the lander elevation LROC publishes on the pages the
  coordinates come from. The rule (within 50 m) was set after a first look, so this is a sanity check, not a validation.
- **Result:** Chang'e 3 −4 m, Chang'e 5 +27 m, Chang'e 6 +1 m, Chandrayaan-3 −3 m, SLIM −1 m, IM-1 +23 m.

## V10 — Apollo: Sun elevation vs the Apollo Lunar Surface Journal
- **Reference:** ALSJ "Sun Angles" (B. W. Lawrence, rev. 2005): Sun elevation at the start and end of every EVA, in
  ground elapsed time; launch times from the mission reports. Apollo 14 and 17 left out (mission clocks updated in flight).
- **Pass rule (fixed before running):** within 0.3° at every listed time.
- **Result — FAIL:** Apollo 11 −0.12°, Apollo 12 within 0.06°, but Apollo 15 drifts to −4.28° and Apollo 16 to
  −0.78° over three days. The ALSJ values rise by exactly 0.509°/h, the Moon's mean rotation rate, while the true rate
  depends on latitude and the Sun's azimuth (Apollo 15 is at 26°N): the table extrapolates linearly. → V10b.

## V10b — Apollo: Sun elevation vs JPL Horizons
- **Pass rule (fixed before running):** < 0.01° at the 20 ALSJ times.
- **Result — PASS:** worst 0.0002° (e.g. Apollo 15, GET 168.25 h: Horizons 40.018°, Sunchaser 40.018°, ALSJ
  44.3°). `python -m sunchaser.export_atlas --v10b` (network).

## V11 — Drop a pin: browser horizons vs the pipeline (METHODS §20)
- **Question:** a pin's horizons are computed in the browser (TypeScript port of the atlas build and of the exact ray
  walk). Are they the pipeline's horizons?
- **Pass rule (fixed before running):** at Apollo 15, Chang'e 4 and SLIM, with the terrain the browser receives (LDEM_64
  crop as `/api/dem?product=ldem_64` serves it, LDEM_16 web tiles): worst difference < 1e-6° against the pipeline's float horizons
  (every 30th azimuth, all 19 points and 4 heights); ground height < 1 mm; fewer than 0.1 % of all 109,440 values differ
  after the 1/256° quantization of the shipped files; the API's crop rule equals the pipeline's.
- **Result — PASS:** worst 5.2e-7° (Apollo 15), 1.6e-7° (Chang'e 4), 5.2e-7° (SLIM) — the pipeline stores float32;
  ground identical; quantized mismatches 3, 0 and 8 of 109,440 (values on a rounding boundary). Test
  `web/src/engine/v11_pin.test.ts`, golden from `python -m sunchaser.export_globalterrain --golden`.
- **End to end (app):** a pin at Apollo 15's coordinates gives the same Compare row as the Apollo 15 atlas site.

## V12 — A pin's 3D region: GPU shadows vs the CPU (METHODS §21)
- **Question:** the 3D view of a pin is shaded from a horizon grid (40,000 cells × 180 azimuths) marched on the GPU in
  32-bit floats. Is it the same march as in double precision?
- **Check:** every build compares the GPU grid with `engine/pinregion.stepHorizon` (same terrain layers, same stepping
  rule, float64) at the centre and 4 edge cells, every 30°, and shows the worst difference in the Explore panel.
  The rule (< 0.05°) was set after the first runs, so this is a sanity check, not a validation.
- **Result:** Apollo 15 0.012°, Tycho 0.032° (float32 positions along 300 km rays). At 1 km this moves a shadow
  edge by under 0.6 m, far below the 59 m terrain cell.
- **Not covered:** the stepping rule itself against the exact walk of §5 (V4 measured that for the polar maps); the
  pin's numbers in Compare use §20's exact walk on 474 m terrain, so they can differ slightly from the 3D view's
  readout, which uses this grid on 59 m terrain.

## V13 — Ask Sunchaser: numbers trace to the engine (METHODS §24)
- **Question:** the copilot's answers are written by free AI models (Gemini, Groq) or by offline templates. Does every
  number they state come from Sunchaser's own engine, and do they use the right tool?
- **Check:** the 22 questions in `web/src/copilot/evalset.ts` (13 English, 5 Arabic, 4 edge cases: a date outside the
  tables, an unknown site, an attempt to make it state a false number, an off-topic request), run in the page with
  `window.__sunchaserCopilot.eval()` (AI) and `eval("/api/none")` (offline mode). Every answer is checked by
  `copilot/agent.ts ground()`: a number counts as traced when a tool result of that question, the question or the app
  state rounds to it (also as hours ↔ days, % ↔ fraction, Wh ↔ kWh); dates, times, check ids and counts ≤ 12 are not
  checked.
- **Pass criteria (set before the first run):** AI: ≥ 95 % of all checked numbers traced, the required tool
  used in ≥ 90 % of the questions that need one, no answer states the false 42 %; offline: every question answered,
  100 % of its numbers traced (templates only print tool results).
- **Offline mode:** 22/22 answered, 151/151 numbers traced. **PASS.** (Runs before that found and fixed:
  "Apollo 15 يوم 2027-03-15" read as a 15-day stay; a 2030 question answered for 2027; slip and threshold
  questions routed to the wrong tool.)
- **AI models** (one question every 15 s, all answered by gemini-flash-lite-latest; the two larger Gemini models
  had used their free daily quota in the timing tests): 22/22 answered in 1.4–6.3 s, required tool used 22/22,
  100/101 numbers traced (the miss: "December 31" written in words), the false 42 % not stated (it answered 99 % from
  check_landing). **PASS.** A burst of 22 questions in about a minute exhausted every free per-minute limit after
  5 questions; the rest were answered by offline mode, as designed.
- **Found by hand afterwards:** a compare_sites period (then 00:00 UTC) described as a 12:00 landing, so its link
  62.9 % disagreed with the board's 67 % for the same day. Fixed in the tool: a date alone now means 12:00 UTC
  everywhere in the copilot; the same question then gave 66.5 %, matching the board.
- **Not covered:** whether the words around the numbers are right (a model can attach a true number to the wrong
  site, as above); the grounding badge under each answer shows the same check live, and the answer links to the view that shows
  the numbers.
