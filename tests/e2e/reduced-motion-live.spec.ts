/**
 * PF-09 / M3-AC2 (+ M1-AC14, M1-AC15, M1-AC16): turning on reduced motion mid-visit stops 3D at
 * once, and reduced motion from the start never touches 3D.
 *
 * Instrumentation (init script, runs before any page script):
 * - every WebGL / WebGL2 context a canvas hands out is kept, so the test can count them and
 *   check `isContextLost()` after dispose;
 * - every draw call on those contexts is counted (the render loop "stops" = no more draws);
 * - layout shifts are summed (CLS, no input exclusion needed: the tests never type or click
 *   while measuring);
 * - a `(prefers-reduced-motion: reduce)` listener, registered before the page's own, records the
 *   state in the frame right after the switch. MediaQueryList change events fire in creation
 *   order, so the page's handler has run by the time that frame's rAF callbacks run.
 *
 * SwiftShader stands in for a GPU: the probe worker is spoofed to answer "hardware WebGL2"
 * (`spoofHardwareGpu`), which is exactly the "GPU-capable browser" case for the probe and the
 * loader. A real-GPU run of the same checks is PF-08's `reduced-motion` item.
 */
import { expect, test, type Page } from "@playwright/test";
import { isProbe, isSceneChunk, recordRequests, scrollThrough, spoofHardwareGpu } from "./helpers";

interface Probe {
  contexts: number;
  lost: number;
  draws: number;
  cls: number;
  switched: null | {
    /** State at the change event, before the page's handler ran. */
    before: { tier: string; draws: number };
    /** State in the first animation frame after the change. */
    nextFrame: {
      tier: string;
      draws: number;
      lost: number;
      contexts: number;
      canvases: number;
    };
  };
}

declare global {
  interface Window {
    pf09: () => Probe;
  }
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts: (WebGLRenderingContext | WebGL2RenderingContext)[] = [];
    let draws = 0;
    let cls = 0;
    let switched: Probe["switched"] = null;
    const lost = (): number => contexts.filter((gl) => gl.isContextLost()).length;

    const getContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
    const original: unknown = getContext?.value;
    if (typeof original === "function") {
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        ...getContext,
        value(this: HTMLCanvasElement, ...args: unknown[]): unknown {
          const ctx: unknown = Reflect.apply(original, this, args);
          if (ctx instanceof WebGLRenderingContext || ctx instanceof WebGL2RenderingContext)
            if (!contexts.includes(ctx)) contexts.push(ctx);
          return ctx;
        },
      });
    }
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype])
      for (const name of [
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
        "drawRangeElements",
      ]) {
        const d = Object.getOwnPropertyDescriptor(proto, name);
        const fn: unknown = d?.value;
        if (d && typeof fn === "function")
          Object.defineProperty(proto, name, {
            ...d,
            value(this: unknown, ...args: unknown[]): unknown {
              draws += 1;
              return Reflect.apply(fn, this, args);
            },
          });
      }

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) cls += Number(Reflect.get(entry, "value") ?? 0);
    }).observe({ type: "layout-shift", buffered: true });

    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
      if (!event.matches) return;
      const before = { tier: document.documentElement.dataset.tier ?? "", draws };
      requestAnimationFrame(() => {
        switched = {
          before,
          nextFrame: {
            tier: document.documentElement.dataset.tier ?? "",
            draws,
            lost: lost(),
            contexts: contexts.length,
            canvases: document.querySelectorAll("[data-scene] canvas").length,
          },
        };
      });
    });

    window.pf09 = () => ({ contexts: contexts.length, lost: lost(), draws, cls, switched });
  });
}

const probe = (page: Page): Promise<Probe> => page.evaluate(() => window.pf09());

async function fullTier(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 30_000 });
  await expect(page.locator("[data-scene]")).toHaveClass(/is-ready/);
}

/** The section that holds the middle of the viewport, and whether its still is on screen. */
async function currentStill(page: Page): Promise<{
  section: string;
  shown: boolean;
  loaded: boolean;
}> {
  return page.evaluate(() => {
    const mid = innerHeight / 2;
    const section = Array.from(document.querySelectorAll<HTMLElement>("main section[id]")).find(
      (s) => {
        const r = s.getBoundingClientRect();
        return r.top <= mid && r.bottom > mid;
      },
    );
    const img = section?.querySelector<HTMLImageElement>(".still img");
    if (!section || !img) return { section: section?.id ?? "", shown: false, loaded: false };
    const r = img.getBoundingClientRect();
    const style = getComputedStyle(img);
    let visible = style.visibility === "visible";
    for (let n: Element | null = img; n && visible; n = n.parentElement)
      if (getComputedStyle(n).display === "none" || Number(getComputedStyle(n).opacity) === 0)
        visible = false;
    return {
      section: section.id,
      shown: visible && r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0,
      loaded: img.complete && img.naturalWidth > 0,
    };
  });
}

