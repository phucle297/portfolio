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
import { openScene, settle } from "./helpers";

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

const toTop = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await settle(page);
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
    await page.locator("body").click({ position: { x: 5, y: 500 } });
    await page.evaluate(() => window.darkroomTest?.startTrace());
    await page.keyboard.press("End");
    await settle(page);
    const rec = await trace(page);
    const moving = rec.frames.filter((f) => f.frame.target > 0);
    expect(moving.length, "frames after End").toBeGreaterThan(2);
    // Big moves of the drawn progress between frames: exactly one (the cut), straight to ~1.
    const shown = [rec.start.shown, ...rec.frames.map((f) => f.shown)];
    const jumps = shown.flatMap((p, i) =>
      i > 0 && Math.abs(p - (shown[i - 1] ?? p)) > 0.05 ? [i] : [],
    );
    expect(
      jumps,
      `drawn progress per frame: ${shown.map((p) => p.toFixed(3)).join(" ")}`,
    ).toHaveLength(1);
    const cut = jumps[0] ?? 0;
    expect(shown[cut] ?? 0).toBeGreaterThan(1 - CUT_LEAD_GAP);
    // Before the cut, the scene held exactly where it was (no sweep at all).
    expect(shown.slice(0, cut).every((p) => p === rec.start.shown)).toBe(true);
    // At least one frame held, and the hold lasted until the lead was within CUT_LEAD_GAP of the
    // end (τ ln(1/0.01) ≈ 0.69 s of frame time), or until the idle budget forced the snap (slow
    // SwiftShader frames: three of the slowest frames would overrun 1.5 s).
    expect(cut).toBeGreaterThan(1);
    const cutFrame = rec.frames[cut - 1];
    const held = rec.frames.slice(0, cut).reduce((sum, f) => sum + f.frame.dt, 0);
    if (!cutFrame?.frame.overBudget) expect(held).toBeGreaterThan(0.6);
    expect(shown.at(-1)).toBeCloseTo(1, 4);
    expect(replayDivergence(rec)).toBe(0);
  });

  test("every stage frame replays through stageStep: End, Home, wheel, drag, back-and-forth", async ({
    page,
  }) => {
    await openScene(page);
    await toTop(page);
    await page.locator("body").click({ position: { x: 5, y: 500 } });
    await page.evaluate(() => window.darkroomTest?.startTrace());
    await page.keyboard.press("End");
    await settle(page);
    await page.keyboard.press("Home");
    await settle(page);
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 2400);
    await settle(page);
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
    await settle(page);
    const rec = await trace(page);
    expect(rec.frames.length).toBeGreaterThan(20);
    expect(replayDivergence(rec)).toBe(0);
  });
});
