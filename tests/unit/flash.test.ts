import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/_pages/home/model/evaluate";
import {
  CATCH_UP_SECONDS,
  CUT_GAP,
  CUT_LEAD_GAP,
  MAX_SWEEP_PER_SECOND,
  MIN_CUT_SECONDS,
  QUIET_SECONDS,
  stageAt,
  stageStep,
  type StageState,
} from "../../src/_pages/home/lib/catch-up";
import {
  legacyStageStep,
  luminance,
  maxInWindow,
  minSafeSeconds,
  pathFlashesPerSecond,
  rampSpan,
  regionMeans,
  replayCatchUp,
  saturatedRed,
  type StageStepFn,
  sweepStates,
  transitions,
  valueAt,
  worstFlashesPerSecond,
} from "../../tools/flash/lib";
import { REVERSAL_GRID, reversalGrid } from "../../tools/flash/reversals";

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

describe("flash check mirrors the stage's idle budget", () => {
  it("IDLE_BUDGET_MS matches tools/flash/check.ts SNAP_SECONDS", () => {
    const stage = readFileSync("src/_pages/home/lib/stage.ts", "utf8");
    const check = readFileSync("tools/flash/check.ts", "utf8");
    expect(num(check, "SNAP_SECONDS") * 1000).toBe(num(stage, "IDLE_BUDGET_MS"));
    expect(check).toContain('from "../../src/_pages/home/lib/catch-up.ts"');
  });
});

