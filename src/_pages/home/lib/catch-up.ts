/**
 * Scroll catch-up of the page-wide scene (pure, no DOM): how far the shown progress moves toward
 * the scroll position each frame. Shared by the stage (stage.ts) and the motion-safety check
 * (tools/flash), so the check replays exactly what ships.
 *
 * Small moves ease in exponentially (τ = `CATCH_UP_SECONDS`, ≈ GSAP `scrub: .6`). Big moves are
 * made motion-safe (M3-AC10, PF-14): sweeping the page in a fraction of a second strobes the
 * scene's lights and red safelight (7 flashes/s on an End key press with the plain exponential).
 * - The shown progress never sweeps faster than `MAX_SWEEP_PER_SECOND` (a full page in 8 s,
 *   under the 6.18 s shortest safe constant scroll the flash check measures).
 * - A gap wider than `CUT_GAP` (End / Home, a far section link, a fast scrollbar drag) is not
 *   swept: the scene holds, then crosses it with a single cut. A cut changes each part of the
 *   screen once (one transition, never a flash on its own).
 * - A cut waits until the scene has not swept for `QUIET_SECONDS` and has not cut for
 *   `MIN_CUT_SECONDS`, so a cut never adds to a sweep's transitions in the same second and
 *   there are at most 2 cuts in any second.
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

/** Seconds since the last cut and since the last sweep move (Infinity if none yet). */
export interface CatchUpClock {
  sinceCut: number;
  sinceSweep: number;
}

/**
 * One frame of catch-up toward `target`, `dt` seconds after the previous frame. Returns the new
 * shown progress, whether this frame was a cut (straight to the target) and whether it swept.
 */
export function catchUpStep(
  shown: number,
  target: number,
  dt: number,
  clock: CatchUpClock,
): { shown: number; cut: boolean; swept: boolean } {
  const gap = target - shown;
  if (Math.abs(gap) > CUT_GAP) {
    const cut = clock.sinceCut >= MIN_CUT_SECONDS && clock.sinceSweep >= QUIET_SECONDS;
    return { shown: cut ? target : shown, cut, swept: false };
  }
  const eased = gap * (1 - Math.exp(-dt / CATCH_UP_SECONDS));
  const cap = MAX_SWEEP_PER_SECOND * dt;
  const move = Math.max(-cap, Math.min(cap, eased));
  return { shown: shown + move, cut: false, swept: move !== 0 };
}
