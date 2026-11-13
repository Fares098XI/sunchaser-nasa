# Methods — Sunchaser

Each quantity: inputs, method, outputs, assumptions, limits. Code references point to the single implementation (Python) and its browser twin (TypeScript) where one exists.

## 1. Frames, grid and time
- **Body-fixed frame:** `MOON_ME` from `moon_de440_250416.tf` (= `MOON_ME_DE440_ME421`, aligned to the DE421 mean-Earth frame of the LOLA DEMs to ≤ 0.53 m). See DATA.md.
- **Reference surface:** sphere R = 1,737,400 m. DEM heights are metres above it.
- **Map grid:** south polar stereographic, true scale at the pole: ρ = 2R·tan(π/4 + lat/2), x = ρ·sin(lon), y = ρ·cos(lon). Code: `pipeline/sunchaser/frames.py` (tested equal to PROJ on the DEM's own CRS to 1e-6 m).
- **Local frame:** east/north/up from the sphere normal. Azimuth is clockwise from local north toward east (same as JPL Horizons).
- **Grid bearing:** local north points along grid bearing = longitude, so `az_grid = az_local + lon` (mod 360). Checked by finite steps in `tests/test_frames.py`. The web uses grid bearings because the map is a grid.
- **Time:** UTC ISO 8601 everywhere; converted to TDB by SPICE with `naif0012.tls`. No leap second is announced after 2016, so future UTC is the same convention Horizons uses.

## 2. Sun and Earth direction
- **Inputs:** surface point (lat, lon, h_m), UTC times, target (Sun = 10, Earth = 399).
- **Method:** SPICE `spkcpo(target, et, "MOON_ME", "OBSERVER", "CN+S", obs, "MOON", "MOON_ME")`: observer fixed on the rotating Moon; converged Newtonian light time + stellar aberration (the Moon's ~1 km/s orbital velocity around Earth and ~30 km/s around the Sun shift the apparent Sun by up to ~0.006°, so aberration matters at our 0.01° target). The vector is rotated into east/north/up; az = atan2(e, n), elev = asin(u/|v|).
- **Outputs:** `az_deg`, `elev_deg`, `dist_m`. Code: `pipeline/sunchaser/ephem.py`.
- **Validated:** V1, max 1.5e-6° from Horizons over 8,760 hours for both bodies.
- **Limits:** no gravitational light bending (Horizons includes it; it is negligible here), no refraction (airless).

## 3. Visible fraction of the solar disc
- **Solar angular radius:** r = asin(R☉ / d), R☉ = 695,700 km (IAU 2015 nominal). The web skeleton uses the mean at d = 1 au: 0.2665°. The pipeline will use the true distance per hour (varies ±1.7 %).
- **Fraction above a horizon at elevation h:** with d = (elev − h)/r clamped to [−1, 1], f = 1 − (acos d − d·√(1 − d²))/π (circular segment, straight horizon edge across the disc).
- **Code:** `web/src/engine/sky.ts` `visibleDiscFraction`; Python twin `visibility.py`; V5 golden files enforce equality.
- **Limits:** treats the horizon as straight across the 0.53° disc; true ridge profiles can curve within the disc (sub-percent effect, to be quantified with V2).

## 4. Terrain mesh and shading (web)
- 500 × 500 cells of the 20 m DEM, 1 scene unit = 1 km, no vertical exaggeration.
- **Shadows = data:** each fragment samples the horizon texture array (§5) at the Sun's grid azimuth (linear between the two nearest 2° layers, bilinear in space), then applies the §3 disc fraction. The light/shadow boundary and the penumbra width are therefore computed quantities. Brightness inside the lit area is stylised (exposure lifted, N·L softened) because at 1–2° Sun elevation true N·L leaves flat ground almost black; this changes how bright lit ground looks, never where it is lit.
- One Sun grid azimuth per time step (region centre): across the 10 km window the true grid bearing of the Sun changes by ≤ ~0.3° (curvature), far below the 2° azimuth bins.
- Readouts in the inspector use the same horizon file in TypeScript (`engine/horizon.ts`), matching Python on V5 golden cases.

## 5. Terrain horizons
- **Quantity:** for an observer `z_m` above the ground at grid point (x, y), the horizon `h(α)` is the highest elevation angle of terrain seen along grid bearing α. Region maps use 180 bearings (2° steps) on a 40 m cell grid, `z_m = 2` (panel/mast height); point studies (V2) use 720 bearings.
- **Nested DEM layers** (distance from the observer): PGDA 20 m for 0–25 km, 80 m for 25–150 km, 240 m for 150–300 km (widened from 12/60 km after V4 run 1 failed); for site studies Barker's 5 m site DEM is added as the innermost layer. 300 km is enough: with a maximum relief of ~8 km, terrain beyond ~245 km drops below −2.1° (the lowest Sun limb at these sites) because of curvature.
- **Exact ray walk (not fixed-step sampling):** the DEM surface is bilinear between pixel centres, so along a ray it is piecewise quadratic, with breaks where the ray crosses a grid line. The walk visits every crossing (a two-family DDA), fits the in-cell quadratic from the two crossings and the midpoint, and also evaluates its analytic maximum s* = √((A − h_obs)/C) when it falls inside the cell (C includes the curvature drop 1/2R). Each layer evaluates its start point and closes its final partial cell, so the layers tile the ray with no gap. Fixed-step sampling once per pixel was measured to miss near ridge crests by up to 2.7° (V4b diagnostic); the walk is never beaten by any denser sampling by more than 0.00001° (V4c). Cost ≈ 2 evaluations per crossed cell, faster than the dense references it beats.
- **Exact sphere geometry:** each sample's grid (x, y) and height become a body-fixed 3D point by the closed-form inverse stereographic map (u = (y/R, x/R, −(1−t²))/(1+t²), t² = (x²+y²)/4R²); elevation = asin(v·up/|v|) with v = sample − observer. No parabolic curvature approximation, no flat-Earth distances (stereographic scale error grows to 0.8 % at 300 km and is avoided this way).
- **Code:** `pipeline/sunchaser/horizon.py` (numba, parallel). Tests: bare sphere dip = acos(R/(R+z)) within 0.005°; a wall matches an independent 3D computation to 1e-6°.
- **Storage for the web:** int16 steps of 1/256° (max rounding 0.002° = 0.7 % of the solar radius), delta-coded along azimuth and byte-shuffled: 22.5 MB raw → ~9.5 MB compressed (brotli on Vercel), vs 17.5 MB for plain float16. The GPU receives the same integers (`R16I` texture array) and interpolates them exactly as `engine/horizon.ts` does, so shading and readouts share one dataset.
- **Limits:** rays are straight lines in the grid rather than exact geodesics (bearing drift of a fraction of a degree at 300 km near the pole); 2° azimuth bins in region maps can miss narrow peaks between rays at long range (site studies use 0.25°); DEM effective resolution ~15–35 m, so boulders and small rims are not seen.

## 6. Direct-to-Earth (DTE) link and DSN visibility
- **DSN:** the three 70 m antennas DSS-14 (Goldstone), DSS-43 (Canberra), DSS-63 (Madrid). Moon elevation from SPICE `spkpos("MOON", et, "<DSS>_TOPO", "CN+S", "<DSS>")` (topocentric frame, +Z zenith; ITRF93 Earth orientation from `earth_1962_260806_2126_combined.bpc`). Visible when ≥ **6°**, the 70 m antennas' elevation motion limit (DSN 810-005, module 302 Rev. C, Table 1: 6–89.5°). Code: `pipeline/sunchaser/dsn.py`. Validation V1b.
- **Earth visible at a site:** Earth disc fraction ≥ 0.5, i.e. Earth's centre above the terrain horizon in its direction (the same horizon data and disc formula as the Sun, Earth radius = IUGG mean 6,371.0088 km at the true distance).
- **DTE:** Earth visible **and** at least one DSN antenna sees the Moon ≥ 6°.
- **Limits:** the Moon's centre stands in for the lander (≤ 0.26° from Earth); station terrain masks (module 301), DSN scheduling and link budgets are not modelled — the Window Finder says "geometric".

## 7. Site catalog data (web)
- Per site, `web/public/data/sites/<id>.bin` = horizon block + table block.
- **Horizon block:** 1,440 azimuths × 19 points (centre, 6 at 125 m, 12 at 250 m) × 4 heights (1, 2, 5, 10 m), int16 steps of 1/256°, delta along azimuth, byte-shuffled ([az][pt][z]). Layers: Barker 5 m site DEM to 3 km where it exists, then 20/80/240 m to 25/150/300 km, with NaN fallback to the next layer.
- **Table block:** every 10 min from 2026-11-01 to 2029-01-01 (114,048 steps): Sun and Earth grid azimuth (uint16 units of 360/65536°), elevation (0.001°), angular radius (Sun 0.25° + k·1e-6°, Earth 0.85° + k·1e-5°), each delta-coded mod 2¹⁶ and byte-shuffled. Observer: site centre, 2 m above ground. Rounding: ≤ 0.0027° in azimuth, 0.0005° in elevation.
- `dsn.bin`: one byte per step, bit k = station k sees the Moon ≥ 6°.
- Python computes the V5 golden values from the *decoded* numbers, so the browser must reproduce them to < 1e-6.

## 8. Mission-window metrics (Compare, Window Finder)
For a stay [t, t + D) sampled every 10 min, at one point and height:
- **Sunlight %** = mean visible solar-disc fraction (same quantity as Barker 2021 "average illumination").
- **Longest darkness** = longest run with no part of the Sun visible (battery sizing).
- **Earth in view %** = share of steps with Earth's centre above the horizon.
- **DTE %** = share of steps with a DTE link; **longest blackout** = longest run without one.
- **Solar energy** = Σ 1361 W/m² · (1 au/d)² · fraction · Δt per day, on a Sun-tracking panel before efficiency (TSI: Kopp & Lean 2011; d from the true solar radius: d = R☉ / sin r).
- **Window Finder:** every landing hour whose whole stay fits in the table; a landing passes when every requirement holds. Margins are signed distances to each requirement. **Minimal relaxation** = for each requirement, the best value reached by landings that already meet all the others (exact over the search) — the smallest single change that opens at least one window.
- **Robustness:** the same window evaluated at the 19 landing-dispersion points (250 m radius, IM-2's miss distance).
- **Battery:** starting full, each 10-minute step adds solar energy on a Sun-tracking panel (incident energy above × panel area × efficiency) and removes the load, clamped to [0, capacity]; a step whose load cannot be fully met counts as "short". Reported: lowest charge (%), hours short, final charge. Panel area, efficiency, load and capacity are user inputs; the defaults (2 m², 30 %, 150 W, 3 kWh) are an example, not a specific lander. Window Finder can require "battery never runs out". Python twin `windows.battery`, V5 golden.
- Code: `web/src/engine/windows.ts` (worker `windows.worker.ts`), Python twin `pipeline/sunchaser/windows.py`.

## 9. Light painting and permanent shadow
- **Light painting:** per 40 m hero cell, the running average over the 30-day track of the visible solar-disc fraction (Sun) or of the Earth-visible flag (Earth), at 24 checkpoints so it can "paint itself" in; computed in a Web Worker with the same horizon lookup and disc formula as the panel stats (`engine/lightmap.ts`, unit-tested against per-hour values).
- **PSR layer:** NASA Goddard's permanent-shadow map `LPSR_85S_060M_201608` (PGDA product 69, Mazarico et al. 2011; value = DN·0.000025 + 0.5), sampled at each 40 m cell centre. **Speck filter (rule fixed after measuring):** only patches of ≥ 9 cells (0.0144 km², ~4 map pixels) are shown. Measured in the hero region for Jan 2027: patches of 1–8 cells receive a median 30 % sunlight in our 20 m engine (only 9 % fully dark), while patches ≥ 25 cells are 94 % fully dark — the small specks are the pixel-scale noise also seen in V3. Raw map: 3.2 % of the region; shown: 1.3 %.

## 10. Explore time range: hourly tracks 2020–2045

`sunchaser.export_tracks` computes, for every hour from 2020-01-01 00:00 to 2045-12-31 23:00 UTC (227,928 hours) at the
hero region centre: Sun and Earth grid azimuth, elevation and distance (§2, `spkcpo`, `CN+S`), Earth's orientation
(`IAU_EARTH` → scene) and the sky orientation (`J2000` → `MOON_ME` → scene, for the stars). Each channel is quantised
(angles 1e-6°, distance 0.1 km, quaternion components 1e-7), second-differenced into int32 and byte-shuffled, one file
per year (~490 kB raw, ~110 kB compressed); azimuths are unwrapped within the year. The browser decodes a year on
demand, cuts any period of 1–366 days (stitching across year boundaries), and computes the period statistics and light
painting with the same engine as before. Checked by V1c (vs JPL Horizons over the whole range) and V5c (Python ≡ TS).
The almanac in the Time Machine averages the same hourly series per UTC day (Sun: mean visible disc; Earth: share of
hours with any part above the terrain).

## 11. Visual rendering (no number depends on it)

- **Reflectance:** lunar-Lambert, r = 2L(g)μ0/(μ0+μ) + (1−L(g))μ0 with L(g) = 1 − 0.019g + 2.42e-4g² − 1.46e-6g³
  (g phase angle in degrees, clamped to ≤ 110°; McEwen 1991, coefficients as in USGS ISIS `LunarLambertMcEwen`).
  On the hero terrain this multiplies the computed visible-disc fraction (§3, §4); a mild exposure curve (r^0.8)
  keeps grazing-lit ground readable. All custom shaders share one ACES filmic tone curve and sRGB encoding.
- **Earthshine:** on the hero terrain, ground facing a visible Earth (Earth's disc fraction above the same horizons)
  gets a bluish fill ∝ Earth's lit fraction (1 − ŝ·ê)/2, boosted ~300× for display.
- **Far field:** LOLA 80 m resampled (Gaussian pre-filter, bilinear) to ±8 km at 80 m (right outside each region),
  ±25 km at 250 m and ±150 km at 1 km, on the
  curved Moon (drop d²/2R), shaded the same way and shadowed with a 4096² shadow map fitted along the Sun direction.
  The hero mesh also drops d²/2R (≤ 7 m at its edges).
- **Sky:** Hipparcos (ESA 1997, CDS I/239) stars with V ≤ 7.5 (25,493) at epoch 2030.0 (proper motion applied),
  colour from B−V via Ballesteros' temperature and a blackbody → CIE 1931 → sRGB; NASA SVS Deep Star Maps 2020
  Milky Way (Hipparcos/Tycho stars removed, so nothing is drawn twice), in J2000 and rotated by the hourly sky
  quaternion. Orientation check: the map's brightest region is at RA 272°, Dec −29° (galactic centre RA 266°, Dec −29°).
- **Sun:** true angular radius, limb darkening I/I0 = 1 − 0.6(1 − μ), camera glare that fades when terrain covers the
  Sun's pixel. **Earth:** Blue Marble NG day, Black Marble night lights, clouds, ocean glint, a thin limb; true
  orientation and phase. **Moon globe:** LROC WAC colour + LOLA ldem_16 normals (×1.5 relief) and a LOLA 80 m polar
  cap below 77–80°S, lit by the true Sun direction, earthshine on the night side.
- **Micro-relief:** a tileable normal map (value noise + power-law craters, built in the browser) perturbs the shading
  normal below the 20 m DEM scale, fading with distance; light still falls only where the horizons say.
- **Close-ups (tap Earth or the Sun):** same scene axes and SPICE quaternions as Explore. Earth: separate cloud layer and
  an atmosphere whose brightness follows the view ray's closest approach to Earth (exp(-(b-1)/0.011), ~70 km scale);
  the Moon drawn at its true size and distance; the three DSN 70 m dishes (geodetic positions from the pinned station
  kernel) with the Moon's elevation computed from each dish's own position (topocentric, ≥ 6° = in reach). Sun:
  distance, light time, irradiance 1361 (1 au / d)² W/m² and apparent diameter from SPICE; the surface (Worley-cell
  granulation baked once on the GPU, quadratic limb darkening, spots, faculae, prominences, corona) is illustrative and
  spins about the IAU solar pole (RA 286.13°, Dec 63.87°) in time-lapse.
- **Gestures:** pressing on the Sun (within its disc or 28 px) and dragging scrubs time to the hour whose Sun azimuth
  matches the pointer; a tap without movement flies to the body. The gesture is handled before the camera controls and
  ends on pointer-up, cancel, lost capture or window blur.
- **Moon globe, free exploration:** the sphere is drawn as 8 × 4 patches of 45°; each patch fades in its own LOLA
  `ldem_64` relief tile (16384 × 8192 overall, ~0.67 km/px at the equator, ×1.5 relief like the base map) when it faces
  the camera below 3,200 km (at most 12 tiles kept). South of 77–80°S the LOLA 80 m polar cap takes over (297 m/px),
  and a 104 m/px cap (±212 km, every catalogued site) loads when the camera is over the pole below 2,500 km. Zoom and
  rotate speeds scale with altitude (one wheel step ≈ 15 % of the height, 8 km to 15,000 km) and the near plane follows
  the altitude. Near the pole the globe also casts shadows: a march toward the Sun over LOLA heights (594 m over
  ±304 km; native 80 m over ±82 km, 5 MB, loaded when the camera comes within 700 km of the pole) on the curved Moon,
  with the Sun's disc as a soft penumbra; below 600 km the relief shading uses the same 80 m heights. Visual only —
  the numbers come from the exact horizons (§5).
- **Where Sunchaser works:** the study area (convex hull of all catalogued sites + 14 km, animated amber edge) and the
  region being explored (cyan square, 10 or 5 km) are drawn in polar stereographic grid coordinates in the globe
  shader, with screen-space line widths, so the study area cannot be mistaken for another spot.

## 12. Light Path — rover traverse planner

**Grid.** 80 m cells over the analysed 10 km region (125 × 125). Slope: LOLA 20 m heights averaged to 40 m blocks,
central differences over 80 m, the steepest of the cell's blocks; a cell is drivable when that slope is below the limit.
Lighting: for every hour of a 7-day window from the departure, the visible Sun and Earth disc fractions at each cell
centre, from the same horizons, tracks and formula as every other number (§3, §5, §10).

**Rover (defaults, editable).** VIPER-class values from NASA documents (docs/DATA.md): drive speed 10 cm/s (360 m/h),
15° slope design limit, 5,420 Wh battery, 450 W solar with the Sun on a panel corner (scaled by the visible disc fraction
and (1 au / d)²), driving load 602 W = 5,420 Wh / "9 h ops in a PSR", waiting load 108 W = 5,420 Wh / "50 h survival in
low-power mode", reserve 20 %. The derived loads are our assumption, stated as such.

**Search.** Time in hours split into K = floor(speed / 80 m) sub-steps, so each sub-step is at most one 4-neighbour move
(the route's driven length is therefore ≤ speed per hour exactly). Each sub-step the rover either waits (waiting load)
or moves into a drivable neighbour (driving load); its battery changes by (solar − load) / K, capped at capacity, and
states below the reserve are discarded. For a given cell and moment only the highest battery charge is kept — more
charge can do everything less charge can — so the search is exact, not heuristic. The first sub-step at which the
target holds a state is the **earliest arrival**; the route is traced back. Checked by V6 (independent checker,
mutation tests, exhaustive search on small grids).

**Display.** The route is drawn as a ribbon over the terrain (amber in sunlight, blue on battery), smoothed for display
only (Chaikin, twice); waits of an hour or more are labelled; the rover is placed at the current hour along the route.
"Why this route" sentences come from the route itself (wait at the start, detour ratio vs the straight line, hours in
shadow). Limits: rover-scale obstacles and slopes below the LOLA resolution are not seen; solar input assumes the
panels face the Sun; no thermal model; Earth contact is reported, not required.

## 13. Astronaut's eye

The camera stands 2 m above the rendered surface (bilinear between DEM vertices) — the height the horizons are computed
for — and turns with the pointer. The point's computed horizon (180 azimuth bins, as stored) is drawn as a thin line on
the sky; where the rendered mountains meet it, the 3D picture and the numbers agree (the rendered far field ends at
150 km and is coarser, so small departures beyond it are expected). Gauges: visible Sun fraction and irradiance
(1361 W/m² × fraction / d²), visible Earth fraction and the number of DSN 70 m dishes that see the Moon ≥ 6°.

**The ground at your feet (visual only).** At 2 m the 20 m DEM alone looks like smooth plastic, so a 600 m patch
follows the walker: vertices 12 cm apart under the eye and ~5 m at its rim, standing on the same bilinear DEM surface,
plus micro-relief below the DEM's resolution (rolling regolith from value noise; craters 0.5–14 m across at three
scales with bowl, rim and degraded-to-fresh depths 0.08–0.24 r), and ~1,500 rocks (0.15–3 m, sizes skewed to the small
end). All of it comes from an integer hash of position, so the ground is the same on every visit; the walker stands on
exactly the drawn height (the same function in JS and GLSL, `scene/micro.ts`). Light at the DEM scale is still the
horizon disc fraction (§5) — identical lookups to the terrain — and a 2048² sun-aligned shadow map adds the long
shadows of rocks and bumps (world-locked texels, so they do not crawl while you walk). No number reads any of it.
The walkable area is the region minus the patch radius; at its edge a notice says the numbers stop there.

## 14. Every site in 3D (site regions)

**Terrain and horizons.** Each catalogued site besides Connecting Ridge gets a 5 × 5 km region centred on its point:
LOLA 20 m terrain (250 × 250), horizons on 40 m cells (125 × 125) in 180 azimuths at 2 m, from the same exact ray walk
and DEM layers as the hero region (§5), NASA's permanent-shadow mask (§9) and far-field rings (§11) centred on it.
Where a layer's product ends (the 80 m map stops 304 km from the pole) the walk reads the next, wider layer, as for the
site horizons (§6); the PSR mask is the 60 m product to 85°S and the 120 m product beyond.
`python -m sunchaser.export_regions` → `web/public/data/regions/<id>/`, listed in `regions/index.json`. Everything the
3D views compute (live shadows, light painting, period statistics, Light Path, Astronaut's eye) then runs on that
region exactly as on the hero region.

**Sun and Earth.** Tracks are not duplicated per site. The browser derives them from the hero region's SPICE tracks
(§10): the hero direction (grid azimuth, elevation) and distance give the body's position relative to the hero centre in
MOON_ME (rows of `scene_from_me` transposed); adding the hero centre and subtracting the site centre (both on the
1737.4 km sphere plus the DEM height) gives the vector from the site — exact, including Earth's parallax of up to
~0.26° between sites ~30 km apart; it is turned into the site's scene axes (`scene_from_me` of the site) and back into
azimuth/elevation/distance. Earth's and the sky's orientation quaternions are left-multiplied by the frame rotation
N·Mᵀ. Light time differs between sites by < 0.1 ms (negligible). Code: `web/src/engine/regiontracks.ts`, mirrored by
`pipeline/sunchaser/export_regions.derive`. Check: V5d.

**Window Finder → Explore.** "View this landing in 3D" opens the picked site's region at the landing hour, with a period
starting that UTC day and covering the stay, and a card with touchdown, stay length and shortcuts (jump to touchdown,
play the stay). The Window Finder computes at the site point at the chosen panel height; the 3D view shows the 2 m
horizons of the 40 m cell under that point, so numbers can differ slightly between the two at heights other than 2 m.

## 15. Landing safety and science access (NASA's other two site criteria)

NASA chose the Artemis III candidate regions for lighting, Earth communications, **terrain slope** and **proximity to a
permanently shadowed region** (water ice), with a landing site taken as a ~100 m radius circle (NASA news release,
19 Aug 2022). Sunchaser's lighting and comms are §3–§8; these are the other two.

- **Slope:** every LOLA 20 m cell (central differences, one-sided at edges, as `numpy.gradient`) whose centre lies within
  100 m of the point: median, 95th percentile, maximum, and the share below a lander limit (user setting 5–15°, default
  10°; NASA publishes no single number and landers differ). Verdict: *safe* if the steepest 5 % is under the limit,
  *marginal* if only the median is, else *too steep*. Pipeline `sunchaser/site_terrain.py` (per site, Compare) and
  browser `engine/terrainmetrics.ts` (any point, Explore) give identical results on the real terrain (test
  `terrainmetrics.test.ts`).
- **Nearest permanent shadow:** distance and direction to the nearest PSR cell (PGDA product 69, 60 m to 85°S, else
  120 m; specks < 4 cells removed as in §9): per site within 40 km (pipeline), and within the 3D region for any point.
- **Limit (stated in the app):** 20 m cannot see boulders or craters a few metres across. IM-2 Athena's touchdown point
  looks under 5° at this scale, yet the lander tipped over in a small crater.

## 16. Learn page figures (teaching, not analysis)
- **Tilt explorer:** solar elevation sin e = sin φ sin δ + cos φ cos δ cos H over one rotation, with declination
  δ = tilt · sin(2π · season). Tilts: Moon 1.54° (the lunar spin axis to the ecliptic normal, Cassini state; IAU WGCCRE,
  Archinal et al. 2018) and Earth 23.44° (IAU 2006 obliquity, 84,381.406″). The ridge line is a 300 m ridge 10 km away
  over the curved Moon: atan((0.3 − 10²/(2 R)) / 10), R = 1,737.4 km → 1.55°. Unit-tested in `views/learn.test.ts`.
  It is a teaching model (no terrain, no libration); the numbers in the app come from §2–§5.
- **Disc explorer:** the engine's own `visibleDiscFraction` (§3) at the mean solar radius (1 au), with TSI 1,361 W/m²
  (Kopp & Lean 2011) for the watts.
- **Horizon view and site criteria:** the real site data through the same worker as Compare (1–30 Jan 2027, 2 m above
  ground, example power system), and the slope/PSR fields of §15.

## 17. Mission clock and landing accuracy
- **Conditions as margins (degrees, positive while true):** Sun up = Sun elevation − terrain horizon in its direction +
  the Sun's angular radius (some of the disc visible, §3); Earth up = Earth elevation − horizon (centre above the
  terrain, §6); DSN = highest Moon elevation over the three 70 m antennas − 6° (§6); link to Earth = min(Earth up, DSN);
  ops window = min(Sun up, link). Same horizons, tracks and DSN geometry as every other number.
- **Next change:** the next sign change after the current time, by linear interpolation between samples (hourly in
  the 3D view, so the minute is approximate; 10-minute steps in the horizon view). The sunset point is the Sun's
  direction at that moment, on the skyline. Code `web/src/engine/clock.ts`, test `clock.test.ts`.
- **Compare, at landing:** steps from the landing time until the Sun (visible fraction > 0) or the DTE flag changes, on
  the site's 10-minute series (searched up to 90 days).
- **Landing accuracy:** the catalog's landing-dispersion pattern (centre, 6 points at 125 m, 12 at 250 m; pipeline
  `build_sites.dispersion_points`). Sites: every point has its own exact horizons (worker `spread`). 3D view: the same
  pattern around any clicked point, from the region's 40 m horizon grid. Reported: the range of sunlight (mean visible
  disc, %) and link time (%) over the period.
- **Limits:** hourly sampling in 3D can miss changes shorter than an hour; a dispersion of 250 m is our choice to show
  sensitivity, not a lander's guaranteed accuracy.

## 18. Replan: launch slips
- **Question:** a landing planned at site S, time T slips by d days. For every catalog site and every d from −30 to +150,
  the landing at T + d days (same time of day) is checked over the whole stay against the mission's requirements,
  with the same metrics and pass rules as the Window Finder (§8: sunlight %, longest darkness, link %, longest blackout,
  battery). Worker message `slip`; days whose stay runs past the ephemeris table are marked "no data".
- **Answers:** (1) the planned site on the new date: GO/NO-GO with each requirement's value and limit; (2) the first
  later day that meets everything at the planned site; (3) Plan B: other sites meeting everything on the new date,
  nearest first (distance on the polar stereographic grid, within 0.3 % of the surface distance south of 84°S); if none,
  the closest day, either side, on which some site works. Helpers `engine/replan.ts`, test `replan.test.ts`.
- **Why a month helps:** the Sun's and Earth's patterns at a polar site roughly repeat each synodic month (29.53 d),
  so the slider offers a one-month slip; the numbers, not the rule of thumb, decide.
- **Limits:** whole-day slips at a fixed time of day (the Window Finder searches every hour); requirements are the
  user's; distances are straight-line, not traverse routes.

## 19. Lunar atlas: landing sites anywhere on the Moon
- **Sites:** 15 published landing points (`pipeline/sunchaser/atlas.json`): Apollo 11–17 (Lunar Module, NASA NSSDCA,
  Wagner et al. 2017), Chang'e 3–6, Chandrayaan-3, SLIM, IM-1, Blue Ghost 1 (LROC / NASA pages), and the IM-3 target
  region (IAU gazetteer centre of Reiner Gamma). Coordinates are planetocentric MOON_ME, copied from the source named
  on each entry; Blue Ghost 1 is LROC's landing-region centre and IM-3 a feature centre, said so in the app.
- **Horizons:** the same exact ray walk as every other site (§5), on an oblique stereographic grid: the polar projection
  after a rotation that puts the site at the pole, its north on grid +y and east on +x, so grid bearings are true
  azimuths. Terrain: LOLA GDR LDEM_64 (474 m) to 30 km and LDEM_16 (1895 m) to 300 km, bilinear, heights above the
  1737.4 km sphere. Test `pipeline/tests/test_atlas.py`. Coarser than the 5–20 m polar maps: stated in the app.
- **Sun and Earth:** derived from the reference site's tables (Connecting Ridge): the body's position seen from the
  reference observer (direction + distance from the angular radius) minus the atlas observer's position, in the atlas
  site's east/north/up. Light time and aberration are the reference observer's (differences below 1e-6°). V9.
- **Not available for atlas sites:** landing slope and nearest permanent shadow (need the 20 m polar maps), 3D view.
- **Plan B** (§18) considers only sites within 400 km of the planned one (the "same region"), by great-circle distance.

## 20. Drop a pin anywhere
- **Input:** a tap on the globe (the view ray meets the 1737.4 km sphere) or typed coordinates ("12.5 S, 33 E",
  "-12.5, 33"); rounded to 1e-5° (~0.3 m), shareable as `?pin=lat,lon`.
- **Terrain:** the same products as the atlas (§19). LDEM_16 is shipped as 288 tiles of 15° × 15° (lossless int16,
  zlib; `python -m sunchaser.export_globalterrain`); LDEM_64 comes from `web/api/dem.ts`, a serverless function that
  crops ±1.6° around the pin from the NASA PDS file with one multi-range HTTP request (the PDS server allows no direct
  browser reads). Poleward of 86°, or when the function is unreachable, the near field uses LDEM_16 and the app says so.
- **Horizons:** `web/src/engine/pinhorizon.ts`, a line-by-line port of the atlas build (oblique stereographic grid,
  bilinear resampling, float32) and of the exact ray walk (`horizon._march_dda`): 1,440 azimuths × 19 landing points ×
  4 heights, on up to 6 Web Workers; the four heights share each ray's terrain samples. V11.
- **Sun and Earth:** derived from the reference site's tables exactly as for atlas sites (§19); the pin then joins the
  catalog in the windows worker, so Compare, the horizon view, mission clock, landing spread, Window Finder and Replan
  all work on it. No landing slope or permanent-shadow distance (need the 20 m polar maps).

## 21. A pin in 3D: the whole Moon as a landscape
- **Region:** 24 × 24 km around the pin on its oblique stereographic grid (§19: grid +x east, +y north, so grid bearings
  are azimuths; scene axes in MOON_ME `[E, U, −N]`), mesh of 400 × 400 points at 60 m, centre height as the scene origin.
- **Terrain:** SLDEM2015 (LOLA + SELENE Terrain Camera, 512 px/deg ≈ 59 m, Barker et al. 2016) within ±60°, LOLA
  LDEM_512 (59 m) poleward of it — cropped ±16.6 km from the PDS tiles by `web/api/dem.ts` (one multi-range request per
  tile touched, int16 0.5 m out) and resampled bilinearly. LDEM_64 to ±32 km and LDEM_16 to 300 km as in §20. LOLA-only
  LDEM_512/1024 were rejected at low latitude: they are interpolated between laser tracks (stripes); SLDEM2015 is not.
  Beyond ~79° the 59 m crop exceeds the function's 4.5 MB limit and the near terrain falls back to 474 m (said so).
- **Shadows:** a horizon grid of 200 × 200 cells (120 m) × 180 azimuths at 2 m, marched on the GPU
  (`scene/horizonGpu.ts`, one fragment per cell and azimuth) through the three layers, the finest that covers each sample;
  step = clamp(0.005 s, res/2, res) of that layer; exact inverse-stereographic geometry written as differences of small
  numbers (`engine/pinregion.sinElev`, test `pinregion.test.ts`). Then the standard terrain shader (§7) shades it from
  the horizons; V12 checks the GPU against the CPU.
- **Surroundings and colour:** far-field rings to 150 km (visual only, as for the polar regions); albedo relative to the
  Moon's mean from the globe's LRO WAC colour map (2.6 km), smooth, on the mesh and the rings; auto-exposure for a Sun
  higher than the pole's grazing Sun (no change below ~8°).
- **Sun, Earth, sky:** derived from the hero tracks by `engine/regiontracks` (V5d), as for every region.
- **Not available:** landing slope and permanent shadow (need the 20 m polar maps), Light Path.

## 22. Scenario board and mission brief
- **Scenario:** a site, a landing time (UTC) and a stay (1–60 days); the board holds up to four (A–D), shareable as
  `?mode=scenarios&sc=site,time,days;...&bt=title`. Requirements, power system and panel height are shared.
- **Run** (`engine/scenario.runScenario`, in the windows worker): the window metrics of §11 over the stay
  (identical to Compare, test `scenario.test.ts`), hourly ribbons (mean visible Sun fraction, link share), the battery
  charge step by step (the same arithmetic as `windows.battery`), the state changes during the stay (sunset, sunrise,
  link lost / back, battery empty / recovers), where the landing falls in the lunar day (hours since the last and until
  the next sunrise or sunset, searched ±45 days), the mean terrain horizon under the Sun's path (Sun above −2°), the
  Sun's highest elevation, and Earth's mean elevation and mean horizon toward it.
- **What changed** (`engine/scenario.explain`), B against A: when both the site and the "when" (landing time + stay)
  differ, the two crossed cases are run (B's site with A's timing, A's site with B's timing) and each change in sunlight
  and link is split into a date part and a site part by averaging the two orders (the Shapley value of two factors):
  date = ½[(A@B-time − A) + (B − B@A-time)], site = total − date. The split is exact (date + site = total). Sentences then
  name the physics: where in the lunar day each landing falls; for polar sites the Sun's highest elevation (season) and
  the skyline under its path; between a polar and a non-polar site, the 14.8-day night of a lunar month; the battery's
  hours of darkness (capacity / load) against the longest night; Earth's clearance above the terrain, libration
  (Earth below the level horizon) and the far side (Earth never rises).
- **Mission clock:** the ribbons aligned by mission day (landing = day 0) or by calendar date, with a shared cursor and
  a play control that runs all scenarios in step.
- **Mission brief:** one A4 page (print or save as PDF): scenarios table, the mission clock, what changed, key events in
  UTC, engineering assumptions (power, link definition), science and method (data, validations), sources and the live
  link. It measures itself and scales to fit one page.

## 23. Mission stories and the Explore upgrades
- **Stories mode** (`views/StoriesView.tsx`, figures in `views/storyFigures.tsx`; `?mode=stories&story=im2|apollo|farside&ch=N`):
  three chaptered stories whose figures are computed live from the app's data; each ends in the 3D view.
- **"250 metres" (IM-2 Athena):** the im2-target region (LOLA 20 m terrain, its 40 m horizon grid) with the Sun from
  the SPICE tracks derived to the region (§14), from touchdown (6 March 2025, 17:28:50 UTC; Wikipedia "IM-2") for 12 days.
  The draggable lander reads the mean visible solar disc over those 12 days (`series.siteSeries`) and the 100 m landing
  circle's slope (§15 arithmetic on the region's terrain); GO = the app defaults (sunlight ≥ 70 %, steepest 5 % < 8°).
  Finding stated in the story: on these maps the target and Athena's resting point (LROC 1401 / 1408, 370 m apart) both
  have 100 % sunlight and gentle slopes; the ~20 m crater (LROC 1408) is one map cell. The story does not claim
  Sunchaser would have saved the mission.
- **"Why Apollo landed at dawn":** `pipeline/sunchaser/export_stories.py` → `web/public/data/stories.json`: the Sun and
  Earth at the six Apollo touchdowns (NSSDCA times, cross-checked as launch + GET) from SPICE at the NSSDCA LM coordinates
  (2 m above the LOLA ground), and the Sun hourly over that lunar day. Result: 5.15°–14.76° up, azimuth 86°–96°. The
  relief figure lights SLDEM2015 (59 m, ±6 km, via `/api/dem`) with that Sun: Lambert shading, cast shadows by walking
  each pixel toward the Sun on the height grid, the 3D view's auto-exposure.
- **"The side that never sees Earth":** Earth's elevation hourly over 1 Jan – 1 Mar 2027 from the atlas tables (§19) at
  Apollo 11, Blue Ghost 1, Chang'e 6 and Chang'e 4; an orbit diagram (one turn per 27.3-day orbit) and a relay diagram
  (Queqiao at the Earth–Moon L2 point; no distances drawn to scale).
- **Mission clock hero**: the Sun's next change at the point and the share of the current light (or night) that has
  passed; an operations ribbon (Sun, link, ops windows over the period, click to jump).
- **Landing heat map**: sunlight over the period on a 21 × 21 grid (30 m spacing, ±300 m) around the point, from the
  same horizon grid; hover to read, click to move the point there.
- **Display only:** the airless Moon's shadows are black. Every ground shader shares one response
  (`scene/display.ts regolith`): no scattered-light lift in shadows (1 % ambient), earthshine
  boosted for display at half the earlier level, grazing sunlight is
  compressed (ll^0.6, like a camera exposed for the lit ground) so sunlit plains stay clearly brighter than any
  shadow, and the gain keeps regolith grey; the ground's brightness varies at two scales (fine speckle, broad
  mottle). A version that lifted shadows to 3 % read as flat grey, close to grazing-lit plains. No number
  reads any of it: sunlight figures come from the horizons alone. The globe streams ~4.6 km colour tiles with its relief tiles
  (DATA.md); a pin's 3D ground takes its brightness from them (a longitude offset that sampled the map 180° away, so
  mare read bright and highlands dark, was fixed the same day). Away from the south polar caps the
  globe's zoom stops 300 km up, where the global 474 m relief is still sharp; closer views go through a pin's 3D region.
  "Go to coordinates" (home) flies the camera to the point and drops the pin there (checked: pins at Tycho and
  Copernicus land on the craters' central peaks in the LROC imagery).


## 24. Ask Sunchaser: the copilot (no number of its own)
- **What it is:** a chat panel on every view (`web/src/copilot/CopilotPanel.tsx`, Ctrl+K). Questions in English or
  Arabic, typed or spoken (browser speech recognition); answers can be read aloud.
- **Where the numbers come from:** the AI model only chooses tools and writes sentences. The tools
  (`copilot/tools.ts`) run in the browser on the same worker and engine as the views: `compare_sites` (Compare's
  metrics, §8), `check_landing` (the scenario run, §22), `find_windows` (the Window Finder search and ranking, §8),
  `explain_change` (§22's date/site split), `sky_at` (Sun, Earth and DSN at one 10-minute step: the §3 disc fraction
  over the §5 horizon), `search_knowledge` (short method notes plus the app's validation record and limitations,
  `copilot/knowledge.ts`), `show` (a button that opens a view on the answer). The system prompt
  (`api/copilot.ts`) forbids stating a number no tool returned.
- **Grounding check, live:** `copilot/agent.ts ground()` compares every number in the answer with the numbers in that
  question's tool results, the question and the app state (rounded to the answer's precision; also hours ↔ days,
  % ↔ fraction, Wh ↔ kWh). The badge under each answer says "N numbers traced to the engine" or names the ones it
  could not trace. V13 runs it over a fixed question set.
- **Providers, in order** (`api/copilot.ts`, a Vercel function holding the keys): Google Gemini free tier
  (gemini-3.6-flash → gemini-3.5-flash → gemini-flash-lite-latest → gemini-3.5-flash-lite, low thinking), then Groq free
  tier (openai/gpt-oss-120b → qwen/qwen3.8-27b → openai/gpt-oss-20b). A model that returns a quota or overload error, or
  takes over 9 s, rests for 60 s and the next is tried. The browser runs the tool loop (at most 6 rounds).
- **Offline mode** (`copilot/offline.ts`): with no internet, no keys or every quota used, a keyword router (English and
  Arabic: sites, dates, coordinates, stays, slips, thresholds) calls one of the same tools and fills a written
  template, so it is narrower but its numbers are the engine's.
- **Limits:** per IP 30 requests a minute and 600 a day (one question takes 2–4), best effort per server instance;
  the model can still misread a question or attach a true number to the wrong thing, so each answer links to the
  view that shows it.
