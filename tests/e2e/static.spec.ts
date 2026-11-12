import { expect, type Page, test } from "@playwright/test";
import { SECTION_IDS, scrollThrough, spoofHardwareGpu } from "./helpers";
import { layoutShifts, recordLayoutShifts, shiftScore } from "./layout-shift";

for (const viewport of [
  { name: "D", width: 1440, height: 900 },
  { name: "M", width: 390, height: 844 },
]) {
  test(`M1-AC9 reads without JS at ${viewport.name}`, async ({ browser }) => {
    const on = await browser.newContext({ viewport });
    const off = await browser.newContext({ viewport, javaScriptEnabled: false });
    const pageOn = await on.newPage();
    const pageOff = await off.newPage();
    await pageOn.goto("/");
    await pageOff.goto("/");
    const lenOn = await pageOn.evaluate(() => document.body.innerText.length);
    const lenOff = await pageOff.evaluate(() => document.body.innerText.length);
    expect(lenOff / lenOn).toBeGreaterThanOrEqual(0.95);
    const sections = await pageOff.evaluate(
      (ids) =>
        ids.map((id) => {
          const el = document.getElementById(id);
          return {
            height: el?.getBoundingClientRect().height ?? 0,
            stills: el?.querySelectorAll(".still img").length ?? 0,
          };
        }),
      SECTION_IDS,
    );
    for (const section of sections) {
      expect(section.height).toBeGreaterThan(0);
      expect(section.stills).toBe(1);
    }
    await expect(pageOff.locator("form input, form textarea, form select")).toHaveCount(6);
    // QA-1 / QA-4: elements that ship `hidden` stay hidden without JS (no display rule beats it).
    const errorsShown = (page: typeof pageOn) =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll(".field__error")).filter(
            (el) => getComputedStyle(el).display !== "none",
          ).length,
      );
    expect(await errorsShown(pageOn)).toBe(0);
    expect(await errorsShown(pageOff)).toBe(0);
    await expect(pageOff.locator(".field__error")).toHaveCount(3);
    await expect(pageOff.locator("[data-motion-toggle]")).toBeHidden();
    await expect(pageOff.locator("[data-copy-email]")).toBeHidden();
    await expect(pageOff.locator("#contact a[href^='mailto:']")).toBeVisible();
    await on.close();
    await off.close();
  });
}

