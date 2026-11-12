/**
 * M3-AC11 / PF-05: the static tier works on every engine and each engine picks the right tier.
 * Runs on all three Playwright projects (chromium, firefox, webkit). Engine-neutral stand-ins
 * for the few Chromium-only checks in static.spec.ts / structure.spec.ts live here too (see
 * playwright.config.ts for why each original stays Chromium-only).
 */
import { expect, test, type BrowserContextOptions, type Page } from "@playwright/test";

const isScene = (url: string): boolean => /\/_astro\/stage\.[\w-]+\.js/.test(url);
const isProbe = (url: string): boolean => url.includes("probe.worker");

interface Watch {
  urls: string[];
  /** Console errors and uncaught exceptions. Warnings are not failures. */
  errors: string[];
}

function watch(page: Page): Watch {
  const w: Watch = { urls: [], errors: [] };
  page.on("request", (r) => w.urls.push(r.url()));
  page.on("console", (m) => {
    if (m.type() === "error") w.errors.push(m.text());
  });
  page.on("pageerror", (e) => w.errors.push(`pageerror: ${e.message}`));
  return w;
}

/** Pin the off-main-thread probe's answer, so the tier decision is deterministic on any host. */
async function pinProbe(page: Page, hardware: boolean): Promise<void> {
  await page.route(/probe\.worker/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: `postMessage(${hardware});` }),
  );
}

/** Load, pass the idle gate (or a first input), then scroll the page top → bottom → top. */
async function visit(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("load");
  await page.waitForTimeout(3500);
  await page.evaluate(async () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    await [0.25, 0.5, 0.75, 1, 0.5, 0].reduce(
      (previous, f) =>
        previous.then(
          () =>
            new Promise<void>((resolve) => {
              window.scrollTo(0, max * f);
              requestAnimationFrame(() => {
                setTimeout(resolve, 60);
              });
            }),
        ),
      Promise.resolve(),
    );
  });
  await page.waitForTimeout(500);
}

test.describe("M3-AC11 tier choice and console, every engine", () => {
  test("desktop, real probe: no console errors and the tier matches what was loaded", async ({
    page,
  }) => {
    const w = watch(page);
    await visit(page);
    const tier = await page.locator("html").getAttribute("data-tier");
    const sceneLoaded = w.urls.some(isScene);
    // GPU-less hosts (this box, CI) get the poster; a real GPU gets the scene.
    expect(tier).toBe(sceneLoaded ? "full" : "static");
    if (tier === "static") await expect(page.locator("#hello .still img")).toBeVisible();
    expect(w.urls.filter(isProbe).length).toBeLessThanOrEqual(1);
    expect(w.errors).toEqual([]);
  });

  test("desktop, no hardware GPU: static tier, no three.js, posters shown", async ({ page }) => {
    await pinProbe(page, false);
    const w = watch(page);
    await visit(page);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    expect(w.urls.filter(isScene)).toEqual([]);
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0);
    await expect(page.locator("#hello .still img")).toBeVisible();
    expect(w.errors).toEqual([]);
  });

  test("desktop, hardware GPU: the full tier is chosen and mounts one canvas", async ({ page }) => {
    await pinProbe(page, true);
    const w = watch(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 30_000 });
    expect(w.urls.filter(isScene)).toHaveLength(1);
    await expect(page.locator("[data-scene] canvas")).toHaveCount(1);
    expect(w.errors).toEqual([]);
  });

  test("phone (390×844, touch): static tier, no probe, no three.js", async ({
    browser,
    browserName,
  }) => {
    const phone: BrowserContextOptions = {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      // Playwright's Firefox has no mobile emulation; width + touch drive the same gates.
      ...(browserName === "firefox" ? {} : { isMobile: true, deviceScaleFactor: 3 }),
    };
    const context = await browser.newContext(phone);
    const page = await context.newPage();
    await pinProbe(page, true);
    const w = watch(page);
    await visit(page);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    expect(w.urls.filter(isScene)).toEqual([]);
    expect(w.urls.filter(isProbe)).toEqual([]);
    await expect(page.locator("#hello .still img")).toBeVisible();
    expect(w.errors).toEqual([]);
    await context.close();
  });
});

