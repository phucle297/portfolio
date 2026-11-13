/**
 * Scroll catch-up of the page-wide scene (pure, no DOM): the stage's whole per-frame state
 * transition, `stageStep`. The stage (stage.ts) applies its result as is, with no easing of its
 * own; the motion-safety check (tools/flash) and the unit tests replay the same function, so the
 * check tests exactly what ships (PF-14, QA M1).
 *
 * - A lead follows the scroll position with the plain exponential (τ = `CATCH_UP_SECONDS`,
 *   ≈ GSAP `scrub: .6`), the pre-PF-14 catch-up.
 * - The shown progress follows the lead, never faster than `MAX_SWEEP_PER_SECOND` (a full page in
 *   8 s, under the 6.18 s shortest safe constant scroll the flash check measures). When the cap
 *   does not bind, shown = lead: small moves ease exactly as before. Because the shown progress
 *   only ever moves toward the lead, it stays within the range the pre-fix catch-up covers and
 *   crosses a given point no more often, so back-and-forth input is no worse than before.
 * - A gap to the scroll position wider than `CUT_GAP` (End / Home, a far section link, a fast
 *   scrollbar drag) is not swept: the scene holds, then crosses it with a single cut. A cut
 *   changes each part of the screen once (one transition, never a flash on its own).
 * - A cut waits until the scene has not swept for `QUIET_SECONDS` and has not cut for
 *   `MIN_CUT_SECONDS`, so a cut never adds to a sweep's transitions in the same second and
 *   there are at most 2 cuts in any second.
 * - Settle: within `SETTLE_EPSILON` of the scroll position, or when the stage's idle budget would
 *   be overrun (`overBudget`), the scene snaps to the scroll position (a cut) and rendering stops.
 */
export const CATCH_UP_SECONDS = 0.15;
/** Fastest sweep of the shown progress, in progress per second (1 = the whole page). */
export const MAX_SWEEP_PER_SECOND = 0.125;
/** A gap wider than this (progress) is cut, not swept. */
export const CUT_GAP = 0.1;
/** Shortest time between two cuts. */
export const MIN_CUT_SECONDS = 0.5;
/** No cut within this long after the scene last swept. */
export const QUIET_SECONDS = 1;
/** A cut waits until the lead is this close to the scroll position (the input has stopped). */
export const CUT_LEAD_GAP = 0.01;
/** Closer than this to the scroll position counts as caught up (snap and stop). */
export const SETTLE_EPSILON = 1e-4;

/** The stage's catch-up state between frames. */
export interface StageState {
  /** The progress the scene and the copy layer show. */
  shown: number;
  /** The plain exponential follower of the scroll position (the pre-PF-14 catch-up). */
  lead: number;
  /** The lead's path not yet shown: one point per frame, with that frame's duration (s). */
  path: readonly PathPoint[];
  /** Seconds since the last cut / since the last sweep move (Infinity if none yet). */
  sinceCut: number;
  sinceSweep: number;
}

export interface PathPoint {
  p: number;
  dt: number;
}

/** One frame's input. */
export interface StageFrame {
  /** Scroll progress now. */
  target: number;
  /** Easing step, s (the stage clamps slow frames to 0.1 s). */
  dt: number;
  /** Real time since the previous frame, s (advances the cut / sweep clocks). */
  elapsed: number;
  /** Whether continuing would overrun the stage's idle budget: snap and stop. */
  overBudget: boolean;
}

export interface StageStepResult {
  state: StageState;
  /** This frame jumped straight to the scroll position (a cut or the settle snap). */
  cut: boolean;
  /** This frame moved the shown progress continuously. */
  swept: boolean;
  /** Caught up (or out of budget): render this frame, then stop. */
  settled: boolean;
}

/** Start state at progress `p` (page load, a test hook jump). */
export function stageAt(p: number): StageState {
  return {
    shown: p,
    lead: p,
    path: [],
    sinceCut: Number.POSITIVE_INFINITY,
    sinceSweep: Number.POSITIVE_INFINITY,
  };
}

/** Longest backlog of the lead's path kept (frames); older points are dropped. */
export const MAX_PATH_POINTS = 1200;

/**
 * Walks `shown` along `path` for one frame: at most `dt` seconds of the path (never faster than
 * the lead moved) and at most `cap` of progress. Returns the new position and what is left.
 */
function walk(
  shown: number,
  path: readonly PathPoint[],
  dt: number,
  cap: number,
): { shown: number; path: PathPoint[] } {
  let time = dt;
  let dist = cap;
  let i = 0;
  let head: PathPoint | undefined;
  for (; i < path.length && time > 0 && dist > 0; i += 1) {
    const q = path[i] ?? { p: shown, dt: 0 };
    const d = Math.abs(q.p - shown);
    const f = Math.min(1, q.dt > 0 ? time / q.dt : 1, d > 0 ? dist / d : 1);
    shown += (q.p - shown) * f;
    time -= q.dt * f;
    dist -= d * f;
    if (f < 1) {
      head = { p: q.p, dt: q.dt * (1 - f) };
      i += 1;
      break;
    }
  }
  const rest = path.slice(i);
  return { shown, path: head ? [head, ...rest] : rest };
}

/** One frame of the stage: the full state transition the stage applies, nothing else. */
export function stageStep(state: StageState, frame: StageFrame): StageStepResult {
  const { target, dt, elapsed } = frame;
  const sinceCut = state.sinceCut + elapsed;
  const sinceSweep = state.sinceSweep + elapsed;
  let { shown, lead } = state;
  let cut = false;
  let swept = false;
  lead += (target - lead) * (1 - Math.exp(-dt / CATCH_UP_SECONDS));
  if (Math.abs(target - lead) < SETTLE_EPSILON) lead = target;
  let path = [...state.path.slice(-(MAX_PATH_POINTS - 1)), { p: lead, dt }];
  if (Math.abs(target - shown) > CUT_GAP) {
    cut =
      sinceCut >= MIN_CUT_SECONDS &&
      sinceSweep >= QUIET_SECONDS &&
      Math.abs(target - lead) < CUT_LEAD_GAP;
    if (cut) {
      shown = target;
      lead = target;
      path = [];
    }
  } else {
    const next = walk(shown, path, dt, MAX_SWEEP_PER_SECOND * dt);
    swept = next.shown !== shown;
    shown = next.shown;
    path = next.path;
  }
  const settled =
    (Math.abs(target - shown) < SETTLE_EPSILON && Math.abs(target - lead) < SETTLE_EPSILON) ||
    frame.overBudget;
  if (settled) {
    if (shown !== target && Math.abs(target - shown) >= SETTLE_EPSILON) cut = true;
    shown = target;
    lead = target;
    path = [];
  }
  return {
    state: { shown, lead, path, sinceCut: cut ? 0 : sinceCut, sinceSweep: swept ? 0 : sinceSweep },
    cut,
    swept,
    settled,
  };
}
