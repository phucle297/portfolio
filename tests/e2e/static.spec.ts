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
  const bg = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
  const alpha = Number(/rgba?\(([^)]+)\)/u.exec(bg)?.[1]?.split(",")[3] ?? "1");
  expect(alpha).toBeGreaterThanOrEqual(0.95);
});
