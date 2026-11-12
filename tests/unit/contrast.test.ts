import { describe, expect, it } from "vitest";
import {
  composite,
  contrastRatio,
  csv,
  isAccent,
  luminance,
  parseCssColor,
  pixelsIn,
  quantile,
  requiredRatio,
  worstCase,
  type RGB,
} from "../../tools/contrast/lib.ts";

const ratio = (a: RGB, b: RGB): number => contrastRatio(luminance(a), luminance(b));

describe("contrast: WCAG maths", () => {
  it("matches the WCAG reference values", () => {
    expect(luminance([255, 255, 255])).toBeCloseTo(1, 6);
    expect(luminance([0, 0, 0])).toBe(0);
    expect(ratio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 6);
    expect(ratio([0x77, 0x77, 0x77], [255, 255, 255])).toBeCloseTo(4.48, 2);
    // Design tokens on the flat background: --text and --muted on --bg (build-plan §3: 7.6–17.8:1).
    expect(ratio([0xff, 0xf1, 0xe4], [0x0e, 0x0a, 0x08])).toBeCloseTo(17.8, 1);
    expect(ratio([0xc9, 0xb4, 0xa2], [0x0e, 0x0a, 0x08])).toBeGreaterThan(7.6);
  });

  it("composites translucent text over its background", () => {
    expect(composite([255, 255, 255], 0.5, [0, 0, 0])).toEqual([127.5, 127.5, 127.5]);
    expect(composite([10, 20, 30], 1, [200, 200, 200])).toEqual([10, 20, 30]);
    expect(composite([10, 20, 30], 0, [200, 200, 200])).toEqual([200, 200, 200]);
  });

  it("takes nearest-rank quantiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(quantile(values, 0.95)).toBe(95);
    expect(quantile(values, 0.05)).toBe(5);
    expect(quantile([3], 0.95)).toBe(3);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe("contrast: worst case over the glyph background", () => {
  it("judges light text against the brightest 5 % of its background", () => {
    // 90 dark pixels and 10 bright ones: the p95 pixel is bright.
    const bg: RGB[] = [
      ...Array.from({ length: 90 }, (): RGB => [14, 10, 8]),
      ...Array.from({ length: 10 }, (): RGB => [200, 180, 160]),
    ];
    const w = worstCase([255, 241, 228], 1, bg);
    expect(w?.polarity).toBe("light");
    expect(w?.background).toEqual([200, 180, 160]);
    expect(w?.ratio).toBeCloseTo(ratio([255, 241, 228], [200, 180, 160]), 6);
  });

  it("ignores a bright outlier below the 95th percentile cut", () => {
    const bg: RGB[] = [...Array.from({ length: 99 }, (): RGB => [14, 10, 8]), [255, 255, 255]];
    expect(worstCase([255, 241, 228], 1, bg)?.background).toEqual([14, 10, 8]);
  });

  it("judges dark text (a button label) against the darkest 5 %", () => {
    const bg: RGB[] = [
      ...Array.from({ length: 95 }, (): RGB => [255, 122, 61]),
      ...Array.from({ length: 5 }, (): RGB => [120, 60, 30]),
    ];
    const w = worstCase([14, 10, 8], 1, bg);
    expect(w?.polarity).toBe("dark");
    expect(w?.background).toEqual([120, 60, 30]);
  });

  it("applies copy opacity to the text colour", () => {
    const solid = worstCase([255, 241, 228], 1, [[14, 10, 8]]);
    const faded = worstCase([255, 241, 228], 0.5, [[14, 10, 8]]);
    expect(faded?.ratio).toBeLessThan(solid?.ratio ?? 0);
    expect(worstCase([255, 255, 255], 1, [])).toBeNull();
  });

  it("reads each pixel inside the boxes once", () => {
    // 4×2 RGBA image: left half black, right half white.
    const data = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 2; x < 4; x += 1) data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    }
    const image = { data, width: 4, height: 2, channels: 4 };
    const px = pixelsIn(image, [
      { x: 1, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 1, height: 2 },
    ]);
    expect(px).toHaveLength(4);
    expect(px.filter((c) => c[0] === 255)).toHaveLength(2);
  });
});

describe("contrast: bars and colours", () => {
  it("uses 3:1 for H1/H2 and ≥ 24 px, 4.5:1 below", () => {
    expect(requiredRatio({ tag: "H1", heading: "H1", fontSize: 64 })).toBe(3);
    expect(requiredRatio({ tag: "EM", heading: "H2", fontSize: 18 })).toBe(3);
    expect(requiredRatio({ tag: "P", heading: null, fontSize: 24 })).toBe(3);
    expect(requiredRatio({ tag: "P", heading: null, fontSize: 23.9 })).toBe(4.5);
    expect(requiredRatio({ tag: "SPAN", heading: "H3", fontSize: 18 })).toBe(4.5);
  });

  it("parses computed colours and spots the accent", () => {
    expect(parseCssColor("rgb(255, 122, 61)")).toEqual({ rgb: [255, 122, 61], alpha: 1 });
    expect(parseCssColor("rgba(255, 241, 228, 0.6)")).toEqual({ rgb: [255, 241, 228], alpha: 0.6 });
    expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual({ rgb: [1, 2, 3], alpha: 0.5 });
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(isAccent([255, 122, 61])).toBe(true);
    expect(isAccent([255, 194, 75])).toBe(false);
    expect(csv('a "b", c')).toBe('"a ""b"", c"');
  });
});
