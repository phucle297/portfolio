import type { Page, Request } from "@playwright/test";

/** Requests for the lazy three.js + scene chunk. */
export const isSceneChunk = (url: string): boolean => /\/_astro\/stage\.[\w-]+\.js/.test(url);
/** Requests for the off-main-thread WebGL probe. */
export const isProbe = (url: string): boolean => url.includes("probe.worker");

export function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request: Request) => {
    urls.push(request.url());
  });
  return urls;
}

/**
 * Stand-in for a hardware GPU on a GPU-less box: the probe worker reports "hardware WebGL2"
 * and the scene renders on SwiftShader.
 */
export async function spoofHardwareGpu(page: Page): Promise<void> {
  await page.route(/probe\.worker/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "postMessage(true);" }),
  );
}

export async function scrollThrough(page: Page): Promise<void> {
  // Scroll down to the bottom and back up in ~40 steps each way, one frame + 30 ms per step.
  await page.evaluate(async () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const down = Array.from({ length: 41 }, (_, i) => (max * i) / 40);
    const positions = [...down, ...down.toReversed()];
    await positions.reduce(
      (previous, y) =>
        previous.then(
          () =>
            new Promise<void>((resolve) => {
              window.scrollTo(0, y);
              requestAnimationFrame(() => {
                setTimeout(resolve, 30);
              });
            }),
        ),
      Promise.resolve(),
    );
  });
}

export const SECTION_IDS = ["hello", "journey", "work", "services", "process", "contact"];

/** Run async steps strictly one after another (browser state is shared, so order matters). */
export async function inSequence<T>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item, index) => previous.then(() => step(item, index)),
    Promise.resolve(),
  );
}

/**
 * Wait for the scene loader's own ready signal (`html[data-scene-load]`, PF-54) instead of a fixed
 * time: under CI load the three.js chunk, the atlases and the SwiftShader shader compile can take
 * longer than 20 s, so this waits as long as the loader is still "loading" (bounded by the test
 * timeout) and fails at once with the loader's state if it gave up ("failed" or "off").
 */
export async function waitForScene(page: Page): Promise<void> {
  const handle = await page.waitForFunction(
    () => {
      const state = document.documentElement.dataset.sceneLoad;
      return state === "ready" || state === "failed" || state === "off" ? state : false;
    },
    null,
    { timeout: 0 },
  );
  const state = await handle.jsonValue();
  if (state !== "ready") throw new Error(`scene loader ended "${String(state)}", not "ready"`);
}

/** Full tier with the test hook (`?scene-test`) on a spoofed hardware GPU. */
export async function openScene(page: Page): Promise<void> {
  await spoofHardwareGpu(page);
  await page.goto("/?scene-test");
  await waitForScene(page);
  await page.waitForFunction(() => window.darkroomTest !== undefined, null, { timeout: 5000 });
}

/** Scroll to progress p and wait until the scene (and the copy layer) has caught up. */
export async function scrollToP(page: Page, p: number): Promise<void> {
  await page.evaluate((target) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: target * max, behavior: "instant" });
  }, p);
  await settle(page);
}

/** Wait until the page has stopped scrolling (keyboard / wheel scrolls animate) and the scene has caught up. */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const y = scrollY;
        setTimeout(() => {
          resolve(scrollY === y);
        }, 250);
      }),
    null,
    { timeout: 15_000 },
  );
  await page.waitForFunction(
    () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      const shown = window.darkroomTest?.shown() ?? -1;
      return Math.abs(shown - scrollY / max) < 2e-4;
    },
    null,
    { timeout: 15_000 },
  );
}

/**
 * PF-67: hide the first-open loader cover for tests that measure the page beneath it in the
 * first seconds (screenshots, luminance, visible jumps). The page lays out and paints normally
 * under the cover; loader.spec.ts covers the loader itself.
 */
export async function hideLoader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const style = document.createElement("style");
    style.textContent = ".loader { display: none !important; }";
    document.documentElement.append(style);
  });
}

/** PF-67: wait until the first-open loader has left (html.is-ready, node removed). */
export async function waitForLoader(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.documentElement.classList.contains("is-ready") && !document.querySelector(".loader"),
    undefined,
    { timeout: 5000 },
  );
}