test("M1-AC13 fonts: design faces, no fallback in the names, ≤ 150 KB of page fonts", async ({
  page,
}) => {
  const fontBytes = new Map<string, number>();
  page.on("response", async (response) => {
    const url = response.url();
    if (/\.woff2?($|\?)/.test(url)) {
      const body = await response.body().catch(() => Buffer.alloc(0));
      fontBytes.set(url, body.length);
    }
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await scrollThrough(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const checks = await page.evaluate(() => ({
    sans: document.fonts.check('400 16px "Be Vietnam Pro"', "Lê Đàm Duy Phúc Asia/Saigon"),
    serif: document.fonts.check('400 64px "Instrument Serif"', "Phúc Lê"),
    serifItalic: document.fonts.check('italic 400 64px "Instrument Serif"', "developing."),
    mono: document.fonts.check('500 13px "IBM Plex Mono"', "Asia/Saigon (UTC+7)"),
    h1Family: getComputedStyle(document.querySelector("h1") ?? document.body).fontFamily,
  }));
  expect(checks.sans).toBe(true);
  expect(checks.serif).toBe(true);
  expect(checks.serifItalic).toBe(true);
  expect(checks.mono).toBe(true);
  expect(checks.h1Family).toContain("Instrument Serif");
  const urls = [...fontBytes.keys()];
  expect(urls.some((u) => u.includes("inter"))).toBe(false);
  expect(urls.some((u) => u.includes("anton"))).toBe(false);
  const total = [...fontBytes.values()].reduce((a, b) => a + b, 0);
  expect(total).toBeLessThanOrEqual(150 * 1024);
});

for (const viewport of [
  { name: "D", width: 1440, height: 900, gpu: true },
  { name: "M", width: 390, height: 844, gpu: false },
]) {
  test(`M1-AC15 CLS ≤ 0.02 across load, island mount and full scroll at ${viewport.name}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    if (viewport.gpu) await spoofHardwareGpu(page);
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
    if (viewport.gpu) {
      await expect(page.locator("html")).toHaveAttribute("data-tier", "full", {
        timeout: 20_000,
      });
    }
    await page.waitForTimeout(1500);
    await scrollThrough(page);
    const cls = await page.evaluate(() => (window as Window & { cls?: number }).cls ?? 0);
    expect(cls).toBeLessThanOrEqual(0.02);
    await context.close();
  });
}

test("LCP still is discoverable, eager and high priority", async ({ page }) => {
  await page.goto("/");
  const img = page.locator("#hello .still img");
  await expect(img).toHaveAttribute("fetchpriority", "high");
  await expect(img).toHaveAttribute("loading", "eager");
});

test("QA-1: no element that ships `hidden` is displayed on load", async ({ page }) => {
  await page.goto("/");
  const shown = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[hidden]"))
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(shown).toEqual([]);
  await page.locator("#contact").scrollIntoViewIfNeeded();
  // Every contact-form error (name, email, brief), not just the first, is hidden on load,
  // shows on an invalid submit and clears once its field is corrected.
  const fields = ["name", "email", "brief"] as const;
  const error = (name: string) => page.locator(`#contact-${name}-error`);
  const input = (name: string) => page.locator(`#contact-${name}`);
  const submit = page.locator(".contact__submit");
  const each = (check: (name: (typeof fields)[number]) => Promise<void>) =>
    Promise.all(fields.map(check));
  await expect(page.locator("form .field__error")).toHaveCount(fields.length);
  await each(async (name) => {
    await expect(error(name)).toBeHidden();
    await expect(input(name)).not.toHaveAttribute("aria-invalid", "true");
  });
  await submit.click();
  await each(async (name) => {
    await expect(error(name)).toBeVisible();
    await expect(input(name)).toHaveAttribute("aria-invalid", "true");
  });
  // Correct one field at a time: only the fixed field's error clears.
  await input("name").fill("Ada");
  await input("email").fill("not-an-email");
  await submit.click();
  await expect(error("name")).toBeHidden();
  await expect(error("email")).toBeVisible();
  await expect(error("brief")).toBeVisible();
  await input("email").fill("ada@example.com");
  await submit.click();
  await expect(error("email")).toBeHidden();
  await expect(input("email")).toHaveAttribute("aria-invalid", "false");
  await expect(error("brief")).toBeVisible();
  await input("brief").fill("A small marketing site.");
  await submit.click();
  await each(async (name) => {
    await expect(error(name)).toBeHidden();
    await expect(input(name)).toHaveAttribute("aria-invalid", "false");
  });
});

test("QA-5: copy-email button copies the address and announces it", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.goto("/");
  const button = page.locator("[data-copy-email]");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("Copy email");
  const email = await button.getAttribute("data-copy-email");
  await button.click();
  await expect(page.locator("[data-copy-status]")).toHaveText("Email copied.");
  await expect(button).toHaveText("Email copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(email);
  await expect(button).toHaveText("Copy email", { timeout: 4000 });
  await expect(page.locator("[data-copy-status]")).toHaveText("");
  await context.close();
});

test("QA-5: when the clipboard write fails, the address is selected and the failure announced", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  await page.goto("/");
  await page.locator("[data-copy-email]").click();
  await expect(page.locator("[data-copy-status]")).toContainText("Couldn't copy");
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toBe(await page.locator("[data-copy-email]").getAttribute("data-copy-email"));
});

test("QA-7: the header is opaque once scrolled, so copy never shows through it", async ({
  page,
}) => {
  await page.goto("/");
  const header = page.locator(".site-header");
  await expect(header).toHaveAttribute("data-at-top", "");
  await page.evaluate(() => {
    window.scrollTo(0, innerHeight * 2);
  });
  await expect(header).not.toHaveAttribute("data-at-top", "");
  // The bar fades in over --t-ui (background-color transition), so wait for the settled value.
  await expect
    .poll(
      async () => {
        const bg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
        return Number(/rgba?\(([^)]+)\)/u.exec(bg)?.[1]?.split(",")[3] ?? "1");
      },
      { timeout: 2000 },
    )
    .toBeGreaterThanOrEqual(0.95);
});

test("QA-8: the header's at-top state is in the HTML, and without JS the scrolled bar stays opaque", async ({
  page,
  browser,
  request,
}) => {
  // Server-rendered: the first paint does not wait for the scroll script.
  const html = await (await request.get("/")).text();
  expect(html).toMatch(/<header class="site-header"[^>]*\bdata-at-top\b/u);
  // With JS the gradient applies at the top from the first paint; the script clears it on scroll.
  await page.goto("/");
  const header = page.locator(".site-header");
  await expect(header).toHaveAttribute("data-at-top", "");
  const topBg = await header.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(topBg).toContain("gradient");
  // Without JS nothing clears the attribute, so the gradient is gated on html.js: opaque bar.
  const off = await browser.newContext({ javaScriptEnabled: false });
  const nojs = await off.newPage();
  await nojs.goto("/");
  const style = await nojs
    .locator(".site-header")
    .evaluate((el) => [getComputedStyle(el).backgroundImage, getComputedStyle(el).backgroundColor]);
  expect(style[0]).toBe("none");
  const alpha = Number(/rgba?\(([^)]+)\)/u.exec(style[1] ?? "")?.[1]?.split(",")[3] ?? "1");
  expect(alpha).toBeGreaterThanOrEqual(0.95);
  await off.close();
});

