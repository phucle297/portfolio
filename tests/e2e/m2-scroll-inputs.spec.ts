/**
 * PF-15 (M2-AC9 / M2-AC10 leftovers): every way people scroll drives the scene, and nothing
 * renders when nobody is looking.
 *
 * - AC1: mouse wheel and scrollbar drag, each on its own, leave the page and the scene in the same
 *   state as keyboard scrolling to the same scroll position.
 * - AC2: 0 frames render later than 1.5 s after the last scroll input, measured from the scroll
 *   stop (the last `scroll` event), not from "caught up": at normal speed, with every frame slow
 *   (CPU throttled), and with one long frame in the middle of the catch-up. The rAF loop is also
 *   quiet for the 2 s after that (0 callbacks).
 * - AC3: while the tab is hidden, 0 frames render and 0 rAF callbacks run, even when it is hidden
 *   in the middle of a catch-up, then scrolled, resized and its Safelight toggled; once visible
 *   again it catches up and idles. Headless Chrome never hides a page (a minimized window or a
 *   tab in the background both stay "visible" with rAF at 60 Hz, checked on this box), so the
 *   hidden state is emulated with `document.hidden` / `visibilityState` plus `visibilitychange`,
 *   while rAF keeps running: the stage's own guards are what keep it at 0. The real-browser
 *   hidden-tab run is PF-08's hardware kit.
 *
 * Frames are timed exactly: an init script wraps requestAnimationFrame and stamps every callback
 * in which the scene's frame counter (`darkroomTest.frames()`) or rAF counter (`rafs()`) moved.
 * Its own file: it launches Chrome with visible scrollbars and instant (non-animated) scrolling.
 */
import { expect, test, type Page } from "@playwright/test";
import { openScene, settle } from "./helpers";

test.use({ viewport: { width: 1600, height: 1000 } });
test.use({
  launchOptions: {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--ignore-gpu-blocklist",
      // Same reason as m2-keys.spec.ts: SwiftShader frames are slow, and animated keyboard /
      // wheel scrolling then drops inputs; instant scrolling keeps positions exact.
      "--disable-smooth-scrolling",
    ],
    // Playwright hides scrollbars in headless Chrome by default; the drag test needs one.
    ignoreDefaultArgs: ["--hide-scrollbars"],
  },
});

interface FrameLog {
  lastScroll: number;
  frames: number[];
  ticks: number[];
}
declare global {
  interface Window {
    pf15?: FrameLog;
  }
}

/** Install the exact frame clock before any page script runs. */
async function withFrameClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: FrameLog = { lastScroll: 0, frames: [], ticks: [] };
    window.pf15 = log;
    window.addEventListener(
      "scroll",
      () => {
        log.lastScroll = performance.now();
      },
      { capture: true, passive: true },
    );
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        const frames = window.darkroomTest?.frames() ?? 0;
        const ticks = window.darkroomTest?.rafs() ?? 0;
        const at = performance.now();
        callback(time);
        if ((window.darkroomTest?.frames() ?? 0) > frames) log.frames.push(at);
        if ((window.darkroomTest?.rafs() ?? 0) > ticks) log.ticks.push(at);
      });
  });
}

/** Everything the page and the scene show at the current scroll position. */
async function snapshot(page: Page) {
  await settle(page);
  return page.evaluate(() => ({
    y: window.scrollY,
    shown: window.darkroomTest?.shown() ?? -1,
    state: JSON.stringify(window.darkroomTest?.state()),
    pinned: window.darkroomTest?.pinned() ?? false,
    // Page state: the current-section markers (header nav and rail) and the copy layer's scrub.
    current: [...document.querySelectorAll('[data-section-link][aria-current="true"]')]
      .map((a) => a.getAttribute("data-section-link"))
      .join(","),
    copy: [...document.querySelectorAll<HTMLElement>("[data-copy-body]")]
      .map((b) => `${b.style.getPropertyValue("--copy-o")}/${b.style.getPropertyValue("--copy-y")}`)
      .join(" "),
  }));
}

async function openFocused(page: Page): Promise<void> {
  await openScene(page);
  // Keyboard scrolling needs focus in the document; click an inert spot at the far left.
  await page.locator("body").click({ position: { x: 5, y: 500 } });
  await settle(page);
}

