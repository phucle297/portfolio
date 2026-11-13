/**
 * Scroll catch-up of the page-wide scene (pure, no DOM): how far the shown progress moves toward
 * the scroll position each frame. Shared by the stage (stage.ts) and the motion-safety check
 * (tools/flash), so the check replays exactly what ships.
 *
 * Small moves ease in exponentially (τ = `CATCH_UP_SECONDS`, ≈ GSAP `scrub: .6`). Big moves are
 * motion-safe (M3-AC10, PF-14): sweeping the whole page in a fraction of a second strobes the
 * scene's lights and red safelight (7 flashes/s on an End key press with the plain exponential),
 * so
 * - the shown progress never sweeps faster than `MAX_SWEEP_PER_SECOND` (a full page in 8 s, under
 *   the shortest safe constant scroll measured by the flash check), and
 * - a gap wider than `CUT_GAP` (End / Home, a far section link, a fast scrollbar drag) is crossed
 *   with a single cut instead of a sweep, at most once per `MIN_CUT_SECONDS`. A cut changes each
 *   part of the screen once: one transition, never a flash on its own.
 */
export const CATCH_UP_SECONDS = 0.15;
/** Fastest sweep of the shown progress, in progress per second (1 = the whole page). */
export const MAX_SWEEP_PER_SECOND = 0.125;
/** A gap wider than this (progress) is cut, not swept. */
export const CUT_GAP = 0.1;
/** Shortest time between two cuts: at most 2 cuts (2 transitions) in any 1 s. */
export const MIN_CUT_SECONDS = 0.5;

/**
 * One frame of catch-up toward `target`, `dt` seconds after the previous frame and `sinceCut`
 * seconds after the last cut (Infinity if none). Returns the new shown progress and whether this
 * frame was a cut (straight to the target, no sweep).
 */
export function catchUpStep(
  shown: number,
  target: number,
  dt: number,
  sinceCut: number,
): { shown: number; cut: boolean } {
  const gap = target - shown;
  if (Math.abs(gap) > CUT_GAP && sinceCut >= MIN_CUT_SECONDS) return { shown: target, cut: true };
  const eased = gap * (1 - Math.exp(-dt / CATCH_UP_SECONDS));
  const cap = MAX_SWEEP_PER_SECOND * dt;
  return { shown: shown + Math.max(-cap, Math.min(cap, eased)), cut: false };
}
