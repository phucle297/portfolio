/**
 * Static tier, desktop and tablet (≥ 768 px): one viewport-fixed poster still at a time, the one of
 * the section under the scroll position (the same progress → section mapping as the scene and the
 * nav), cross-faded in {@link CROSSFADE_MS} ms when the section changes (build plan M3-AC1).
 *
 * Never black (M2-AC7 intent):
 * - a still only takes over once its image is decoded; until then the current one stays;
 * - only one of the two stills animates. The later one in DOM order (which paints on top) fades
 *   over the earlier one, which stays fully opaque underneath until the fade has really finished
 *   (the Web Animation's `finished`, not a wall-clock timer, so a busy main thread or a stalled
 *   frame can delay the fade but never uncover the page background). Every pixel is a mix of the
 *   two stills and never darker than the darker of them.
 * Under reduced motion (OS setting or the site's Motion toggle) the change is instant.
 *
 * Only the shown still and its neighbours are displayed (so lazy images load ahead of the scroll
 * and the rest are never fetched early).
 *
 * Tier switches (PF-09): on the full tier the stills are `display: none` behind the live scene, so
 * nothing is picked or decoded there. When the tier becomes static mid-visit (reduced motion or
 * the Motion toggle switched on), the still of the current section is picked, decoded and shown
 * right away, without waiting for a scroll. A still whose image could not be decoded is retried
 * on the next update instead of being remembered as the target. Phones keep their in-flow stills (portrait intro +
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
    // decode() can reject for a lazy image whose load has not started yet (Firefox, WebKit: it
    // was not displayed when asked). It is displayed now, so wait for the load itself.
    if (img.complete) return img.naturalWidth > 0;
    return new Promise<boolean>((resolve) => {
      img.addEventListener(
        "load",
        () => {
          resolve(img.naturalWidth > 0);
        },
        { once: true },
      );
      img.addEventListener(
        "error",
        () => {
          resolve(false);
        },
        { once: true },
      );
    });
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
  let running: Animation | null = null;
  let queued = false;

  /** End any running fade at once: only the shown still stays visible. */
  const settle = (): void => {
    const animation = running;
    running = null;
    animation?.cancel();
    for (const still of stills) {
      still.classList.remove(FADING);
      still.classList.toggle(SHOWN, still === shown);
    }
  };

  const fade = (previous: HTMLElement, next: HTMLElement): void => {
    const nextIsLater =
      (previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    // Scrolling down the next still fades in over the previous one; scrolling back the previous
    // (on top) fades out over the next one. Both stay shown (opacity 1) underneath the animation.
    const fader = nextIsLater ? next : previous;
    const picture = fader.querySelector("picture");
    previous.classList.add(SHOWN);
    next.classList.add(SHOWN);
    if (!picture) {
      settle();
      return;
    }
    fader.classList.add(FADING);
    const animation = picture.animate(
      nextIsLater ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }],
      { duration: CROSSFADE_MS, easing: "linear" },
    );
    running = animation;
    animation.finished.then(
      () => {
        if (running === animation) settle();
        return animation;
      },
      // Cancelled by settle() (a newer section won): it has already cleaned up.
      () => animation,
    );
  };

  const go = async (next: HTMLElement): Promise<void> => {
    if (next === target) return;
    target = next;
    const index = stills.indexOf(next);
    for (const [i, still] of stills.entries())
      still.classList.toggle(NEAR, Math.abs(i - index) <= 1);
    const ok = await ready(next);
    // Scrolled on meanwhile: a newer go() owns the target.
    if (target !== next) return;
    // The image failed (or could not decode yet): keep what is on screen, retry on the next update.
    if (!ok) {
      target = shown;
      return;
    }
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
    // The live scene covers the page and the stills are not displayed: nothing to pick or decode.
    if (root.dataset.tier === "full") return;
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
  // Full → static mid-visit (reduced motion, the Motion toggle, a lost context): show the current
  // section's still now, not on the next scroll.
  new MutationObserver(queue).observe(root, { attributes: true, attributeFilter: ["data-tier"] });
  update();
}
