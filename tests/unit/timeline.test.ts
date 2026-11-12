import { describe, expect, it } from "vitest";
import { HOLDS, KEY_PROGRESS, SECTIONS, ease, locate, sectionAt } from "@shared/lib/timeline";

describe("timeline", () => {
  it("has six sections whose DOM ranges tile 0 → 1 at the design boundaries", () => {
    expect(SECTIONS.map((s) => s.start)).toEqual([0, 0.12, 0.3, 0.52, 0.68, 0.84]);
    expect(SECTIONS.at(-1)?.end).toBe(1);
  });

  it("places every key frame inside its hold", () => {
    KEY_PROGRESS.forEach((p, k) => {
      expect(locate(p)).toEqual({ k, t: 0 });
      const hold = HOLDS[k];
      expect(hold && p >= hold[0] && p <= hold[1]).toBe(true);
    });
  });

  it("reports morph-local time between holds", () => {
    const { k, t } = locate(0.115);
    expect(k).toBe(0);
    expect(t).toBeCloseTo(0.5, 6);
    expect(locate(0.855).k).toBe(4);
  });

  it("maps progress to the containing DOM section", () => {
    expect([0, 0.119, 0.12, 0.31, 0.6, 0.7, 0.9, 1].map(sectionAt)).toEqual([
      0, 0, 1, 2, 3, 4, 5, 5,
    ]);
  });

  it("eases with zero velocity at both ends", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(1e-4)).toBeLessThan(1e-9);
    expect(1 - ease(1 - 1e-4)).toBeLessThan(1e-9);
  });
});