describe("the stage applies stageStep and nothing else (PF-14, QA M1)", () => {
  // Cheap static guard; the behavioural guard is tests/e2e/catch-up.spec.ts (End on the real
  // page holds then cuts once, and every stage frame replays through stageStep bit for bit).
  const stage = readFileSync("src/_pages/home/lib/stage.ts", "utf8");
  it("calls stageStep once and takes the scene state only from it (or stageAt)", () => {
    expect(stage.match(/stageStep\(/g)).toHaveLength(1);
    expect(stage).toContain("scene = next.state;");
    const assignments = stage.match(/\bscene = [^;]+;/g) ?? [];
    expect(assignments.every((a) => a === "scene = next.state;" || a.includes("stageAt("))).toBe(
      true,
    );
    // Drawing uses the state's shown progress, and no easing maths is left in the stage.
    expect(stage).toContain("drawn = scene.shown;");
    expect(stage).not.toMatch(/Math\.(exp|pow|log)\b|CATCH_UP_SECONDS|shown\s*[+-]?=/);
  });
});

const legacyStep = legacyStageStep;
/** Back-and-forth ±5 % around p .5 every 0.75 s: faster than the sweep cap. */
const wiggle = (t: number): number => 0.5 + 0.05 * Math.sin((2 * Math.PI * t) / 0.75);
const DT = 1 / 60;
const frame = (target: number, dt = DT) => ({ target, dt, elapsed: dt, overBudget: false });
const at = (p: number, clocks: Partial<StageState> = {}): StageState => ({
  ...stageAt(p),
  ...clocks,
});
const N = 384;
/** A red region that turns on and off every 27 frames (14 transitions over the page), like r4c3. */
const strobe = Array.from({ length: N }, (_, i) => (Math.floor(i / 27) % 2 === 0 ? 0 : 40));
const jumpFps = (step: StageStepFn, p0: number, p1: number): number =>
  pathFlashesPerSecond(
    strobe,
    sweepStates(
      replayCatchUp(step, p0, () => p1, 0, { snapSeconds: 1.5 }),
      N,
    ),
    "red",
  );
const dragFps = (step: StageStepFn, seconds: number, p0: number, p1: number): number =>
  pathFlashesPerSecond(
    strobe,
    sweepStates(
      replayCatchUp(step, p0, (t) => p0 + (p1 - p0) * Math.min(1, t / seconds), seconds, {
        snapSeconds: 1.5,
      }),
      N,
    ),
    "red",
  );

describe("stage catch-up is motion-safe on big jumps (PF-14 / M3-AC10)", () => {
  it("small gaps ease exactly as the τ 0.15 s exponential", () => {
    const next = stageStep(at(0.5), frame(0.505));
    expect(next.cut).toBe(false);
    expect(next.swept).toBe(true);
    expect(next.state.shown).toBeCloseTo(0.5 + 0.005 * (1 - Math.exp(-DT / CATCH_UP_SECONDS)), 12);
    expect(next.state.lead).toBe(next.state.shown);
  });

  it("sweeps no faster than MAX_SWEEP_PER_SECOND; holds, then cuts, gaps over CUT_GAP", () => {
    // Within CUT_GAP: capped sweep along the lead's path.
    const capped = stageStep(at(0), frame(CUT_GAP * 0.99));
    expect(capped.cut).toBe(false);
    expect(capped.state.shown).toBeCloseTo(MAX_SWEEP_PER_SECOND * DT, 12);
    // Over CUT_GAP: hold until the lead is within CUT_LEAD_GAP of the target, then one cut.
    let s = at(0);
    let k = 0;
    for (; k < 600; k += 1) {
      const next = stageStep(s, frame(1));
      s = next.state;
      if (next.cut) break;
      expect(next.swept).toBe(false);
      expect(s.shown).toBe(0);
    }
    expect(s.shown).toBe(1);
    expect(k * DT).toBeCloseTo(CATCH_UP_SECONDS * Math.log(1 / CUT_LEAD_GAP), 1);
    // Too soon after a cut or a sweep: hold (no sweep, no cut), even with the lead there.
    const ready = { lead: 0 };
    const held = (clocks: Partial<StageState>) =>
      stageStep(at(1, { ...clocks, ...ready }), frame(0));
    expect(held({ sinceCut: MIN_CUT_SECONDS - 2 * DT }).cut).toBe(false);
    expect(held({ sinceSweep: QUIET_SECONDS - 2 * DT }).cut).toBe(false);
    expect(held({ sinceCut: MIN_CUT_SECONDS, sinceSweep: QUIET_SECONDS }).cut).toBe(true);
  });

  it("follows the pre-fix path, only later: never past where the old catch-up went", () => {
    // Back-and-forth faster than the sweep cap: shown replays the lead's (pre-fix) path.
    let s = at(0.5);
    let old = at(0.5);
    let [lo, hi, oldLo, oldHi] = [1, 0, 1, 0];
    for (let k = 1; k < 300; k += 1) {
      const f = frame(wiggle(k * DT));
      s = stageStep(s, f).state;
      old = legacyStageStep(old, f).state;
      expect(s.lead).toBe(old.shown);
      expect(Math.abs(s.shown - (s.path.at(-2)?.p ?? s.shown))).toBeLessThanOrEqual(1);
      [lo, hi] = [Math.min(lo, s.shown), Math.max(hi, s.shown)];
      [oldLo, oldHi] = [Math.min(oldLo, old.shown), Math.max(oldHi, old.shown)];
    }
    expect(lo).toBeGreaterThanOrEqual(oldLo);
    expect(hi).toBeLessThanOrEqual(oldHi);
    expect(s.path.length).toBeGreaterThan(1);
  });

  it("settles (snap, stop) only when caught up or out of the idle budget", () => {
    const done = stageStep(at(0.5), frame(0.5));
    expect(done.settled).toBe(true);
    expect(done.cut).toBe(false);
    const snap = stageStep(at(0.5), { ...frame(0.55), overBudget: true });
    expect(snap).toMatchObject({ settled: true, cut: true });
    expect(snap.state.shown).toBe(0.55);
    // Shown crossing the target mid back-and-forth is not caught up: the lead is elsewhere.
    const crossing = stageStep({ ...at(0.5), lead: 0.52, path: [{ p: 0.52, dt: DT }] }, frame(0.5));
    expect(crossing.settled).toBe(false);
  });

  it("regression: End / Home and far section links strobe with the old catch-up, not the new one", () => {
    // Old behaviour (459f3f9): a full-page sweep in ~1 s, red r4c3 at 7 flashes/s on the capture.
    expect(jumpFps(legacyStep, 0, 1)).toBeGreaterThan(3);
    expect(jumpFps(legacyStep, 1, 0)).toBeGreaterThan(3);
    expect(jumpFps(legacyStep, 0.12, 0.84)).toBeGreaterThan(3);
    for (const [p0, p1] of [
      [0, 1],
      [1, 0],
      [0.12, 0.84],
      [0.84, 0],
      [0.3, 0.52],
    ] as const) {
      expect(jumpFps(stageStep, p0, p1)).toBeLessThanOrEqual(0.5);
    }
  });

  it("regression: fast scrollbar drags strobe with the old catch-up, not the new one", () => {
    expect(dragFps(legacyStep, 0.5, 0, 1)).toBeGreaterThan(3);
    for (const seconds of [0.25, 0.5, 1, 1.5, 2, 3, 4, 8, 16])
      for (const [p0, p1] of [
        [0, 1],
        [1, 0],
        [0.12, 0.84],
        [0.84, 0.12],
        [0.3, 0.68],
      ] as const)
        expect(dragFps(stageStep, seconds, p0, p1)).toBeLessThanOrEqual(3);
  });

  it("hammering End / Home cuts at most twice in any 1 s and stays under the bar", () => {
    for (const every of [0.05, 0.1, 0.3, 0.75, 1.5]) {
      const shown = replayCatchUp(stageStep, 0, (t) => Math.floor(t / every) % 2, 3, {
        snapSeconds: 1.5,
      });
      const cuts = shown.filter((s) => s.cut).map((s) => s.t);
      expect(cuts.length).toBeGreaterThan(0);
      expect(maxInWindow(cuts, 1)).toBeLessThanOrEqual(2);
      expect(pathFlashesPerSecond(strobe, sweepStates(shown, N), "red")).toBeLessThanOrEqual(1);
    }
  });

  it("sweep states cover every captured frame a sweep passes, and none a cut skips", () => {
    const sweep = sweepStates(
      [
        { t: 0, p: 0, cut: false },
        { t: 1, p: 10 / (N - 1), cut: false },
      ],
      N,
    );
    expect(sweep.map((s) => Math.round(s.p * (N - 1)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sweep[5]?.t).toBeCloseTo(0.5, 9);
    const cut = sweepStates(
      [
        { t: 0, p: 0, cut: false },
        { t: 1 / 60, p: 1, cut: true },
      ],
      N,
    );
    expect(cut).toHaveLength(2);
    expect(valueAt([0, 10], 0.25)).toBeCloseTo(2.5, 12);
  });

  it("back-and-forth: no grid pattern worse than the pre-fix catch-up + 0.5/s (synthetic content)", () => {
    // QA's 2079-pattern reversal grid over synthetic regions: the r4c3-like strobe and a tight
    // red cluster of 6 transitions within 5 % of the page (like the safelight at p .50–.55).
    const cluster = Array.from({ length: N }, (_, i) =>
      i >= 192 && i < 212 && Math.floor((i - 192) / 3) % 2 === 0 ? 40 : 0,
    );
    const grid = reversalGrid(
      stageStep,
      legacyStep,
      [
        { values: strobe, kind: "red", name: "strobe" },
        { values: cluster, kind: "red", name: "cluster" },
      ],
      N,
      1.5,
    );
    expect(grid.rows).toHaveLength(REVERSAL_GRID.length);
    expect(REVERSAL_GRID).toHaveLength(2079);
    expect(grid.regressions.map((r) => `${r.shape} ${r.center} ±${r.amp} / ${r.period}`)).toEqual(
      [],
    );
    expect(grid.mean.head).toBeLessThanOrEqual(grid.mean.legacy);
    expect(grid.worst.head.head).toBeLessThanOrEqual(grid.worst.legacy.legacy);
  });
});
