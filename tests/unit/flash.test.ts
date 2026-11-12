import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/_pages/home/model/evaluate";
import {
  catchUpTime,
  luminance,
  maxInWindow,
  minSafeSeconds,
  rampSpan,
  regionMeans,
  saturatedRed,
  transitions,
  worstFlashesPerSecond,
} from "../../tools/flash/lib";

describe("flash maths (WCAG 2.2 general and red flash)", () => {
  it("relative luminance of black, white and mid grey", () => {
    expect(luminance(0, 0, 0)).toBe(0);
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 6);
    expect(luminance(128, 128, 128)).toBeCloseTo(0.2158, 3);
  });

  it("saturated red only counts strongly red pixels", () => {
    expect(saturatedRed(255, 0, 0)).toBeCloseTo(320, 6);
    expect(saturatedRed(255, 40, 40)).toBeGreaterThan(0);
    // Linear R / (R + G + B) < 0.8: not saturated red.
    expect(saturatedRed(200, 120, 120)).toBe(0);
    expect(saturatedRed(0, 0, 0)).toBe(0);
  });

  it("region means average in linear light, per grid cell", () => {
    // 2×1 image: left black, right white; RGB.
    const data = Uint8Array.from([0, 0, 0, 255, 255, 255]);
    const { luminance: l } = regionMeans(data, 2, 1, 3, { cols: 2, rows: 1 });
    expect([...l]).toEqual([0, expect.closeTo(1, 6)]);
    const whole = regionMeans(data, 2, 1, 3, { cols: 1, rows: 1 });
    expect(whole.luminance[0]).toBeCloseTo(0.5, 6);
  });

  it("counts opposing transitions with hysteresis, not noise or slow single ramps", () => {
    // A slow ramp from dark to light is ONE transition.
    expect(transitions([0, 0.03, 0.06, 0.09, 0.12, 0.3, 0.6], "general")).toHaveLength(1);
    // Noise below 0.1 never counts.
    expect(transitions([0.2, 0.25, 0.2, 0.27, 0.21, 0.26], "general")).toEqual([]);
    // Dark-light-dark-light: 3 transitions = 1.5 flashes.
    expect(transitions([0, 0.5, 0, 0.5], "general")).toEqual([1, 2, 3]);
    // Both states ≥ 0.8 (bright to brighter) is not a flash.
    expect(transitions([0.8, 0.95, 0.8, 0.95], "general")).toEqual([]);
    // Red: change > 20 counts.
    expect(transitions([0, 30, 0, 30], "red")).toHaveLength(3);
    expect(transitions([0, 15, 0, 15], "red")).toEqual([]);
  });

  it("worst 1 s window and flashes per second", () => {
    expect(maxInWindow([0, 0.2, 0.4, 0.6, 2], 1)).toBe(4);
    expect(maxInWindow([0, 1, 2], 1)).toBe(1);
    // Order-independent (reverse-scroll lists arrive in descending frame order).
    expect(maxInWindow([2, 0.6, 0.4, 0.2, 0], 1)).toBe(4);
    expect(maxInWindow([2, 1, 0], 1)).toBe(1);
    // 8 transitions within 1 s = 4 flashes: over the bar.
    const frames = [0, 1, 2, 3, 4, 5, 6, 7];
    expect(worstFlashesPerSecond(frames, (i) => i * 0.1)).toBe(4);
    expect(worstFlashesPerSecond(frames, (i) => i * 0.5)).toBe(1);
  });

  it("finds the shortest safe constant-rate scroll", () => {
    // 8 transitions evenly over 100 frames: safe once 7 transitions never fit in 1 s.
    const frames = Array.from({ length: 8 }, (_, i) => i * 14);
    const s = minSafeSeconds([frames], 100);
    const ok = (sec: number): boolean => worstFlashesPerSecond(frames, (i) => (i / 99) * sec) <= 3;
    expect(ok(s)).toBe(true);
    expect(ok(s * 0.99)).toBe(false);
    expect(minSafeSeconds([[]], 100)).toBe(0);
    // A reverse-scroll list (descending frames) gives the same answer, and terminates.
    expect(minSafeSeconds([frames.toReversed()], 100)).toBeCloseTo(s, 6);
  });

  it("catch-up time follows the stage's exponential and snaps at the idle budget", () => {
    expect(catchUpTime(0, 0, 1, 0.15, 1.5)).toBe(0);
    expect(catchUpTime(1 - Math.exp(-1), 0, 1, 0.15, 1.5)).toBeCloseTo(0.15, 6);
    expect(catchUpTime(1, 0, 1, 0.15, 1.5)).toBe(1.5);
    // Upward jump mirrors it.
    expect(catchUpTime(Math.exp(-2), 1, 0, 0.15, 1.5)).toBeCloseTo(0.3, 6);
  });

  it("ramp span from the last flat sample to the top", () => {
    const ps = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const v = [0, 0, 0.5, 1, 1, 1];
    const ramp = rampSpan(ps, v, 0, 1);
    expect([ramp.from, ramp.to]).toEqual([0.1, 0.3]);
    expect(ramp.span).toBeCloseTo(0.2, 9);
  });
});

describe("M3-AC10 lights-on ramp in the scene model", () => {
  it("the scene light level ramps 0 → 1 over ≥ 4 % of scroll", () => {
    const ps = Array.from({ length: 10_001 }, (_, i) => i / 10_000);
    const lit = ps.map((p) => evaluate(p).tiles[0]?.lit ?? 0);
    const ramp = rampSpan(ps, lit, 0, 1);
    expect(lit[0]).toBe(0);
    expect(lit.at(-1)).toBe(1);
    expect(ramp.span).toBeGreaterThanOrEqual(0.04);
    // Exposure and background follow the same light track (no separate faster jump).
    const exposure = ps.map((p) => evaluate(p).exposure);
    const tail = ps.findIndex((p) => p >= 0.79);
    const exposureRamp = rampSpan(ps.slice(tail), exposure.slice(tail), 0, 1);
    expect(exposureRamp.span).toBeGreaterThanOrEqual(0.04);
  });
});

const num = (src: string, name: string): number =>
  Number(new RegExp(`const ${name} = ([\\d._]+)`).exec(src)?.[1]?.replaceAll("_", ""));

describe("flash check mirrors the stage's catch-up constants", () => {
  it("CATCH_UP_SECONDS and IDLE_BUDGET_MS match tools/flash/check.ts", () => {
    const stage = readFileSync("src/_pages/home/lib/stage.ts", "utf8");
    const check = readFileSync("tools/flash/check.ts", "utf8");
    expect(num(check, "CATCH_UP_TAU")).toBe(num(stage, "CATCH_UP_SECONDS"));
    expect(num(check, "SNAP_SECONDS") * 1000).toBe(num(stage, "IDLE_BUDGET_MS"));
  });
});
