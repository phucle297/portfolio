/**
 * Runtime for the page-wide canvas: one renderer, one scene, one canvas. Scroll progress drives
 * `set(p)`; rendering is on demand only (scroll, resize, catch-up easing), never while the tab is
 * hidden, and it stops as soon as the scene has caught up with the scroll position.
 */
import { onSafelightChange, safelightOn } from "@shared/lib/motion";
import { clamp } from "@shared/lib/timeline";
import { catchUpStep } from "./catch-up";
import { createCopyLayer } from "./copy-layer";
import { createDarkroom, type Darkroom, type RenderInfo } from "./darkroom";
import type { Tier } from "./tiers";

const SETTLE_EPSILON = 1e-4;
/**
 * Idle budget after the last scroll (or resize): rendering must have stopped this long after
 * scrolling stops, even when frames are slow (M2-AC10, QA B-4). Each frame looks three of the
 * slowest frame times seen since the input ahead and, if that would overrun the budget, snaps
 * the scene to the scroll position and stops. On a 60 fps GPU that happens at ~1.45 s, when
 * < 0.01 % of the jump is left, so the snap is invisible.
 */
const IDLE_BUDGET_MS = 1500;
const FADE_IN_MS = 560;

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
  /** Whether the safelight is on. */
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

  const [w, h] = size();
  let darkroom: Darkroom;
  try {
    darkroom = await createDarkroom(canvas, { tier, width: w, height: h });
  } catch (error) {
    canvas.remove();
    throw error;
  }

  const copy = createCopyLayer();
  let safelight = safelightOn();
  darkroom.setSafelight(safelight);
  let shown = scrollProgress();
  let raf = 0;
  let last = 0;
  let inputAt = 0;
  let slowestFrameMs = 0;
  /** When the scene last cut straight to the scroll position (catch-up.ts), ms. */
  let lastCutAt = Number.NEGATIVE_INFINITY;
  let frames = 0;
  let rafs = 0;
  let disposed = false;

  const draw = (): RenderInfo => {
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
    // Eased, speed-capped, and cut on big jumps: never a strobe (M3-AC10, catch-up.ts).
    const next = catchUpStep(shown, target, dt, (now - lastCutAt) / 1000);
    shown = next.shown;
    if (next.cut) lastCutAt = now;
    const settled =
      Math.abs(target - shown) < SETTLE_EPSILON ||
      performance.now() - inputAt + 3 * slowestFrameMs >= IDLE_BUDGET_MS;
    if (settled) {
      if (Math.abs(target - shown) >= SETTLE_EPSILON) lastCutAt = now;
      shown = target;
    }
    draw();
    if (!settled) raf = requestAnimationFrame(tick);
    else last = 0;
  };

  const request = (): void => {
    inputAt = performance.now();
    slowestFrameMs = 0;
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
  const offSafelight = onSafelightChange(() => {
    safelight = safelightOn();
    darkroom.setSafelight(safelight);
    if (!document.hidden) draw();
  });

  draw();
  // Fade in over the poster after the first frame.
  requestAnimationFrame(() => {
    host.classList.add("is-ready");
  });

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
      safelight: () => safelight,
      tier,
    };
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      offSafelight();
      copy.dispose();
      host.classList.remove("is-ready");
      darkroom.dispose();
      window.setTimeout(() => {
        canvas.remove();
      }, FADE_IN_MS);
      if (exposeTestHook) delete window.darkroomTest;
    },
  };
}
