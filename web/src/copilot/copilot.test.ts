import { describe, expect, it } from "vitest";
import { cleanText, ground } from "./agent";
import { searchKnowledge } from "./knowledge";
import { findDate, findSites } from "./offline";
import { findSite } from "./tools";
import type { SiteEntry } from "../engine/sites";

const S = (id: string, name: string) => ({ id, name } as SiteEntry);
const SITES = [S("connecting-ridge", "Connecting Ridge"), S("shackleton-rim", "Shackleton Rim"), S("apollo-15", "Apollo 15"), S("change-4", "Chang'e 4"), S("pin", "Your pin")];

describe("copilot grounding", () => {
  const src = [{ sunlight_pct: 88.5, longest_darkness_h: 88.9, link_pct: 61.2, solar_energy_kwh_m2_day: 28.4 }];
  it("accepts numbers that round from a tool result, also as days and in Arabic digits", () => {
    expect(ground("**88.5 %** sunlight (about 89 %), darkness 3.7 days, link 61 %", src)).toEqual({ checked: 4, unmatched: [] });
    expect(ground("ضوء الشمس ٨٨٫٥٪", src).unmatched).toEqual([]);
  });
  it("flags a number no tool returned, and ignores dates, times, check ids and small counts", () => {
    expect(ground("Sunlight 93.1 % on 2027-03-15T12:00 (V2), top 3 sites", src)).toEqual({ checked: 1, unmatched: ["93.1"] });
  });
});

describe("answer cleanup", () => {
  it("drops an action object the model pasted into its answer", () => {
    const raw = 'Nobile Rim 2 - land at 2027-01-08 08:00 UTC.\n\nThis window meets all requirements.\n\n{"days":14,"label":"Show Nobile Rim 2 Landing","landing_utc":"2027-01-08T08:00","site_id":"nobile-rim-2","view":"globe"}';
    expect(cleanText(raw)).toBe("Nobile Rim 2 - land at 2027-01-08 08:00 UTC.\n\nThis window meets all requirements.");
    expect(cleanText('Here:\n```json\n{"view":"compare"}\n```')).toBe("Here:");
    expect(cleanText("Sunlight {about} 88 %")).toBe("Sunlight {about} 88 %"); // ordinary braces stay
  });
});

describe("offline parsing", () => {
  it("reads dates in ISO, English and Arabic", () => {
    expect(findDate("land on 2027-03-15")).toBe("2027-03-15T12:00");
    expect(findDate("at 2027-03-15T06:30 UTC")).toBe("2027-03-15T06:30");
    expect(findDate("15 March 2027")).toBe("2027-03-15T12:00");
    expect(findDate("in January 2027")).toBe("2027-01-01T12:00");
    expect(findDate("March 5, 2027")).toBe("2027-03-05T12:00");
    expect(findDate("أفضل موقع في مارس ٢٠٢٧")).toBe("2027-03-01T12:00");
    expect(findDate("which site is best")).toBeNull();
  });
  it("finds sites by name, alias and number, in order", () => {
    expect(findSites("shackleton vs Apollo 15", SITES).map((s) => s.id)).toEqual(["shackleton-rim", "apollo-15"]);
    expect(findSites("chang'e 4 on the far side", SITES).map((s) => s.id)).toEqual(["change-4"]);
    expect(findSites("أبولو 15", SITES).map((s) => s.id)).toEqual(["apollo-15"]);
    expect(findSite(SITES, "Connecting Ridge")?.id).toBe("connecting-ridge");
    expect(findSite(SITES, "apollo_15")?.id).toBe("apollo-15");
    expect(findSite(SITES, "apollo15")?.id).toBe("apollo-15");
    expect(findSite(SITES, "connectingridge")?.id).toBe("connecting-ridge");
    expect(findSite(SITES, "mars")).toBeNull();
  });
});

describe("knowledge search", () => {
  it("finds the check by id and the topic by words, English or Arabic", () => {
    expect(searchKnowledge("what is V2")[0].id).toBe("V2");
    expect(searchKnowledge("how is the link to Earth computed")[0].id).toBe("M-link");
    expect(searchKnowledge("ما مدى دقة البيانات").length).toBeGreaterThan(0);
  });
});
