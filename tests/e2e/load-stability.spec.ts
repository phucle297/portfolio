import { expect, test, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { hideLoader, spoofHardwareGpu } from "./helpers";

/**
 * PF-57: on a cold load nothing on the first screen jumps when the web fonts swap in, and the
 * background at first paint already has the settled page's colour and tone.
 *
 * Fonts: every woff2 request is held until the test releases it, so the page first lays out as a
 * visitor on a slow link sees it for ~1 s: with only the inlined first-screen subsets
 * (fonts-critical.css) and the metric-matched local fallbacks (global.css). The boxes of the
 * header, the nav, the H1, the Hello copy and buttons are read in that state and again once the
 * web fonts have loaded: none may move more than 8 px, no text block may change its line count,
 * and the single-line text boxes keep their width to 1 px (the same typeface, AC1).
 *
 * Background: the intro still's AVIF is held instead. Before it arrives the first screen must
 * already show the print's colour and tone (the inline placeholder, SectionStill.astro); the
 * mean colour of the still area may differ from the settled frame by only a few levels (AC2).
 * Before PF-57 it was the flat page background, ~60 levels darker.
 *
 * Full tier: the still on screen must stay until the live canvas has faded in behind it, so no
 * frame shows the bare dark page (it used to for the 560 ms fade).
 */

// PF-67: these checks measure the page under the first-open loader (its first paint, its font swap
// and its still); the cover is hidden so the screenshots see the page. loader.spec.ts covers the
// loader and its exit.
test.beforeEach(async ({ page }) => {
  await hideLoader(page);
});

const MAX_MOVE_PX = 8;
/** Mean channel difference (0-255) allowed between the placeholder and the settled still. */
const MAX_TONE_DELTA = 12;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const;

const WATCHED = {
  header: ".site-header",
  brand: ".site-header__brand",
  nav: ".site-header__nav ul",
  h1: "#hello-title",
  subtitle: ".hello__subtitle",
  lede: ".hello__lede",
  primary: ".hello .button--primary",
  ghost: ".hello .button--ghost",
  actions: ".hello__actions",
} as const;

type Name = keyof typeof WATCHED;
const NAMES: readonly Name[] = [
  "header",
  "brand",
  "nav",
  "h1",
  "subtitle",
  "lede",
  "primary",
  "ghost",
  "actions",
];
/** Single-line text boxes whose width is the text's own width: a typeface change shows here. */
const TEXT_WIDTH: ReadonlySet<Name> = new Set<Name>(["brand", "nav", "primary", "ghost"]);
/** A visible typeface change moves these widths by more than this (px). */
const MAX_TEXT_WIDTH_DELTA = 1;

interface SceneFrame {
  full: boolean;
  still: boolean;
  canvas: number;
}

declare global {
  interface Window {
    pf57Frames?: SceneFrame[];
    pf57Early?: Record<string, { x: number; y: number; w: number; h: number; lines: number }>;
  }
}
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: number;
}

async function readBoxes(page: Page): Promise<Partial<Record<Name, Box>>> {
  return page.evaluate((watched) => {
    const out: Record<string, { x: number; y: number; w: number; h: number; lines: number }> = {};
    for (const [name, selector] of Object.entries(watched)) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2;
      out[name] = {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        lines: Math.round(r.height / lineHeight),
      };
    }
    return out;
  }, WATCHED);
}

/** Holds every matching request until `release()`; returns the release function. */
async function hold(
  page: Page,
  pattern: RegExp,
): Promise<{ release: () => Promise<void>; count: () => number }> {
  const held: Route[] = [];
  let seen = 0;
  let open = false;
  await page.route(pattern, (route) => {
    if (open) return route.continue();
    seen += 1;
    held.push(route);
    return undefined;
  });
  return {
    count: () => seen,
    release: async () => {
      open = true;
      await Promise.all(held.splice(0).map((route) => route.continue().catch(() => undefined)));
    },
  };
}

async function meanRgb(png: Buffer): Promise<number[]> {
  const { channels } = await sharp(png).stats();
  return channels.slice(0, 3).map((c) => c.mean);
}

