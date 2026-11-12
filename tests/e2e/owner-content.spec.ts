/**
 * PF-07 (M4-AC1, build plan §4): no `[Owner: …]` placeholder ships, in any built file or in the
 * visible page with JS on or off, and the Owner decisions show on the page.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { REPLY_PROMISE } from "../../src/entities/profile/model/content";

const DIST = join(process.cwd(), "dist");
const TOKEN = "[Owner:";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const visibleText = async (page: Page): Promise<string> =>
  page.evaluate(() => document.body.innerText);

test.describe("PF-07 owner content", () => {
  test("the production build has 0 [Owner: occurrences (every text file in dist/)", () => {
    // dist/ is the build the e2e webServer just made for this run.
    const text = files(DIST).filter((f) =>
      /\.(?:html|js|mjs|css|json|xml|txt|svg|webmanifest)$/u.test(f),
    );
    expect(text.some((f) => f.endsWith("index.html"))).toBe(true);
    const hits = text.filter((f) => readFileSync(f, "utf8").includes(TOKEN));
    expect(hits).toEqual([]);
  });

  test("no [Owner: in the served HTML, its scripts or the visible text, with JS on and off", async ({
    page,
    browser,
    request,
  }) => {
    const pages = await Promise.all(
      ["/", "/404"].map(async (path) => (await request.get(path)).text()),
    );
    expect(pages.filter((html) => html.includes(TOKEN))).toEqual([]);
    const scripts: string[] = [];
    page.on("response", (res) => {
      if (/\.(?:js|css)(?:\?|$)/u.test(res.url())) scripts.push(res.url());
    });
    await page.goto("/");
    await page.evaluate(async () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= max; y += innerHeight) {
        window.scrollTo(0, y);
        // oxlint-disable-next-line no-await-in-loop -- one step per frame, in order
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    expect(await visibleText(page)).not.toContain(TOKEN);
    const bodies = await Promise.all(scripts.map(async (url) => (await request.get(url)).text()));
    expect(bodies.filter((b) => b.includes(TOKEN))).toEqual([]);

    const off = await browser.newContext({ javaScriptEnabled: false });
    const nojs = await off.newPage();
    await nojs.goto("/");
    expect(await visibleText(nojs)).not.toContain(TOKEN);
    await off.close();
  });

  test("Owner decisions are on the page: email, 4-hour promise, no photo, no case links, CV on LinkedIn", async ({
    page,
  }) => {
    await page.goto("/");
    // Q2: the public address as a mailto: link.
    await expect(page.locator('#contact a[href="mailto:phucle.2971.dd@gmail.com"]')).toHaveText(
      "phucle.2971.dd@gmail.com",
    );
    // Q3: the same wording in Process step 1, the form note and the success text.
    const promise = `${REPLY_PROMISE}.`;
    await expect(page.locator("#process").getByText(promise, { exact: false })).toHaveCount(1);
    await expect(page.locator("#contact form").getByText(promise, { exact: true })).toHaveCount(1);
    const success = await page
      .locator("#contact [data-form-messages]")
      .evaluate((t) =>
        t instanceof HTMLTemplateElement
          ? (t.content.querySelector('[data-msg="success"]')?.textContent ?? "")
          : "",
      );
    expect(success).toContain(promise);
    // Q1: no photo; Q4: no case screenshots or case links.
    // (The section stills are the scene's own poster frames, not photos or screenshots.)
    const content = await page.evaluate(() =>
      ["journey", "work"].map((id) => ({
        id,
        imgs: Array.from(document.querySelectorAll(`#${id} img`)).filter(
          (i) => !i.closest(".still"),
        ).length,
        links: document.querySelectorAll(`#${id} a[href]`).length,
      })),
    );
    expect(content).toEqual([
      { id: "journey", imgs: 0, links: 0 },
      { id: "work", imgs: 0, links: 0 },
    ]);
    // Q9: "CV on LinkedIn" opens LinkedIn.
    const cv = page.getByRole("link", { name: "CV on LinkedIn" });
    expect(await cv.count()).toBeGreaterThan(0);
    expect(
      new Set(await cv.evaluateAll((els) => els.map((el) => el.getAttribute("href")))),
    ).toEqual(new Set(["https://www.linkedin.com/in/dp2907"]));
    await expect(page.getByRole("link", { name: /download cv/iu })).toHaveCount(0);
  });

  test("Q5: phones get static stills and no three.js", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
    expect(urls.filter((u) => /\/_astro\/stage\.[\w-]+\.js/u.test(u))).toEqual([]);
    await context.close();
  });
});
