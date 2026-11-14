/**
 * PF-02 (M3-AC1, §3 Posters, M1-AC15): the static tier shows the right still for every section on
 * every device, cross-fades between them in 320 ms without ever going darker than the darker
 * still, stays instant under reduced motion, and keeps the first still as the eager LCP image.
 *
 * The static tier is forced by answering the hardware-WebGL probe with `false` (what a machine
 * without hardware WebGL gets). Runner setup stays in this spec.
 *
 * Reviewer side-by-side: set SIDE_BY_SIDE_DIR (and FALLBACK_POSTER / MOBILE_FULL to the mockups)
 * to also write the comparison images; that test is skipped otherwise.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import sharp from "sharp";
import {
  assertExactPreloadCandidate,
  normalizeAssetUrl,
  parseSrcset,
  preloadPickedCandidate,
} from "./preload-candidate";

const SECTIONS = ["hello", "journey", "work", "services", "process", "contact"] as const;
const COPY_HIDDEN = `.home-section__body, body > header, body > footer, .rail, .home-scrim, .skip-link
  { visibility: hidden !important; }`;
const KB = 1024;

async function staticPage(
  browser: Browser,
  options: BrowserContextOptions & { javaScriptEnabled?: boolean } = {},
): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  await page.route(/probe\.worker/u, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "postMessage(false);" }),
  );
  await page.goto("/");
  await page.waitForLoadState("load");
  return page;
}

/** Scroll so the middle of section `index` is in the middle of the viewport. */
async function scrollToSection(page: Page, index: number): Promise<void> {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    const rect = el.getBoundingClientRect();
    const y = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, y), behavior: "instant" });
  }, SECTIONS[index] ?? "");
}

/** Desktop/tablet: wait until still `index` is the shown one and no fade is running. */
async function settledOn(page: Page, index: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          `${document.documentElement.dataset.stillActive ?? ""}:${document.querySelectorAll(".still.is-fading").length}`,
      ),
    )
    .toBe(`${index}:0`);
}

interface ShownStill {
  index: string;
  opacity: string;
  src: string;
  loaded: boolean;
  covers: boolean;
  others: string[];
}

const shownStill = (page: Page): Promise<ShownStill[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".still"))
      .filter((still) => {
        const picture = still.querySelector("picture");
        return (
          picture !== null &&
          getComputedStyle(picture).opacity === "1" &&
          getComputedStyle(picture).display !== "none"
        );
      })
      .map((still) => {
        const picture = still.querySelector("picture");
        const img = still.querySelector("img");
        const rect = picture?.getBoundingClientRect();
        return {
          index: still.dataset.still ?? "",
          opacity: picture ? getComputedStyle(picture).opacity : "",
          src: img?.currentSrc ?? "",
          loaded: img !== null && img.complete && img.naturalWidth > 0,
          covers:
            rect !== undefined &&
            rect.top <= 0 &&
            rect.left <= 0 &&
            rect.bottom >= window.innerHeight &&
            rect.right >= window.innerWidth,
          others: [],
        };
      }),
  );

async function grey(png: Buffer): Promise<Buffer> {
  return sharp(png).resize(360).greyscale().raw().toBuffer();
}

const tile = (png: Buffer): Promise<Buffer> => sharp(png).resize(720, 450).png().toBuffer();

const mean = (buf: Buffer): number => buf.reduce((sum, v) => sum + v, 0) / buf.length;

test.describe("PF-02 static tier: desktop and tablet", () => {
  for (const viewport of [
    { name: "desktop static 1440×900", width: 1440, height: 900 },
    { name: "tablet 768×1024", width: 768, height: 1024 },
  ]) {
    test(`${viewport.name}: each section shows its own key-state still, full viewport`, async ({
      browser,
      browserName,
    }) => {
      // Architect ruling (PF-05 attempt 5): intermittent on Playwright WebKit, no retries.
      test.skip(browserName === "webkit", "Flaky on WebKit, tracked in PF-45");
      const page = await staticPage(browser, { viewport });
      await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
      for (const [index] of SECTIONS.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        await scrollToSection(page, index);
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        await settledOn(page, index);
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        const shown = await shownStill(page);
        expect(shown, `section ${index}`).toHaveLength(1);
        expect(shown[0]).toMatchObject({ index: String(index), loaded: true, covers: true });
        expect(shown[0]?.src).toMatch(new RegExp(`/d-${index}\\.[^/]*\\.avif`, "u"));
      }
      await page.context().close();
    });
  }
});

