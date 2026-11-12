/** Render tiers (design.md §8, §10, §11.10). No three.js import: safe for the loader. */
export type Tier = "full" | "lite";

export interface TierConfig {
  /** Atlas width in px (height = width × 1462 / 2048). */
  atlasWidth: number;
  maxPixelRatio: number;
  liquidSegments: readonly [number, number];
  antialias: boolean;
  /** Portrait camera offsets when the viewport is taller than wide. */
  portraitFraming: boolean;
}

export const TIERS: Readonly<Record<Tier, TierConfig>> = {
  full: {
    atlasWidth: 1536,
    maxPixelRatio: 1.5,
    liquidSegments: [48, 36],
    antialias: true,
    portraitFraming: false,
  },
  lite: {
    atlasWidth: 1024,
    maxPixelRatio: 1,
    liquidSegments: [24, 18],
    antialias: false,
    portraitFraming: true,
  },
};

/**
 * Lite morph on capable phones is an open Owner question (build plan Q5, default: static
 * stills). The lite tier exists and is measurable through the test hook, but the loader never
 * picks it while this is false.
 */
export const LITE_MORPH_ENABLED = false;