test("B-8: a reload while scrolled keeps the header opaque before its script runs", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.scrollTo(0, innerHeight * 3);
  });
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(100);
  // Hold every bundled module script, so the header's own script (and everything else that
  // hydrates) has not run while the browser restores the scrolled position.
  const held: { continue: () => Promise<void> }[] = [];
  await page.route(/\/_astro\/[^/]+\.js(\?.*)?$/u, (route) => {
    held.push(route);
  });
  await page.reload({ waitUntil: "commit" });
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 10_000 }).toBeGreaterThan(100);
  await expect.poll(() => held.length).toBeGreaterThan(0);
  const header = page.locator(".site-header");
  // Not hydrated: the module script still has not cleared the server-rendered at-top state, and
  // the JS-only Safelight button is still hidden.
  await expect(header).toHaveAttribute("data-at-top", "");
  await expect(page.locator("[data-safelight-toggle]")).toBeHidden();
  const before = await header.evaluate((el) => [
    getComputedStyle(el).backgroundImage,
    getComputedStyle(el).backgroundColor,
    `html[data-scrolled]=${document.documentElement.hasAttribute("data-scrolled")} scrollY=${scrollY}`,
  ]);
  expect(before[0], `no see-through gradient over the copy (${before[2]})`).toBe("none");
  const alpha = Number(/rgba?\(([^)]+)\)/u.exec(before[1] ?? "")?.[1]?.split(",")[3] ?? "1");
  expect(alpha).toBeGreaterThanOrEqual(0.95);
  // Once the scripts run, the bar stays opaque (at-top cleared by the header's script).
  await Promise.all(held.map(async (route) => route.continue()));
  await page.unroute(/\/_astro\/[^/]+\.js(\?.*)?$/u);
  await expect(header).not.toHaveAttribute("data-at-top", "");
  expect(await header.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
});

/** Loaded font faces as "family weight". */
const families = async (page: Page): Promise<string[]> =>
  page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => `${face.family.replaceAll('"', "")} ${face.weight}`);
  });

