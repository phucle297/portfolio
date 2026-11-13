/**
 * Runtime for the page-wide canvas: one renderer, one scene, one canvas. Scroll progress drives
 * `set(p)`; rendering is on demand only (scroll, resize, catch-up easing), never while the tab is
 * hidden, and it stops as soon as the scene has caught up with the scroll position.
 */
import { onSafelightChange, safelightOn } from "@shared/lib/motion";
import { clamp } from "@shared/lib/timeline";
import { SETTLE_EPSILON, stageAt, stageStep, type StageFrame, type StageState } from "./catch-up";
import { createCopyLayer } from "./copy-layer";
import { createDarkroom, type Darkroom, type RenderInfo } from "./darkroom";
import type { Tier } from "./tiers";

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
  /** Whether no frame is scheduled (the render loop has stopped). */
  idle: () => boolean;
  /** Number of requestAnimationFrame callbacks run since mount (M2-AC10). */
  rafs: () => number;
  /** The progress the scene and the copy layer currently show (smoothed scroll progress). */
  shown: () => number;
  /** Whether the pinned copy layout is on. */
  pinned: () => boolean;
  /** Whether the safelight is on. */
  safelight: () => boolean;
  /**
   * Starts recording every catch-up frame (its input and the state after it) from the current
   * state; `trace()` returns what was recorded. The e2e replays it through stageStep (PF-14).
   */
  startTrace: () => void;
  trace: () => StageTrace;
  tier: Tier;
}

export interface StageTrace {
  start: StageState;
  frames: { frame: StageFrame; state: StageState; shown: number }[];
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
  /** Catch-up state (catch-up.ts): the shown progress and its clocks. Only stageStep moves it. */
  let scene = stageAt(scrollProgress());
  let raf = 0;
  let last = 0;
  /** Previous tick's timestamp, kept across idle (the catch-up clocks run in real time). */
  let prevTick = 0;
  let inputAt = 0;
  let slowestFrameMs = 0;
  let frames = 0;
  let rafs = 0;
  let trace: StageTrace | null = null;
  let disposed = false;
  /** Watchdog: restarts the loop if rAF stalls mid-catch-up (see armPump). */
  let pumpTimer = 0;

  /** The progress last drawn (scene and copy layer). */
  let drawn = scene.shown;
  const draw = (): RenderInfo => {
    drawn = scene.shown;
    darkroom.set(drawn);
    copy.update(drawn);
    frames += 1;
    return darkroom.render();
  };

  const caughtUp = (): boolean => Math.abs(scrollProgress() - scene.shown) < SETTLE_EPSILON;

  const stopPump = (): void => {
    window.clearTimeout(pumpTimer);
    pumpTimer = 0;
  };

  /**
   * A big jump (End/Home) holds `shown` still until the lead arrives, then cuts. Only this loop
   * can finish that hold. If rAF stops after a couple of frames (a hidden flicker, a dropped
   * frame, or a tick that returns without rescheduling), the scene would stay at the pre-jump
   * progress forever — nothing else calls request() until the next scroll. Keep pumping until
   * shown actually reaches the scroll position (or the idle-budget snap does).
   */
  const armPump = (): void => {
    stopPump();
    if (disposed || document.hidden || caughtUp()) return;
    pumpTimer = window.setTimeout(() => {
      pumpTimer = 0;
      if (disposed || document.hidden || caughtUp()) return;
      if (!raf) raf = requestAnimationFrame(tick);
      armPump();
    }, 50);
  };

  const tick = (now: number): void => {
    raf = 0;
    rafs += 1;
    if (disposed || document.hidden) return;
    try {
      const frameMs = last ? now - last : 1000 / 60;
      slowestFrameMs = Math.max(slowestFrameMs, frameMs);
      last = now;
      // The whole per-frame transition is stageStep's (eased, speed-capped, held and cut on big
      // jumps: never a strobe, M3-AC10); its result is applied as is (PF-14, QA M1).
      const frame: StageFrame = {
        target: scrollProgress(),
        dt: Math.min(0.1, frameMs / 1000),
        elapsed: prevTick ? (now - prevTick) / 1000 : frameMs / 1000,
        overBudget: performance.now() - inputAt + 3 * slowestFrameMs >= IDLE_BUDGET_MS,
      };
      const next = stageStep(scene, frame);
      prevTick = now;
      scene = next.state;
      draw();
      trace?.frames.push({ frame, state: scene, shown: drawn });
    } finally {
      if (!disposed && !document.hidden) {
        // Do not trust settled alone: the loop must keep going until shown is actually there.
        if (!caughtUp()) {
          if (!raf) raf = requestAnimationFrame(tick);
          armPump();
        } else {
          last = 0;
          stopPump();
        }
      }
    }
  };

  const request = (): void => {
    inputAt = performance.now();
    slowestFrameMs = 0;
    if (!raf && !disposed && !document.hidden) raf = requestAnimationFrame(tick);
    armPump();
  };

  const onResize = (): void => {
    const [rw, rh] = size();
    darkroom.resize(rw, rh);
    request();
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      stopPump();
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
    // Disposed in the same frame it mounted (reduced motion switched on mid-start): no fade-in.
    if (!disposed) host.classList.add("is-ready");
  });

  if (exposeTestHook) {
    window.darkroomTest = {
      set: (p) => {
        scene = { ...stageAt(clamp(p)), sinceCut: scene.sinceCut, sinceSweep: scene.sinceSweep };
        return draw();
      },
      state: () => darkroom.state(),
      info: () => darkroom.info(),
      frames: () => frames,
      rafs: () => rafs,
      idle: () => raf === 0,
      shown: () => drawn,
      pinned: () => copy.pinned(),
      safelight: () => safelight,
      startTrace: () => {
        trace = { start: scene, frames: [] };
      },
      trace: () => trace ?? { start: scene, frames: [] },
      tier,
    };
  }

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopPump();
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
