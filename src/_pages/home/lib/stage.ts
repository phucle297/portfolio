/**
 * Runtime for the page-wide canvas: one renderer, one scene, one canvas. Scroll progress drives
 * `set(p)`; rendering is on demand only (scroll, resize, catch-up easing), never while the tab is
 * hidden, and it stops as soon as the scene has caught up with the scroll position.
 */
import { onSafelightChange, safelightOn } from "@shared/lib/motion";
import { clamp } from "@shared/lib/timeline";
import { createCopyLayer } from "./copy-layer";
import { createDarkroom, type Darkroom, type RenderInfo } from "./darkroom";
import type { Tier } from "./tiers";

/** Time constant of the scroll catch-up (≈ GSAP `scrub: .6`): ~98 % caught up after 0.6 s. */
const CATCH_UP_SECONDS = 0.15;
const SETTLE_EPSILON = 1e-4;
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
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
    last = now;
    const step = 1 - Math.exp(-dt / CATCH_UP_SECONDS);
    shown += (target - shown) * step;
    const settled = Math.abs(target - shown) < SETTLE_EPSILON;
    if (settled) shown = target;
    draw();
    if (!settled) raf = requestAnimationFrame(tick);
    else last = 0;
  };

  const request = (): void => {
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
