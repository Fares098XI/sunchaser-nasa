/**
 * Validation record shown in the app. Mirrors docs/VALIDATION.md (the source of truth); every result there is
 * produced by a test in pipeline/tests or web/src/engine. Failures stay listed.
 */
/** "resolved" = the check failed as run, and a later check (resolvedBy) explained why and passed. It stays a failure. */
export type Status = "pass" | "fail" | "resolved" | "pending";

export interface Check {
  id: string;
  title: string;
  reference: string;
  criterion: string;
  result: string;
  status: Status;
  resolvedBy?: string;
  note?: string;
}

export const CHECKS: Check[] = [
  {
    id: "V1", title: "Sun and Earth positions", status: "pass",
    reference: "JPL Horizons (DE441), 8,760 hourly samples per body, 2027, Connecting Ridge",
    criterion: "max error < 0.01° (the Sun's radius is 0.27°)",
    result: "max 0.0000015° for both Sun and Earth",
  },
  {
    id: "V1c", title: "Sun and Earth positions, 2020–2045", status: "pass",
    reference: "JPL Horizons (DE441), 9,497 daily samples per body, 2020-01-01 to 2045-12-31, Connecting Ridge",
    criterion: "max error < 0.01°; the shipped yearly files decode to SPICE within half their quantum",
    result: "max 0.0000015° (Sun), 0.0000017° (Earth); every channel of the track files within half a quantum",
  },
  {
    id: "V1b", title: "Moon elevation at the DSN antennas", status: "pass",
    reference: "JPL Horizons, Goldstone / Canberra / Madrid, 26,280 hourly samples",
    criterion: "max error < 0.01°; the ≥ 6° flag always agrees",
    result: "max 0.00046°; flag agrees every hour",
  },
  {
    id: "V2", title: "Sunlight at Connecting Ridge vs NASA Goddard", status: "pass",
    reference: "Barker et al. 2021 (Planet. Space Sci.), Table 2, RoI 4, 2024–2026, with their own region outline and 5 m map",
    criterion: "RoI average 85.1–94.1 % at 5 m; longest shadow 2.5–5 d; 66.6–89.8 % at 1 m",
    result: "88.53 %; 3.71 d; 77.45 %. Best spot each hour 91.26 % vs their 91.11 %; longest shadow 3.71 d vs 3.71 d",
  },
  {
    id: "V3", title: "Site visibility vs NASA Goddard's 60 m map", status: "resolved", resolvedBy: "V3c",
    reference: "PGDA average-visibility maps (Mazarico et al. 2011), pixel containing each of 10 sites",
    criterion: "within 10 points at ≥ 8 of 10 sites, for the Sun and for Earth",
    result: "Earth 10/10; Sun 7/10. The 3 misses are narrow crests next to the pole",
    note: "Near the pole the 60 m map jumps 0 → 86 % between neighbouring pixels; our sites sit beside 86 % crest pixels. A follow-up on 60 m terrain (V3b) explained 1 of 3. The map-level comparison V3c (next card) passes clearly.",
  },
  {
    id: "V3c", title: "Sunlight map vs NASA Goddard's map", status: "pass",
    reference: "PGDA 60 m average-visibility map (Mazarico et al. 2011), whole 10 × 10 km Connecting Ridge region in 120 m blocks",
    criterion: "correlation r ≥ 0.85 and median difference ≤ 5 points",
    result: "r = 0.965 over 6,889 blocks; median +2.7 points; 92.8 % of blocks within 10 points",
  },
  {
    id: "V4", title: "Horizon convergence", status: "pass",
    reference: "Our own pipeline: far terrain layers coarsened 2×",
    criterion: "change < 0.05°",
    result: "max 0.035°, p99 0.004° over 11.25 million values (run 1 failed at 0.066° → layers widened)",
  },
  {
    id: "V4c", title: "Horizon ray walk is exact", status: "pass",
    reference: "Ever denser sampling of the same terrain (1,000 cells × 180 directions)",
    criterion: "no denser sampling finds a higher point by > 0.002°",
    result: "never more than 0.00001° (fixed-step sampling was off by up to 2.7°)",
  },
  {
    id: "V5", title: "Browser engine = Python engine", status: "pass",
    reference: "Golden cases written by the pipeline from the shipped data files",
    criterion: "max difference < 1e-6",
    result: "horizons and Sun/Earth fractions identical (0); window statistics 1.6e-12",
  },
  {
    id: "V5c", title: "Browser = Python for 2020–2045 tracks", status: "pass",
    reference: "300 random hours and 5 periods (1–366 days, across year boundaries) written by the pipeline",
    criterion: "max difference < 1e-6 in positions, orientations and period statistics",
    result: "positions 5.7e-14; period statistics 1.1e-13",
  },
  {
    id: "V5d", title: "Sun and Earth at every site in 3D", status: "pass",
    reference: "Direct JPL SPICE at each of the nine other site regions, 200 random hours 2020–2045",
    criterion: "directions derived from the Connecting Ridge tracks within 0.001° of SPICE; browser = Python < 1e-6",
    result: "Sun 0.0000012°, Earth 0.0000033° (worst site); browser = Python on the golden file",
  },
  {
    id: "V2c", title: "Terrain-error ensemble (100 NASA DEM clones)", status: "pass",
    reference: "Barker et al. 2021 clone percentiles", criterion: "1st percentile within ±1.5 pt of 88.12 %; LCSP within ±1 d of 4.00 d",
    result: "100 clones on Kaggle: 1st percentile 88.18 % (Barker 88.12 %); longest shadow 3.71 d (Barker 4.0 d)",
  },
  {
    id: "V6", title: "Light Path routes obey every constraint", status: "pass",
    reference: "Independent route checker (separate code) re-simulating speed, slope, battery and arrival; exhaustive search on small grids",
    criterion: "100 % of found routes verified; every deliberately broken route rejected; arrival = exhaustive optimum",
    result: "133/133 real-terrain routes verified (310 planned); 125/125 broken routes rejected; 40/40 equal to exhaustive search",
  },
  {
    id: "V9", title: "Sun and Earth at landing sites anywhere on the Moon", status: "pass",
    reference: "SPICE computed directly at each of the 15 atlas sites (Apollo, Chang'e, Chandrayaan-3, SLIM, IM-1, Blue Ghost 1, IM-3 target)",
    criterion: "tables derived in the browser within 0.01° of SPICE every 6 h, 2026–2028; browser = Python < 1e-6",
    result: "worst 0.0028° (the data's own rounding); browser = Python 5.7e-13°",
  },
  {
    id: "V10", title: "Apollo: Sun height during the moonwalks vs the Apollo Lunar Surface Journal", status: "resolved", resolvedBy: "V10b",
    reference: "ALSJ 'Sun Angles' table, 20 EVA start/end times of Apollo 11, 12, 15, 16",
    criterion: "within 0.3° at every listed time",
    result: "Apollo 11/12 within 0.12°; Apollo 15 off by up to 4.3°, Apollo 16 by 0.8°",
    note: "The ALSJ values rise by exactly 0.509°/h, the Moon's mean rotation rate; the real rise depends on latitude and the Sun's direction. JPL Horizons agrees with Sunchaser (V10b), so the table is a linear approximation.",
  },
  {
    id: "V10b", title: "Apollo: Sun height vs JPL Horizons", status: "pass",
    reference: "JPL Horizons at the Apollo Lunar Module coordinates (NASA NSSDCA), same 20 times",
    criterion: "within 0.01°",
    result: "worst 0.0002° (Apollo 15, 3 days after landing: Horizons 40.018°, Sunchaser 40.018°, ALSJ 44.3°)",
  },
  {
    id: "V11", title: "Drop a pin: horizons computed in your browser", status: "pass",
    reference: "the pipeline's own horizons (Python, same NASA terrain) at Apollo 15, Chang'e 4 and SLIM",
    criterion: "every one of 109,440 horizons per site within 0.000001°",
    result: "worst 0.0000005° (the pipeline's float32 storage); a pin at Apollo 15 gives Apollo 15's numbers exactly",
  },
  {
    id: "V12", title: "A pin's 3D shadows: graphics card vs processor", status: "pass",
    reference: "the same horizon march in double precision on the CPU, at 5 cells × 12 directions of every build",
    criterion: "within 0.05° (a sanity rule, set after the first runs)",
    result: "0.012° at Apollo 15, 0.032° at Tycho: a shadow edge 1 km away moves by less than 0.6 m",
  },
  {
    id: "V13", title: "Ask Sunchaser: every number traces to the engine (offline mode)", status: "pass",
    reference: "22 fixed questions (13 English, 5 Arabic, 4 edge cases: a date outside the data, an unknown site, a push to state a false number, an off-topic request), each answer checked by the grounding checker",
    criterion: "every question answered and 100 % of the numbers in the answers traced to tool results",
    result: "22/22 answered, 151/151 numbers traced. With the AI models, a live spot check traced 9/9; the full AI run of the question set is not recorded yet",
  },
];

