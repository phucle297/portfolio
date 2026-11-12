/** M2-AC8 (logic): the copy scrub table, one section at a time, and beats inside a pin. */
import { describe, expect, it } from "vitest";
import {
  COPY_TRAVEL_PX,
  HOLDS,
  KEY_COUNT,
  beatAt,
  beatFade,
  beatOpacity,
  beatProgress,
  copyState,
  copyWindow,
  ease,
  sectionAt,
} from "@shared/lib/timeline";

const morphP = (k: number, t: number): number => {
  const end = HOLDS[k]?.[1] ?? 0;
  const start = HOLDS[k + 1]?.[0] ?? 1;
  return end + (start - end) * t;
};

describe("copy scrub", () => {
  it("holds copy fully on, at rest, during its own hold", () => {
    HOLDS.forEach(([a, b], k) => {
      for (const p of [a, (a + b) / 2, b]) expect(copyState(p, k)).toEqual({ opacity: 1, y: 0 });
    });
  });

  it("exits over t 0–.35 (1 → 0, 0 → −24 px) and enters over .65–1 (+24 px → 0), eased", () => {
    for (let k = 0; k < KEY_COUNT - 1; k += 1) {
      for (const t of [0.1, 0.175, 0.3]) {
        const s = copyState(morphP(k, t), k);
        expect(s.opacity).toBeCloseTo(1 - ease(t / 0.35), 6);
        expect(s.y).toBeCloseTo(-COPY_TRAVEL_PX * ease(t / 0.35), 6);
      }
      for (const t of [0.7, 0.825, 0.95]) {
        const s = copyState(morphP(k, t), k + 1);
        expect(s.opacity).toBeCloseTo(ease((t - 0.65) / 0.35), 6);
        expect(s.y).toBeCloseTo(COPY_TRAVEL_PX * (1 - ease((t - 0.65) / 0.35)), 6);
      }
      // Mid-morph: no copy at all.
      for (const t of [0.36, 0.5, 0.64]) {
        for (let i = 0; i < KEY_COUNT; i += 1) expect(copyState(morphP(k, t), i).opacity).toBe(0);
      }
    }
  });

  it("never shows two sections at once (10,000 p)", () => {
    for (let i = 0; i <= 10_000; i += 1) {
      const p = i / 10_000;
      const visible = Array.from({ length: KEY_COUNT }, (_, s) => copyState(p, s).opacity).filter(
        (o) => o > 0,
      );
      expect(visible.length).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous (no opacity jump > .01 per 1e-4 p)", () => {
    for (let s = 0; s < KEY_COUNT; s += 1) {
      let prev = copyState(0, s).opacity;
      for (let i = 1; i <= 10_000; i += 1) {
        const o = copyState(i / 10_000, s).opacity;
        expect(Math.abs(o - prev)).toBeLessThan(0.01);
        prev = o;
      }
    }
  });

  it("keeps the section boundaries the nav switches at (12/30/52/68/84 %)", () => {
    const boundaries = [0.12, 0.3, 0.52, 0.68, 0.84];
    boundaries.forEach((b, i) => {
      expect(sectionAt(b - 0.005)).toBe(i);
      expect(sectionAt(b + 0.005)).toBe(i + 1);
    });
  });
});

describe("beats", () => {
  it("step in order across the section's copy window", () => {
    const [from, to] = copyWindow(3);
    expect(beatAt(from, 3, 5)).toBe(0);
    expect(beatAt(to, 3, 5)).toBe(4);
    let last = 0;
    for (let i = 0; i <= 100; i += 1) {
      const b = beatAt(from + ((to - from) * i) / 100, 3, 5);
      expect(b).toBeGreaterThanOrEqual(last);
      last = b;
    }
  });

  it("every beat is fully shown (copy and card at opacity 1) inside its section's hold (QA B-7)", () => {
    for (const [index, count] of [
      [1, 3],
      [3, 5],
    ] as const) {
      const hold = HOLDS[index] ?? [0, 0];
      const stretches: number[] = [];
      for (let b = 0; b < count; b += 1) {
        let shown = 0;
        for (let p = hold[0]; p <= hold[1]; p += 1e-5) {
          if (copyState(p, index).opacity * beatOpacity(p, index, b, count) >= 1 - 1e-9)
            shown += 1e-5;
        }
        stretches.push(shown);
      }
      // Each card is on for the same stretch of the hold: at least 3.4e-3 of p (more than one
      // 1/383 smoothness-capture step) for the five Services cards in their .06 hold; the rest
      // of the hold goes to slow crossfades (M2-AC6: Services ≥ .01, Journey ≥ .03 of p).
      expect(beatFade(index, count)).toBeGreaterThanOrEqual(index === 3 ? 0.01 : 0.03);
      for (const shown of stretches) {
        expect(shown).toBeGreaterThan(0.0034);
        expect(shown).toBeCloseTo(stretches[0] ?? 0, 3);
      }
    }
  });

  it("scroll targets land inside their own beat", () => {
    for (const [index, count] of [
      [1, 3],
      [3, 5],
    ] as const) {
      for (let b = 0; b < count; b += 1)
        expect(beatAt(beatProgress(index, b, count), index, count)).toBe(b);
    }
  });

  it("single-beat sections scroll to their key p", () => {
    expect(beatProgress(2, 0, 1)).toBe(0.41);
    expect(beatAt(0.5, 2, 1)).toBe(0);
  });

  it("crossfade by scroll: beat opacities always sum to 1 and change gradually", () => {
    for (const [index, count] of [
      [1, 3],
      [3, 5],
    ] as const) {
      const [from, to] = copyWindow(index);
      const step = 1 / 383;
      const fade = beatFade(index, count);
      // Linear crossfade: at most step / fade per frame.
      const maxStep = step / fade + 1e-9;
      let prev = Array.from({ length: count }, (_, b) => beatOpacity(from, index, b, count));
      for (let p = from; p <= to; p += step) {
        const now = Array.from({ length: count }, (_, b) => beatOpacity(p, index, b, count));
        expect(now.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        now.forEach((o, b) => {
          expect(Math.abs(o - (prev[b] ?? 0))).toBeLessThanOrEqual(maxStep);
        });
        prev = now;
      }
      // Every beat is fully shown at its own scroll target.
      for (let b = 0; b < count; b += 1) {
        expect(beatOpacity(beatProgress(index, b, count), index, b, count)).toBe(1);
      }
    }
  });
});
