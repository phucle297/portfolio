/**
 * Runtime for the page-wide canvas: one renderer, one scene, one canvas. Scroll progress drives
 * `set(p)`; rendering is on demand only (scroll, resize, catch-up easing), never while the tab is
 * hidden, and it stops as soon as the scene has caught up with the scroll position.
 */
import { clamp, HOLDS } from "@shared/lib/timeline";
import { createCopyLayer } from "./copy-layer";
import { createDarkroom, type Darkroom, type RenderInfo } from "./darkroom";
import type { Tier } from "./tiers";

/** Time constant of the scroll catch-up (≈ GSAP `scrub: .6`): ~98 % caught up after 0.6 s. */
const CATCH_UP_SECONDS = 0.15;
const SETTLE_EPSILON = 1e-4;
/**
 * Idle budget after the last scroll (or resize): rendering must have stopped this long after
 * scrolling stops, even when frames are slow (M2-AC10, QA B-4). Each frame looks three of the
 * slowest frame times seen since the input ahead and, if that would overrun the budget, snaps
 * the scene to the scroll position and stops. On a 60 fps GPU that happens at ~1.45 s, when
 * < 0.01 % of the jump is left, so the snap is invisible.
 */
const IDLE_BUDGET_MS = 1500;
/**
 * PF-61: the predictor above cannot see a single stalled frame coming (SwiftShader on a loaded CI
 * host: one rAF delivered 0.5-0.7 s late). So the budget is also a hard deadline, this long before
 * IDLE_BUDGET_MS: a timer cancels any rAF still pending and draws the final, snapped frame itself,
 * and a tick whose draw ran past it snaps and stops in the same callback. No rAF callback starts
 * after the deadline unless the main thread itself is blocked past it.
 */
const IDLE_GUARD_MS = 150;
const FADE_IN_MS = 560;
/** PF-84: the still → live crossfade once the scene is ready (design/hero-handover). */
export const HANDOVER_MS = 240;

/**
 * Where the first-open loader cover is (read only, never animated): "opaque" while it still hides
 * the whole page (PF-75 states 0-1, the iris hole included), "opening" while its iris opens
 * (html.is-open, the cover still shown: no swap then), else "gone" (also its early fade).
 */
function coverState(): "opaque" | "opening" | "gone" {
  const cover = document.querySelector<HTMLElement>(".loader");
  if (!cover) return "gone";
  const style = getComputedStyle(cover);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.999)
    return "gone";
  return document.documentElement.classList.contains("is-open") ? "opening" : "opaque";
}

/** The poster stills on screen now (desktop: viewport-fixed pictures). */
function visibleStills(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-still] picture")).filter(
    (picture) => {
      const style = getComputedStyle(picture);
      const still = picture.parentElement;
      return (
        style.display !== "none" &&
        Number(style.opacity) > 0 &&
        still !== null &&
        getComputedStyle(still).display !== "none"
      );
    },
  );
}

export interface StageHandle {
  dispose: () => void;
}

export interface StageTestHook {
  set: (p: number) => RenderInfo;
  state: () => ReturnType<Darkroom["state"]>;
  info: () => RenderInfo;
  /** Number of frames rendered since mount. */
  frames: () => number;
  /** Number of requestAnimationFrame callbacks run since mount (M2-AC10). */
  rafs: () => number;
  /** The progress the scene and the copy layer currently show (smoothed scroll progress). */
  shown: () => number;
  /** Whether the pinned copy layout is on. */
  pinned: () => boolean;
  /** Always true: the header Safelight toggle was removed (PF-49). */
  safelight: () => boolean;
  tier: Tier;
}

declare global {
  interface Window {
    darkroomTest?: StageTestHook;
  }
}

const size = (): [number, number] => [window.innerWidth, window.innerHeight];

/** Page scroll progress 0 → 1. Section heights put the DOM boundaries at the timeline's points. */
export function scrollProgress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? clamp(window.scrollY / max) : 0;
}

