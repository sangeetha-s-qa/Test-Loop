import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Deterministic pixel comparison with masking.
 *
 * Masked rectangles are painted the same solid colour in BOTH images before comparison, so a
 * clock or an advert cannot produce a difference. Nothing here ever approves a baseline: the
 * result is a measurement, and a person decides what it means.
 */

export type Mask = { x: number; y: number; width: number; height: number };

export type ComparisonResult = {
  dimensionsMatch: boolean;
  diffPixelCount: number;
  totalPixelCount: number;
  diffRatio: number;
  /** True only when the measured ratio is at or below the configured threshold. */
  matched: boolean;
  diffPng: Buffer | null;
};

const maskSchemaKeys: (keyof Mask)[] = ["x", "y", "width", "height"];

export function parseMasks(value: unknown): Mask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Mask => typeof entry === "object" && entry !== null && maskSchemaKeys.every(key => Number.isFinite((entry as Record<string, unknown>)[key])))
    .map(mask => ({ x: Math.max(0, Math.floor(mask.x)), y: Math.max(0, Math.floor(mask.y)), width: Math.max(0, Math.floor(mask.width)), height: Math.max(0, Math.floor(mask.height)) }));
}

/** Paints each mask rectangle a fixed colour so both images are identical inside it. */
function applyMasks(image: PNG, masks: Mask[]) {
  for (const mask of masks) {
    const right = Math.min(image.width, mask.x + mask.width);
    const bottom = Math.min(image.height, mask.y + mask.height);
    for (let y = mask.y; y < bottom; y += 1) {
      for (let x = mask.x; x < right; x += 1) {
        const offset = (image.width * y + x) << 2;
        image.data[offset] = 0;
        image.data[offset + 1] = 0;
        image.data[offset + 2] = 0;
        image.data[offset + 3] = 255;
      }
    }
  }
}

export function compareScreenshots(baselinePng: Buffer, currentPng: Buffer, options: { threshold: number; masks?: Mask[]; pixelThreshold?: number }): ComparisonResult {
  const baseline = PNG.sync.read(baselinePng);
  const current = PNG.sync.read(currentPng);
  const masks = options.masks ?? [];

  // A size change is a real, reportable difference, not something to silently crop or scale.
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return { dimensionsMatch: false, diffPixelCount: current.width * current.height, totalPixelCount: current.width * current.height, diffRatio: 1, matched: false, diffPng: null };
  }

  applyMasks(baseline, masks);
  applyMasks(current, masks);

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixelCount = pixelmatch(baseline.data, current.data, diff.data, baseline.width, baseline.height, { threshold: options.pixelThreshold ?? 0.1, includeAA: false });
  const totalPixelCount = baseline.width * baseline.height;
  const diffRatio = totalPixelCount === 0 ? 0 : diffPixelCount / totalPixelCount;

  return {
    dimensionsMatch: true,
    diffPixelCount,
    totalPixelCount,
    diffRatio,
    matched: diffRatio <= options.threshold,
    // A diff image is only worth storing when there is something to look at.
    diffPng: diffPixelCount > 0 ? PNG.sync.write(diff) : null,
  };
}
