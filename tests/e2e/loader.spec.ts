import { expect, test, type Page } from "@playwright/test";
import { waitForLoader } from "./helpers";

/**
 * PF-67: the first-open loader ("the print develops", design/loading/design.md).
 *
 * AC1 it covers the page from first paint, leaves once fonts and the intro still are in, never
 *     lasts past the 3 s cap, and a fast load shows no loader content (300 ms delay).
 * AC2 its exit moves nothing on the page; under reduced motion it just disappears.
 * AC3 polite busy → done announcement, no focus trap, first Tab lands on the skip link.
 */

const WATCHED = [".site-header", ".site-header__brand", "#hello-title", ".hello__actions"];

function boxes(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate((selectors) => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const sel of selectors) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r) out[sel] = { x: r.x, y: r.y };
    }
    return out;
  }, WATCHED);
}

test("PF-67 AC1+AC3: the loader covers the first paint, announces busy then done, and leaves once the page is ready", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const early = await page.evaluate(() => {
    const loader = document.querySelector(".loader");
    const cs = loader ? getComputedStyle(loader) : null;
    return {
      present: Boolean(loader),
      position: cs?.position,
      background: cs?.backgroundColor,
      zIndex: cs?.zIndex,
      ariaHidden: loader?.getAttribute("aria-hidden"),
      focusable: loader?.querySelectorAll("a,button,input,[tabindex]").length ?? -1,
      ready: document.documentElement.classList.contains("is-ready"),
      busy: document.getElementById("main")?.getAttribute("aria-busy") ?? null,
      status: document.querySelector("[data-load-status]")?.textContent ?? "",
    };
  });
  expect(early.present).toBe(true);
  expect(early.position).toBe("fixed");
  expect(early.background).toBe("rgb(14, 10, 8)");
  expect(Number(early.zIndex)).toBeGreaterThan(22);
  expect(early.ariaHidden).toBe("true");
  expect(early.focusable).toBe(0);
  if (!early.ready) {
    expect(early.busy).toBe("true");
    expect(early.status).toBe("Loading the page");
  }

  await waitForLoader(page);
  const done = await page.evaluate(() => ({
    fonts: document.fonts.status,
    still: document.documentElement.classList.contains("still0-loaded"),
    busy: document.getElementById("main")?.hasAttribute("aria-busy"),
    status: document.querySelector("[data-load-status]")?.textContent,
    live: document.querySelector("[data-load-status]")?.getAttribute("aria-live"),
  }));
  expect(done).toEqual({
    fonts: "loaded",
    still: true,
    busy: false,
    status: "Page loaded",
    live: "polite",
  });

  // AC3: nothing was focused; the first Tab lands on the skip link.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
});

test("PF-67 AC1: a page that never gets ready still shows at the 3 s cap", async ({ page }) => {
  // Hold the intro still forever: the page is never "ready" by the still.
  await page.route(/\/_astro\/[dm]-0\.[\w-]+\.avif/, () => {});
  const start = Date.now();
  await page.goto("/", { waitUntil: "commit" });
  await page.waitForFunction(
    () => document.documentElement.classList.contains("is-ready"),
    undefined,
    {
      timeout: 6000,
    },
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThan(2500);
  expect(elapsed).toBeLessThan(4500);
  await expect(page.locator(".loader")).toHaveCount(0);
});

test("PF-67 AC2: the loader exit moves nothing on the page by more than 8px", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Read under the cover once the fonts are in, then after the cover is gone.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const before = await boxes(page);
  await waitForLoader(page);
  const after = await boxes(page);
  for (const sel of WATCHED) {
    const a = before[sel];
    const b = after[sel];
    expect(a && b, sel).toBeTruthy();
    if (!a || !b) continue;
    expect(Math.abs(b.x - a.x), `${sel} dx`).toBeLessThanOrEqual(8);
    expect(Math.abs(b.y - a.y), `${sel} dy`).toBeLessThanOrEqual(8);
  }
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("PF-67 AC2: under reduced motion nothing animates and the cover just disappears", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const styles = await page.evaluate(() => {
      const cs = [".loader", ".loader__glow", ".loader__in", ".loader__burst", ".loader__plate"]
        .map((sel) => document.querySelector(sel))
        .map((el) => (el ? getComputedStyle(el) : null));
      const timer = document.querySelector(".loader__timer");
      return {
        transition: cs[0]?.transitionDuration,
        animations: cs.slice(1).map((c) => c?.animationName ?? "missing"),
        timer: timer ? getComputedStyle(timer).display : "missing",
      };
    });
    // `transition: none` (global.css also caps every duration at 0.01 ms under reduced motion).
    expect(
      styles.transition?.split(",").every((d) => Number.parseFloat(d) <= 0.001),
      `transition-duration ${styles.transition}`,
    ).toBe(true);
    expect(styles.animations).toEqual(["none", "none", "none", "none"]);
    expect(styles.timer).toBe("none");
    await waitForLoader(page);
    await page.keyboard.press("Tab");
    await expect(page.locator(".skip-link")).toBeFocused();
  });
});

test.describe("without JS", () => {
  test.use({ javaScriptEnabled: false });

  test("PF-67: without JS the cover never shows", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".loader")).toBeHidden();
  });
});