test.describe("PF-15 AC1 wheel and scrollbar match keyboard scrolling", () => {
  test("mouse wheel to the keyboard's position gives the same page and scene", async ({ page }) => {
    await openFocused(page);
    const top = await snapshot(page);
    await page.keyboard.press("PageDown");
    await page.keyboard.press("PageDown");
    await page.keyboard.press("ArrowDown");
    const keyboard = await snapshot(page);
    expect(keyboard.y).toBeGreaterThan(0);
    expect(keyboard.state).not.toBe(top.state);

    await page.keyboard.press("Home");
    expect((await snapshot(page)).y).toBe(0);
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, keyboard.y);
    // Under load the wheel scroll can land later than settle()'s 250 ms stability window.
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
      .toBe(keyboard.y);
    const wheel = await snapshot(page);
    expect(wheel).toEqual(keyboard);
  });

  test("dragging the scrollbar thumb gives the same page and scene as the keyboard", async ({
    page,
  }) => {
    await openFocused(page);
    const top = await snapshot(page);
    const bar = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        x: (window.innerWidth + doc.clientWidth) / 2,
        width: window.innerWidth - doc.clientWidth,
        height: window.innerHeight,
        max: doc.scrollHeight - window.innerHeight,
        ratio: window.innerHeight / doc.scrollHeight,
      };
    });
    // A classic (non-overlay) scrollbar is present: the drag is a real thumb drag.
    expect(bar.width).toBeGreaterThan(0);
    // Chrome's classic scrollbar: one arrow button (= bar width) at each end of the track.
    const track = bar.height - 2 * bar.width;
    const thumb = track * bar.ratio;
    const grabY = bar.width + thumb / 2;

    // Drag the thumb about 40 % down the track, in small steps like a hand would.
    await page.mouse.move(bar.x, grabY);
    await page.mouse.down();
    await page.mouse.move(bar.x, grabY + (track - thumb) * 0.4, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
      .toBeGreaterThan(0);
    const drag = await snapshot(page);
    expect(drag.state, "the drag moved the scene").not.toBe(top.state);
    expect(drag.y).toBeGreaterThan(bar.max * 0.3);
    expect(drag.y).toBeLessThan(bar.max * 0.5);

    // Keyboard scrolling back to the very same position: away by one arrow step and back. No
    // click to focus (clicking the copy would move focus into a section, and focus scrolls the
    // pinned copy into view); dropping focus to the document lets the keys scroll the viewport.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("ArrowDown");
    const away = await snapshot(page);
    expect(away.y).not.toBe(drag.y);
    await page.keyboard.press("ArrowUp");
    expect(await snapshot(page)).toEqual(drag);

    // And the far end: thumb dragged past the bottom of the track = End.
    await page.mouse.move(bar.x, bar.width + (track - thumb) * 0.4 + thumb / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x, bar.height + 50, { steps: 12 });
    await page.mouse.up();
    const dragEnd = await snapshot(page);
    expect(dragEnd.y).toBe(bar.max);
    await page.keyboard.press("Home");
    await snapshot(page);
    await page.keyboard.press("End");
    expect(await snapshot(page)).toEqual(dragEnd);
  });
});

/** Scroll with the wheel, then report every frame and rAF tick relative to the scroll stop. */
async function wheelAndWatch(
  page: Page,
  { longFrameAt, longFrameMs }: { longFrameAt?: number; longFrameMs?: number } = {},
) {
  await page.evaluate(
    ([at, ms]) => {
      const log = window.pf15;
      if (!log) throw new Error("no frame clock");
      log.frames = [];
      log.ticks = [];
      if (at === undefined || ms === undefined) return;
      // One long frame `at` ms after the scroll stop: re-armed by every scroll event, it runs
      // inside a rAF callback, so the frame that contains it takes `ms` longer.
      let timer = 0;
      const arm = (): void => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          requestAnimationFrame(() => {
            const end = performance.now() + ms;
            while (performance.now() < end) {
              // Busy: a slow frame, as on a weak laptop or under a GC pause.
            }
          });
        }, at);
      };
      window.addEventListener("scroll", arm, { passive: true });
    },
    [longFrameAt, longFrameMs],
  );
  await page.mouse.move(800, 500);
  await page.mouse.wheel(0, 1200);
  await page.mouse.wheel(0, 1200);
  await page.mouse.wheel(0, 1200);
  // 1.5 s budget + the 2 s that must stay quiet, plus slack for the slowest frame to land.
  await page.waitForTimeout(4500);
  return page.evaluate(() => {
    const log = window.pf15;
    if (!log) throw new Error("no frame clock");
    const since = (t: number): number => Math.round(t - log.lastScroll);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return {
      frames: log.frames.map(since),
      ticks: log.ticks.map(since),
      scrolled: window.scrollY / max,
      shown: window.darkroomTest?.shown() ?? -1,
      drawn: window.darkroomTest?.state().p ?? -1,
    };
  });
}

function expectIdleWithin1500(result: Awaited<ReturnType<typeof wheelAndWatch>>): void {
  const detail = JSON.stringify(result);
  // The scene responded to the scroll...
  expect(result.frames.length, detail).toBeGreaterThan(0);
  // ...stopped rendering by 1.5 s after the scroll stop, and its rAF loop stayed quiet after...
  expect(
    result.frames.filter((t) => t > 1500),
    detail,
  ).toEqual([]);
  expect(
    result.ticks.filter((t) => t > 1500),
    detail,
  ).toEqual([]);
  // ...and the last frame it drew shows where the page is (no stale scene).
  expect(Math.abs(result.drawn - result.scrolled), detail).toBeLessThan(2e-4);
  expect(Math.abs(result.shown - result.scrolled), detail).toBeLessThan(2e-4);
}

