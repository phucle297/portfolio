import type { Page } from "@playwright/test";

/**
 * PF-50: watch where the first-screen elements actually are on screen, frame by frame.
 *
 * Chrome's `layout-shift` entries (and so CLS and Lighthouse) miss some jumps a visitor sees: in
 * PR #33 the Hello H1 moved 98 px and the copy 178 px when `data-pin="on"` turned the body into
 * `position: fixed` under opacity/translate3d, and CLS read 0. This samples
 * `getBoundingClientRect()` every animation frame instead, which is what the visitor sees.
 */

/** The first-screen elements to watch, by name. */
export const WATCHED = {
  header: ".site-header",
  h1: "#hello-title",
  /** The Hello section body (at 1440 it is the viewport-sized wrapper the pin makes fixed). */
  copy: "#hello [data-copy-body]",
  /** The visible Hello copy itself: catches a move of the text that leaves the wrapper in place. */
  lede: "#hello .hello__lede",
} as const;

export type WatchedName = keyof typeof WATCHED;

/** Watched element names, in report order. */
export const WATCHED_NAMES: readonly WatchedName[] = ["header", "h1", "copy", "lede"];

/** One element's on-screen box in one frame, in CSS px (0.1 px precision). */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** One animation frame. A watched element is null until it is in the DOM with a non-empty box. */
export interface Sample {
  t: number;
  tier: string | null;
  pin: string | null;
  scrollY: number;
  boxes: Record<WatchedName, Box | null>;
}

declare global {
  interface Window {
    visibleJump?: { samples: Sample[]; firstPaint: number | null; done: boolean };
  }
}

/**
 * Samples the watched boxes on every animation frame from the start of each navigation until
 * `untilMs` after it (`performance.now()`). Call before `page.goto` / `page.reload`.
 */
export async function recordVisibleBoxes(page: Page, untilMs: number): Promise<void> {
  await page.addInitScript(
    ({ watched, until }: { watched: Record<WatchedName, string>; until: number }) => {
      const state: NonNullable<Window["visibleJump"]> = {
        samples: [],
        firstPaint: null,
        done: false,
      };
      window.visibleJump = state;
      // 0.1 px precision.
      const scale = 10;
      const round = (n: number): number => Math.round(n * scale) / scale;
      const boxOf = (selector: string): Box | null => {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        return r && r.width > 0 && r.height > 0
          ? {
              top: round(r.top),
              left: round(r.left),
              width: round(r.width),
              height: round(r.height),
            }
          : null;
      };
      const tick = (): void => {
        if (state.firstPaint === null) {
          const paint = performance
            .getEntriesByType("paint")
            .find((entry) => entry.name === "first-paint");
          if (paint) state.firstPaint = Math.round(paint.startTime);
        }
        const boxes: Record<WatchedName, Box | null> = {
          header: boxOf(watched.header),
          h1: boxOf(watched.h1),
          copy: boxOf(watched.copy),
          lede: boxOf(watched.lede),
        };
        const root = document.documentElement;
        state.samples.push({
          t: Math.round(performance.now()),
          tier: root.dataset.tier ?? null,
          pin: root.dataset.pin ?? null,
          scrollY: Math.round(window.scrollY),
          boxes,
        });
        if (performance.now() < until) requestAnimationFrame(tick);
        else state.done = true;
      };
      requestAnimationFrame(tick);
    },
    { watched: { ...WATCHED }, until: untilMs },
  );
}

/** How far one element moved from its first painted position. */
export interface Movement {
  name: WatchedName;
  /** Time of the baseline sample (first frame at or after first paint with a box). */
  baselineT: number | null;
  baseline: Box | null;
  /** Largest |Δtop| / |Δleft| from the baseline, with the frame it happened in. */
  maxDTop: number;
  maxDLeft: number;
  worstT: number | null;
  worst: Box | null;
  frames: number;
}