test.describe("PF-02 static tier: phones", () => {
  for (const viewport of [
    { name: "390×844", width: 390, height: 844 },
    { name: "360×740", width: 360, height: 740 },
  ]) {
    test(`${viewport.name}: portrait intro still, then a 390×240 band still per section`, async ({
      browser,
    }) => {
      const page = await staticPage(browser, { viewport, hasTouch: true, isMobile: true });
      await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
      for (const [index, id] of SECTIONS.entries()) {
        const img = page.locator(`#${id} .still img`);
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        await img.scrollIntoViewIfNeeded();
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        await expect
          .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
          .toBe(true);
        // oxlint-disable-next-line no-await-in-loop -- one section after another, by design
        const info = await img.evaluate((el: HTMLImageElement) => {
          const rect = el.getBoundingClientRect();
          const picture = el.closest("picture");
          return {
            src: el.currentSrc,
            ratio: rect.width / rect.height,
            width: rect.width,
            visible:
              picture !== null &&
              getComputedStyle(picture).display !== "none" &&
              getComputedStyle(picture).opacity === "1",
          };
        });
        expect(info.src, `section ${index}`).toMatch(new RegExp(`/m-${index}\\.[^/]*\\.avif`, "u"));
        expect(info.visible).toBe(true);
        expect(info.width).toBeCloseTo(viewport.width, 0);
        expect(info.ratio).toBeCloseTo(index === 0 ? 390 / 1010 : 390 / 240, 2);
      }
      await page.context().close();
    });
  }
});

declare global {
  interface Window {
    /** Set by the spec: each still fade's Web Animation, with its start and finish times. */
    stillFades?: { animation: Animation; start: number; end?: number }[];
    /** When true, the spec pauses each still fade as soon as it starts. */
    pauseStillFades?: boolean;
  }
}

/** Record (and optionally pause) the stills' Web Animations, via Element.prototype.animate. */
async function recordFades(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original: unknown = Object.getOwnPropertyDescriptor(Element.prototype, "animate")?.value;
    if (typeof original !== "function") return;
    window.stillFades = [];
    Element.prototype.animate = function animate(
      this: Element,
      ...args: Parameters<Element["animate"]>
    ): Animation {
      const result: unknown = Reflect.apply(original, this, args);
      if (!(result instanceof Animation))
        throw new TypeError("Element.animate returned no Animation");
      const animation = result;
      if (this.tagName === "PICTURE" && this.closest(".still")) {
        const entry: { animation: Animation; start: number; end?: number } = {
          animation,
          start: performance.now(),
        };
        window.stillFades?.push(entry);
        if (window.pauseStillFades === true) animation.pause();
        void animation.finished.then(
          () => {
            entry.end = performance.now();
            return entry.end;
          },
          () => undefined,
        );
      }
      return animation;
    };
  });
}

