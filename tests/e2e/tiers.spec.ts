import { expect, test, type Page } from "@playwright/test";
import { isProbe, isSceneChunk, recordRequests, scrollThrough, spoofHardwareGpu } from "./helpers";

/** Load, wait past idle, scroll to the bottom and back, for ~10 s in total (M1-AC14). */
async function exercise(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState("load");
  await page.waitForTimeout(4000);
  await scrollThrough(page);
  await page.mouse.move(200, 200);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(3000);
}

test.describe("F1 / M1-AC14 gating before any download", () => {
  test("reduced motion: no probe, no three.js, static tier", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    await exercise(page);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    expect(urls.filter(isProbe)).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0);
    await expect(page.locator("#hello .still img")).toBeVisible();
  });

  test("phone viewport (390 wide, touch): no three.js", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    await exercise(page);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    expect(urls.filter(isProbe)).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await context.close();
  });

  test("Save-Data: no three.js", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { value: { saveData: true } });
    });
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    await exercise(page);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    expect(urls.filter(isProbe)).toEqual([]);
  });

  test("no hardware WebGL (probe fails on the software renderer): no three.js", async ({
    page,
  }) => {
    const urls = recordRequests(page);
    await exercise(page);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("#hello .still img")).toBeVisible();
  });

  test("Motion toggle off (persisted): no three.js", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("motion", "off");
    });
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    await exercise(page);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    expect(urls.filter(isProbe)).toEqual([]);
  });

  test("hardware GPU, motion allowed: the scene chunk loads and mounts one canvas", async ({
    page,
  }) => {
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
    expect(urls.filter(isSceneChunk)).toHaveLength(1);
    await expect(page.locator("canvas")).toHaveCount(1);
  });
});

test.describe("full tier", () => {
  test("M1-AC7 canvas placement and the description", async ({ page }) => {
    await spoofHardwareGpu(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
    const canvas = page.locator("[data-scene] canvas");
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    await expect.poll(() => canvas.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    const layout = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>("[data-scene]");
      const canvasEl = host?.querySelector("canvas");
      if (!host || !canvasEl) return null;
      const hs = getComputedStyle(host);
      const r = canvasEl.getBoundingClientRect();
      const prev = host.previousElementSibling;
      return {
        position: hs.position,
        zIndex: hs.zIndex,
        rect: [r.left, r.top, r.width, r.height],
        viewport: [innerWidth, innerHeight],
        display: getComputedStyle(canvasEl).display,
        visibility: getComputedStyle(canvasEl).visibility,
        description: prev?.textContent?.trim() ?? "",
        descriptionHidden: prev?.classList.contains("visually-hidden") ?? false,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout?.position).toBe("fixed");
    expect(Number(layout?.zIndex)).toBeLessThan(2);
    expect(layout?.rect).toEqual([0, 0, ...(layout?.viewport ?? [])]);
    expect(layout?.display).not.toBe("none");
    expect(layout?.visibility).toBe("visible");
    expect(layout?.descriptionHidden).toBe(true);
    expect(layout?.description).toBe(
      "Decorative animation: a photo darkroom that changes as you scroll. A print of Phúc Lê's name develops in a tray, splits into a contact sheet of his roles, hangs on a drying line as his work, becomes labels on four amber bottles for his services, settles into four trays for his process, and joins back into one print when the lights come on at Contact. All content is in the page text.",
    );
  });

  test("M1-AC4 set(p) back and forth leaves the graph unchanged; budgets hold", async ({
    page,
  }) => {
    await spoofHardwareGpu(page);
    await page.goto("/?scene-test");
    await page.waitForFunction(() => window.darkroomTest !== undefined, null, { timeout: 20_000 });
    const result = await page.evaluate(() => {
      const hook = window.darkroomTest;
      if (!hook) throw new Error("no hook");
      const ps = [0, 0.03, 0.21, 0.41, 0.6, 0.76, 0.96, 1];
      // Warm up: three.js uploads a geometry/texture to the GPU the first time it is drawn, so
      // GPU-side counts settle after every key state has been rendered once.
      for (const p of ps) hook.set(p);
      const before = hook.info();
      for (let r = 0; r < 3; r += 1) for (const p of [...ps, ...ps.toReversed()]) hook.set(p);
      const after = hook.info();
      let maxCalls = 0;
      let maxTris = 0;
      for (let i = 0; i <= 100; i += 1) {
        const info = hook.set(i / 100);
        maxCalls = Math.max(maxCalls, info.calls);
        maxTris = Math.max(maxTris, info.triangles);
      }
      return { before, after, maxCalls, maxTris };
    });
    expect(result.after.objects).toBe(result.before.objects);
    expect(result.after.geometries).toBe(result.before.geometries);
    expect(result.after.textures).toBe(result.before.textures);
    expect(result.maxCalls).toBeLessThanOrEqual(60);
    expect(result.maxTris).toBeLessThanOrEqual(80_000);
    expect(result.before.textures).toBeLessThanOrEqual(16);
    expect(result.before.textureBytes).toBeLessThanOrEqual(80 * 1024 * 1024);
  });

  test("render loop is on demand: idle and hidden tab render nothing", async ({ page }) => {
    await spoofHardwareGpu(page);
    await page.goto("/?scene-test");
    await page.waitForFunction(() => window.darkroomTest !== undefined, null, { timeout: 20_000 });
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight * 0.3);
    });
    // Wait until the catch-up easing has settled (SwiftShader renders slowly), then expect
    // zero frames for 2 s.
    await expect
      .poll(
        async () => {
          const a = await page.evaluate(() => window.darkroomTest?.frames() ?? -1);
          await page.waitForTimeout(400);
          const b = await page.evaluate(() => window.darkroomTest?.frames() ?? -1);
          return b - a;
        },
        { timeout: 15_000 },
      )
      .toBe(0);
    const idleStart = await page.evaluate(() => window.darkroomTest?.frames() ?? -1);
    await page.waitForTimeout(2000);
    const idleEnd = await page.evaluate(() => window.darkroomTest?.frames() ?? -1);
    expect(idleEnd).toBe(idleStart);

    const scrolled = await page.evaluate(async () => {
      const start = window.darkroomTest?.frames() ?? 0;
      window.scrollBy(0, 400);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return (window.darkroomTest?.frames() ?? 0) - start;
    });
    expect(scrolled).toBeGreaterThan(0);

    const hidden = await page.evaluate(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const start = window.darkroomTest?.frames() ?? 0;
      window.scrollBy(0, 600);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return (window.darkroomTest?.frames() ?? 0) - start;
    });
    expect(hidden).toBe(0);
  });

  test("M1-AC16 Motion toggle switches full → static without reload and persists", async ({
    page,
  }) => {
    await spoofHardwareGpu(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight * 0.4);
    });
    const toggle = page.locator("[data-motion-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0, { timeout: 2000 });
    await expect(page.locator("#work .still img")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("motion"))).toBe("off");

    const urls = recordRequests(page);
    await page.reload();
    await page.waitForTimeout(4000);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    await toggle.click();
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
  });

  test("Motion toggle defaults to off under reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const toggle = page.locator("[data-motion-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).toBeDisabled();
  });
});
