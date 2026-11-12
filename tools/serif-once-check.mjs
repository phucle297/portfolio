#!/usr/bin/env node
/**
 * PF-24: count Instrument Serif woff2 requests on a cold load in Chromium, Firefox and WebKit.
 *
 * The Playwright config on main sets launchOptions.executablePath from CHROME_PATH for every
 * project, so `playwright test --browser=firefox` (or webkit) would launch Google Chrome and
 * fail. This script launches each engine itself, with Chrome only for Chromium.
 *
 * Usage (against an already-running preview; do not start browsers without the heavy lock):
 *   CHROME_PATH=/usr/bin/google-chrome node tools/serif-once-check.mjs http://127.0.0.1:4542
 */
import { chromium, firefox, webkit } from "@playwright/test";

const base = (process.argv[2] ?? "http://127.0.0.1:4542").replace(/\/$/, "");

/** @param {string} url */
const isSerifFont = (url) => /instrument-serif/i.test(url) && /\.woff2?(?:\?|$)/i.test(url);

const engines = [
  {
    name: "chromium",
    type: chromium,
    launch: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  { name: "firefox", type: firefox, launch: {} },
  { name: "webkit", type: webkit, launch: {} },
];

/** @param {string} url */
const fontKey = (url) => new URL(url).pathname;

/**
 * @param {{ name: string, type: import("@playwright/test").BrowserType, launch: object }} engine
 * @returns {Promise<boolean>}
 */
async function check(engine) {
  const browser = await engine.type.launch(engine.launch);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    /** @type {string[]} */
    const requests = [];
    page.on("request", (request) => {
      const url = request.url();
      if (isSerifFont(url)) requests.push(url);
    });
    await page.goto(`${base}/`, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const counts = requests.map(fontKey).reduce((acc, key) => {
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, /** @type {Record<string, number>} */ ({}));
    const names = Object.keys(counts).map((path) => path.split("/").pop() ?? path);
    const duplicates = Object.entries(counts).filter(([, n]) => n !== 1);
    const family = await page.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily);
    const glyphs = await page.evaluate(() =>
      document.fonts.check('72px "Instrument Serif"', "Phúc Lê Đàm"),
    );

    const ok =
      duplicates.length === 0 &&
      names.length === 2 &&
      names.some((n) => n.includes("instrument-serif-400") && !n.includes("italic")) &&
      names.some((n) => n.includes("instrument-serif-400-italic")) &&
      names.every((n) => n.endsWith(".woff2")) &&
      /Instrument Serif/i.test(family) &&
      glyphs;

    const line = `${engine.name}: ${ok ? "PASS" : "FAIL"} files=${names.join(",") || "(none)"} counts=${JSON.stringify(counts)} family=${family} glyphs=${glyphs}`;
    process.stdout.write(`${line}\n`);
    if (!ok) {
      process.stderr.write(
        `${engine.name} expected two unique woff2 files (400 and 400-italic), each requested once, H1 in Instrument Serif.\n`,
      );
    }
    return ok;
  } finally {
    await browser.close();
  }
}

// Sequential on purpose: the box allows at most two browser processes at a time.
const failed = await engines.reduce(
  async (previous, engine) => (await previous) + ((await check(engine)) ? 0 : 1),
  Promise.resolve(0),
);
process.exit(failed === 0 ? 0 : 1);