test.describe("PF-02 cross-fade", () => {
  test("effect duration is 320 ms, and no frame is darker than the darker of the two stills, both ways", async ({
    browser,
    browserName,
  }) => {
    // Architect ruling (PF-05 attempt 5): intermittent on Playwright WebKit, no retries.
    test.skip(browserName === "webkit", "Flaky on WebKit, tracked in PF-45");
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await recordFades(page);
    await page.route(/probe\.worker/u, (route) =>
      route.fulfill({ contentType: "text/javascript", body: "postMessage(false);" }),
    );
    await page.goto("/");
    await page.waitForLoadState("load");
    await expect(page.locator("html")).toHaveClass(/motion-ok/u);
    await page.addStyleTag({ content: COPY_HIDDEN });
    const steady = async (index: number): Promise<Buffer> => {
      await scrollToSection(page, index);
      await settledOn(page, index);
      return grey(await page.screenshot());
    };
    const a = await steady(1);
    const b = await steady(2);
    const darker = Buffer.from(a.map((v, k) => Math.min(v, b[k] ?? 0)));

    for (const [from, to, label] of [
      [1, 2, "down (1 → 2)"],
      [2, 1, "up (2 → 1)"],
    ] as const) {
      // Real time: one fade, from its start to its finish.
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await steady(from);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await page.evaluate(() => {
        window.stillFades = [];
        window.pauseStillFades = false;
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await scrollToSection(page, to);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await settledOn(page, to);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const fades = await page.evaluate(() =>
        (window.stillFades ?? []).map((f) => ({
          ms: (f.end ?? Number.NaN) - f.start,
          duration: Number(f.animation.effect?.getComputedTiming().duration ?? 0),
        })),
      );
      expect(fades, `${label}: exactly one fade`).toHaveLength(1);
      // The contract is the WAAPI effect duration, not wall-clock time (which drifts under load).
      expect(fades[0]?.duration, `${label}: effect duration`).toBe(320);
      const real = fades[0]?.ms ?? Number.NaN;
      expect(Number.isFinite(real), `${label}: fade completed`).toBe(true);
      // Hang guard only: under load the fade can take longer than 320 ms, but it must end.
      expect(real, `${label}: hang guard ${real.toFixed(0)} ms`).toBeLessThanOrEqual(1000);

      // Frames: pause the same fade as it starts and step through it.
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await steady(from);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await page.evaluate(() => {
        window.stillFades = [];
        window.pauseStillFades = true;
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await scrollToSection(page, to);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await page.waitForFunction(() => (window.stillFades ?? []).length === 1);
      for (const t of [0, 64, 128, 160, 192, 256, 319]) {
        // oxlint-disable-next-line no-await-in-loop -- one frame at a time
        await page.evaluate((time) => {
          const fade = window.stillFades?.[0];
          if (fade) fade.animation.currentTime = time;
        }, t);
        // oxlint-disable-next-line no-await-in-loop -- one frame at a time
        const frame = await grey(await page.screenshot());
        let below = 0;
        let worst = 0;
        for (const [k, v] of frame.entries()) {
          const gap = (darker[k] ?? 0) - v;
          if (gap > 2) below += 1;
          worst = Math.max(worst, gap);
        }
        expect(below, `${label} t=${t} ms: pixels darker than both stills (worst ${worst})`).toBe(
          0,
        );
        expect(mean(frame)).toBeGreaterThanOrEqual(Math.min(mean(a), mean(b)) - 0.5);
      }
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await page.evaluate(() => {
        window.pauseStillFades = false;
        window.stillFades?.[0]?.animation.finish();
      });
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await settledOn(page, to);
    }
    await context.close();
  });

  test("reduced motion: the still changes instantly, no fade runs", async ({
    browser,
    browserName,
  }) => {
    // Architect ruling (PF-05 attempt 5): intermittent on Playwright WebKit, no retries.
    test.skip(browserName === "webkit", "Flaky on WebKit, tracked in PF-45");
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await recordFades(page);
    await page.route(/probe\.worker/u, (route) =>
      route.fulfill({ contentType: "text/javascript", body: "postMessage(false);" }),
    );
    await page.goto("/");
    await settledOn(page, 0);
    for (const index of [1, 2, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await scrollToSection(page, index);
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await settledOn(page, index);
      // Same task as the class change: no transition or animation in between.
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const shown = await shownStill(page);
      expect(shown.map((s) => s.index)).toEqual([String(index)]);
    }
    expect(await page.evaluate(() => (window.stillFades ?? []).length)).toBe(0);
    await context.close();
  });
});

test.describe("PF-02 poster budget and LCP", () => {
  test("every shipped still is ≤ 60 KB (desktop) / ≤ 25 KB (mobile) AVIF", () => {
    const dir = join(process.cwd(), "dist", "_astro");
    const stills = readdirSync(dir).filter((f) => /^[dm]-\d\..*\.avif$/u.test(f));
    expect(stills.filter((f) => f.startsWith("d-")).length).toBeGreaterThanOrEqual(6);
    expect(stills.filter((f) => f.startsWith("m-")).length).toBeGreaterThanOrEqual(6);
    for (const f of stills) {
      const size = statSync(join(dir, f)).size;
      expect(size, `${f}: ${(size / KB).toFixed(1)} KB`).toBeLessThanOrEqual(
        (f.startsWith("d-") ? 60 : 25) * KB,
      );
    }
  });

  for (const viewport of [
    { name: "desktop static", width: 1440, height: 900 },
    { name: "phone", width: 390, height: 844 },
  ]) {
    test(`${viewport.name}: the first still is the eager, high-priority, first-fetched LCP candidate; the rest are lazy`, async ({
      browser,
    }) => {
      const page = await staticPage(browser, { viewport });
      const attrs = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLImageElement>(".still img")).map((img) => ({
          loading: img.loading,
          priority: img.getAttribute("fetchpriority"),
        })),
      );
      expect(attrs[0]).toEqual({ loading: "eager", priority: "high" });
      for (const rest of attrs.slice(1)) expect(rest.loading).toBe("lazy");
      // Requested at high priority right away: before the load event, ahead of every other still.
      const timing = await page.evaluate(() => {
        const srcs = Array.from(
          document.querySelectorAll<HTMLImageElement>(".still img"),
          (img) => img.currentSrc,
        );
        const starts = srcs.map(
          (src) => performance.getEntriesByName(src)[0]?.startTime ?? Number.POSITIVE_INFINITY,
        );
        const nav = performance.getEntriesByType("navigation")[0];
        const loadEvent = nav instanceof PerformanceNavigationTiming ? nav.loadEventStart : 0;
        const first = starts[0] ?? Number.POSITIVE_INFINITY;
        // PF-52: count same-ms ties so a competing still is not treated as "after" the first.
        const othersBefore = srcs.filter((_, i) => i > 0 && (starts[i] ?? 0) <= first);
        return { first, loadEvent, othersBefore };
      });
      expect(timing.first).toBeLessThan(timing.loadEvent);
      expect(timing.othersBefore).toEqual([]);
      // The head preload for this viewport must be the exact candidate shown (PF-56).
      const preloadMatch = await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>(".still img");
        const currentSrc = img?.currentSrc ?? "";
        const shownRaw = currentSrc === "" ? (img?.src ?? "") : currentSrc;
        const active = Array.from(
          document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]'),
        ).find((link) => link.media === "" || matchMedia(link.media).matches);
        const resources = performance.getEntriesByType("resource").flatMap((entry) => {
          if (!(entry instanceof PerformanceResourceTiming)) return [];
          return [
            {
              name: entry.name,
              initiatorType: entry.initiatorType,
              startTime: entry.startTime,
            },
          ];
        });
        if (active === undefined) {
          return {
            base: document.baseURI,
            shownRaw,
            href: "",
            srcset: "",
            resources,
          };
        }
        const href = active.getAttribute("href") ?? "";
        const srcset =
          active.imageSrcset !== ""
            ? active.imageSrcset
            : (active.getAttribute("imagesrcset") ?? "");
        return {
          base: document.baseURI,
          shownRaw,
          href,
          srcset,
          resources,
        };
      });
      const shown = normalizeAssetUrl(preloadMatch.shownRaw, preloadMatch.base);
      const hrefFromLink = normalizeAssetUrl(preloadMatch.href, preloadMatch.base);
      const candidates = parseSrcset(preloadMatch.srcset, preloadMatch.base);
      const picked = preloadPickedCandidate({
        href: hrefFromLink,
        candidateUrls: candidates.map((c) => c.url),
        resources: preloadMatch.resources,
      });
      expect(shown).not.toBe("");
      assertExactPreloadCandidate(shown, picked);
      // Painted in the first viewport (an LCP candidate, not hidden or transparent).
      const painted = await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>(".still img");
        const picture = img?.closest("picture");
        const rect = img?.getBoundingClientRect();
        return (
          img !== null &&
          img !== undefined &&
          img.complete &&
          img.naturalWidth > 0 &&
          picture !== null &&
          picture !== undefined &&
          getComputedStyle(picture).display !== "none" &&
          getComputedStyle(picture).opacity === "1" &&
          rect !== undefined &&
          rect.top < window.innerHeight &&
          rect.height > 0
        );
      });
      expect(painted).toBe(true);
      // Report which element the browser picked as LCP (text can win over the dimmed still).
      const lcp = await page.evaluate(
        () =>
          new Promise<string>((resolve) => {
            new PerformanceObserver((list) => {
              resolve(
                list
                  .getEntries()
                  .map((entry) => {
                    const el: unknown = Reflect.get(entry, "element");
                    return el instanceof Element
                      ? el.closest(".still")
                        ? "still 0"
                        : el.tagName.toLowerCase()
                      : "?";
                  })
                  .join(" → "),
              );
            }).observe({ type: "largest-contentful-paint", buffered: true });
          }),
      );
      test.info().annotations.push({ type: "lcp candidates", description: lcp });
      await page.context().close();
    });
  }

  test("no JS: every section still has its still and the intro still is painted", async ({
    browser,
  }) => {
    const page = await staticPage(browser, { javaScriptEnabled: false });
    const intro = page.locator("#hello .still img");
    await expect(intro).toBeVisible();
    await expect
      .poll(() => intro.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);
    await page.context().close();
  });
});

