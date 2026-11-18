import { expect, test, type Page, type Route } from "@playwright/test";
import sharp from "sharp";
import { waitForLoader } from "./helpers";

/**
 * PF-67: the first-open loader ("the print develops", design/loading/design.md).
 *
 * AC1 it covers the page from first paint, leaves once fonts and the intro still are in, never
 *     lasts past the 3 s cap (JS) / 3.2 s (CSS failsafe), and a load that is ready in under
 *     300 ms never shows the loader's content (the 300 ms delay).
 * AC2 its exit moves nothing on the page and is never brighter than the settled page; under
 *     reduced motion it just disappears.
 * AC3 polite busy → done announcement, no focus trap, first Tab lands on the skip link.
 *
 * The only app signal used is `html.is-ready` (and the loader node itself). A recorder injected
 * at document start samples the cover every animation frame (times are performance.now(), ms
 * from navigation start), so the timing assertions read the page's own clock, not the runner's.
 */

const WATCHED = [".site-header", ".site-header__brand", "#hello-title", ".hello__actions"];
const INTRO_STILL = /\/_astro\/[dm]-0\.[\w-]+\.avif/;
/** Design timing (design.md): content delay, JS cap, CSS failsafe, exit fade, node removal. */
const CONTENT_DELAY_MS = 300;
const JS_CAP_MS = 3000;
const CSS_CAP_MS = 3200;
const EXIT_MS = 240;
const REMOVE_MS = 400;
/** One frame of sampling slack (a 30 fps runner) on top of the design times. */
const FRAME_MS = 34;

interface LoaderFrame {
  t: number;
  ready: boolean;
  cover: number;
  visible: boolean;
  content: number;
}
interface LoaderLog {
  frames: LoaderFrame[];
  readyAt: number | null;
  removedAt: number | null;
  hiddenAt: number | null;
}
declare global {
  interface Window {
    pf67?: LoaderLog;
  }
}

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