test.describe("PF-15 AC2 no frames 1.5 s after the scroll stops", () => {
  test.beforeEach(async ({ page }) => {
    await withFrameClock(page);
    await openScene(page);
  });

  test("at normal speed", async ({ page }) => {
    expectIdleWithin1500(await wheelAndWatch(page));
  });

  test("when every frame is slow (CPU throttled 6×)", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    try {
      expectIdleWithin1500(await wheelAndWatch(page));
    } finally {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    }
  });

  test("when one frame mid catch-up takes 700 ms", async ({ page }) => {
    expectIdleWithin1500(await wheelAndWatch(page, { longFrameAt: 500, longFrameMs: 700 }));
  });

  test("when one frame near the budget takes 500 ms", async ({ page }) => {
    expectIdleWithin1500(await wheelAndWatch(page, { longFrameAt: 1000, longFrameMs: 500 }));
  });
});

/** Emulate a hidden (or visible again) tab: what the page sees when the user switches tabs. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    if (h) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
    } else {
      // Drop the instance overrides: the real (visible) Document getters apply again.
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test.describe("PF-15 AC3 a hidden tab renders nothing", () => {
  test("0 frames and 0 rAF callbacks while hidden; catches up and idles once visible", async ({
    page,
  }) => {
    await withFrameClock(page);
    await openScene(page);
    await page.mouse.move(800, 500);
    // Hide in the middle of a catch-up: the loop is running when the tab goes away.
    await page.mouse.wheel(0, 2400);
    await setHidden(page, true);
    // Count with the stage's own counters, not only the rAF-stamped log: a draw outside rAF (a
    // Safelight change, say) must count too.
    const atHide = await page.evaluate(() => {
      const log = window.pf15;
      if (!log) throw new Error("no frame clock");
      log.frames = [];
      log.ticks = [];
      return {
        frames: window.darkroomTest?.frames() ?? -1,
        rafs: window.darkroomTest?.rafs() ?? -1,
        safelight: window.darkroomTest?.safelight() ?? null,
      };
    });
    expect(await page.evaluate(() => document.visibilityState)).toBe("hidden");
    // Things that would normally request or draw frames, all while hidden.
    await page.evaluate(() => {
      window.scrollBy(0, 900);
    });
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.locator("[data-safelight-toggle]").evaluate((el) => {
      if (el instanceof HTMLElement) el.click();
    });
    await page.waitForTimeout(2500);
    const hidden = await page.evaluate(() => ({
      frames: window.darkroomTest?.frames() ?? -1,
      rafs: window.darkroomTest?.rafs() ?? -1,
      safelight: window.darkroomTest?.safelight() ?? null,
      stampedFrames: window.pf15?.frames.length ?? -1,
      stampedTicks: window.pf15?.ticks.length ?? -1,
    }));
    // The Safelight click really landed (so a draw on it would have been counted).
    expect(hidden.safelight).toBe(!atHide.safelight);
    expect(
      {
        frames: hidden.frames - atHide.frames,
        rafs: hidden.rafs - atHide.rafs,
        stampedFrames: hidden.stampedFrames,
        stampedTicks: hidden.stampedTicks,
      },
      JSON.stringify({ atHide, hidden }),
    ).toEqual({ frames: 0, rafs: 0, stampedFrames: 0, stampedTicks: 0 });
    // rAF itself still runs here (headless never pauses it): the stage's guards kept it at 0.
    const rafAlive = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          requestAnimationFrame(() => {
            resolve(true);
          });
          setTimeout(() => {
            resolve(false);
          }, 1000);
        }),
    );
    expect(rafAlive).toBe(true);

    // Visible again: it catches up to where the page now is, then goes idle.
    await setHidden(page, false);
    await page.waitForTimeout(4000);
    const back = await page.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const now = performance.now();
      const log = window.pf15;
      return {
        frames: log?.frames.length ?? -1,
        lastTickAgo: log?.ticks.length ? now - (log.ticks.at(-1) ?? 0) : -1,
        scrolled: window.scrollY / max,
        drawn: window.darkroomTest?.state().p ?? -1,
      };
    });
    expect(back.frames, JSON.stringify(back)).toBeGreaterThan(0);
    expect(Math.abs(back.drawn - back.scrolled), JSON.stringify(back)).toBeLessThan(2e-4);
    expect(back.lastTickAgo, JSON.stringify(back)).toBeGreaterThan(2000);
  });
});