test.describe("engine-neutral stand-ins for Chromium-only checks", () => {
  test("M1-AC13 fonts: design faces cover the names, ≤ 150 KB of page fonts, no Anton", async ({
    page,
  }) => {
    const sizes = new Map<string, number>();
    page.on("response", async (response) => {
      if (/\.woff2?($|\?)/.test(response.url())) {
        const body = await response.body().catch(() => Buffer.alloc(0));
        sizes.set(response.url(), body.length);
      }
    });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(500);
    const pageFonts = [...sizes.entries()];
    expect(pageFonts.some(([u]) => u.includes("anton"))).toBe(false);
    expect(pageFonts.some(([u]) => u.includes("inter"))).toBe(false);
    expect(pageFonts.reduce((sum, [, n]) => sum + n, 0)).toBeLessThanOrEqual(150 * 1024);
    // `document.fonts.check()` is only true for faces that are already loaded in Firefox and
    // WebKit (Chromium also answers for unloaded faces), so load each face for the text first:
    // a face that cannot cover a glyph leaves check() false.
    const covered = await page.evaluate(async () => {
      const cases: [string, string][] = [
        ['400 16px "Be Vietnam Pro"', "Lê Đàm Duy Phúc Asia/Saigon"],
        ['400 64px "Instrument Serif"', "Phúc Lê"],
        ['italic 400 64px "Instrument Serif"', "developing."],
        ['400 13px "IBM Plex Mono"', "Lê Đàm Duy Phúc"],
        ['500 13px "IBM Plex Mono"', "Asia/Saigon (UTC+7)"],
      ];
      const loaded = await Promise.all(
        cases.map(([font, text]) => document.fonts.load(font, text)),
      );
      return Object.fromEntries(
        cases.map(([font, text], i) => [
          font,
          (loaded[i]?.length ?? 0) > 0 && document.fonts.check(font, text),
        ]),
      );
    });
    for (const [font, ok] of Object.entries(covered)) expect(ok, font).toBe(true);
    const h1 = await page.evaluate(
      () => getComputedStyle(document.querySelector("h1") ?? document.body).fontFamily,
    );
    expect(h1).toContain("Instrument Serif");
  });

  test("QA-5: copy-email copies the address and announces it (clipboard stubbed)", async ({
    page,
  }) => {
    // Clipboard permissions are Chromium-only in Playwright; record the write instead.
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.defineProperty(window, "pwClipboardWrites", { value: writes });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (text: string) => {
            writes.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    await page.goto("/");
    const button = page.locator("[data-copy-email]");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Copy email");
    const email = await button.getAttribute("data-copy-email");
    await button.click();
    await expect(page.locator("[data-copy-status]")).toHaveText("Email copied.");
    await expect(button).toHaveText("Email copied.");
    const writes = await page.evaluate(
      () => (window as Window & { pwClipboardWrites?: string[] }).pwClipboardWrites ?? [],
    );
    expect(writes).toEqual([email]);
    await expect(button).toHaveText("Copy email", { timeout: 4000 });
  });

  test("contact form: a valid brief opens the mail app and announces success", async ({ page }) => {
    await page.goto("/");
    const contact = page.locator("#contact");
    await page.fill("#contact-name", "Test Person");
    await page.fill("#contact-email", "test@example.com");
    await page.fill("#contact-brief", "A small marketing site by next month.");
    await contact.getByRole("button", { name: "Send brief" }).click();
    await expect(contact.getByText("Your email app is open with your brief.")).toBeVisible();
    await expect(contact.locator("[aria-invalid='true']")).toHaveCount(0);
  });

  test("QA-7: the header settles opaque once scrolled", async ({ page }) => {
    await page.goto("/");
    const header = page.locator(".site-header");
    await expect(header).toHaveAttribute("data-at-top", "");
    await page.evaluate(() => {
      window.scrollTo(0, innerHeight * 2);
    });
    await expect(header).not.toHaveAttribute("data-at-top", "");
    // The bar fades in over --t-ui (a background-color transition): read the settled value.
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
});