/** Samples the cover every frame from document start until it is removed (or 5 s). */
async function recordLoader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: LoaderLog = { frames: [], readyAt: null, removedAt: null, hiddenAt: null };
    window.pf67 = log;
    // The exact moment the exit starts: the class change, not the next frame.
    new MutationObserver(() => {
      if (log.readyAt === null && document.documentElement?.classList.contains("is-ready")) {
        log.readyAt = performance.now();
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["class"] });
    const tick = (): void => {
      const now = performance.now();
      const loader = document.querySelector(".loader");
      if (!loader) {
        if (log.frames.length > 0 && log.removedAt === null) log.removedAt = now;
        if (log.removedAt === null && now < 5000) requestAnimationFrame(tick);
        return;
      }
      const cs = getComputedStyle(loader);
      const inner = loader.querySelector(".loader__in");
      const visible = cs.visibility !== "hidden" && cs.display !== "none";
      if (!visible && log.hiddenAt === null) log.hiddenAt = now;
      log.frames.push({
        t: now,
        ready: document.documentElement.classList.contains("is-ready"),
        cover: Number(cs.opacity),
        visible,
        content: inner ? Number(getComputedStyle(inner).opacity) : 0,
      });
      if (now < 5000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function loaderLog(page: Page): Promise<LoaderLog> {
  const log = await page.evaluate(() => window.pf67);
  if (!log) throw new Error("loader recorder missing");
  return log;
}

/** Holds every request matching `pattern` until release() (later ones pass straight through). */
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

test("PF-67 AC1+AC3: the loader covers the first paint, announces busy while the page loads, then done once it is ready", async ({
  page,
}) => {
  await recordLoader(page);
  // Hold the intro still so the page is deterministically not ready yet (well under the cap).
  const still = await hold(page, INTRO_STILL);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect
    .poll(() => still.count(), { message: "intro still request held" })
    .toBeGreaterThan(0);
  const early = await page.evaluate(() => {
    const loader = document.querySelector(".loader");
    const cs = loader ? getComputedStyle(loader) : null;
    return {
      t: performance.now(),
      present: Boolean(loader),
      position: cs?.position,
      background: cs?.backgroundColor,
      opacity: cs?.opacity,
      zIndex: cs?.zIndex,
      ariaHidden: loader?.getAttribute("aria-hidden"),
      focusable: loader?.querySelectorAll("a,button,input,select,textarea,[tabindex]").length ?? -1,
      ready: document.documentElement.classList.contains("is-ready"),
      busy: document.getElementById("main")?.getAttribute("aria-busy") ?? null,
      status: document.querySelector("[data-load-status]")?.textContent ?? "",
      live: document.querySelector("[data-load-status]")?.getAttribute("aria-live"),
    };
  });
  expect(early.t, "checked well before the 3 s cap").toBeLessThan(JS_CAP_MS - 500);
  expect(early).toMatchObject({
    present: true,
    position: "fixed",
    background: "rgb(14, 10, 8)",
    opacity: "1",
    ariaHidden: "true",
    focusable: 0,
    ready: false,
    busy: "true",
    status: "Loading the page",
    live: "polite",
  });
  expect(Number(early.zIndex)).toBeGreaterThan(22);

  await still.release();
  await waitForLoader(page);
  const done = await page.evaluate(() => ({
    fonts: document.fonts.status,
    still: document.documentElement.classList.contains("still0-loaded"),
    busy: document.getElementById("main")?.hasAttribute("aria-busy"),
    status: document.querySelector("[data-load-status]")?.textContent,
  }));
  expect(done).toEqual({ fonts: "loaded", still: true, busy: false, status: "Page loaded" });
  const log = await loaderLog(page);
  expect(log.readyAt, "left on readiness, not on the cap").toBeLessThan(JS_CAP_MS - 100);
  // Every frame before the exit was opaque (the cover never let the loading page through).
  for (const f of log.frames.filter((frame) => !frame.ready)) expect(f.cover).toBe(1);

  // AC3: nothing was focused; the first Tab lands on the skip link.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
});

test("PF-67 AC1: a page ready in under 300 ms never shows the loader's content", async ({
  page,
}) => {
  await recordLoader(page);
  // Warm the HTTP cache once, then find a load that is ready before the 300 ms content delay
  // (a local preview is ready in ~100-200 ms; up to 5 tries so a slow runner tick cannot flake).
  await page.goto("/");
  let log: LoaderLog | null = null;
  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential reloads by design
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // oxlint-disable-next-line no-await-in-loop -- sequential reloads by design
    await waitForLoader(page);
    // oxlint-disable-next-line no-await-in-loop -- sequential reloads by design
    const attempt = await loaderLog(page);
    log = attempt;
    if (attempt.readyAt !== null && attempt.readyAt < CONTENT_DELAY_MS) break;
  }
  if (!log) throw new Error("no load recorded");
  expect(log.readyAt, "a load that is ready in under 300 ms").toBeLessThan(CONTENT_DELAY_MS);
  expect(log.frames.length, "the cover was sampled").toBeGreaterThan(0);
  // The content (glow, print, caption, timer) never showed: its own opacity stays 0 until the
  // exit starts, and through the exit fade the visible part (content × cover) stays under 5 %.
  for (const f of log.frames) {
    if (!f.ready) expect(f.content, `content at ${f.t.toFixed(0)} ms`).toBe(0);
    else expect(f.content * f.cover, `content seen at ${f.t.toFixed(0)} ms`).toBeLessThan(0.05);
  }
});

test("PF-67 AC1: a page that never gets ready starts its exit at the 3 s cap and is gone by 3.2 s + the fade", async ({
  page,
}) => {
  await recordLoader(page);
  // Hold the intro still forever: the page is never "ready" by the still.
  await page.route(INTRO_STILL, () => {});
  await page.goto("/", { waitUntil: "commit" });
  await page.waitForFunction(() => (window.pf67?.removedAt ?? null) !== null, undefined, {
    timeout: 6000,
  });
  const log = await loaderLog(page);
  const readyAt = log.readyAt ?? Number.NaN;
  expect(readyAt, "JS cap starts the exit at 3 s").toBeGreaterThanOrEqual(JS_CAP_MS - 50);
  expect(readyAt, "exit starts by 3.2 s at the latest").toBeLessThanOrEqual(CSS_CAP_MS);
  const lastVisible = Math.max(
    ...log.frames.filter((f) => f.visible && f.cover > 0).map((f) => f.t),
  );
  expect(lastVisible, "the cover is fully gone after its 240 ms fade").toBeLessThanOrEqual(
    CSS_CAP_MS + EXIT_MS + FRAME_MS,
  );
  expect(log.removedAt ?? Number.NaN).toBeLessThanOrEqual(readyAt + REMOVE_MS + 2 * FRAME_MS);
  await expect(page.locator(".loader")).toHaveCount(0);
});

test("PF-67 AC1: with the loader script stripped, the CSS failsafe still hides the cover by 3.2 s", async ({
  page,
}) => {
  await recordLoader(page);
  // Serve the page without the loader's inline script (as if it failed to run). html.js is still
  // set by the head script, so only the CSS `ld-cap` animation can take the cover away.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const stripped = html.replace(
        /<script>(?:(?!<\/script>)[\s\S])*?Loading the page[\s\S]*?<\/script>/,
        "",
      );
      expect(stripped.length, "loader script found and removed").toBeLessThan(html.length);
      await route.fulfill({ response, body: stripped });
    },
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.pf67?.hiddenAt ?? null) !== null, undefined, {
    timeout: 6000,
  });
  const log = await loaderLog(page);
  const state = await page.evaluate(() => ({
    js: document.documentElement.classList.contains("js"),
    ready: document.documentElement.classList.contains("is-ready"),
    present: Boolean(document.querySelector(".loader")),
    busy: document.getElementById("main")?.hasAttribute("aria-busy"),
  }));
  expect(state, "no loader script ran: never is-ready, node stays").toEqual({
    js: true,
    ready: false,
    present: true,
    busy: false,
  });
  const hiddenAt = log.hiddenAt ?? Number.NaN;
  // Visible well into the load (no early hide), hidden by 3.2 s after the cover was first styled
  // (its first sampled frame, at first paint), plus a frame of sampling slack.
  const firstFrame = log.frames[0]?.t ?? Number.NaN;
  expect(log.frames.some((f) => f.visible && f.t > JS_CAP_MS - 200)).toBe(true);
  expect(hiddenAt).toBeGreaterThanOrEqual(CSS_CAP_MS - FRAME_MS);
  expect(hiddenAt, `first frame ${firstFrame.toFixed(0)} ms`).toBeLessThanOrEqual(
    firstFrame + CSS_CAP_MS + FRAME_MS,
  );
  await expect(page.locator(".loader")).toBeHidden();
});

