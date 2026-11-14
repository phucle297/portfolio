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
  copy: "#hello [data-copy-body]",
} as const;

export type WatchedName = keyof typeof WATCHED;

/** Watched element names, in report order. */
export const WATCHED_NAMES: readonly WatchedName[] = ["header", "h1", "copy"];

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
