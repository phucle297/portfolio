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

declare global {
  interface Window {
    /** Set by the fonts.ready parse probe's init script (QA L1). */
    pf27FontsProbe?: { installed: boolean; duringParse: number; afterParse: number };
  }
}

const bar = (page: Page) => page.locator(".home-progress");
const fill = (page: Page) => page.locator("[data-progress]");

const openAt = async (page: Page, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(bar(page)).toBeVisible();
  // Geometry is asserted on a painted frame. --header-bottom is measured in a ResizeObserver
  // (after layout, before paint), not during HTML parse (QA L1), so on a loaded box `load` can
  // fire before the first frame; what a user sees is the painted frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
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
    route.fulfill({
      contentType: "text/javascript",
      body: "postMessage(false);",
    }),
  );
};

/**
 * Force the JS fallback driver: hide scroll timelines from CSS.supports and switch off the
 * CSS timeline animation, as on an engine without scroll-driven animations.
 */
const forceFallback = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const native = CSS.supports.bind(CSS);
    Object.defineProperty(CSS, "supports", {
      configurable: true,
      value: (property: string, value?: string): boolean => {
        if (`${property} ${value ?? ""}`.includes("timeline")) return false;
        return value === undefined ? native(property) : native(property, value);
      },
    });
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".home-progress span{animation:none!important}";
      document.head.append(style);
    });
  });
};

/** Two animation frames: a scroll or resize has been painted by the rAF-throttled driver. */
const settle = async (page: Page): Promise<void> => {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
};

/** Scroll to `fromEnd` px above the bottom and return the fill and the exact ratio there. */
const sampleAt = async (
  page: Page,
  fromEnd: number,
): Promise<{ fill: number; expected: number; fromEnd: number }> => {
  await page.evaluate((offset) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: Math.max(0, max - offset), behavior: "instant" });
  }, fromEnd);
  await settle(page);
  await settle(page);
  const fillNow = await scaleX(page);
  const state = await page.evaluate(() => {
    const max = document.documentElement.scrollHeight - innerHeight;
    return { expected: max > 0 ? scrollY / max : 0, fromEnd: max - scrollY };
  });
  return { fill: fillNow, ...state };
};

