# Sunchaser

**Follow the Sun. Stay in touch with Earth.**

A mission planner for the Moon's south pole, by **Team Eternal Light** for the
[NASA Space Apps Challenge 2026](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/)
(*Lunar Landing Site Navigator*), NASA Space Apps Cairo.

**Live app:** https://sunchaser-nasa.vercel.app

At the south pole the Sun never climbs more than about 2° above a flat horizon, so a ridge 30 km away can cut a
lander's power for days, and the same terrain can hide Earth. Sunchaser traces the real skyline from NASA's LOLA
laser terrain maps, places the Sun and Earth on it with NASA/JPL SPICE data, and shows for any site and date how
much sunlight a lander gets, when it can reach Earth through the Deep Space Network, and the best window to land.

## What it does

- **Explore** real south-pole terrain in 3D. Drag the Sun across the sky and the computed shadows move; click any
  point for its sunlight, Earth contact, mission clock (sunset / Earthset in…) and landing slope.
- **Compare** ten sourced landing sites side by side for any date, stay and panel height.
- **Landing windows:** state your requirements and every landing hour from Nov 2026 to Dec 2028 is checked, with
  the reason when one fails and the smallest change that would open a window.
- **Replan a slip:** what a launch delay does to your site, and the nearest Plan B.
- **Light Path:** a rover route through moving shadows that never runs the battery below its reserve.
- **Anywhere on the Moon:** 15 historic landing sites and any point you tap or type.
- **Ask Sunchaser:** a copilot (English and Arabic) whose numbers all come from the engine and are traced.
- **NASA tools:** every point opens in QuickMap, Moon Trek and JPL Horizons.

## How the numbers are checked

Every pass rule is written before its check runs; failures are kept in the record.

| Check | Reference | Result |
|---|---|---|
| Sun and Earth direction, 8,760 hours | JPL Horizons | max 0.0000015° (rule: 0.01°) |
| Moon elevation at the DSN 70 m antennas | JPL Horizons | max 0.00046°; the 6° flag never disagrees |
| Sunlight at Connecting Ridge, 5 m map | Barker et al. 2021 (NASA Goddard) | best spot 91.26 % vs 91.11 %; longest shadow 3.71 d vs 3.71 d |
| Horizon ray walk | ever-denser sampling | exact to 0.00001° |
| Browser engine vs Python engine | golden files | horizons identical; statistics within 2 × 10⁻¹² |

The 3D shadows are drawn from the same horizon data and formula as the numbers in the panels.

## Run it

```bash
# web app (Node 20+)
cd web
npm install
npm run dev        # http://localhost:5173
npm run test       # engine tests and golden files
npm run build      # production build

# science pipeline (Python 3.11+)
cd pipeline
pip install -e . pytest
python -m sunchaser.fetch   # downloads the SPICE kernels and terrain windows (checksums pinned)
python -m pytest            # tests and validation
```

The copilot uses Google Gemini and Groq. Put `GEMINI_API_KEY` and `GROQ_API_KEY` in `web/.env.local` (never
commit them) or in the Vercel project settings. Without keys it answers in offline mode.

## Repository

| Folder | Contents |
|---|---|
| `pipeline/sunchaser/` | Python: SPICE geometry, exact terrain horizons, DSN visibility, windows, exports, validation |
| `pipeline/tests/` | Python tests and cached reference data |
| `web/src/engine/` | TypeScript engine (matches the Python engine on golden files) |
| `web/src/scene/` | 3D scene: terrain, computed shadows, Sun, Earth, stars |
| `web/src/views/`, `web/src/ui/` | Screens and design system |
| `web/src/copilot/`, `web/api/` | Copilot and serverless functions |
| `web/public/` | Precomputed data, textures and icons |
| `docs/` | `METHODS.md` (every formula), `VALIDATION.md` (every check, its pass rule and result), `DATA.md` (every dataset, source and checksum) |

## Data and credits

NASA LRO LOLA elevation maps via NASA GSFC's Planetary Geodesy Data Archive (Barker et al. 2021, *Planet. Space
Sci.* 203:105119; Barker et al. 2023, *PSJ* 4:183); permanent-shadow and illumination maps (Mazarico et al. 2011,
*Icarus* 211:1066); NAIF SPICE toolkit and kernels; JPL Horizons; DSN Telecommunications Link Design Handbook
810-005; LROC; NASA Visible Earth Blue Marble and Black Marble; NASA Scientific Visualization Studio CGI Moon Kit
and Deep Star Maps; ESA Hipparcos catalogue. Not a NASA product and not for flight operations.

## Team Eternal Light

Fares Sherif (lead) · Omar Sherif · Abdelrahman Adel — NASA Space Apps Cairo 2026.
