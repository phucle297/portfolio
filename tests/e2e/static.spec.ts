import { expect, test } from "@playwright/test";
import { SECTION_IDS, scrollThrough, spoofHardwareGpu } from "./helpers";

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
