/**
 * PF-14 (QA M1): the stage's real per-frame behaviour is the catch-up the flash check tests.
 * tools/flash/check.ts and the unit tests replay `stageStep` (src/_pages/home/lib/catch-up.ts);
 * these tests guard that the stage on the built page applies exactly that and nothing else:
 * 1. End on the real page: the scene holds, then crosses with a single cut (no sweep);
 * 2. every recorded stage frame (End, Home, a wheel scroll, a scrollbar-style drag, a quick
 *    back-and-forth) replays through stageStep to the same shown progress, bit for bit.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  CUT_LEAD_GAP,
  stageStep,
  type StageFrame,
  type StageState,
} from "../../src/_pages/home/lib/catch-up";
import { openScene } from "./helpers";

// Instant End / Home / wheel scrolling: the input is a jump, so the stage alone decides how the
// scene gets there (see m2-keys.spec.ts for why the box needs this flag).
test.use({
  launchOptions: {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      "--disable-smooth-scrolling",
    ],
  },
});

interface Recorded {
  start: StageState;
  frames: { frame: StageFrame; state: StageState; shown: number }[];
}

/**
 * Waits until the page has stopped scrolling and the stage's render loop has stopped (no frame
 * scheduled). Unlike helpers.ts `settle`, it does not require the scene to match the scroll
 * position, so a broken stage fails the assertions below rather than a timeout; and it does not
 * depend on the frame rate (CI SwiftShader frames can take longer than any fixed quiet window).
 */
const quiet = async (page: Page): Promise<void> => {
  await page.waitForFunction(
    async () =>
      new Promise<boolean>((resolve) => {
        const y = scrollY;
        setTimeout(() => {
          // idle() is raf===0, which is also briefly true in the middle of a tick. A 300 ms
          // sample can land there during the End hold and return before the cut. Confirm on
          // the next animation frame that the loop has really stopped.
          if (scrollY !== y || window.darkroomTest?.idle() !== true) {
            resolve(false);
            return;
          }
          requestAnimationFrame(() => {
            resolve(scrollY === y && window.darkroomTest?.idle() === true);
          });
        }, 300);
      }),
    null,
    { timeout: 30_000 },
  );
};

const toTop = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await quiet(page);
};

/** Give the document the keyboard so End/Home scroll the page, not <main tabindex=-1>. */
const armKeyboard = async (page: Page): Promise<void> => {
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  });
};

/** Press End and wait until the page itself has jumped (before the scene catch-up). */
const pressEnd = async (page: Page): Promise<void> => {
  await page.keyboard.press("End");
  await page.waitForFunction(
    () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      return max > 0 && scrollY / max > 0.99;
    },
    null,
    { timeout: 10_000 },
  );
};

const trace = async (page: Page): Promise<Recorded> =>
  page.evaluate(() => {
    const hook = window.darkroomTest;
    if (!hook) throw new Error("no scene test hook");
    return hook.trace();
  });

/** Replays recorded frames through stageStep; returns the largest |replayed − drawn| shown. */
const replayDivergence = (rec: Recorded): number => {
  let state = rec.start;
  let worst = 0;
  for (const f of rec.frames) {
    state = stageStep(state, f.frame).state;
    worst = Math.max(worst, Math.abs(state.shown - f.shown));
  }
  return worst;
};

test.describe("PF-14 stage applies stageStep exactly", () => {
  test("End holds the scene, then crosses with a single cut", async ({ page }) => {
    await openScene(page);
    await toTop(page);
    await armKeyboard(page);
    await page.evaluate(() => window.darkroomTest?.startTrace());
    await pressEnd(page);
    await quiet(page);
    const rec = await trace(page);
    const moving = rec.frames.filter((f) => f.frame.target > 0);
    expect(moving.length, "frames after End").toBeGreaterThan(0);
    // Big moves of the drawn progress between frames: exactly one (the cut), straight to ≥ 0.99.
    const shown = [rec.start.shown, ...rec.frames.map((f) => f.shown)];
    const jumps = shown.flatMap((p, i) =>
      i > 0 && Math.abs(p - (shown[i - 1] ?? p)) > 0.05 ? [i] : [],
    );
    expect(
      jumps,
      `drawn ${shown.map((p) => p.toFixed(3)).join(" ")} targets ${rec.frames.map((f) => f.frame.target.toFixed(3)).join(" ")}`,
    ).toHaveLength(1);
    const cut = jumps[0] ?? 0;
    expect(shown[cut] ?? 0).toBeGreaterThanOrEqual(1 - CUT_LEAD_GAP);
    // Before the cut, the scene held exactly where it was (no intermediate sweep).
    expect(shown.slice(0, cut).every((p) => p === rec.start.shown)).toBe(true);
    // Normal path: at least one frame held, and the hold lasted until the lead was within
    // CUT_LEAD_GAP (τ ln(1/0.01) ≈ 0.69 s of frame time). Idle-budget snap path (slow CI
    // SwiftShader): 2 or fewer frames after End still hold, then a single jump to ≥ 0.99.
    if (moving.length > 2) {
      expect(cut).toBeGreaterThan(1);
      const cutFrame = rec.frames[cut - 1];
      const held = rec.frames.slice(0, cut).reduce((sum, f) => sum + f.frame.dt, 0);
      if (!cutFrame?.frame.overBudget) expect(held).toBeGreaterThan(0.6);
    }
    expect(shown.at(-1)).toBeCloseTo(1, 4);
    expect(replayDivergence(rec)).toBe(0);
  });

  test("every stage frame replays through stageStep: End, Home, wheel, drag, back-and-forth", async ({
    page,
  }) => {
    await openScene(page);
    await toTop(page);
    await armKeyboard(page);
    await page.evaluate(() => window.darkroomTest?.startTrace());
    await pressEnd(page);
    await quiet(page);
    await page.keyboard.press("Home");
    await quiet(page);
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 2400);
    await quiet(page);
    // Scrollbar-style drag 0.2 → 0.6 over ~1.5 s, then a quick back-and-forth around 0.5.
    await page.evaluate(
      async () =>
        new Promise<void>((resolve) => {
          const max = document.documentElement.scrollHeight - innerHeight;
          const t0 = performance.now();
          const step = (now: number): void => {
            const t = (now - t0) / 1000;
            const p =
              t < 1.5
                ? 0.2 + 0.4 * (t / 1.5)
                : 0.5 + 0.05 * Math.sign(Math.sin((2 * Math.PI * (t - 1.5)) / 0.3));
            window.scrollTo({ top: p * max, behavior: "instant" });
            if (t < 3.5) requestAnimationFrame(step);
            else resolve();
          };
          requestAnimationFrame(step);
        }),
    );
    await quiet(page);
    const rec = await trace(page);
    // Frame counts depend on the renderer's speed (SwiftShader on CI runs far below 60 fps), so
    // only require that each kind of input reached the stage: a cut, sweeps, and the drag range.
    test.info().annotations.push({ type: "stage frames", description: String(rec.frames.length) });
    expect(rec.frames.length).toBeGreaterThan(8);
    expect(rec.frames.some((f) => f.frame.target > 0.25 && f.frame.target < 0.55)).toBe(true);
    expect(replayDivergence(rec)).toBe(0);
  });
});
