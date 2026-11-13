# Data — Sunchaser

Every dataset, kernel, coordinate source and third-party library we use. Checksums are SHA-256.

## SPICE kernels (NAIF generic kernels, NASA/JPL)
Base URL `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`. Downloaded and pinned by `pipeline/sunchaser/fetch.py` (fails loudly on mismatch).

| File | Path | Size | SHA-256 | Use |
|---|---|---|---|---|
| naif0012.tls | lsk/ | 5,257 B | 678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b | UTC ↔ TDB leap seconds |
| pck00011.tpc | pck/ | 131,226 B | 3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1 | body constants |
| moon_pa_de440_200625.bpc | pck/ | 12,863,488 B | 60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f | lunar orientation (DE440 PA) |
| moon_de440_250416.tf | fk/satellites/ | 19,478 B | a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768 | defines `MOON_ME` = alias of `MOON_ME_DE440_ME421` |
| de440s.bsp | spk/planets/ | 32,726,016 B | c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2 | planetary ephemeris 1849–2150 |

**Frame note (from the kernel's own comments):** `MOON_ME_DE440_ME421` is aligned with the DE421 mean-Earth frame used by the LOLA DEMs; max difference 3.07e-7 rad (≈ 0.53 m on the surface) over 2000–2040. The PA↔ME rotation is 0.02886° (≈ 875 m), so using `MOON_PA` by mistake would be a visible error.

## LOLA south pole DEMs (NASA GSFC PGDA)
Barker, M.K. et al. 2023, *PSJ* 4:183, doi:10.3847/PSJ/acf3e1; data doi:10.60903/gsfcpgda-lola-spole. Cloud-optimized GeoTIFF (deflate, 512×512 tiles, overviews 2–64), read by HTTP range requests (`rasterio` `/vsicurl/`).

| Product | URL | Size (bytes) | Grid |
|---|---|---|---|
| 20 m | https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF | 2,696,082,051 | 30,400², ±304 km |
| 40 m | https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_40MPP_ADJ.TIF | 716,299,920 | |
| 80 m | https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_80MPP_ADJ.TIF | 189,158,392 | |
| 240 m | https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_60S_240MPP_ADJ.TIF | 218,961,039 | |
| 10 m | https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_83S_10MPP_ADJ.TIF | 5,116,709,568 | not used yet |

CRS (read from the file): `+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400`, sphere "Moon (2015)". Values: float32 metres above the 1737.4 km sphere (GMT history: km × 1000), NaN = no data, pixel-is-area. Last-Modified 2023-07-07.

### 5 m site products (PGDA product 78, Barker et al. 2021)
Base `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/`. 5 m GeoTIFFs, south polar stereographic, MOON_ME (DE421), pixel-registered. Pinned by `fetch.SITE_FILES`.

| File | Size | SHA-256 | Use |
|---|---|---|---|
| Site01/Site01_final_adj_5mpp_surf.tif | 40,980,810 B (3200², x −19…−3 km, y −20…−4 km, uncompressed strips) | 3ba7b97cb00a2bcf21189c3aeb535f65afc21207154ab9f0d43c5bdc1f7e747e | innermost horizon layer for V2 |
| Site01/Site01_ROIs.tgz | 2,934 B | 40b961417a344ce0274aecbab522e171a22f658507d82e8fb4d7bc97526ffc4f | RoI polygons (shapefile, 7 records; record 4 = Table 2 RoI 4) |

Available, not yet used: 100 DEM error clones per site (`Site01/Clones/`, ~41 MB each) for V2c and robustness.

### Web data derived from it
`web/public/data/terrain_connecting-ridge-roi4_20mpp.bin`: 500 × 500 float32 window of the 20 m DEM centred on Connecting Ridge RoI 4 (top-left corner x0 = −16,300 m, y0 = −7,160 m). Its SHA-256 is written into `manifest.json` by `python -m sunchaser.export`.

### Site regions (`python -m sunchaser.export_regions`)
`web/public/data/regions/<site id>/`: `terrain.bin` (250 × 250 float32 window of the same 20 m DEM, centred on the
site), `horizon.bin` (180 × 125 × 125, packed as the hero horizons), `psr.bin` (PGDA product 69 LPSR, nearest pixel),
`farfield.bin` (LDEM_80S_80MPP_ADJ rings: ±8 km at 80 m, ±25 km at 250 m, ±150 km at 1 km; LDEM_60S_240MPP_ADJ
beyond 304 km), `manifest.json` with every source URL
and the SHA-256 of terrain and horizons. PSR beyond 85°S: PGDA product 69 `LPSR_75S_120M_201608.TIF`
(https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_75S_120M_201608.TIF, 120 m, ±457 km), read by range requests. Index: `regions/index.json`. About 6 MB per site (2.4 MB gzip-compressed horizons), fetched only when that
site is opened.

### Full-file copies (pinned)
| File | Size | SHA-256 |
|---|---|---|
| LDEM_80S_80MPP_ADJ.TIF | 189,158,392 B | 82030dcbdd7c4bb0c7d858e9b4b293b9f2cda5a543ba31ec0f42784bd6beee5a |
| LDEM_60S_240MPP_ADJ.TIF | 218,961,039 B | 3f9663257b63022f2b0d5a623482ff3cadddceb91594a4e4ca14a94d8cec8b34 |

### PGDA illumination products (product 69, Mazarico et al. 2011; read by range requests)
`https://pgda.gsfc.nasa.gov/data/MoonIllumination/` — `AVGVISIB_85S_060M_201608.TIF` (33,994,464 B), `AVGVISIB_85S_060M_201608_EARTH.TIF` (24,862,958 B), `AVGVISIB_75S_120M_201608.TIF` (83,052,039 B), `AVGVISIB_75S_120M_201608_EARTH.TIF` (43,148,153 B); `LPSR_85S_060M_201608.TIF` (PSR map). int16, value = DN × 0.00004 = fraction of hourly time steps with any part of the disc visible (PDS labels at imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/*.LBL).

## LOLA global maps (atlas sites)
NASA PDS Geosciences Node, LRO LOLA GDR (Smith et al.), `lrolol_1xxx/data/lola_gdr/cylindrical/img/`, read by HTTP
range requests (rows around each site), int16 × 0.5 m above the 1737.4 km sphere, simple cylindrical, 0–360°E:
| Product | Size | Grid | Use |
|---|---|---|---|
| ldem_64.img (+ .lbl) | 530,841,600 B | 23040 × 11520, 473.8 m/pix | atlas horizons 0–30 km |
| ldem_16.img (+ .lbl) | 33,177,600 B | 5760 × 2880, 1895.2 m/pix | atlas horizons 30–300 km |

## Global terrain for "drop a pin"
- `web/public/data/terrain16/`: LDEM_16 (above) cut into 288 tiles of 15° × 15° (240 × 240 int16, the product's own
  0.5 m values, zlib), 28.1 MB in total, a pin loads the ~6–30 tiles within 300 km; `meta.json` records the source
  SHA-256. Built by `python -m sunchaser.export_globalterrain`.
- LDEM_64 near a pin: read live from the PDS file above through `web/api/dem.ts` (no copy shipped).
- V11 golden: LDEM_64 crops at Apollo 15, Chang'e 4, SLIM (`web/src/engine/golden/v11_*.i16z`).

## Mission stories
- `web/public/data/stories.json` (`python -m sunchaser.export_stories`): Apollo touchdown times from NASA NSSDCA mission
  pages (= mission-report launch time + GET at landing, asserted in the script); Sun/Earth by SPICE.
- IM-2 Athena touchdown 2025-03-06 17:28:50 UTC (Wikipedia "IM-2"); power depleted by 7 March, lander on its side
  (Spaceflight Now, 7 March 2025, https://spaceflightnow.com/2025/03/07/intuitive-machines-im-2-mission-ends-with-lander-on-its-side-on-the-moon/);
  ~20 m crater: LROC "IM-2 Athena Seen Obliquely" (https://lroc.im-ldi.com/images/1408).
- Chang'e 4 landing date and far-side note: atlas.json (LROC post 1087).

## 59 m terrain for a pin's 3D view — read live through `web/api/dem.ts`, nothing shipped
- **SLDEM2015** (Barker, Mazarico, Neumann, Zuber, Haruyama, Smith 2016, Icarus 273:346, "A new lunar digital
  elevation model from the Lunar Orbiter Laser Altimeter and SELENE Terrain Camera"): NASA PDS Geosciences Node,
  `lrolol_1xxx/data/sldem2015/tiles/float_img/sldem2015_512_<lat>_<lon>_float.img`, 32 tiles of 30° × 45°, 60° S–60° N,
  512 px/deg, float32 km above 1737.4 km.
- **LOLA LDEM_512** (LOLA GDR, Smith et al.): `lola_gdr/cylindrical/img/ldem_512_<lat>_<lon>.img`, 16 tiles of 45° × 90°,
  int16 × 0.5 m. Used poleward of 60°.
- Albedo tint: the globe's colour map (`web/public/textures/moon_color_4k.jpg`, NASA SVS CGI Moon Kit, LRO WAC).

## Atlas landing times (checked against Wikipedia mission pages, Scientific American, JAXA/Firefly schedules: Chandrayaan-3 12:33 UTC, SLIM 15:20, Chang'e 5 15:11, Chang'e 6 22:23, Blue Ghost 1 08:34)

## Atlas landing coordinates (every entry names its source in `pipeline/sunchaser/atlas.json`)
- Apollo 11, 12, 14, 15, 16, 17 (Lunar Module): NASA NSSDCA "Apollo Landing Site Coordinates" (Wagner et al. 2017,
  Icarus 283:92), https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html
- Chang'e 3: LROC 2016 coordinates of human features (PDF); Chang'e 4: LROC post 1087; Chang'e 5: LROC image 1172;
  Chang'e 6: LROC image 1374; Chandrayaan-3: LROC post 1314; SLIM: LROC image 1358; Blue Ghost 1: LROC image 1400
  (landing-region centre); IM-1: NASA "LRO images Odysseus"; IM-3 target: IAU/USGS gazetteer, Reiner Gamma centre.
- V10 reference: ALSJ "Sun Angles" (https://apollojournals.org/alsj//alsj-sunangles.html); Apollo launch times: NASA
  mission reports.

## DSN
- Kernels (pinned): `earth_1962_260806_2126_combined.bpc` (31,318,016 B, cc87ad1a495cf598800ba403763d350f087ac0b97da9fec603278a3864c6a53e), `earth_assoc_itrf93.tf` (aab7bbc19b8a69bad11988ee1b4812a3963812a03a029c2776863e680719b336), `earthstns_itrf93_260814.bsp` (007eb0aad5dd022c6d61bdbfb2395680bd1eb31c49a8637d0b0a1cfbea737c6b), `earth_topo_260814.tf` (4f40cd1e86718047bc8ea6ff6bd063c9fbf36102b63f0dca370c8e94fd282490).
- 6° minimum elevation: DSN Telecommunications Link Design Handbook 810-005, module 302 Rev. C, Table 1 (70 m antennas: elevation motion limits 6–89.5°), https://deepspace.jpl.nasa.gov/dsndocs/810-005/302/302C.pdf.

## Imagery
- **Earth texture:** NASA Visible Earth "Blue Marble: Land Surface, Shallow Water, and Shaded Topography" (NASA GSFC, R. Stöckli et al.), `https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/land_shallow_topo_2048.jpg`, 2048×1024, 238,676 B, SHA-256 5b54cc586c6cbf2b28762ef4d4011f6cf4227a8b93a637b818a0c54090ce6c2c. NASA imagery, public domain. Stored as `web/public/textures/earth_blue_marble_2048.jpg`. Orientation per hour from SPICE `IAU_EARTH` (pck00011), phase from the true Sun direction.

- **Sky:** NASA SVS "Deep Star Maps 2020" (SVS 4851, E. Wright), `milkyway_2020_4k.exr`, 36,436,668 B,
  SHA-256 2eb802d6e68d170b410f766c7fec07f7518619f6b6708fdc81e9302d93e74fdb → `textures/milkyway_4k.jpg`. Credit: NASA's
  Scientific Visualization Studio. Stars: Hipparcos Main Catalogue (ESA 1997), CDS VizieR I/239 `hip_main`, V < 7.5
  → `data/stars.bin`.
- **Earth:** Blue Marble Next Generation, December 2004 with bathymetry (NASA Earth Observatory, R. Stöckli),
  `world.topo.bathy.200412.3x5400x2700.jpg`, 2,566,770 B, SHA-256 a9f0088972dee0254610af851c4d6838ca3f2cf79176987e0a5713e2c15ec042;
  Black Marble 2016 night lights (NASA Earth Observatory / GSFC, M. Román, J. Stevens), `BlackMarble_2016_01deg.jpg`,
  779,638 B, SHA-256 d87de751a264e4f8ff69c68de5dab9606daee87a6f15ae743c93200743bd7ec1; Blue Marble clouds
  `cloud_combined_2048.jpg`, 829,367 B, SHA-256 daddaad84d7a33bbbc86cdda3f591099f57cee8607b7bcf3b67eb7e4f7a1c793.
  NASA imagery, public domain.
- **Moon:** NASA SVS "CGI Moon Kit" (SVS 4720, E. Wright, N. Petro): LROC WAC colour 2025
  `lroc_color_16bit_srgb_4k.tif`, 61,891,324 B, SHA-256 9731fa8af425b6c2f88f277ecca82bf8c603f3743894f64ed7b25c5bfefa22ff;
  LOLA `ldem_16.tif` (km), 66,378,634 B, SHA-256 1ea42bf44f7e9d694f79c3afa7145f97fbf06cc67372067d9fe73dce43bad796.
  Credit: NASA's Scientific Visualization Studio. South polar cap and far field: the pinned `LDEM_80S_80MPP_ADJ.TIF`.
- **Moon relief tiles:** LOLA `ldem_64_uint.tif` (CGI Moon Kit, 23040×11520, half-metres), 530,934,146 B,
  SHA-256 0f40bce8b42864deddb6943a38474879e691d5b20647aa5e54c2612b23106499 → `textures/moon_tiles/n_<col>_<row>.jpg` (8 × 4,
  2048²) and `moon_southcap_hi_4k.jpg` (±212 km at 104 m, from the pinned LDEM_80S_80MPP_ADJ.TIF).
- **Moon colour tiles:** LROC WAC colour `lroc_color_poles_16k.tif` (CGI Moon Kit, 16384×8192, 8-bit),
  187,004,094 B, SHA-256 dbff4356479764d89f9fd7722140043eddbc2cafbad4dec5950858e2df77ac54 → `textures/moon_tiles/c_<col>_<row>.jpg`
  (8 × 4, 1024², ~4.6 km/px at the equator, 4.7 MB; native 2048² cost the T495 10–20 fps while zooming), each channel tone-matched by a lookup table to the 4k map
  above (this version is darker: mean 144 vs 182), so tiles fade in without a jump (`export_assets colortiles`).
  Used by the globe below 2,200 km and for the near ground's albedo of a pin's 3D region. Visual only.
- **Near-pole heights:** `moon_southcap_height_near_2k.png`, the pinned LDEM_80S_80MPP_ADJ.TIF at its
  native 80 m over ±81.92 km (2048², 16-bit packed as R/G bytes of (h + 8192) × 4), 4,962,421 B,
  SHA-256 1e1deb76484118f219f341a720655fd0be80e7a41f3071d5c92a4e780866b9ad (`export_assets polenear`).
- Built by `python -m sunchaser.export_assets` (needs `pip install OpenEXR`). Visual only.

## Rover parameters (Light Path defaults)
- NASA LSIC 2024 "VIPER Mobility Hardware" (NTRS 20240013903), slide 2: solar arrays 320 W per panel (450 W on corner);
  battery 5,420 Wh (start of life, 0 °C); 50 h survival in low-power mode; 9 h of operations in a PSR. Slide 4: drive top
  speed 20 cm/s, nominal 10 cm/s.
- T. Fong et al., VIPER briefing 2024-06-07 (NTRS 20240007332), slide 27: 15° slopes and 20 cm steps (design limit);
  10 cm/s while prospecting; moving shadows 0.1–1.8 cm/s.
- NASA, "VIPER Lunar Operations" (science.nasa.gov/mission/viper/lunar-operations): the rover cannot endure more than
  50 hours of continuous darkness.

## Validation references
- **JPL Horizons API** `https://ssd.jpl.nasa.gov/api/horizons.api` (validation only). Lunar observer frame reported as `MEAN_ME (high precision)`, sphere 1737.4 km, ephemeris DE441. Cached responses: `pipeline/tests/data/horizons_{sun,earth}_2027.csv` (fetched from the Horizons API).
- **Barker, M.K. et al. 2021**, "Improved LOLA elevation maps for south pole landing sites: Error estimates and their impact on illumination conditions", *Planet. Space Sci.* 203:105119, doi:10.1016/j.pss.2020.105119. Free copy: NASA NTRS 20205009660. Table 2 used for V2 (see VALIDATION.md).

## Sites (rule D-SITE, generated by `python -m sunchaser.select_sites` → `pipeline/sunchaser/sites.json`)
Rule D-SITE, fixed before selection:
1. **Barker et al. 2021 sites with published RoIs** (PGDA `Site01/04/07/11_ROIs.tgz`): centroid of the largest RoI by 5 m pixel count (record X/Y as published). Reproduces Table 2's RoI 4 for Connecting Ridge (asserted in code).
2. **NASA Artemis III candidate regions (Oct 2024) that have a PGDA 5 m site DEM** (Malapert Massif = Site23, Nobile Rim 1 = Site06, Nobile Rim 2 = DM2, Haworth): the pixel with the highest PGDA average solar visibility (product 69, Mazarico et al. 2011; 60 m `AVGVISIB_85S_060M_201608`, or 120 m `AVGVISIB_75S_120M_201608` when the footprint extends north of 85°S) inside the 5 m site footprint inset by 1 km, among pixels with mean slope ≤ 10° (from the 20 m DEM); ties broken by Earth visibility (`_EARTH` products). Scale: value = DN × 0.00004 (PDS label). The 10° slope limit is a rule parameter that keeps the point landable, not a physical claim.
3. **IM-2:** LROC's published points (below).
Regions without a PGDA 5 m DEM (Peak near Cabeus B, Mons Mouton Plateau, Slater Plain, de Gerlache Rim 2) are not in the catalog; NASA published no coordinates for them.

| Site | Coordinates | Source |
|---|---|---|
| Connecting Ridge RoI 4 | x = −11,287.5 m, y = −12,167.5 m (89.452675° S, 222.851347° E); area 13,300 m² | Barker et al. 2021, Table 2 (Site 1 = connecting ridge between Shackleton and de Gerlache) |
| IM-2 intended site | 84.78° S, 29.13° E (2 decimals as published) | LROC "IM-2 Landing Region", https://lroc.im-ldi.com/images/1401 (NASA/GSFC/ASU) |
| IM-2 Athena resting point | 84.7906° S, 29.1957° E, on its side in a ~20 m crater | LROC "IM-2 Athena Seen Obliquely", https://lroc.im-ldi.com/images/1408 (NASA/GSFC/ASU) |



## AI services for Ask Sunchaser (METHODS §24)
- **Google Gemini API** (free tier, Google AI Studio key), `generativelanguage.googleapis.com/v1beta` `generateContent`
  with function calling. Free-tier prompts may be used by Google to improve its products; the copilot sends only the
  question, the app's view state and tool results (no personal data).
- **Groq API** (free tier), OpenAI-compatible `api.groq.com/openai/v1/chat/completions` with tools.
- Keys: `GEMINI_API_KEY`, `GROQ_API_KEY` in Vercel environment variables and the git-ignored `web/.env.local` only
  (setup: README). No AI output is stored.

## Third-party libraries
| Library | License | Where |
|---|---|---|
| numpy | BSD-3-Clause | pipeline |
| spiceypy (wraps NAIF CSPICE) | MIT (CSPICE: NAIF terms, free use) | pipeline |
| rasterio / GDAL | BSD-3-Clause / MIT | pipeline |
| pyproj / PROJ | MIT | pipeline tests |
| requests | Apache-2.0 | pipeline |
| numba | BSD-2-Clause | pipeline (horizon engine) |
| scipy | BSD-3-Clause | pipeline (quaternions) |
| pyshp | MIT | pipeline (RoI shapefile) |
| matplotlib | PSF-based (matplotlib license) | pipeline (point-in-polygon) |
| pytest | MIT | tests |
| React, React DOM | MIT | web |
| three.js | MIT | web |
| @react-three/fiber, @react-three/drei | MIT | web |
| three-mesh-bvh | MIT | web (terrain click raycasts) |
| Vite, Vitest, TypeScript | MIT / MIT / Apache-2.0 | web tooling |
| Fonts: Space Grotesk, Inter, JetBrains Mono | SIL OFL 1.1 | web (Google Fonts) |
