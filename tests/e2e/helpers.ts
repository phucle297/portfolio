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
