// PF-57: list the characters the first screen (header + Hello) sets in each design face, so
// tools/critical-fonts/build.py can inline a tiny subset of exactly those glyphs.
//
// Usage: bun run build && bun run preview -- --port 4321 &
//        CHROME_PATH=/usr/bin/google-chrome node tools/critical-fonts/collect.mjs [http://127.0.0.1:4321]
// Output: tools/critical-fonts/chars.json. Then: python3 tools/critical-fonts/build.py
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4321";
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
);

/**
 * Text per face key ("family|weight|style") in the header and Hello at one viewport.
 * @param {{ width: number, height: number }} viewport
 * @returns {Promise<Record<string, string>>}
 */
async function collect(viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(base, { waitUntil: "load" });
  /** @type {Record<string, string>} */
  const found = await page.evaluate(() => {
    /** @type {Record<string, string>} */
    const out = {};
    for (const root of [document.querySelector(".site-header"), document.querySelector("#hello")]) {
      if (!root) continue;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement;
        const raw = node.textContent ?? "";
        if (!el || !raw.trim()) continue;
        const cs = getComputedStyle(el);
        const family = cs.fontFamily.split(",")[0].replaceAll('"', "").trim();
        const w = Number(cs.fontWeight);
        const weight = w >= 550 ? "600" : w >= 450 ? "500" : "400";
        const key = `${family}|${weight}|${cs.fontStyle === "italic" ? "italic" : "normal"}`;
        const text = cs.textTransform === "uppercase" ? raw.toUpperCase() : raw;
        out[key] = (out[key] ?? "") + text;
      }
    }
    return out;
  });
  await page.close();
  return found;
}

// Both layouts: the phone header (MENU) and the desktop nav show different strings.
const results = await Promise.all([
  collect({ width: 1440, height: 900 }),
  collect({ width: 390, height: 844 }),
]);
await browser.close();

/** @type {Record<string, string>} */
const faces = {};
for (const found of results) {
  for (const [key, text] of Object.entries(found)) faces[key] = (faces[key] ?? "") + text;
}
const byCode = (/** @type {string} */ a, /** @type {string} */ b) =>
  (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0);
/** @type {Record<string, string>} */
const chars = {};
for (const key of Object.keys(faces).toSorted()) {
  chars[key] =
    [...new Set((faces[key] ?? "").replaceAll(/\s/g, ""))].toSorted(byCode).join("") + " ";
}
writeFileSync(new URL("chars.json", import.meta.url), JSON.stringify(chars, null, 2) + "\n");
process.stderr.write(JSON.stringify(chars, null, 2) + "\n");
