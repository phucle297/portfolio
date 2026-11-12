/**
 * PF-27: the orange scroll-progress bar sits flush under the site header on desktop and
 * mobile, on every tier. It is never behind the header, progress still grows with scroll,
 * opening it does not add layout shift, and reduced motion is respected.
 */
import { expect, test, type Page } from "@playwright/test";
import { inSequence } from "./helpers";

const VIEWPORTS = [
  { name: "1440×900", width: 1440, height: 900 },
  { name: "390×844", width: 390, height: 844 },
] as const;

const bar = (page: Page) => page.locator(".home-progress");
const fill = (page: Page) => page.locator("[data-progress]");

const openAt = async (page: Page, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(bar(page)).toBeVisible();
};

const geometry = async (page: Page): Promise<{ headerBottom: number; barTop: number }> =>
  page.evaluate(() => {
    const head = document.querySelector(".site-header");
    const line = document.querySelector(".home-progress");
    if (!head || !line) throw new Error("header or progress bar missing");
    return {
      headerBottom: head.getBoundingClientRect().bottom,
      barTop: line.getBoundingClientRect().top,
    };
  });

const scaleX = async (page: Page): Promise<number> =>
  fill(page).evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m11);

const scrollToRatio = async (page: Page, ratio: number): Promise<void> => {
  await page.evaluate((r) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: max * r, behavior: "instant" });
  }, ratio);
  await expect.poll(() => scaleX(page), { timeout: 5_000 }).toBeGreaterThan(ratio * 0.5);
};

test.describe("PF-27 progress bar under the header", () => {
  for (const viewport of VIEWPORTS) {
    test.describe(viewport.name, () => {
      test("the bar's top equals the header's bottom, at the top and scrolled", async ({
        page,
      }) => {
        await openAt(page, viewport.width, viewport.height);

        const atTop = await geometry(page);
        expect(
          Math.abs(atTop.barTop - atTop.headerBottom),
          `at top: bar ${atTop.barTop} vs header ${atTop.headerBottom}`,
        ).toBeLessThanOrEqual(1);

        await scrollToRatio(page, 0.45);
        const scrolled = await geometry(page);
        expect(
          Math.abs(scrolled.barTop - scrolled.headerBottom),
          `scrolled: bar ${scrolled.barTop} vs header ${scrolled.headerBottom}`,
        ).toBeLessThanOrEqual(1);
      });

      test("the bar is on top in the stacking order", async ({ page }) => {
        await openAt(page, viewport.width, viewport.height);
        await scrollToRatio(page, 0.45);
        const hit = await page.evaluate(() => {
          const line = document.querySelector<HTMLElement>(".home-progress");
          if (!line) throw new Error("progress bar missing");
          const previous = line.style.pointerEvents;
          line.style.pointerEvents = "auto";
          const box = line.getBoundingClientRect();
          const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          line.style.pointerEvents = previous;
          return line.contains(el) || el === line;
        });
        expect(hit, "elementFromPoint at the bar should be the bar").toBe(true);
      });

      test("progress grows with scroll", async ({ page }) => {
        await openAt(page, viewport.width, viewport.height);
        await expect.poll(() => scaleX(page)).toBeCloseTo(0, 2);

        await scrollToRatio(page, 0.45);
        const mid = await scaleX(page);
        expect(mid).toBeGreaterThan(0.3);
        expect(mid).toBeLessThan(0.7);

        await scrollToRatio(page, 1);
        await expect.poll(() => scaleX(page)).toBeCloseTo(1, 2);
      });
    });
  }

  test("reduced motion still places the bar under the header and updates it instantly", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openAt(page, 1440, 900);
    const atTop = await geometry(page);
    expect(Math.abs(atTop.barTop - atTop.headerBottom)).toBeLessThanOrEqual(1);

    const duration = await fill(page).evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration === "0s" || duration === "0.01ms" || duration === "0.00001s").toBe(true);

    await scrollToRatio(page, 0.5);
    const mid = await scaleX(page);
    expect(mid).toBeGreaterThan(0.35);
    const scrolled = await geometry(page);
    expect(Math.abs(scrolled.barTop - scrolled.headerBottom)).toBeLessThanOrEqual(1);
  });

  test("moving the bar under the header does not add layout shift (CLS ≤ 0.02)", async ({
    browser,
  }) => {
    await inSequence(VIEWPORTS, async (viewport) => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await page.addInitScript(() => {
        const w = window as Window & { cls?: number };
        w.cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const value = "value" in entry && typeof entry.value === "number" ? entry.value : 0;
            const input = "hadRecentInput" in entry && entry.hadRecentInput === true;
            if (!input) w.cls = (w.cls ?? 0) + value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto("/");
      await expect(bar(page)).toBeVisible();
      await page.evaluate(async () => {
        const max = document.documentElement.scrollHeight - innerHeight;
        const positions = Array.from({ length: 8 }, (_, i) => (max * (i + 1)) / 8);
        await positions.reduce(
          (previous, top) =>
            previous.then(
              () =>
                new Promise<void>((resolve) => {
                  window.scrollTo({ top, behavior: "instant" });
                  requestAnimationFrame(() => {
                    resolve();
                  });
                }),
            ),
          Promise.resolve(),
        );
      });
      const cls = await page.evaluate(() => (window as Window & { cls?: number }).cls ?? 0);
      expect(cls, `${viewport.name} CLS ${cls}`).toBeLessThanOrEqual(0.02);
      await context.close();
    });
  });
});
