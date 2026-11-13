/**
 * PF-24 (M1-AC13): each Instrument Serif file (400 and italic) is fetched exactly once per cold
 * load, and the H1 is rendered in Instrument Serif.
 *
 * The test runs against the current Playwright project / browser. On main today that is Chromium;
 * after PF-05 merges, the same file runs on Firefox and WebKit too (new specs are cross-browser
 * by default). Do not use `--browser=firefox` or `--browser=webkit` with this repo's Playwright
 * config while it sets `launchOptions.executablePath` from `CHROME_PATH` — that launches Chrome
 * as Firefox/WebKit and fails. Cross-browser evidence uses `tools/serif-once-check.mjs`.
 */
import { expect, test } from "@playwright/test";

const isSerifFont = (url: string): boolean =>
  /instrument-serif/i.test(url) && /\.woff2?(?:\?|$)/i.test(url);

function fontKey(url: string): string {
  return new URL(url).pathname;
}

test.describe("PF-24 Instrument Serif is downloaded once", () => {
  test("each Instrument Serif file is fetched exactly once on a cold load", async ({
    page,
    browserName,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (isSerifFont(request.url())) requests.push(request.url());
    });
    // `load`, not `networkidle`: the live page can keep connections open (scene / probe), and
    // networkidle is what made the earlier all-engine loop hit the 120 s test timeout.
    await page.goto("/", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const keys = requests.map(fontKey);
    const counts = keys.reduce<Record<string, number>>((acc, key) => {
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const duplicates = Object.entries(counts).filter(([, n]) => n !== 1);
    const names = Object.keys(counts).map((path) => path.split("/").pop() ?? path);

    expect(
      duplicates,
      `${browserName} duplicate serif requests: ${JSON.stringify(counts)}`,
    ).toEqual([]);
    expect(names.some((n) => n.includes("instrument-serif-400") && !n.includes("italic"))).toBe(
      true,
    );
    expect(names.some((n) => n.includes("instrument-serif-400-italic"))).toBe(true);
    expect(
      names.every((n) => n.endsWith(".woff2")),
      `${browserName} unexpected serif files: ${names.join(", ")}`,
    ).toBe(true);
    expect(names).toHaveLength(2);

    const h1 = page.locator("h1");
    await expect(h1).toHaveCount(1);
    const fontFamily = await h1.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).toMatch(/Instrument Serif/i);
    const rendered = await page.evaluate(() =>
      document.fonts.check('72px "Instrument Serif"', "Phúc Lê Đàm"),
    );
    expect(rendered, `${browserName} H1 glyphs not in Instrument Serif`).toBe(true);
  });

  test("the built HTML declares two Instrument Serif faces and does not preload them", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    const preloadTags = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
    const serifTags = preloadTags.filter((tag) => /instrument-serif/i.test(tag));
    // A crossorigin preload plus @font-face made WebKit issue a second no-cors GET per file.
    expect(serifTags).toHaveLength(0);

    const faces = [...html.matchAll(/@font-face\{[^}]*font-family:Instrument Serif;[^}]*\}/gi)];
    expect(faces.length).toBe(2);
    const srcs: string[] = [];
    for (const face of faces) {
      const block = face[0];
      expect(block).toMatch(/font-display:swap/);
      expect(block).not.toMatch(/unicode-range/);
      const src = /src:url\(([^)]+)\)/.exec(block)?.[1];
      expect(src).toBeTruthy();
      expect(src).toMatch(/instrument-serif-400(?:-italic)?\.[^/]+\.woff2$/);
      srcs.push(src ?? "");
    }
    expect(srcs.some((s) => s.includes("instrument-serif-400-italic"))).toBe(true);
    expect(srcs.some((s) => /instrument-serif-400\.[^/]+\.woff2$/.test(s))).toBe(true);
  });
});
