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

/** Force the static tier on a wide viewport by failing the WebGL probe. */
const forceStatic = async (page: Page): Promise<void> => {
  await page.route(/probe\.worker/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "postMessage(false);" }),
  );
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
    const seconds = duration.split(",").map((part) => {
      const token = part.trim();
      const value = Number.parseFloat(token);
      if (Number.isNaN(value)) return Number.POSITIVE_INFINITY;
      return token.endsWith("ms") ? value / 1000 : value;
    });
    expect(
      Math.max(0, ...seconds),
      `transition-duration should be instant under reduced motion, got ${duration}`,
    ).toBeLessThanOrEqual(0.00002);

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

  test.describe("static tier", () => {
    for (const viewport of VIEWPORTS) {
      test(`${viewport.name}: the bar is visible, under the header, and grows with scroll`, async ({
        page,
      }) => {
        if (viewport.width >= 768) await forceStatic(page);
        await openAt(page, viewport.width, viewport.height);
        await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
        await expect(bar(page)).toBeVisible();

        const atTop = await geometry(page);
        expect(Math.abs(atTop.barTop - atTop.headerBottom)).toBeLessThanOrEqual(1);
        await expect.poll(() => scaleX(page)).toBeCloseTo(0, 2);

        await scrollToRatio(page, 0.45);
        const mid = await scaleX(page);
        expect(mid).toBeGreaterThan(0.3);
        expect(mid).toBeLessThan(0.7);
        const scrolled = await geometry(page);
        expect(Math.abs(scrolled.barTop - scrolled.headerBottom)).toBeLessThanOrEqual(1);
      });
    }
  });

  test.describe("no JS", () => {
    for (const viewport of VIEWPORTS) {
      test(`${viewport.name}: the bar is CSS-driven or hidden, never stuck, with no errors`, async ({
        browser,
      }) => {
        const context = await browser.newContext({
          javaScriptEnabled: false,
          viewport: { width: viewport.width, height: viewport.height },
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => {
          errors.push(error.message);
        });
        page.on("console", (msg) => {
          if (msg.type() === "error") errors.push(msg.text());
        });
        await page.goto("/");
        expect(errors, "no page or console errors").toEqual([]);

        const visible = await bar(page).isVisible();
        if (!visible) {
          await expect(bar(page)).toBeHidden();
        } else {
          const track = await bar(page).boundingBox();
          const startFill = await fill(page).boundingBox();
          expect(track, "track is on screen").not.toBeNull();
          expect(startFill, "fill is on screen").not.toBeNull();
          const start = (startFill?.width ?? 0) / Math.max(1, track?.width ?? 1);

          await page.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
          await page.mouse.wheel(0, 4000);
          const midTrack = await bar(page).boundingBox();
          const midFill = await fill(page).boundingBox();
          const mid = (midFill?.width ?? 0) / Math.max(1, midTrack?.width ?? 1);
          expect(mid, `fill grew (was ${start}, now ${mid})`).toBeGreaterThan(start + 0.1);
        }
        await context.close();
      });
    }
  });
});