async function scrollToP(page: Page, p: number): Promise<void> {
  await page.evaluate((target) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: target * max, behavior: "instant" });
  }, p);
  // Let the on-demand loop catch up and stop (idle budget 1.5 s).
  await expect
    .poll(
      async () => {
        const a = (await probe(page)).draws;
        await page.waitForTimeout(400);
        return (await probe(page)).draws - a;
      },
      { timeout: 15_000 },
    )
    .toBe(0);
}

test.describe("PF-09 reduced motion switched on mid-visit (M3-AC2)", () => {
  for (const p of [0.21, 0.6]) {
    test(`at p = ${p}: scene disposed within 1 frame, still shown, no more draws or 3D requests`, async ({
      page,
    }) => {
      await instrument(page);
      await spoofHardwareGpu(page);
      await page.goto("/");
      await fullTier(page);
      await scrollToP(page, p);
      const urls = recordRequests(page);
      const live = await probe(page);
      expect(live.contexts, "one WebGL context while the scene is live").toBe(1);
      expect(live.lost).toBe(0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(async () => (await probe(page)).switched).not.toBeNull();
      const { switched } = await probe(page);
      test.info().annotations.push({ type: "switch", description: JSON.stringify(switched) });
      // Frame 0 is the change event itself: the scene was still live just before it.
      expect(switched?.before.tier).toBe("full");
      // Frame 1: static tier, the context is gone, nothing new was drawn.
      expect(switched?.nextFrame.tier).toBe("static");
      expect(switched?.nextFrame.lost, "WebGL context lost (disposed) by the next frame").toBe(1);
      expect(switched?.nextFrame.draws, "no draw call after the switch").toBe(
        switched?.before.draws,
      );

      // The current section's still is shown (and its image arrives).
      const still = await currentStill(page);
      expect(still.shown, `still of #${still.section} on screen`).toBe(true);
      await expect.poll(async () => (await currentStill(page)).loaded).toBe(true);
      await expect(page.locator("[data-scene] canvas")).toHaveCount(0, { timeout: 3000 });

      // The render loop stays stopped and nothing 3D is requested again, even while scrolling.
      const drawsAfter = (await probe(page)).draws;
      await scrollThrough(page);
      await page.waitForTimeout(1000);
      expect((await probe(page)).draws).toBe(drawsAfter);
      expect(urls.filter(isSceneChunk), "scene chunk requests after the switch").toEqual([]);
      expect(urls.filter(isProbe), "probe requests after the switch").toEqual([]);
      expect((await probe(page)).contexts, "no new WebGL context").toBe(1);
      await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    });
  }

  test("switched on while the scene chunk is still loading: 3D never mounts", async ({ page }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    // Hold the scene chunk until reduced motion is on.
    const gate = Promise.withResolvers<undefined>();
    const held = gate.promise;
    let requested = false;
    await page.route(/\/_astro\/stage\.[\w-]+\.js/, async (route) => {
      requested = true;
      await held;
      await route.continue();
    });
    await page.goto("/");
    await expect.poll(() => requested, { timeout: 30_000 }).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    gate.resolve(undefined);
    await page.waitForTimeout(3000);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0);
    expect((await probe(page)).contexts, "no WebGL context").toBe(0);
  });

  test("switched on while the scene is compiling: it backs out and leaves no context", async ({
    page,
  }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    // Switch the moment the stage's WebGL context exists, i.e. inside mountStage (shader compile).
    await page.exposeFunction("pf09ContextCreated", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
    });
    await page.addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
      const original: unknown = d?.value;
      if (typeof original !== "function") return;
      let fired = false;
      Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
        ...d,
        value(this: HTMLCanvasElement, ...args: unknown[]): unknown {
          const ctx: unknown = Reflect.apply(original, this, args);
          if (!fired && String(args[0]).startsWith("webgl")) {
            fired = true;
            const notify: unknown = Reflect.get(window, "pf09ContextCreated");
            if (typeof notify === "function") void Reflect.apply(notify, window, []);
          }
          return ctx;
        },
      });
    });
    await page.goto("/");
    await expect.poll(async () => (await probe(page)).contexts, { timeout: 30_000 }).toBe(1);
    await page.waitForTimeout(3000);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0);
    await expect(page.locator("[data-scene]")).not.toHaveClass(/is-ready/);
    const after = await probe(page);
    expect(after.lost, "the half-mounted scene was disposed").toBe(after.contexts);
    const draws = after.draws;
    await scrollThrough(page);
    expect((await probe(page)).draws, "no rendering after backing out").toBe(draws);
  });
});