/** Per-element movement after first paint; the baseline is the first sample with a box. */
export function movements(samples: Sample[], firstPaint: number | null): Movement[] {
  const painted = samples.filter((s) => firstPaint === null || s.t >= firstPaint);
  return WATCHED_NAMES.map((name) => {
    const seen = painted.filter((s) => s.boxes[name] !== null);
    const first = seen[0];
    const result: Movement = {
      name,
      baselineT: first?.t ?? null,
      baseline: first?.boxes[name] ?? null,
      maxDTop: 0,
      maxDLeft: 0,
      worstT: null,
      worst: null,
      frames: seen.length,
    };
    if (!result.baseline) return result;
    let worstD = 0;
    for (const s of seen) {
      const box = s.boxes[name];
      if (!box) continue;
      const dTop = Math.abs(box.top - result.baseline.top);
      const dLeft = Math.abs(box.left - result.baseline.left);
      result.maxDTop = Math.max(result.maxDTop, round1(dTop));
      result.maxDLeft = Math.max(result.maxDLeft, round1(dLeft));
      if (Math.max(dTop, dLeft) > worstD) {
        worstD = Math.max(dTop, dLeft);
        result.worstT = s.t;
        result.worst = box;
      }
    }
    return result;
  });
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Visible-jump window after first paint (PF-50 / PF-53 / PF-62). */
export const WINDOW_MS = 3000;
/**
 * Minimum sampled frames after first paint in the window (10 fps). A starved run cannot see a
 * jump that undoes itself between two frames, so it fails rather than passes.
 */
export const MIN_FRAMES = 30;
/**
 * PF-62: a single stall longer than this (1 s) in the 3 s window also fails as "not enough
 * frames". A jump can hide inside that stall even when the total frame count is still above
 * MIN_FRAMES. 1000 ms is about 2× the longest gap seen on SwiftShader in PF-53 (449–534 ms), so
 * the cap should not flake there, and a real GPU should be well under it.
 */
export const MAX_FRAME_GAP_MS = 1000;

/** Software WebGL renderers that do not count as a hardware-GPU run. */
export const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|software/i;

export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  return SOFTWARE_RENDERER_RE.test(renderer ?? "");
}

/** Longest gap between consecutive sample timestamps, in ms. */
export function maxFrameGapMs(times: readonly number[]): number {
  let max = 0;
  for (let i = 1; i < times.length; i++) {
    max = Math.max(max, (times[i] ?? 0) - (times[i - 1] ?? 0));
  }
  return max;
}

export function notEnoughFramesMessage(frames: number, gapMs: number): string {
  return `not enough frames: ${frames} sampled after first paint in ${WINDOW_MS} ms (need >= ${MIN_FRAMES}, longest gap ${gapMs} ms, cap ${MAX_FRAME_GAP_MS} ms)`;
}

/** Inputs for the visible-jump gates that run before the movement assertions. */
export interface VisibleJumpGuardInput {
  realGpu: boolean;
  renderer: string | null;
  expectedTier: string;
  actualTier: string | null;
  expectedPin: string | null;
  actualPin: string | null;
  firstPaint: number | null;
  framesAfterFirstPaint: number;
  maxFrameGapMs: number;
}

/**
 * First failing visible-jump gate, in assertion order, or null if those gates pass.
 * On a real-GPU run (`realGpu: true`) the software-renderer check comes first, so a machine
 * without a hardware GPU fails with "no hardware GPU" before the tier check (desktop widths
 * otherwise fail first on `data-tier=static` because the probe spoof is skipped).
 */
export function firstVisibleJumpFailure(input: VisibleJumpGuardInput): string | null {
  if (input.realGpu && isSoftwareRenderer(input.renderer)) {
    return `no hardware GPU: WebGL renderer is ${input.renderer ?? "(none)"}`;
  }
  if (input.actualTier !== input.expectedTier) {
    return "data-tier at the end of the window";
  }
  if (input.actualPin !== input.expectedPin) {
    return "data-pin at the end of the window";
  }
  if (input.firstPaint === null) {
    return "first-paint timing";
  }
  if (input.framesAfterFirstPaint < MIN_FRAMES || input.maxFrameGapMs > MAX_FRAME_GAP_MS) {
    return notEnoughFramesMessage(input.framesAfterFirstPaint, input.maxFrameGapMs);
  }
  return null;
}
