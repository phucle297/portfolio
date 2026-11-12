import { type Browser, type Page, test } from "@playwright/test";

// TASK-20261112-14 investigation only: what the hello copy looks like before vs after the web fonts.
const SELECTORS = [
  "#hello .home-section__body",
  "#hello .eyebrow",
  "#hello .hello__title",
  "#hello .hello__subtitle",
  "#hello .hello__lede",
  "#hello .hello__actions",
  "#hello .hello__cue",
  ".site-header__nav ul",
  ".site-header__actions",
];

const measure = async (page: Page) =>
  page.evaluate((sels) => {
    const out: Record<string, unknown> = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      out[s] = {
        y: Math.round(r.y),
        h: Math.round(r.height),
        x: Math.round(r.x),
        w: Math.round(r.width),
        font: getComputedStyle(el).fontFamily.slice(0, 30),
      };
    }
    // natural widths of single runs, per family, to derive size-adjust
    const span = document.createElement("span");
    document.body.append(span);
    const probe = (family: string, weight: string, size: string, text: string): number => {
      span.style.cssText = `position:absolute;white-space:nowrap;font-family:${family};font-weight:${weight};font-size:${size};visibility:hidden`;
      span.textContent = text;
      return Math.round(span.getBoundingClientRect().width * 100) / 100;
    };
    const lede = document.querySelector("#hello .hello__lede")?.textContent ?? "";
    const sub = document.querySelector("#hello .hello__subtitle")?.textContent ?? "";
    const nav = document.querySelector(".site-header__nav ul")?.textContent ?? "";
    const widths = {
      fonts: [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => `${f.family} ${f.weight} ${f.style}`)
        .join(", "),
      ledeWeb: probe('"Be Vietnam Pro"', "400", "100px", lede),
      ledeFallback: probe('"Be Vietnam Pro Fallback"', "400", "100px", lede),
      ledeLiberation: probe('"Liberation Sans"', "400", "100px", lede),
      ledeArial: probe("Arial", "400", "100px", lede),
      ledeSystem: probe("ui-sans-serif, system-ui, sans-serif", "400", "100px", lede),
      subWeb: probe('"Be Vietnam Pro"', "600", "100px", sub),
      subFallback: probe('"Be Vietnam Pro Fallback"', "600", "100px", sub),
      subLiberation: probe('"Liberation Sans"', "600", "100px", sub),
      navWeb: probe('"Be Vietnam Pro"', "400", "100px", nav),
      navLiberation: probe('"Liberation Sans"', "400", "100px", nav),
      titleWeb: probe('"Instrument Serif"', "400", "100px", "Phúc Lê, developing."),
      titleFallback: probe('"Instrument Serif Fallback"', "400", "100px", "Phúc Lê, developing."),
      titleLiberation: probe('"Liberation Serif"', "400", "100px", "Phúc Lê, developing."),
    };
    span.remove();
    out.widths = widths;
    return out;
  }, SELECTORS);

const run = async (browser: Browser, withheld: boolean): Promise<void> => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (withheld) await page.route(/be-vietnam-pro|instrument-serif/u, (route) => route.abort());
  await page.goto("/");
  await page.waitForTimeout(1500);
  process.stdout.write(`FONT_PROBE ${JSON.stringify({ withheld, m: await measure(page) })}\n`);
  await context.close();
};

test("probe hello layout with and without web fonts at 1440x900", async ({ browser }) => {
  await run(browser, true);
  await run(browser, false);
});