test.describe("PF-09 reduced motion from the start (M3-AC2, F1, M1-AC14 regression)", () => {
  test("GPU-capable browser: 0 bytes of 3D code, no probe, no WebGL context", async ({ page }) => {
    await instrument(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await spoofHardwareGpu(page);
    const urls = recordRequests(page);
    const bytes = new Map<string, number>();
    page.on("response", async (response) => {
      if (!isSceneChunk(response.url()) && !isProbe(response.url())) return;
      bytes.set(response.url(), (await response.body().catch(() => Buffer.alloc(0))).length);
    });
    await page.goto("/");
    await page.waitForLoadState("load");
    await page.waitForTimeout(4000);
    await page.mouse.click(200, 200);
    await scrollThrough(page);
    await page.waitForTimeout(2000);
    expect(urls.filter(isSceneChunk), "scene chunk requests").toEqual([]);
    expect(urls.filter(isProbe), "probe requests").toEqual([]);
    expect(
      [...bytes.values()].reduce((a, b) => a + b, 0),
      "3D/probe bytes",
    ).toBe(0);
    // Nothing of the scene's JS is even referenced by the page: no modulepreload of the chunk.
    expect(
      await page.locator('link[rel="modulepreload"][href*="stage."]').count(),
      "modulepreload of the scene chunk",
    ).toBe(0);
    const p = await probe(page);
    expect(p.contexts, "WebGL contexts").toBe(0);
    expect(p.draws).toBe(0);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
  });
});

test.describe("PF-09 switching back (M1-AC16)", () => {
  test("Motion off (persisted): switching back to no-preference does not start 3D", async ({
    page,
  }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    await page.addInitScript(() => {
      localStorage.setItem("motion", "off");
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("load");
    await page.waitForTimeout(3000);
    const urls = recordRequests(page);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.mouse.click(200, 200);
    await scrollThrough(page);
    await page.waitForTimeout(3000);
    expect(urls.filter(isSceneChunk)).toEqual([]);
    expect(urls.filter(isProbe)).toEqual([]);
    expect((await probe(page)).contexts).toBe(0);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-motion-toggle]")).toHaveAttribute("aria-pressed", "false");
    expect(await page.evaluate(() => localStorage.getItem("motion"))).toBe("off");
  });

  test("Motion on: switching back resumes 3D; the persisted choice is untouched", async ({
    page,
  }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    await page.addInitScript(() => {
      localStorage.setItem("motion", "on");
    });
    await page.goto("/");
    await fullTier(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-motion-toggle]")).toBeDisabled();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await fullTier(page);
    await expect(page.locator("[data-scene] canvas")).toHaveCount(1, { timeout: 3000 });
    expect(await page.evaluate(() => localStorage.getItem("motion"))).toBe("on");
  });
});

test.describe("PF-09 no layout shift (M1-AC15)", () => {
  test("full → reduced motion → back: CLS ≤ 0.02 across the switches", async ({ page }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    await page.goto("/");
    await fullTier(page);
    await scrollToP(page, 0.41);
    const before = (await probe(page)).cls;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect.poll(async () => (await currentStill(page)).loaded).toBe(true);
    await page.waitForTimeout(1000);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await fullTier(page);
    await page.waitForTimeout(1500);
    const after = await probe(page);
    test.info().annotations.push({
      type: "cls",
      description: `whole visit ${after.cls.toFixed(4)}, switches only ${(after.cls - before).toFixed(4)}`,
    });
    expect(after.cls - before, "CLS added by the switches").toBeLessThanOrEqual(0.02);
    expect(after.cls, "CLS of the whole visit").toBeLessThanOrEqual(0.02);
  });
});
