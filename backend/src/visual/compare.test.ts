import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { compareScreenshots, parseMasks } from "./compare";

/** Builds a solid image, optionally painting one rectangle a different colour. */
function image(width: number, height: number, patch?: { x: number; y: number; width: number; height: number; color: [number, number, number] }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (width * y + x) << 2;
      const inside = patch && x >= patch.x && x < patch.x + patch.width && y >= patch.y && y < patch.y + patch.height;
      const [red, green, blue] = inside ? patch!.color : [255, 255, 255];
      png.data[offset] = red;
      png.data[offset + 1] = green;
      png.data[offset + 2] = blue;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("visual comparison", () => {
  it("reports an exact match with no diff image", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40), { threshold: 0 });
    expect(result.matched).toBe(true);
    expect(result.diffPixelCount).toBe(0);
    expect(result.diffPng).toBeNull();
  });

  it("measures a real difference and produces a diff image", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40, { x: 0, y: 0, width: 10, height: 10, color: [255, 0, 0] }), { threshold: 0 });
    expect(result.matched).toBe(false);
    expect(result.diffPixelCount).toBe(100);
    expect(result.totalPixelCount).toBe(1600);
    expect(result.diffRatio).toBeCloseTo(0.0625);
    expect(result.diffPng).not.toBeNull();
  });

  it("treats a difference within the threshold as a match", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40, { x: 0, y: 0, width: 10, height: 10, color: [255, 0, 0] }), { threshold: 0.1 });
    expect(result.matched).toBe(true);
    expect(result.diffRatio).toBeCloseTo(0.0625);
  });

  it("ignores a masked region entirely", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40, { x: 0, y: 0, width: 10, height: 10, color: [255, 0, 0] }), { threshold: 0, masks: [{ x: 0, y: 0, width: 10, height: 10 }] });
    expect(result.matched).toBe(true);
    expect(result.diffPixelCount).toBe(0);
  });

  it("still reports a difference outside the mask", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40, { x: 20, y: 20, width: 5, height: 5, color: [0, 0, 255] }), { threshold: 0, masks: [{ x: 0, y: 0, width: 10, height: 10 }] });
    expect(result.matched).toBe(false);
    expect(result.diffPixelCount).toBe(25);
  });

  it("reports a size change as a difference rather than cropping", () => {
    const result = compareScreenshots(image(40, 40), image(40, 60), { threshold: 0.5 });
    expect(result.dimensionsMatch).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.diffRatio).toBe(1);
  });

  it("clamps a mask that runs past the image edge", () => {
    const result = compareScreenshots(image(40, 40), image(40, 40, { x: 30, y: 30, width: 10, height: 10, color: [0, 255, 0] }), { threshold: 0, masks: [{ x: 30, y: 30, width: 999, height: 999 }] });
    expect(result.matched).toBe(true);
  });

  it("discards malformed mask entries instead of throwing", () => {
    expect(parseMasks([{ x: 1, y: 2, width: 3, height: 4 }, { x: "a" }, null, 7])).toEqual([{ x: 1, y: 2, width: 3, height: 4 }]);
    expect(parseMasks("not-an-array")).toEqual([]);
  });
});
