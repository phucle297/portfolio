/**
 * PF-24 (M1-AC13): each Instrument Serif file (400 and italic) is fetched exactly once per cold
 * load in Chromium, Firefox and WebKit, and the H1 is rendered in Instrument Serif.
 *
 * This spec launches the three engines itself, in sequence, so it stays correct whether the
 * Playwright config has one project (main today) or chromium/firefox/webkit (PF-05). It is
 * skipped on the firefox and webkit projects so it does not run three times after PF-05 merges.
 */
import { expect, test, chromium, firefox, webkit, type BrowserType } from "@playwright/test";

const ENGINES: readonly { name: "chromium" | "firefox" | "webkit"; type: BrowserType }[] = [
  { name: "chromium", type: chromium },
  { name: "firefox", type: firefox },
  { name: "webkit", type: webkit },
];

const isSerifFont = (url: string): boolean =>
  /instrument-serif/i.test(url) && /\.woff2?(?:\?|$)/i.test(url);

function fontKey(url: string): string {
  return new URL(url).pathname;
}

test.describe("PF-24 Instrument Serif is downloaded once", () => {
  test("one request per serif file in Chromium, Firefox and WebKit", async ({ baseURL }) => {
    test.skip(
      test.info().project.name === "firefox" || test.info().project.name === "webkit",
      "This test already opens all three engines; the chromium (or default) project is enough.",
    );
    test.setTimeout(120_000);
    expect(baseURL).toBeTruthy();

    // Sequential on purpose: the box allows at most two browser processes at a time.
    const reports: string[] = [];
    await ENGINES.reduce(async (previous, engine) => {
      await previous;
      const launchOptions =
        engine.name === "chromium" && process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH }
          : {};
      const browser = await engine.type.launch(launchOptions);
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const requests: string[] = [];
        page.on("request", (request) => {
          if (isSerifFont(request.url())) requests.push(request.url());
        });
        await page.goto(baseURL ?? "/", { waitUntil: "networkidle" });
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
          `${engine.name} duplicate serif requests: ${JSON.stringify(counts)}`,
        ).toEqual([]);
        expect(names.some((n) => n.includes("instrument-serif-400") && !n.includes("italic"))).toBe(
          true,
        );
        expect(names.some((n) => n.includes("instrument-serif-400-italic"))).toBe(true);
        expect(
          names.every((n) => n?.endsWith(".woff2")),
          `${engine.name} unexpected serif files: ${names.join(", ")}`,
        ).toBe(true);
        expect(names).toHaveLength(2);

        const h1 = page.locator("h1");
        await expect(h1).toHaveCount(1);
        const fontFamily = await h1.evaluate((el) => getComputedStyle(el).fontFamily);
        expect(fontFamily).toMatch(/Instrument Serif/i);
        const rendered = await page.evaluate(() =>
          document.fonts.check('72px "Instrument Serif"', "Phúc Lê Đàm"),
        );
        expect(rendered, `${engine.name} H1 glyphs not in Instrument Serif`).toBe(true);

        reports.push(`${engine.name}: ${names.join(", ")} ×1`);
      } finally {
        await browser.close();
      }
    }, Promise.resolve());

    expect(reports).toHaveLength(3);
  });

  test("the document preloads match the Instrument Serif @font-face src URLs", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    const preloadTags = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
    const serifTags = preloadTags.filter((tag) => /instrument-serif/i.test(tag));
    expect(serifTags).toHaveLength(2);
    expect(serifTags.every((tag) => tag.includes('as="font"') && tag.includes("crossorigin"))).toBe(
      true,
    );
    const serifPreloads = serifTags.flatMap((tag) => {
      const href = /href="([^"]+)"/.exec(tag)?.[1];
      return href ? [href] : [];
    });
    expect(serifPreloads.every((href) => href.endsWith(".woff2"))).toBe(true);

    const faces = [...html.matchAll(/@font-face\{[^}]*font-family:Instrument Serif;[^}]*\}/gi)];
    expect(faces.length).toBe(2);
    for (const face of faces) {
      const block = face[0];
      expect(block).toMatch(/font-display:swap/);
      expect(block).not.toMatch(/unicode-range/);
      const src = /src:url\(([^)]+)\)/.exec(block)?.[1];
      expect(src).toBeTruthy();
      expect(serifPreloads.some((href) => href === src)).toBe(true);
    }
  });
});