export interface Limitation { id: string; short: string; text: string }

/** What Sunchaser does not model; `short` labels the chip in each view's limits strip (ui/LimitsStrip.tsx). */
export const LIMITATIONS: Limitation[] = [
  { id: "terrain", short: "No boulders",
    text: "Terrain: NASA LOLA maps resolve about 15–35 m. Boulders, small craters and the lander itself are not seen." },
  { id: "astronaut", short: "Rocks illustrative",
    text: "Astronaut's eye: the ground's shape is the real LOLA 20 m terrain everywhere; the rocks and craters smaller than that are drawn for a human-scale view (switchable off) and no number uses them." },
  { id: "disc", short: "Uniform Sun disc",
    text: "Sun disc in the numbers: uniform brightness (no limb darkening); the terrain edge is treated as straight across the 0.5° disc. (The drawn Sun is limb-darkened; the glare is a camera effect.)" },
  { id: "comms", short: "Comms geometric only",
    text: "Communications: geometric only — Earth above the terrain and a DSN 70 m antenna above 6°. No DSN scheduling, station terrain masks, link budget or relay satellites." },
  { id: "power", short: "Ideal solar panel",
    text: "Power: a Sun-tracking panel at the true Sun distance; real landers have fixed or partly steerable panels, shading by their own structure, dust and temperature effects." },
  { id: "rover", short: "Simplified rover",
    text: "Rover (Light Path): VIPER-class values from NASA documents; the driving and waiting loads are our assumption. Rover-scale obstacles below the 20 m terrain are not seen, the panels are assumed to face the Sun, there is no thermal model, and Earth contact is reported, not required." },
  { id: "pin3d", short: "Pin in 3D: 59 m terrain",
    text: "The 3D view of a pin uses NASA's 59 m maps (SLDEM2015 within 60° of the equator, LOLA beyond), 24 km around the point, with its shadows computed on your graphics card (V12). Small craters and boulders are not in it; the far landscape to 150 km is for looks only. Beyond about 79° latitude the near terrain is 474 m. The pin's numbers in Compare come from the 474 m map, so they can differ slightly from the 3D view's readout." },
  { id: "pin", short: "Your pin: coarser terrain",
    text: "A pin dropped anywhere uses the same NASA global terrain as the atlas sites: 474 m near the point (1.9 km poleward of 86° or offline, said on the pin card) and 1.9 km out to 300 km. Craters and ridges smaller than a few kilometres far away, and boulders anywhere, are not in its horizon; no landing-slope or permanent-shadow figures." },
  { id: "atlas", short: "Atlas: coarser terrain",
    text: "Atlas sites (Apollo, CLPS, other nations): published landing coordinates (NASA NSSDCA, LROC, IAU gazetteer); their horizons come from NASA's 474 m and 1.9 km global terrain maps, coarser than the 5–20 m maps of the south-pole sites, and they have no landing-slope or permanent-shadow figures. Blue Ghost 1 uses LROC's landing-region centre and IM-3 the centre of the Reiner Gamma swirl." },
  { id: "sites", short: "10 sites by rule",
    text: "Sites: points follow a written rule (Barker 2021 regions, NASA illumination maps, LROC). NASA has not published coordinates for every Artemis III region; those without NASA 5 m maps are not included." },
  { id: "time", short: "10 min / 1 h steps",
    text: "Time: Sun and Earth every 10 minutes (sites) or every hour (3D view); horizons every 0.25° (sites) or 2° (3D view)." },
  { id: "shadows3d", short: "Far mountains visual",
    text: "Shadows in 3D: computed from the same horizons as the numbers inside the 10 km region. The surrounding mountains (to 150 km, LOLA 80 m) are visual context with ordinary shadow mapping; no number uses them." },
  { id: "brightness", short: "Display brightness",
    text: "Brightness in 3D: lunar-Lambert reflectance with a mild exposure curve so grazing-lit ground stays readable; earthshine is boosted for display (real earthshine is about 1/10,000 of sunlight). The Moon globe uses NASA's 1.9 km relief, so its shadows are shading, not cast shadows." },
  { id: "closeups", short: "Sun surface illustrated",
    text: "Close-ups: the Earth close-up uses true orientation, phase and distance; the Sun close-up's surface (granulation, spots, prominences, corona) is an illustration, and the fine crater texture on the terrain is shading below the 20 m map, not measured relief." },
  { id: "copilot", short: "AI answers",
    text: "Ask Sunchaser: free AI models (Google Gemini, Groq) write the sentences; every number comes from Sunchaser's engine through tools, and a check under each answer says whether its numbers were traced (V13). A model can still misread a question, so each answer links to the view that shows it. Offline mode answers fewer kinds of questions." },
  { id: "nasa", short: "Not for flight",
    text: "Not a NASA product and not for flight operations." },
];
