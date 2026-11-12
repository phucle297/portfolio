/**
 * Static tier, desktop and tablet (≥ 768 px): one viewport-fixed poster still at a time, the one of
 * the section under the scroll position (the same progress → section mapping as the scene and the
 * nav), cross-faded in {@link CROSSFADE_MS} ms when the section changes (build plan M3-AC1).
 *
 * Never black (M2-AC7 intent):
 * - a still only takes over once its image is decoded; until then the current one stays;
 * - only one of the two stills animates. The later one in DOM order (which paints on top) fades
 *   over the earlier one, which stays fully opaque underneath until the fade ends, so every pixel
 *   is a mix of the two stills and never darker than the darker of them.
 * Under reduced motion (OS setting or the site's Motion toggle) the change is instant.
 *
 * Only the shown still and its neighbours are displayed (so lazy images load ahead of the scroll
 * and the rest are never fetched early). Phones keep their in-flow stills (portrait intro +
 * 390×240 bands), so nothing runs there.
 */
import { sectionAt } from "@shared/lib/timeline";

export const CROSSFADE_MS = 320;
/** Viewport width from which the stills are viewport-fixed and cross-fade (the tablet breakpoint). */
export const CROSSFADE_MIN_WIDTH = 768;

const SHOWN = "is-shown";
const FADING = "is-fading";
const NEAR = "is-near";

function progress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function instant(): boolean {
  return (
    !document.documentElement.classList.contains("motion-ok") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Resolves once the still's image can be painted (true), or failed to load (false). */
async function ready(still: HTMLElement): Promise<boolean> {
  const img = still.querySelector("img");
  if (!img) return false;
  if (img.complete && img.naturalWidth > 0) return true;
  try {
    await img.decode();
    return true;
  } catch {
    return false;
  }
}

export function initStillCrossfade(): void {
  const stills = Array.from(document.querySelectorAll<HTMLElement>("[data-still]"));
  if (stills.length === 0) return;
  const root = document.documentElement;
  const wide = window.matchMedia(`(min-width: ${CROSSFADE_MIN_WIDTH}px)`);
  /** The still that is fully visible (or fading in). */
  let shown: HTMLElement | null = null;
  /** The still of the section under the scroll position. */
  let target: HTMLElement | null = null;
  let settleTimer = 0;
  let queued = false;

  /** End any running fade at once: only the shown still stays visible. */
  const settle = (): void => {
    window.clearTimeout(settleTimer);
    for (const still of stills) {
      still.classList.remove(FADING);
      still.classList.toggle(SHOWN, still === shown);
    }
  };

  const fade = (previous: HTMLElement, next: HTMLElement): void => {
    const nextIsLater =
      (previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    previous.classList.add(SHOWN);
    if (nextIsLater) {
      // Scrolling down: the next still fades in (0 → 1) over the previous one.
      next.classList.add(FADING);
      // Commit the start value so the transition runs (reading style flushes it).
      void getComputedStyle(next).opacity;
      next.classList.add(SHOWN);
    } else {
      // Scrolling back: the next still is underneath at full opacity; the previous fades out.
      next.classList.add(SHOWN);
      previous.classList.add(FADING);
      void getComputedStyle(previous).opacity;
      previous.classList.remove(SHOWN);
    }
    settleTimer = window.setTimeout(settle, CROSSFADE_MS + 40);
  };

  const go = async (next: HTMLElement): Promise<void> => {
    if (next === target) return;
    target = next;
    const index = stills.indexOf(next);
    for (const [i, still] of stills.entries())
      still.classList.toggle(NEAR, Math.abs(i - index) <= 1);
    const ok = await ready(next);
    // Scrolled on meanwhile, or the image failed: keep what is on screen.
    if (target !== next || !ok) return;
    const previous = shown;
    // A fade in progress jumps to its end first, so at most two stills are ever involved.
    settle();
    shown = next;
    root.dataset.stillActive = next.dataset.still ?? "";
    if (!previous || previous === next || instant()) settle();
    else fade(previous, next);
  };

  const update = (): void => {
    queued = false;
    if (!wide.matches) return;
    const next = stills.find((still) => still.dataset.still === String(sectionAt(progress())));
    if (next) void go(next);
  };

  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  update();
}
