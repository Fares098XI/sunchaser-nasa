import { describe, expect, it } from "vitest";
import { standIn } from "./bitmapTexture";

describe("texture stand-in for a failed download", () => {
  it("is a flat normal for normal maps and mid grey for colour maps", () => {
    expect(Array.from(standIn("/textures/moon_southcap_normal_2k.jpg").image.data as Uint8Array)).toEqual([128, 128, 255, 255]);
    expect(Array.from(standIn("/textures/earth_day_4k.jpg").image.data as Uint8Array)).toEqual([96, 96, 96, 255]);
  });
});
