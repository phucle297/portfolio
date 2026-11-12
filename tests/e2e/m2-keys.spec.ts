/**
 * M2-AC9: native keys, anchors and Tab move the page and the scene (no scroll library, no key
 * handling of our own). Its own file because it needs a different browser launch flag.
 */
import { expect, test } from "@playwright/test";
import { copyState } from "../../src/shared/lib/timeline";
import { inSequence, openScene, SECTION_IDS, settle } from "./helpers";

test.use({ viewport: { width: 1600, height: 1000 } });

// On this GPU-less box every frame is software-rendered (SwiftShader, ~100 ms at 1600×1000);
// Chrome's animated keyboard scrolling then drops some key presses that arrive while a previous
// scroll animation is still running (seen on the full tier only, pinned or not). Instant
// keyboard scrolling keeps the test about the page's behaviour, not the box's frame rate.
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

test.describe("M2-AC9 native scrolling", () => {
  test("Space, PageDown/Up, arrows, End/Home and anchors move the page and the scene", async ({
    page,
  }) => {
    await openScene(page);
    await page.locator("body").click({ position: { x: 5, y: 500 } });
    const p = async (): Promise<number> => {
      await settle(page);
      return page.evaluate(() => window.darkroomTest?.shown() ?? -1);
    };
    const start = await p();
    await page.keyboard.press("PageDown");
    const afterPageDown = await p();
    expect(afterPageDown).toBeGreaterThan(start);
    await page.keyboard.press("Space");
    const afterSpace = await p();
    expect(afterSpace).toBeGreaterThan(afterPageDown);
    await page.keyboard.press("ArrowDown");
    const afterArrow = await p();
    expect(afterArrow).toBeGreaterThan(afterSpace);
    await page.keyboard.press("PageUp");
    expect(await p()).toBeLessThan(afterArrow);
    await page.keyboard.press("End");
    expect(await p()).toBeCloseTo(1, 3);
    await page.keyboard.press("Home");
    expect(await p()).toBeCloseTo(0, 3);

    // Anchors land on each section's key state, where its copy is fully shown.
    await inSequence(SECTION_IDS, async (id, index) => {
      await page.locator(`.site-header__nav a[data-section-link="${id}"]`).click();
      const shown = await p();
      const opacity = await page.evaluate(
        (sid) =>
          Number(
            getComputedStyle(document.querySelector(`#${sid} [data-copy-body]`) ?? document.body)
              .opacity,
          ),
        id,
      );
      expect(opacity, `${id} at p=${shown}`).toBe(1);
      expect(copyState(shown, index).opacity).toBe(1);
    });
  });

  test("Tab moves focus into the page and the focused element is on screen", async ({ page }) => {
    await openScene(page);
    const steps = Array.from({ length: 45 }, (_, i) => i);
    await inSequence(steps, async (i) => {
      await page.keyboard.press("Tab");
      await settle(page);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const body = el.closest<HTMLElement>("[data-copy-body]");
        const beat = el.closest<HTMLElement>("[data-beat]");
        return {
          tag: `${el.tagName} ${el.textContent?.trim().slice(0, 30) ?? ""}`,
          top: r.top,
          bottom: r.bottom,
          vh: innerHeight,
          bodyOpacity: body ? Number(getComputedStyle(body).opacity) : 1,
          beatOpacity: beat ? Number(getComputedStyle(beat).opacity) : 1,
        };
      });
      if (!info) return;
      expect(info.bottom, `${info.tag} #${i}`).toBeGreaterThan(0);
      expect(info.top, `${info.tag} #${i}`).toBeLessThan(info.vh);
      expect(info.bodyOpacity, `${info.tag} #${i}`).toBe(1);
      expect(info.beatOpacity, `${info.tag} #${i}`).toBe(1);
    });
  });

  test("normal flow (below the pin query): focus scrolls clear of the header (scroll-margin-top 96px)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/");
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("#contact a[href]") ?? document.body)
            .scrollMarginTop,
      ),
    ).toBe("96px");
  });
});
