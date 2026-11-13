/**
 * Back-and-forth scroll input (rapid reversals), PF-14 AC1 scope (PM ruling 2026-11-14 b): out
 * of the 3 flashes/s gate, but no regression against the pre-fix catch-up, measured over QA's
 * reversal grid (/workspace/repos/portfolio-qa-reports/TASK-PF-14-a2/reversal-probe.ts):
 * sine, triangle and square inputs; centres 0.1–0.9; ±1–15 %; periods 0.15–3 s; 5 s of input
 * replayed at 60 fps (snap 1.5 s after it), scored as the worst 1 s over every region series.
 * Rule: per pattern, new ≤ pre-fix + `REVERSAL_SLACK`; mean and worst over the grid ≤ pre-fix.
 * Pure, no I/O.
 */
import {
  pathFlashesPerSecond,
  replayCatchUp,
  sweepStates,
  type Kind,
  type StageStepFn,
} from "./lib.ts";

export const REVERSAL_SLACK = 0.5;
export const REVERSAL_SECONDS = 5;

const SHAPES = {
  sine: (x: number): number => Math.sin(2 * Math.PI * x),
  tri: (x: number): number => {
    const f = ((x % 1) + 1) % 1;
    return f < 0.25 ? 4 * f : f < 0.75 ? 2 - 4 * f : 4 * f - 4;
  },
  /** Wheel flicks / PgUp-PgDn. */
  square: (x: number): number => (((x % 1) + 1) % 1 < 0.5 ? 1 : -1),
} as const;
export type Shape = keyof typeof SHAPES;
const SHAPE_NAMES: Shape[] = ["sine", "tri", "square"];

export interface ReversalPattern {
  shape: Shape;
  center: number;
  amp: number;
  period: number;
}

export const REVERSAL_GRID: ReversalPattern[] = SHAPE_NAMES.flatMap((shape) =>
  [0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9].flatMap((center) =>
    [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15].flatMap((amp) =>
      [0.15, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3].map((period) => ({ shape, center, amp, period })),
    ),
  ),
);

export const reversalName = (r: ReversalPattern): string =>
  `${r.shape} ${r.center} ±${r.amp} every ${r.period} s`;

export const reversalTarget =
  (r: ReversalPattern) =>
  (t: number): number =>
    Math.max(0, Math.min(1, r.center + r.amp * SHAPES[r.shape](t / r.period)));

/** A region's value per captured frame, and how to count its transitions. */
export interface RegionSeries {
  values: ArrayLike<number>;
  kind: Kind;
  name: string;
}

/** Worst flashes/s over all regions for one pattern through `step`. */
export function reversalFlashes(
  step: StageStepFn,
  r: ReversalPattern,
  regions: readonly RegionSeries[],
  frameCount: number,
  snapSeconds: number,
): { fps: number; region: string } {
  const states = sweepStates(
    replayCatchUp(step, r.center, reversalTarget(r), REVERSAL_SECONDS, { snapSeconds }),
    frameCount,
  );
  let best = { fps: 0, region: "" };
  for (const region of regions) {
    const fps = pathFlashesPerSecond(region.values, states, region.kind);
    if (fps > best.fps) best = { fps, region: `${region.name}/${region.kind}` };
  }
  return best;
}

export interface ReversalRow extends ReversalPattern {
  head: number;
  headRegion: string;
  legacy: number;
}

export interface ReversalSummary {
  rows: ReversalRow[];
  mean: { head: number; legacy: number };
  worst: { head: ReversalRow; legacy: ReversalRow };
  over3: { head: number; legacy: number };
  /** Patterns where head > legacy + REVERSAL_SLACK (must be 0), and head > legacy at all. */
  regressions: ReversalRow[];
  worse: number;
  better: number;
  pass: boolean;
}

export function reversalGrid(
  head: StageStepFn,
  legacy: StageStepFn,
  regions: readonly RegionSeries[],
  frameCount: number,
  snapSeconds: number,
  grid: readonly ReversalPattern[] = REVERSAL_GRID,
): ReversalSummary {
  const rows = grid.map((r) => {
    const h = reversalFlashes(head, r, regions, frameCount, snapSeconds);
    const l = reversalFlashes(legacy, r, regions, frameCount, snapSeconds);
    return { ...r, head: h.fps, headRegion: h.region, legacy: l.fps };
  });
  const mean = (k: "head" | "legacy"): number => rows.reduce((s, x) => s + x[k], 0) / rows.length;
  const top = (k: "head" | "legacy"): ReversalRow => rows.reduce((a, b) => (b[k] > a[k] ? b : a));
  const regressions = rows.filter((x) => x.head > x.legacy + REVERSAL_SLACK);
  const summary = {
    rows,
    mean: { head: mean("head"), legacy: mean("legacy") },
    worst: { head: top("head"), legacy: top("legacy") },
    over3: {
      head: rows.filter((x) => x.head > 3).length,
      legacy: rows.filter((x) => x.legacy > 3).length,
    },
    regressions,
    worse: rows.filter((x) => x.head > x.legacy).length,
    better: rows.filter((x) => x.head < x.legacy).length,
  };
  return {
    ...summary,
    pass:
      regressions.length === 0 &&
      summary.mean.head <= summary.mean.legacy &&
      summary.worst.head.head <= summary.worst.legacy.legacy,
  };
}