const checkEnd = async (page: Page, label: string): Promise<void> => {
  const near = await sampleAt(page, 100);
  expect(near.fromEnd, `${label}: really 100 px from the end`).toBeGreaterThan(99);
  expect(near.fill, `${label}: under 100 % at 100 px from the end (${near.fill})`).toBeLessThan(1);
  expect(
    Math.abs(near.fill - near.expected),
    `${label}: fill ${near.fill} vs scrollY/max ${near.expected} at 100 px from the end`,
  ).toBeLessThanOrEqual(0.005);

  const bottom = await sampleAt(page, 0);
  expect(bottom.fromEnd, `${label}: at the very bottom`).toBeLessThanOrEqual(1);
  expect(bottom.fill, `${label}: 100 % at the very bottom (${bottom.fill})`).toBeGreaterThan(0.995);
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

  /**
   * QA M1 (attempt 2): engines without CSS scroll timelines use the inline JS driver. It must
   * hit 100 % exactly at the bottom, not early, including after the page grows late (fonts,
   * late content). Forces the fallback by hiding the timeline from CSS.supports and killing
   * the CSS animation, and forces the static tier so the fill follows scrollY, not the scene.
   */
  test.describe("JS fallback without scroll timelines", () => {
    for (const viewport of VIEWPORTS) {
      test(`${viewport.name}: reaches 100 % exactly at the bottom, also after the page grows`, async ({
        page,
      }) => {
        await forceStatic(page);
        await forceFallback(page);
        await openAt(page, viewport.width, viewport.height);
        await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
        await page.evaluate(async () => {
          if (document.readyState !== "complete") {
            await new Promise((resolve) => {
              addEventListener("load", resolve, { once: true });
            });
          }
          await document.fonts.ready;
        });
        const animation = await fill(page).evaluate((el) => getComputedStyle(el).animationName);
        expect(animation, "CSS timeline animation is off, so the JS driver paints").toBe("none");

        await checkEnd(page, `${viewport.name} after load`);

        // Late content (an embed, a lazy block, a font swap) makes the page 600 px taller.
        await page.evaluate(() => {
          const late = document.createElement("div");
          late.dataset.lateContent = "";
          late.style.height = "600px";
          document.querySelector("main")?.append(late);
        });
        await settle(page);
        await checkEnd(page, `${viewport.name} after late content`);
      });
    }
  });

  /**
   * QA L1 (attempt 3): document.fonts.ready flushes layout. The fill driver must not
   * read it while the HTML is still parsing (readyState === "loading"). First-paint
   * flushness of the bar stays on the --header-bottom ResizeObserver path.
   */
  test("the fill driver does not read document.fonts.ready during HTML parse", async ({ page }) => {
    // Init scripts run before the parser has created <html>, so the probe records on window
    // (document.documentElement is still null here). The probe also counts reads after
    // parse, so the test proves the hook was installed and would have seen a parse-time read.
    await page.addInitScript({
      content: `(function () {
          var probe = { installed: false, duringParse: 0, afterParse: 0 };
          window.pf27FontsProbe = probe;
          var fonts = document.fonts;
          if (!fonts) return;
          var desc =
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fonts), "ready") ||
            Object.getOwnPropertyDescriptor(fonts, "ready");
          var getReady = desc && desc.get;
          Object.defineProperty(fonts, "ready", {
            configurable: true,
            get: function () {
              if (document.readyState === "loading") probe.duringParse += 1;
              else probe.afterParse += 1;
              return getReady ? getReady.call(fonts) : Promise.resolve(fonts);
            },
          });
          probe.installed = true;
        })();`,
    });
    await page.goto("/");
    await expect(bar(page)).toBeVisible();
    // The driver still registers fonts.ready after the first frame (font swaps remeasure).
    await expect
      .poll(() => page.evaluate(() => window.pf27FontsProbe?.afterParse ?? 0), { timeout: 5_000 })
      .toBeGreaterThan(0);
    const probe = await page.evaluate(() => window.pf27FontsProbe);
    expect(probe?.installed, "fonts.ready probe is installed before the page parses").toBe(true);
    expect(
      probe?.duringParse,
      "document.fonts.ready was not read while readyState was loading",
    ).toBe(0);
  });

  /**
   * QA (attempt 3): once a JS driver paints the fill, the CSS scroll-timeline animation must be
   * cancelled, or it keeps running and overrides the driver's inline transform. Checked on the
   * static tier and with reduced motion, where the inline driver owns the fill.
   */
  test.describe("JS driver cancels the CSS scroll-timeline animation", () => {
    for (const mode of ["static", "reduced motion"] as const) {
      test(`${mode}: no running animations on the fill after the driver paints`, async ({
        page,
      }) => {
        if (mode === "static") await forceStatic(page);
        else await page.emulateMedia({ reducedMotion: "reduce" });
        await openAt(page, 1440, 900);
        if (mode === "static") {
          await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
        }
        await scrollToRatio(page, 0.3);
        await settle(page);
        const running = await fill(page).evaluate((el) =>
          el
            .getAnimations()
            .filter((a) => a.playState === "running")
            .map((a) => (a instanceof CSSAnimation ? a.animationName : a.constructor.name)),
        );
        expect(running, `running animations on [data-progress]: ${running.join(", ")}`).toEqual([]);
        // The fill still tracks scroll: the driver, not the CSS timeline, painted it.
        const expected = await page.evaluate(
          () => scrollY / (document.documentElement.scrollHeight - innerHeight),
        );
        expect(Math.abs((await scaleX(page)) - expected)).toBeLessThanOrEqual(0.02);
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
