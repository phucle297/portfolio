// Smoothness capture for M2-AC6 / M2-AC7: 384 frames at 1280×800, one per p = i / 383, driven
// through the scene test hook (no wall-clock timing, so the run is deterministic).
//
// Usage: bun run build && bun run preview -- --port 4511 &
//        CHROME_PATH=/usr/bin/google-chrome node tools/smooth/capture.mjs <outDir> <page|scene> \
//          [http://127.0.0.1:4511]
//        python3 tools/smooth/smooth.py <outDir> 'f*.png' <label>   (pops + green scan, CSV)
//        python3 tools/smooth/luma.py <outDir> 'f*.png'              (M2-AC7 luminance floor)
//
// "page" keeps the pinned copy, header and rail (the page run); "scene" hides them.
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const [outDir, mode = "page", base = "http://127.0.0.1:4511"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: capture.mjs <outDir> <page|scene> [baseUrl]");
const FRAMES = 384;
const HIDE_COPY = `main > section, body > header, body > footer, .home-scrim, .home-progress, .rail,
  .skip-link { visibility: hidden !important; }`;

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.route(/probe\.worker/, (route) =>
  route.fulfill({ contentType: "text/javascript", body: "postMessage(true);" }),
);
await page.goto(`${base}/?scene-test`);
await page.waitForFunction(() => window.darkroomTest !== undefined, null, { timeout: 120_000 });
await page.evaluate(() => document.fonts.ready);
// The test hook exists before the canvas has faded in over the poster (.is-ready, 560 ms); wait
// for the canvas to be fully shown so frame 0 is not caught mid-fade.
await page.waitForFunction(
  () => {
    const canvas = document.querySelector(".darkroom-scene__canvas");
    return canvas !== null && getComputedStyle(canvas).opacity === "1";
  },
  null,
  { timeout: 30_000 },
);
if (mode === "scene") await page.addStyleTag({ content: HIDE_COPY });

/** Render and capture frame i (p = i / 383). */
async function capture(i) {
  const p = i / (FRAMES - 1);
  await page.evaluate((target) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: target * max, behavior: "instant" });
    window.darkroomTest?.set(target);
  }, p);
  // Let the scroll-driven rAF (already settled at p) and style updates land.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.evaluate((target) => window.darkroomTest?.set(target), p);
  await page.screenshot({ path: `${outDir}/f${String(i).padStart(3, "0")}.png` });
}

// Sequential on purpose: one page, one p at a time.
await Array.from({ length: FRAMES }, (_, i) => i).reduce(
  (previous, i) => previous.then(() => capture(i)),
  Promise.resolve(),
);
await browser.close();
