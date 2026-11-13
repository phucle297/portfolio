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
import {
  chromium,
  expect,
  firefox,
  test,
  webkit,
  type BrowserType,
  type Page,
} from "@playwright/test";
import sharp from "sharp";
import { isProbe, isSceneChunk, recordRequests, scrollThrough, spoofHardwareGpu } from "./helpers";

/**
 * One animation frame after the switch (PF-09 AC1, PM ruling 2026-11-14), sampled in the page.
 * `cover` is what paints the viewport where the scene was: the live `scene` (a canvas whose WebGL
 * context is not lost, so it still holds its last frame), the current section's `still`, an
 * `other-still:<section>` (a decoded still of another section), the `section-bg` (an opaque
 * background on the current section or its ancestors below `body`), or `bare` (none of these: the
 * page/body background or a transparent hole). The stills and the scene are viewport-fixed and
 * cover the whole viewport, so one classification per frame covers every point.
 */
interface Frame {
  /** ms since the change event. */
  t: number;
  cover: string;
  still: { section: string; shown: boolean; loaded: boolean };
}

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
      /** The scene host still has `is-ready` (the canvas is faded in). */
      sceneReady: boolean;
    };
  };
  /** Every frame from the switch until the current still is shown and loaded (+2 frames, ≤ 3 s). */
  frames: Frame[];
  /** ms from the switch to the first frame with the current section's still shown and loaded. */
  stillAfter: number | null;
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

    const frames: Frame[] = [];
    let stillAfter: number | null = null;
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs inside the init script
    const painted = (el: Element): boolean => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        )
          return false;
      }
      return true;
    };
    // Same rule as `currentStill()` below (kept in the page so every frame can be sampled).
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs inside the init script
    const sectionAtMiddle = (): HTMLElement | undefined =>
      Array.from(document.querySelectorAll<HTMLElement>("main section[id]")).find((s) => {
        const r = s.getBoundingClientRect();
        return r.top <= innerHeight / 2 && r.bottom > innerHeight / 2;
      });
    const stillOf = (section: HTMLElement | undefined): Frame["still"] => {
      const img = section?.querySelector<HTMLImageElement>(".still img");
      if (!section || !img) return { section: section?.id ?? "", shown: false, loaded: false };
      const r = img.getBoundingClientRect();
      return {
        section: section.id,
        shown: painted(img) && r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0,
        loaded: img.complete && img.naturalWidth > 0,
      };
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs inside the init script
    const opaque = (color: string): boolean => {
      const m = /rgba?\(([^)]+)\)/.exec(color);
      if (!m) return false;
      const parts = (m[1] ?? "").split(/[\s,/]+/).filter(Boolean);
      return parts.length < 4 || Number(parts[3]) >= 0.99;
    };
    const coverOf = (section: HTMLElement | undefined): string => {
      const canvas = document.querySelector<HTMLCanvasElement>("[data-scene] canvas");
      const gl = canvas ? contexts.find((c) => c.canvas === canvas) : undefined;
      if (canvas && gl && !gl.isContextLost() && painted(canvas)) return "scene";
      for (const img of document.querySelectorAll<HTMLImageElement>("[data-still] img")) {
        if (!img.complete || img.naturalWidth === 0 || !painted(img)) continue;
        const id = img.closest("section[id]")?.id ?? "";
        return id === section?.id ? "still" : `other-still:${id}`;
      }
      for (let n: Element | null = section ?? null; n && n !== document.body; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (style.backgroundImage !== "none" || opaque(style.backgroundColor)) return "section-bg";
      }
      return "bare";
    };

    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (event) => {
      if (!event.matches) return;
      const switchAt = performance.now();
      let extra = 0;
      const sample = (): void => {
        const t = performance.now() - switchAt;
        const section = sectionAtMiddle();
        const still = stillOf(section);
        frames.push({ t, cover: coverOf(section), still });
        if (still.shown && still.loaded) {
          stillAfter ??= t;
          extra += 1;
        }
        if (extra <= 2 && t < 3000) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
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
            sceneReady:
              document.querySelector("[data-scene]")?.classList.contains("is-ready") ?? false,
          },
        };
      });
    });

    window.pf09 = () => ({
      contexts: contexts.length,
      lost: lost(),
      draws,
      cls,
      switched,
      frames,
      stillAfter,
    });
  });
}

const probe = (page: Page): Promise<Probe> => page.evaluate(() => window.pf09());

/** Poster still images (desktop `d-N`, mobile `m-N`). */
const isStillImage = (url: string): boolean => /\/_astro\/[dm]-\d+\./.test(url);

/** AC1 budget (PM ship-first bar, 2026-11-14): the current section's still is visible and fully
 * loaded within about 1 s of the switch. A first-frame still is tracked separately (PF-43). */
const STILL_BUDGET_MS = 1000;