test("reviewer side-by-side against fallback-poster.png and mobile-full.png", async ({
  browser,
}) => {
  const out = process.env.SIDE_BY_SIDE_DIR;
  test.skip(!out, "set SIDE_BY_SIDE_DIR to write the comparison images");
  if (!out) return;
  test.setTimeout(180_000);
  mkdirSync(out, { recursive: true });
  const desktop = await staticPage(browser);
  const shots: Buffer[] = [];
  for (const [index] of SECTIONS.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await scrollToSection(desktop, index);
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await settledOn(desktop, index);
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    shots.push(await desktop.screenshot());
  }
  await desktop.context().close();
  const tiles = await Promise.all(shots.map(tile));
  const poster = process.env.FALLBACK_POSTER;
  const reference = poster
    ? await sharp(poster).resize(720, 450, { fit: "contain" }).png().toBuffer()
    : null;
  await sharp({ create: { width: 1440, height: 450 * 4, channels: 3, background: "#0e0a08" } })
    .composite([
      ...(reference ? [{ input: reference, left: 0, top: 0 }] : []),
      ...tiles.map((input, i) => ({
        input,
        left: ((i + 1) % 2) * 720,
        top: Math.floor((i + 1) / 2) * 450,
      })),
    ])
    .png()
    .toFile(join(out, "desktop-static-vs-fallback-poster.png"));

  const phone = await staticPage(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  // Scroll through slowly so every reveal-on-scroll card has run and every lazy band has loaded,
  // then return to the top: a full-page shot taken from a scrolled position wraps around and
  // drops Contact, and unrevealed cards are missing from it (QA-PF02-3).
  const total = await phone.evaluate(() => document.documentElement.scrollHeight);
  const stops = Array.from({ length: Math.ceil(total / 500) + 1 }, (_, k) => k * 500);
  await stops.reduce(
    (previous, y) =>
      previous.then(async () => {
        await phone.evaluate((top) => {
          window.scrollTo(0, top);
        }, y);
        return phone.waitForTimeout(120);
      }),
    Promise.resolve(),
  );
  await expect
    .poll(() =>
      phone.evaluate(() => ({
        unrevealed: document.querySelectorAll("[data-reveal]:not([data-revealed])").length,
        unloaded: [...document.querySelectorAll<HTMLImageElement>(".still img")].filter(
          (img) => !img.complete || img.naturalWidth === 0,
        ).length,
      })),
    )
    .toEqual({ unrevealed: 0, unloaded: 0 });
  await phone.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await phone.waitForTimeout(500);
  // One shot per section (and the footer), stacked: a single full-page shot of this ~10 000 px
  // page comes back with the Contact rows replaced by the intro under load (QA-PF02-3). The fixed
  // header would be stamped onto every section, so it stays on the intro only.
  const parts = [...SECTIONS.map((id) => `#${id}`), "body > footer"];
  const pieces = await parts.reduce<Promise<Buffer[]>>(
    (previous, selector, k) =>
      previous.then(async (list) => [
        ...list,
        await phone
          .locator(selector)
          .first()
          .screenshot(k > 0 ? { style: ".site-header { visibility: hidden !important; }" } : {}),
      ]),
    Promise.resolve([]),
  );
  await phone.context().close();
  const heights = await Promise.all(
    pieces.map(async (piece) => (await sharp(piece).metadata()).height ?? 0),
  );
  const tops = heights.map((_, k) => heights.slice(0, k).reduce((sum, h) => sum + h, 0));
  const full = await sharp({
    create: {
      width: 390,
      height: heights.reduce((sum, h) => sum + h, 0),
      channels: 3,
      background: "#0e0a08",
    },
  })
    .composite(pieces.map((input, k) => ({ input, left: 0, top: tops[k] ?? 0 })))
    .png()
    .toBuffer();
  const mobile = process.env.MOBILE_FULL;
  // Both at native 390 px width, top-aligned, so rows line up section by section.
  const ref = mobile ? await sharp(mobile).png().toBuffer() : null;
  const pageHeight = (await sharp(full).metadata()).height ?? 0;
  const refHeight = ref ? ((await sharp(ref).metadata()).height ?? 0) : 0;
  await sharp({
    create: {
      width: 800,
      height: Math.max(pageHeight, refHeight),
      channels: 3,
      background: "#0e0a08",
    },
  })
    .composite([
      ...(ref ? [{ input: ref, left: 0, top: 0 }] : []),
      { input: full, left: 410, top: 0 },
    ])
    .png()
    .toFile(join(out, "mobile-static-vs-mobile-full.png"));
});