export async function mountStage(
  host: HTMLElement,
  { tier, exposeTestHook }: { tier: Tier; exposeTestHook: boolean },
): Promise<StageHandle> {
  const canvas = document.createElement("canvas");
  canvas.className = "darkroom-scene__canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const veilLayer = document.createElement("div");
  veilLayer.className = "darkroom-scene__veil";
  host.append(veilLayer);

  const [w, h] = size();
  let darkroom: Darkroom;
  try {
    darkroom = await createDarkroom(canvas, { tier, width: w, height: h });
  } catch (error) {
    canvas.remove();
    veilLayer.remove();
    throw error;
  }

  const copy = createCopyLayer();
  // Lights stay on the default (on). A leftover localStorage "safelight" = "off" is ignored
  // and cleared in startClient (PF-49).
  darkroom.setSafelight(true);
  let shown = scrollProgress();
  let raf = 0;
  let last = 0;
  let inputAt = 0;
  let slowestFrameMs = 0;
  let frames = 0;
  let rafs = 0;
  let disposed = false;
  let deadlineTimer = 0;

  // PF-84: the intro still carries an edge veil (SectionStill.astro); the live scene wears the same
  // veil over the Hello hold so the handover matches, and drops it on the way to Journey.
  const [, helloEnd] = HOLDS[0] ?? [0, 0.06];
  const [journeyStart] = HOLDS[1] ?? [0.17, 0.25];
  let veil = -1;
  const draw = (): RenderInfo => {
    const v = 1 - clamp((shown - helloEnd) / (journeyStart - helloEnd));
    if (v !== veil) {
      veil = v;
      host.style.setProperty("--hello-veil", String(v));
    }
    darkroom.set(shown);
    copy.update(shown);
    frames += 1;
    return darkroom.render();
  };

  const tick = (now: number): void => {
    raf = 0;
    rafs += 1;
    if (disposed || document.hidden) return;
    const target = scrollProgress();
    const frameMs = last ? now - last : 1000 / 60;
    const dt = Math.min(0.1, frameMs / 1000);
    slowestFrameMs = Math.max(slowestFrameMs, frameMs);
    last = now;
    const step = 1 - Math.exp(-dt / CATCH_UP_SECONDS);
    shown += (target - shown) * step;
    const settled =
      Math.abs(target - shown) < SETTLE_EPSILON ||
      performance.now() - inputAt + 3 * slowestFrameMs >= IDLE_BUDGET_MS;
    if (settled) shown = target;
    draw();
    if (!settled && performance.now() - inputAt >= IDLE_BUDGET_MS - IDLE_GUARD_MS) {
      // This frame's draw ran past the deadline (a stall): snap now, ask for no further frame.
      shown = target;
      draw();
      last = 0;
      return;
    }
    if (!settled) raf = requestAnimationFrame(tick);
    else last = 0;
  };

  /** The idle deadline (PF-61): stop a loop that is still waiting for a late frame. */
  const deadline = (): void => {
    deadlineTimer = 0;
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
    if (disposed || document.hidden) return;
    shown = scrollProgress();
    draw();
  };

  const request = (): void => {
    inputAt = performance.now();
    slowestFrameMs = 0;
    window.clearTimeout(deadlineTimer);
    deadlineTimer = window.setTimeout(deadline, IDLE_BUDGET_MS - IDLE_GUARD_MS);
    if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(tick);
  };

  const onResize = (): void => {
    const [rw, rh] = size();
    darkroom.resize(rw, rh);
    request();
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    } else {
      request();
    }
  };

  window.addEventListener("scroll", request, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
  document.addEventListener("visibilitychange", onVisibility);

  draw();
  // PF-84: hand over from the still on screen without a jump (design/hero-handover). The canvas
  // stays transparent behind the still until two frames have been drawn at the rest state (the
  // textures were uploaded in createDarkroom). Then exactly one swap: instant while the loader
  // cover is still opaque, never during the loader's iris open (PF-75), else a HANDOVER_MS crossfade with the canvas fully shown underneath and
  // the still fading out on top (the same pixels as the canvas fading in over an opaque still:
  // never darker than the darker of the two). The still is hidden only once the fade's `finished`
  // resolves, never on a wall-clock timer, so a slow frame cannot uncover a half-shown canvas.
  let warmFrames = 0;
  let handover: Animation[] = [];
  const reveal = (): void => {
    handover = [];
    if (!disposed) document.documentElement.toggleAttribute("data-scene-shown", true);
  };
  const swap = (): void => {
    if (disposed) return;
    const cover = coverState();
    // PF-75: never during the iris open; wait for it to end, then crossfade.
    if (cover === "opening") {
      requestAnimationFrame(swap);
      return;
    }
    const stills = visibleStills();
    if (cover === "opaque" || stills.length === 0) {
      reveal();
      return;
    }
    handover = stills.map((picture) =>
      picture.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: HANDOVER_MS,
        easing: "linear",
        fill: "forwards",
      }),
    );
    const animations = handover;
    void Promise.all(animations.map((a) => a.finished)).then(
      () => {
        if (handover === animations) {
          reveal();
          // The still is display: none now; drop the fill so a later static fallback shows it.
          for (const a of animations) a.cancel();
        }
        return null;
      },
      // Cancelled by dispose(): it restores the still itself.
      () => null,
    );
  };
  const warm = (): void => {
    // Disposed in the same frame it mounted (reduced motion switched on mid-start): no swap.
    if (disposed) return;
    if (warmFrames < 2) {
      if (!raf) draw();
      warmFrames += 1;
      requestAnimationFrame(warm);
      return;
    }
    // Shown underneath the still (which paints above the scene): nothing changes on screen yet.
    host.classList.add("is-ready");
    requestAnimationFrame(swap);
  };
  requestAnimationFrame(warm);

  if (exposeTestHook) {
    window.darkroomTest = {
      set: (p) => {
        shown = clamp(p);
        return draw();
      },
      state: () => darkroom.state(),
      info: () => darkroom.info(),
      frames: () => frames,
      rafs: () => rafs,
      shown: () => shown,
      pinned: () => copy.pinned(),
      safelight: () => true,
      tier,
    };
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(deadlineTimer);
      for (const a of handover) a.cancel();
      handover = [];
      document.documentElement.removeAttribute("data-scene-shown");
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      copy.dispose();
      host.classList.remove("is-ready");
      darkroom.dispose();
      window.setTimeout(() => {
        canvas.remove();
        veilLayer.remove();
        host.style.removeProperty("--hello-veil");
      }, FADE_IN_MS);
      if (exposeTestHook) delete window.darkroomTest;
    },
  };
}
