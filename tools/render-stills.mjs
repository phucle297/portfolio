// Re-render the poster stills (static tier) from the shipped scene, so the stills always show
// exactly what the live scene shows (e.g. after the photo or copy changes).
//
// Usage: bun run build && bun run preview -- --port 4321 &
//        CHROME_PATH=/usr/bin/google-chrome node tools/render-stills.mjs [http://127.0.0.1:4321]
//
// The hardware-WebGL probe is stubbed so the scene renders on whatever WebGL the browser has
// (SwiftShader on a GPU-less machine). Output: src/_pages/home/ui/stills/{d,m}-0…5.png
import { chromium } from "@playwright/test";
import sharp from "sharp";

const base = process.argv[2] ?? "http://127.0.0.1:4321";
const outDir = new URL("../src/_pages/home/ui/stills/", import.meta.url);
// Key progress per section; Hello uses the end of its hold so the print is fully developed.
const KEYS = [0.06, 0.21, 0.41, 0.6, 0.76, 0.96];
const HIDE_COPY = `main > section, body > header, body > footer, .home-scrim, .rail, .skip-link
  { visibility: hidden !important; }`;

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

/**
 * @param {{ prefix: string, width: number, height: number, outW: number, outH: number,
 *   tier: "full" | "lite", only?: number[] }} options
 *
 * Render every key state at `width × height` CSS px and save it resized to `outW × outH`.
 * Viewports narrower than the full-tier gate are rendered at 4× and scaled down.
 */
async function render({ prefix, width, height, outW, outH, tier, only }) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.route(/probe\.worker/, (route) =>
    route.fulfill({ contentType: "text/javascript", body: "postMessage(true);" }),
  );
  await page.goto(`${base}/?scene-test${tier === "lite" ? "&tier=lite" : ""}`);
  await page.waitForFunction(() => window.darkroomTest !== undefined, null, { timeout: 120_000 });
  await page.addStyleTag({ content: HIDE_COPY });
  // One page, one key state at a time (sequential on purpose).
  await KEYS.reduce(async (previous, p, i) => {
    await previous;
    if (only && !only.includes(i)) return;
    await page.evaluate((value) => window.darkroomTest?.set(value), p);
    await page.waitForTimeout(200);
    const png = await page.screenshot({ type: "png" });
    const file = new URL(`${prefix}-${i}.png`, outDir);
    await sharp(png)
      .resize(outW, outH, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toFile(file.pathname);
    process.stdout.write(`wrote ${file.pathname}\n`);
  }, Promise.resolve());
  await context.close();
}

await render({ prefix: "d", width: 1440, height: 900, outW: 1440, outH: 900, tier: "full" });
// Mobile intro: portrait framing (subject in the top half), 390×1010.
await render({
  prefix: "m",
  width: 1560,
  height: 4040,
  outW: 390,
  outH: 1010,
  tier: "lite",
  only: [0],
});
// Mobile bands: 390×240.
await render({
  prefix: "m",
  width: 1560,
  height: 960,
  outW: 390,
  outH: 240,
  tier: "full",
  only: [1, 2, 3, 4, 5],
});
await browser.close();