// TASK-20261112-14: the two layout shifts behind the CI regression of M1-AC15 at D (0.02065).
// Both are pinned to the element that moved, so they fail on the cause, not on a total that load
// or font timing can hide.
test.describe("TASK-14 layout stability at 1440x900", () => {
  const HELLO = [
    "#hello .home-section__body",
    "#hello .hello__title",
    "#hello .hello__subtitle",
    "#hello .hello__lede",
    "#hello .hello__actions",
    ".site-header__nav ul",
    ".site-header__actions",
  ];
  const boxes = async (page: Page): Promise<Record<string, number[]>> =>
    page.evaluate(
      (selectors) =>
        Object.fromEntries(
          selectors.map((selector) => {
            const r = document.querySelector(selector)?.getBoundingClientRect();
            return [selector, r ? [r.x, r.y, r.width, r.height].map(Math.round) : []];
          }),
        ),
      HELLO,
    );

  test("Hello copy and header keep their layout while the web fonts are still missing", async ({
    browser,
  }) => {
    // Shift 1 (0.017): before Be Vietnam Pro arrived, the Hello subtitle and lede set in a
    // narrower system face took one more line each and the centred Hello block moved 32 px when
    // the font swapped in. The metric-matched fallback must give the same lines and boxes.
    const viewport = { width: 1440, height: 900 };
    const withheld = await browser.newContext({ viewport });
    const loaded = await browser.newContext({ viewport });
    const fallbackPage = await withheld.newPage();
    const webPage = await loaded.newPage();
    await fallbackPage.route(/be-vietnam-pro|instrument-serif/u, async (route) => route.abort());
    await Promise.all([fallbackPage.goto("/"), webPage.goto("/")]);
    const fallbackFaces = await families(fallbackPage);
    const webFaces = await families(webPage);
    // The fallback faces must resolve on this machine (Arial or its Liberation / Arimo clone),
    // otherwise the comparison below measures some system face instead.
    expect(fallbackFaces).toEqual(
      expect.arrayContaining(["Be Vietnam Pro Fallback 400", "Be Vietnam Pro Fallback 600"]),
    );
    expect(fallbackFaces.some((f) => /^Be Vietnam Pro \d/u.test(f))).toBe(false);
    expect(webFaces).toEqual(expect.arrayContaining(["Be Vietnam Pro 400", "Be Vietnam Pro 600"]));
    const before = await boxes(fallbackPage);
    const after = await boxes(webPage);
    for (const selector of HELLO) {
      const [x0 = 0, y0 = 0, w0 = 0, h0 = 0] = before[selector] ?? [];
      const [x1 = 0, y1 = 0, w1 = 0, h1 = 0] = after[selector] ?? [];
      expect(Math.abs(y1 - y0), `${selector} top`).toBeLessThanOrEqual(3);
      expect(Math.abs(h1 - h0), `${selector} height`).toBeLessThanOrEqual(3);
      expect(Math.abs(x1 - x0), `${selector} left`).toBeLessThanOrEqual(6);
      expect(Math.abs(w1 - w0), `${selector} width`).toBeLessThanOrEqual(12);
    }
    await withheld.close();
    await loaded.close();
  });

  test("the full tier mounts without moving the header or the Hello copy", async ({ browser }) => {
    // Shift 2 (0.0035): the Safelight button took its slot only when the full tier mounted, so
    // the Motion toggle and the centred nav jumped 66-133 px sideways after load.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await spoofHardwareGpu(page);
    await recordLayoutShifts(page);
    await page.goto("/");
    const toggle = page.locator("[data-motion-toggle]");
    await expect(toggle).toBeVisible();
    const toggleBefore = await toggle.boundingBox();
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
    await expect(page.locator("[data-safelight-toggle]")).toBeVisible();
    expect(await toggle.boundingBox()).toEqual(toggleBefore);
    await page.waitForTimeout(1000);
    const shifts = await layoutShifts(page);
    const moved = shifts
      .filter((shift) => !shift.hadRecentInput)
      .flatMap((shift) => shift.sources.map((source) => source.node))
      .filter((node) => /site-header|section#hello/u.test(node));
    expect(moved, JSON.stringify(shifts)).toEqual([]);
    expect(shiftScore(shifts)).toBeLessThanOrEqual(0.02);
    await context.close();
  });
});