/**
 * Hello text is --text #fff1e4 (muted #c9b4a2) on a dark page / print. During the
 * font-display:block window the glyphs are not painted, so a clip of #hello-title is only
 * that dark field. Light pixels mean the first visible letters have been drawn — in the
 * Critical faces on a good load, or in a fallback if one was allowed to paint (a swap jump).
 */
const INK_LUMA_MIN = 80;
const INK_MIN_PIXELS = 16;
const INK_TIMEOUT_MS = 8_000;

async function clipHasLightInk(png: Buffer): Promise<boolean> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const step = info.channels;
  let n = 0;
  for (let i = 0; i < data.length; i += step) {
    const y = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
    if (y >= INK_LUMA_MIN) {
      n += 1;
      if (n >= INK_MIN_PIXELS) return true;
    }
  }
  return false;
}

/**
 * First paint of Hello's H1 with visible glyphs, not the layout under still-invisible text
 * (PF-59). Playwright's screenshot path waits for document.fonts.ready unless this env is
 * set; woff2 are held, so that promise would never resolve and the check would hang.
 */
async function screenshotHelloTitle(page: Page): Promise<Buffer> {
  const previous = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
  process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = "1";
  try {
    return await page.locator("#hello-title").screenshot();
  } finally {
    if (previous === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = previous;
  }
}

async function waitForVisibleHelloText(page: Page): Promise<void> {
  await page.locator("#journey").waitFor({ state: "attached" });
  await page.locator("#hello-title").waitFor({ state: "attached" });
  await expect
    .poll(
      async () => {
        try {
          return await clipHasLightInk(await screenshotHelloTitle(page));
        } catch {
          return false;
        }
      },
      { timeout: INK_TIMEOUT_MS, intervals: [50] },
    )
    .toBe(true);
}

for (const vp of VIEWPORTS) {
  test(`PF-57 ${vp.width}×${vp.height}: the first screen paints in its final faces: no box moves more than ${MAX_MOVE_PX}px, no width or line count changes when the web fonts arrive`, async ({
    page,
    browserName,
  }) => {
    // AC1 is Chromium and WebKit. Gecko does not load a later @font-face family in the stack while
    // the first one is still loading, so it shows the metric-matched local fallback instead of the
    // inlined subset until the web fonts arrive (as on main).
    test.skip(browserName === "firefox", "Gecko does not fall through to the inlined subset");
    await page.setViewportSize(vp);
    const fonts = await hold(page, /\.woff2?(?:\?|$)/);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // A few frames in the fallback faces (the swap period of font-display: swap).
    await page.waitForTimeout(500);
    const serifLoaded = await page.evaluate(() =>
      [...document.fonts].some(
        (face) =>
          face.family.replaceAll('"', "") === "Instrument Serif" && face.status === "loaded",
      ),
    );
    expect(fonts.count(), "web font requests held").toBeGreaterThan(0);
    expect(serifLoaded, "the web fonts are held: this is the pre-swap layout").toBe(false);
    const before = await readBoxes(page);

    await fonts.release();
    await page.waitForLoadState("load");
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
      await document.fonts.ready;
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = await readBoxes(page);

    const problems: string[] = [];
    for (const name of NAMES) {
      const a = before[name];
      const b = after[name];
      if (!a && !b) continue;
      if (!a || !b) {
        problems.push(`${name}: present ${Boolean(a)} -> ${Boolean(b)}`);
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > MAX_MOVE_PX || Math.abs(dy) > MAX_MOVE_PX) {
        problems.push(`${name}: moved dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
      }
      if (a.lines !== b.lines) problems.push(`${name}: ${a.lines} -> ${b.lines} lines`);
      const dw = b.w - a.w;
      if (TEXT_WIDTH.has(name) && Math.abs(dw) > MAX_TEXT_WIDTH_DELTA) {
        problems.push(`${name}: width ${dw.toFixed(1)} px (typeface change)`);
      }
    }
    test.info().annotations.push({ type: "boxes", description: JSON.stringify({ before, after }) });
    expect(problems, JSON.stringify({ before, after })).toEqual([]);
  });

  test(`PF-57 ${vp.width}×${vp.height}: the first paint already has the intro still's colour and tone`, async ({
    page,
    browserName,
  }) => {
    await page.setViewportSize(vp);
    const still = await hold(page, /\/_astro\/[dm]-0\.[\w-]+\.avif/);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(300);
    const early = await page.evaluate(() => {
      const img = document.querySelector<HTMLImageElement>(".still--intro img");
      const picture = document.querySelector(".still--intro picture");
      const cs = picture ? getComputedStyle(picture) : null;
      return {
        pending: Boolean(img && !(img.complete && img.naturalWidth > 0)),
        background: cs?.backgroundImage ?? "",
        display: cs?.display ?? "",
        opacity: cs?.opacity ?? "",
        body: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(still.count(), "intro still request held").toBeGreaterThan(0);
    expect(early.pending, "the intro still is held: this is the pre-still first screen").toBe(true);
    expect(early.background, "inline placeholder painted under the still").toContain(
      "data:image/webp",
    );
    expect(early.display).not.toBe("none");
    expect(early.opacity).toBe("1");
    expect(early.body).toBe("rgb(14, 10, 8)");

    // Away from the copy: the right of the print at 1440, the top band at 390.
    const clip =
      vp.width >= 768
        ? { x: 1440 * 0.55, y: 900 * 0.15, width: 1440 * 0.3, height: 900 * 0.7 }
        : { x: 0, y: 80, width: 390, height: 300 };
    // Screenshots wait for pending images in Playwright's WebKit and Firefox; Chromium can take
    // the pre-still frame. The others compare the placeholder and the still themselves below.
    const shot = browserName === "chromium" ? await meanRgb(await page.screenshot({ clip })) : null;

    await still.release();
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>(".still--intro img");
      return Boolean(img && img.complete && img.naturalWidth > 0);
    });
    await page.waitForTimeout(500);

    // Mean colour of the placeholder vs the decoded still, as drawn (both cover the same box).
    const means = await page.evaluate(async () => {
      const img = document.querySelector<HTMLImageElement>(".still--intro img");
      const picture = document.querySelector(".still--intro picture");
      if (!img || !picture) return null;
      const url = /url\("?(data:[^")]+)"?\)/.exec(getComputedStyle(picture).backgroundImage)?.[1];
      if (!url) return null;
      const lqip = new Image();
      lqip.src = url;
      await lqip.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      const result: number[][] = [];
      for (const source of [lqip, img]) {
        ctx.drawImage(source, 0, 0, 32, 32);
        const { data } = ctx.getImageData(0, 0, 32, 32);
        let r = 0;
        let g = 0;
        let bl = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i] ?? 0;
          g += data[i + 1] ?? 0;
          bl += data[i + 2] ?? 0;
        }
        const n = data.length / 4;
        result.push([r / n, g / n, bl / n]);
      }
      return { lqip: result[0] ?? [], still: result[1] ?? [] };
    });
    expect(means, "placeholder and still decoded").not.toBeNull();
    const imageDelta = Math.max(
      ...(means?.lqip ?? []).map((v, i) => Math.abs(v - (means?.still[i] ?? 0))),
    );
    const notes: Record<string, unknown> = { means, imageDelta };
    expect(imageDelta, "placeholder tone vs still").toBeLessThanOrEqual(MAX_TONE_DELTA);

    if (shot) {
      const settled = await meanRgb(await page.screenshot({ clip }));
      const delta = Math.max(...shot.map((v, i) => Math.abs(v - (settled[i] ?? 0))));
      notes.screen = { early: shot, settled, delta };
      expect(
        delta,
        `on screen: early ${shot.join(",")} vs settled ${settled.join(",")}`,
      ).toBeLessThanOrEqual(MAX_TONE_DELTA);
    }
    test.info().annotations.push({ type: "tone", description: JSON.stringify(notes) });
  });
}