test("PF-67 AC2: the loader exit moves nothing on the page by more than 8px", async ({ page }) => {
  const still = await hold(page, INTRO_STILL);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  // Read under the cover once the fonts are in, then after the cover is gone.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const before = await boxes(page);
  expect(await page.evaluate(() => document.querySelector(".loader") !== null)).toBe(true);
  await still.release();
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

/** Mean and 99.5th-percentile luma (0-255) of a frame. */
async function luma(jpegOrPng: Buffer): Promise<{ mean: number; p995: number }> {
  const { data } = await sharp(jpegOrPng).greyscale().raw().toBuffer({ resolveWithObject: true });
  const hist = Array.from({ length: 256 }, () => 0);
  let sum = 0;
  for (const v of data) {
    hist[v] = (hist[v] ?? 0) + 1;
    sum += v;
  }
  let seen = 0;
  let p995 = 255;
  for (let v = 0; v < 256; v += 1) {
    seen += hist[v] ?? 0;
    if (seen >= data.length * 0.995) {
      p995 = v;
      break;
    }
  }
  return { mean: sum / data.length, p995 };
}

// Needs every painted frame across a 240 ms fade: Chromium's DevTools screencast (Firefox and
// WebKit screenshots wait for pending images and are too slow to sample the fade).
test(
  "PF-67 AC2: no frame across the exit is brighter than the settled page @chromium-only",
  { tag: "@chromium-only" },
  async ({ page }) => {
    const still = await hold(page, INTRO_STILL);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const cdp = await page.context().newCDPSession(page);
    const frames: { data: Buffer; ready: boolean }[] = [];
    let ready = false;
    cdp.on("Page.screencastFrame", (frame) => {
      frames.push({ data: Buffer.from(frame.data, "base64"), ready });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await page.waitForTimeout(300);
    ready = true;
    await still.release();
    await waitForLoader(page);
    // Let the page settle, then the last frame is the settled page.
    await page.waitForTimeout(1000);
    await cdp.send("Page.stopScreencast");
    const settledShot = await page.screenshot({ type: "png" });
    const settled = await luma(settledShot);
    const exit = frames.filter((f) => f.ready);
    expect(exit.length, "frames painted across the exit").toBeGreaterThan(2);
    const stats = await Promise.all(exit.map((f) => luma(f.data)));
    test.info().annotations.push({
      type: "luma",
      description: JSON.stringify({ settled, exit: stats }),
    });
    // 2 levels of slack for screencast vs screenshot encoding.
    for (const [i, s] of stats.entries()) {
      expect(s.mean, `frame ${i} mean vs settled ${settled.mean.toFixed(1)}`).toBeLessThanOrEqual(
        settled.mean + 2,
      );
      expect(s.p995, `frame ${i} p99.5 vs settled ${settled.p995}`).toBeLessThanOrEqual(
        settled.p995 + 2,
      );
    }
  },
);

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("PF-67 AC2: under reduced motion nothing animates and the cover just disappears", async ({
    page,
  }) => {
    await recordLoader(page);
    const still = await hold(page, INTRO_STILL);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const styles = await page.evaluate(() => {
      const cs = [".loader", ".loader__glow", ".loader__in", ".loader__burst", ".loader__plate"]
        .map((sel) => document.querySelector(sel))
        .map((el) => (el ? getComputedStyle(el) : null));
      const timer = document.querySelector(".loader__timer");
      return {
        transition: cs[0]?.transitionDuration,
        animations: cs.slice(1).map((c) => c?.animationName ?? "missing"),
        content: cs[2]?.opacity,
        timer: timer ? getComputedStyle(timer).display : "missing",
      };
    });
    // `transition: none` (global.css also caps every duration at 0.01 ms under reduced motion).
    expect(
      styles.transition?.split(",").every((d) => Number.parseFloat(d) <= 0.001),
      `transition-duration ${styles.transition}`,
    ).toBe(true);
    expect(styles.animations).toEqual(["none", "none", "none", "none"]);
    expect(styles.content, "the developed print shows at once").toBe("1");
    expect(styles.timer).toBe("none");
    await still.release();
    await waitForLoader(page);
    // It just disappears: no frame in a half-faded state.
    const log = await loaderLog(page);
    for (const f of log.frames) expect([0, 1], `cover at ${f.t.toFixed(0)} ms`).toContain(f.cover);
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