/** Mean Rec. 709 luma (0-255) of a screenshot, averaged over a 48 × 30 grid. */
async function luma(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .resize(48, 30, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i + 2 < data.length; i += 3)
    sum += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
  return sum / (info.width * info.height);
}

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
      // While 3D runs (full tier) no still image is fetched: no preload bytes (AC1).
      const whileLive = recordRequests(page);
      await scrollToP(page, p);
      const urls = recordRequests(page);
      expect(whileLive.filter(isStillImage), "still images requested while 3D runs").toEqual([]);
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
      expect(
        switched?.nextFrame.sceneReady,
        "scene hidden (is-ready removed) by the next frame",
      ).toBe(false);

      // The current section's still is shown once its image has arrived and decoded (a still only
      // takes over when it can be painted; at p = 0.6 the lazy Services image is fetched only now).
      // AC1: within STILL_BUDGET_MS (about 1 s) of the switch, timed in the page from the change event to the first
      // frame where it is shown and loaded. Until then no frame is bare (see `Frame`).
      await expect
        .poll(async () => (await probe(page)).stillAfter, {
          message: "the current section's still on screen, image loaded",
          timeout: 3000,
        })
        .not.toBeNull();
      const { frames, stillAfter } = await probe(page);
      test.info().annotations.push({
        type: "still",
        description: `after ${stillAfter?.toFixed(0)} ms; covers ${[...new Set(frames.map((f) => f.cover))].join(", ")}`,
      });
      expect(stillAfter, "ms from the switch to the still shown and loaded").toBeLessThanOrEqual(
        STILL_BUDGET_MS,
      );
      expect(
        frames.filter((f) => f.cover === "bare"),
        "frames with nothing over the page background",
      ).toEqual([]);
      expect(await currentStill(page)).toMatchObject({ shown: true, loaded: true });
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

  test("switched on while the scene mounts (atlas fonts loading): 3D backs out, never shows", async ({
    page,
  }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    // Deterministic window inside mountStage(): the island's first await is loading its print
    // fonts (Anton is loaded only by the island). Hold that load until reduced motion is on.
    await page.exposeFunction("pf09FontsRequested", async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
    });
    await page.addInitScript(() => {
      const d = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, "load");
      const original: unknown = d?.value;
      if (typeof original !== "function") return;
      let held = false;
      Object.defineProperty(FontFaceSet.prototype, "load", {
        ...d,
        value(this: FontFaceSet, ...args: unknown[]): unknown {
          const loaded: unknown = Reflect.apply(original, this, args);
          const notify: unknown = Reflect.get(window, "pf09FontsRequested");
          if (held || !String(args[0]).includes("Anton") || typeof notify !== "function")
            return loaded;
          held = true;
          // Resolves only after the test has switched the preference.
          return Promise.all([loaded, Reflect.apply(notify, window, [])]).then(([fonts]) => fonts);
        },
      });
    });
    await page.goto("/");
    await expect.poll(async () => (await probe(page)).switched, { timeout: 30_000 }).not.toBeNull();
    await page.waitForTimeout(3000);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    await expect(page.locator("[data-scene] canvas")).toHaveCount(0);
    await expect(page.locator("[data-scene]")).not.toHaveClass(/is-ready/);
    const after = await probe(page);
    expect(after.lost, "any context the half-mounted scene made is disposed").toBe(after.contexts);
    const draws = after.draws;
    await scrollThrough(page);
    await page.waitForTimeout(500);
    expect((await probe(page)).draws, "no rendering after backing out").toBe(draws);
  });

  test("switched on as the scene's WebGL context is created: no context or fade-in left", async ({
    page,
  }) => {
    await instrument(page);
    await spoofHardwareGpu(page);
    // Switch the moment the stage's WebGL context exists (shader compile or just after mount).
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

/**
 * QA gate on PR #29 (Medium, Firefox and WebKit): at Services (p = 0.6) a mid-visit switch to
 * reduced motion left the Hello still on screen. On the full tier the stills are `display: none`,
 * so the cross-fade's decode of the Services still failed while the scene was live and nothing
 * retried it when the tier became static. This test launches each engine itself (the suite's
 * runner config is Chromium-only), so the regression is covered in all three.
 */
const ENGINES: readonly BrowserType[] = [chromium, firefox, webkit];

function launch(engine: BrowserType): ReturnType<BrowserType["launch"]> {
  return engine.launch(
    // Explicit options for every engine: under the test runner, launch() merges the config's
    // `launchOptions` (CHROME_PATH as executablePath, Chrome-only args) into whatever is passed,
    // so Firefox and WebKit set their own binary and no args (else they start Chrome or reject
    // the flags).
    engine === chromium
      ? {
          ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
          args: [
            "--enable-unsafe-swiftshader",
            "--use-angle=swiftshader",
            "--ignore-gpu-blocklist",
          ],
        }
      : { executablePath: engine.executablePath(), args: [] },
  );
}

test.describe("PF-09 the current section's still after a mid-visit switch, every engine", () => {
  for (const engine of ENGINES) {
    test(`${engine.name()}: at p = 0.6 the Services still is picked, decoded and shown`, async ({
      baseURL,
    }) => {
      const browser = await launch(engine);
      try {
        const context = await browser.newContext({
          ...(baseURL === undefined ? {} : { baseURL }),
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        await instrument(page);
        await spoofHardwareGpu(page);
        await page.goto("/");
        await fullTier(page);
        await scrollToP(page, 0.6);
        const services = await page.evaluate(
          () => document.querySelector<HTMLElement>("#services [data-still]")?.dataset.still ?? "",
        );
        expect(services, "the Services section has a still").not.toBe("");

        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
        // No scroll after the switch: the still must follow the tier change by itself.
        await expect(page.locator("html")).toHaveAttribute("data-still-active", services, {
          timeout: 5000,
        });
        await expect
          .poll(async () => currentStill(page), { timeout: 5000 })
          .toEqual({ section: "services", shown: true, loaded: true });
        // And only that still is shown (not the Hello still over or under it).
        const shown = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-still].is-shown")).map(
            (el) => el.dataset.still,
          ),
        );
        expect(shown).toEqual([services]);
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }
});

/**
 * AC1 (PM ruling 2026-11-14): until the still appears, no blank frame and no luminance flash, and
 * no still bytes are fetched while 3D runs. Method, per engine:
 * - The Services still's image response is held until a screenshot of the gap is taken, so the
 *   gap between the switch and the still is long enough to observe on every engine (it is only
 *   ~50-150 ms unheld). The STILL_BUDGET_MS budget is checked unheld, in the tests above.
 * - Every animation frame from the switch on is classified in the page (`Frame.cover`): no frame
 *   may be `bare` (page/body background or a transparent hole where the scene was).
 * - Luminance: mean luma of a downscaled screenshot just before the switch (the live scene's
 *   last frame), during the held gap, and once the still is shown. The gap must stay within
 *   ±LUMA_TOLERANCE of the range spanned by the before and after frames (a flash to white or a
 *   drop to black falls outside it). Screenshots are the composited pixels, so this also covers
 *   what the in-page classification cannot see.
 */
const LUMA_TOLERANCE = 12;

test.describe("PF-09 no blank frame or flash while the still loads, every engine", () => {
  for (const engine of ENGINES) {
    test(`${engine.name()}: at p = 0.6 the gap until the Services still is covered, no flash, no preload`, async ({
      baseURL,
    }) => {
      const browser = await launch(engine);
      try {
        const context = await browser.newContext({
          ...(baseURL === undefined ? {} : { baseURL }),
          viewport: { width: 1440, height: 900 },
        });
        const page = await context.newPage();
        await instrument(page);
        await spoofHardwareGpu(page);
        await page.goto("/");
        await fullTier(page);
        const whileLive = recordRequests(page);
        await scrollToP(page, 0.6);
        const index = await page.evaluate(
          () => document.querySelector<HTMLElement>("#services [data-still]")?.dataset.still ?? "",
        );
        expect(index, "the Services section has a still").not.toBe("");
        expect(whileLive.filter(isStillImage), "still images requested while 3D runs").toEqual([]);

        const hold = Promise.withResolvers<undefined>();
        await page.route(new RegExp(`/_astro/[dm]-${index}\\.`), async (route) => {
          await hold.promise;
          await route.continue();
        });
        const before = await page.screenshot();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
        await page.waitForTimeout(100);
        const gap = await page.screenshot();
        hold.resolve(undefined);
        await expect
          .poll(async () => (await probe(page)).stillAfter, { timeout: 5000 })
          .not.toBeNull();
        await expect
          .poll(async () => currentStill(page), { timeout: 5000 })
          .toEqual({ section: "services", shown: true, loaded: true });
        const after = await page.screenshot();

        const { frames } = await probe(page);
        const [b, g, a] = await Promise.all([luma(before), luma(gap), luma(after)]);
        test.info().annotations.push({
          type: "gap",
          description: `luma before ${b.toFixed(1)}, gap ${g.toFixed(1)}, after ${a.toFixed(1)}; ${frames.length} frames, covers ${[...new Set(frames.map((f) => f.cover))].join(", ")}`,
        });
        expect(frames.length, "frames sampled from the switch").toBeGreaterThan(0);
        expect(
          frames.filter((f) => f.cover === "bare"),
          "frames with nothing over the page background",
        ).toEqual([]);
        expect(g, "gap luma not below the before/after range").toBeGreaterThanOrEqual(
          Math.min(b, a) - LUMA_TOLERANCE,
        );
        expect(g, "gap luma not above the before/after range").toBeLessThanOrEqual(
          Math.max(b, a) + LUMA_TOLERANCE,
        );
        await context.close();
      } finally {
        await browser.close();
      }
    });
  }
});