/**
 * PF-57 / PF-59: the first-screen layout that a visitor can actually see, compared with the
 * settled page. WebKit used to paint the 600 weight in a system fallback as soon as Hello was
 * parsed (the local() fallback faces did not resolve there) and then reflow: subtitle 2 -> 1
 * lines, H1 and eyebrow +18 px after first paint. That fallback can be replaced by the inlined
 * Critical faces within a few hundred ms, so a later first-ink screenshot misses it; on WebKit
 * the boxes are therefore read synchronously when #journey is inserted. Chromium at 1440 can
 * also lay out the lede / H1 under still-invisible font-display:block text (lede 4 -> 3, h1
 * dy ~14) and then settle — a visitor never sees that reflow, so on Chromium PF-59 snapshots
 * boxes only once Hello's H1 has painted glyphs. woff2 are still held, so a planted font-swap
 * jump (fallback ink, then the web face) still fails the move / line-count checks.
 */
for (const vp of VIEWPORTS) {
  test(`PF-57 ${vp.width}×${vp.height}: the first-screen layout as soon as Hello is parsed is already the settled one (no box moves more than ${MAX_MOVE_PX}px, no line count changes)`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "firefox", "AC1 is Chromium and WebKit");
    await page.setViewportSize(vp);
    await page.addInitScript((watched) => {
      const read = (): void => {
        const out: Record<string, { x: number; y: number; w: number; h: number; lines: number }> =
          {};
        for (const [name, selector] of Object.entries(watched)) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          const lh = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.2;
          out[name] = { x: r.x, y: r.y, w: r.width, h: r.height, lines: Math.round(r.height / lh) };
        }
        window.pf57Early = out;
      };
      const observer = new MutationObserver(() => {
        if (!document.getElementById("journey")) return;
        observer.disconnect();
        read();
      });
      observer.observe(document, { childList: true, subtree: true });
    }, WATCHED);
    // The web fonts arrive late, as on a slow link: the early layout cannot use them.
    const fonts = await hold(page, /\.woff2?(?:\?|$)/);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    let early: Partial<Record<Name, Box>> | null;
    if (browserName === "webkit") {
      early = await page.evaluate(() => window.pf57Early ?? null);
      expect(early, "boxes read when #journey was inserted").not.toBeNull();
    } else {
      await waitForVisibleHelloText(page);
      early = await readBoxes(page);
      expect(early.h1, "H1 box once Hello text is visible").toBeTruthy();
    }

    await fonts.release();
    await page.waitForLoadState("load");
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
      await document.fonts.ready;
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = await readBoxes(page);

    const problems: string[] = [];
    for (const name of NAMES) {
      const a = early?.[name];
      const b = after[name];
      if (!a && !b) continue;
      if (!a || !b) {
        problems.push(`${name}: present ${Boolean(a)} -> ${Boolean(b)}`);
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (Math.abs(dx) > MAX_MOVE_PX || Math.abs(dy) > MAX_MOVE_PX) {
        problems.push(`${name}: moved dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
      }
      if (a.lines !== b.lines) problems.push(`${name}: ${a.lines} -> ${b.lines} lines`);
    }
    test.info().annotations.push({ type: "boxes", description: JSON.stringify({ early, after }) });
    expect(problems, JSON.stringify({ early, after })).toEqual([]);
  });
}

// Needs the SwiftShader-backed full-tier scene (probe spoof), as tiers.spec.ts does.
test("PF-57 full tier: the still stays on screen until the live canvas has faded in @chromium-only", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await spoofHardwareGpu(page);
  await page.addInitScript(() => {
    const frames: { full: boolean; still: boolean; canvas: number }[] = [];
    window.pf57Frames = frames;
    const tick = (): void => {
      const root = document.documentElement;
      const still = document.querySelector(".still--intro");
      const canvas = document.querySelector(".darkroom-scene__canvas");
      frames.push({
        full: root.dataset.tier === "full",
        still: Boolean(still && getComputedStyle(still).display !== "none"),
        canvas: canvas ? Number(getComputedStyle(canvas).opacity) : 0,
      });
      if (frames.length < 2000 && !(root.hasAttribute("data-scene-shown") && frames.length > 5)) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("data-scene-shown", "", { timeout: 10_000 });
  await expect(page.locator(".still--intro")).toBeHidden();
  const frames = await page.evaluate(() => window.pf57Frames ?? []);
  const bare = frames.filter((f) => f.full && !f.still && f.canvas < 0.99);
  expect(
    frames.some((f) => f.full),
    "sampled frames on the full tier",
  ).toBe(true);
  expect(bare, "frames with neither the still nor the opaque canvas").toEqual([]);
});
