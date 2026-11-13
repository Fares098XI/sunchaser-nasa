import { describe, expect, it } from "vitest";
import { horizonsUrl, moonTrekUrl, quickmapUrl } from "./NasaLinks";

describe("NASA resource links", () => {
  it("Moon Trek polar: Shackleton (89.67° S, 129.78° E) is at x ≈ 7690, y ≈ -6404 m, where Moon Trek centred it", () => {
    const u = new URL(moonTrekUrl(-89.67, 129.78).replace("#", "?"));
    expect(Number(u.searchParams.get("x"))).toBeCloseTo(7690, -1);
    expect(Number(u.searchParams.get("y"))).toBeCloseTo(-6404, -1);
    expect(u.searchParams.get("p")).toContain("30120");
  });

  it("Moon Trek and QuickMap use lat/lon away from the pole (Apollo 11), longitudes wrapped to ±180", () => {
    expect(moonTrekUrl(0.6741, 23.4733)).toContain("x=23.4733&y=0.6741");
    expect(moonTrekUrl(10, 350)).toContain("x=-10.0000&y=10.0000");
    expect(quickmapUrl(0.6741, 23.4733)).toBe("https://quickmap.lroc.im-ldi.com/?extent=23.1733,0.3741,23.7733,0.9741&proj=10");
  });

  it("QuickMap has no link for the pole", () => {
    expect(quickmapUrl(-89.5, 0)).toBeNull();
    expect(quickmapUrl(-84.9, 0)).not.toBeNull();
  });

  it("Horizons: same query as the pipeline's V1 check, one day hourly", () => {
    const u = new URL(horizonsUrl("10", -89.45, 222.69, 1500, Date.parse("2027-01-09T00:00Z")));
    const g = (k: string) => u.searchParams.get(k);
    expect(g("COMMAND")).toBe("'10'");
    expect(g("CENTER")).toBe("'coord@301'");
    expect(g("SITE_COORD")).toBe("'-137.310000,-89.450000,1.5000'");
    expect(g("START_TIME")).toBe("'2027-01-09 00:00'");
    expect(g("STOP_TIME")).toBe("'2027-01-10 00:00'");
    expect(g("QUANTITIES")).toBe("'4'");
  });
});
