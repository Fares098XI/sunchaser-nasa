/**
 * Director mode (MASTER_PLAN T2.4): a 90-second tour that plays identically every time, for the video and as the
 * live-demo backup. Everything is a function of the tour clock (seconds since start): the cues below switch views,
 * drivers set the time of day and the astronaut's gaze, camera segments orbit the 3D view. Fixed date and places.
 */
export const TOUR = {
  length: 90,
  periodStart: "2027-01-10", days: 14, hour: "2027-01-12T06", // UTC; Sun and Earth both up at the sites
  sweepHours: 30,                                                // 16.5-28 s: 30 hours of shadows wheeling round
  site: "shackleton-rim", route: { x_m: -2720, y_m: -5060 },    // 1.6 km, crosses ~3 h of shadow on battery
  globeDegPerSec: 2,
};

/** What a cue can do; App implements it. */
export interface TourApi {
  dive(): void;
  paint(on: boolean): void;
  compare(): void;
  land(): void;
  planRoute(): void;
  lightPath(): void;
  earth(open: boolean): void;
  astronaut(): void;
}

export const CUES: [number, (a: TourApi) => void][] = [
  [10, (a) => a.dive()],
  [28, (a) => a.paint(true)],
  [35.5, (a) => { a.paint(false); a.compare(); }],
  [41.5, (a) => a.land()],
  [45, (a) => a.planRoute()],
  [48, (a) => a.lightPath()],
  [61.5, (a) => a.earth(true)],
  [68.5, (a) => a.earth(false)],
  [70, (a) => a.astronaut()],
];

export interface Caption { from: number; to: number; text: string; kind?: "title" | "end" }
/** {dark} and {soc} are filled in from the planned route. */
export const CAPTIONS: Caption[] = [
  { from: 0.8, to: 5.2, text: "The Moon's south pole. The next place humans will land." },
  { from: 5.5, to: 9.9, text: "Here the Sun never climbs more than a few degrees, and shadows stretch for kilometres." },
  { from: 10.3, to: 16, text: "In 2025, a lander touched down 250 metres off target, in a crater. It never recharged." },
  { from: 16.4, to: 21, text: "Follow the Sun. Stay in touch with Earth.", kind: "title" },
  { from: 21.3, to: 27.8, text: "Real NASA terrain, the real Sun and Earth, for any hour from 2020 to 2045. Every shadow is computed." },
  { from: 28.3, to: 35.2, text: "Two weeks of sunlight, painted onto the ground: the bright places keep a lander powered." },
  { from: 35.8, to: 41.2, text: "Ten landing sites side by side: hours of sunlight, hours in contact with Earth." },
  { from: 42.2, to: 47.8, text: "Choose a site and a date, and fly there." },
  { from: 48.3, to: 55.2, text: "Light Path plans the rover's fastest safe drive through the moving shadows." },
  { from: 55.5, to: 61.2, text: "This drive crosses {dark} of darkness on battery and never drops below {soc}." },
  { from: 62, to: 68.3, text: "Earth from the landing site, in its true phase, with the Deep Space Network dishes that can hear you." },
  { from: 70.5, to: 76.6, text: "Stand where the lander will stand. This horizon is the one behind every number." },
  { from: 76.8, to: 83.6, text: "Every number is checked against NASA: JPL ephemerides to 0.000002°, Goddard's published sunlight results within 0.2 points." },
  { from: 84, to: 90, text: "Other tools tell you where to land. Sunchaser tells you how to survive.", kind: "end" },
];

/** Camera orbits of the 3D view around its current centre (deg, eased in and out). */
export const ORBITS = [
  { from: 16.5, to: 27.9, deg: 40 },
  { from: 28.4, to: 35.4, deg: 18 },
];

/** Dips to black over the cuts that change place (the scene is rebuilt behind the curtain): centre time, half widths. */
export const DIPS = [{ at: 41.5, fadeIn: 0.45, fadeOut: 0.8 }];
export function tourCurtain(t: number) {
  let o = 0;
  for (const d of DIPS) {
    if (t >= d.at - d.fadeIn && t <= d.at) o = Math.max(o, (t - (d.at - d.fadeIn)) / d.fadeIn);
    else if (t > d.at && t <= d.at + d.fadeOut) o = Math.max(o, 1 - (t - d.at) / d.fadeOut);
  }
  return o;
}

const ease = (u: number) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };

/** Hour (since the track start) the tour shows at t, or null to leave the clock alone. */
export function tourHour(t: number, h0: number, route: { dep: number; hours: number } | null): number | null {
  if (t < 16.5) return h0;
  if (t < 28) return h0 + TOUR.sweepHours * ease((t - 16.5) / 11.5);
  if (t >= 41.5 && t < 49.5) return h0;
  if (t >= 49.5 && t < 61.5 && route) return route.dep + route.hours * ease((t - 49.5) / 11);
  return null;
}

/** Astronaut's gaze: from the Sun round to Earth (shortest way), 71-80 s, then a slow zoom onto Earth. */
export function tourGaze(t: number, sunAz: number, earthAz: number): { yaw: number; pitch: number; fov: number } | null {
  if (t < 70.5) return null;
  const d = ((earthAz - sunAz + 540) % 360) - 180, e = ease((t - 71) / 9);
  return { yaw: sunAz + d * e, pitch: 3 - e, fov: 60 - 34 * ease((t - 79) / 6) };
}

export const activeCaption = (t: number) => CAPTIONS.find((c) => t >= c.from && t < c.to) ?? null;
export const activeOrbit = (t: number) => ORBITS.find((o) => t >= o.from && t <= o.to) ?? null;
export { ease as tourEase };
