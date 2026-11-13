/**
 * PF-17 (M4-AC4): the served home page has the correct title, description, canonical, OG/Twitter
 * tags, a 1200×630 share image, valid Person JSON-LD, and a valid sitemap and robots.txt.
 */
import { expect, test } from "@playwright/test";
import { personJsonLd } from "../../src/entities/profile/model/jsonld";
import { profile } from "../../src/entities/profile/model/profile";
import { DEFAULT_SITE_URL, siteConfig } from "../../src/shared/config/site";

const site = process.env.SITE_URL ?? DEFAULT_SITE_URL;
const homeCanonical = new URL("/", site).href;
const ogImageUrl = new URL(siteConfig.ogImage, site).href;
const expectedJsonLd = personJsonLd();

const title = `${profile.name} — ${profile.role}`;

/** PNG IHDR width and height from a Response body. */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locValues(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gu)].flatMap((m) => (m[1] ? [m[1]] : []));
}

test.describe("PF-17 search and sharing", () => {
  test("title, description, canonical, OG and Twitter tags are present and correct", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(title);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      "content",
      siteConfig.description,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", homeCanonical);
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      "content",
      profile.name,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", title);
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
      "content",
      siteConfig.description,
    );
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", homeCanonical);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", ogImageUrl);
    await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
      "content",
      String(siteConfig.ogImageWidth),
    );
    await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute(
      "content",
      String(siteConfig.ogImageHeight),
    );
    await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
      "content",
      siteConfig.ogImageAlt,
    );
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      "content",
      "summary_large_image",
    );
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", title);
    await expect(page.locator('meta[name="twitter:description"]')).toHaveAttribute(
      "content",
      siteConfig.description,
    );
    await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", ogImageUrl);
    await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute(
      "content",
      siteConfig.ogImageAlt,
    );
  });

  test("the share image is 1200×630 and is served at the OG URL path", async ({ request }) => {
    const res = await request.get(siteConfig.ogImage);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/image\/png/);
    const body = Buffer.from(await res.body());
    expect(pngSize(body)).toEqual({
      width: siteConfig.ogImageWidth,
      height: siteConfig.ogImageHeight,
    });
  });

  test("Person JSON-LD is in the HTML, parses, and matches the CV facts", async ({ page }) => {
    await page.goto("/");
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    const parsed = blocks.map((text) => parseJson(text));
    const person = parsed.find((block) => isRecord(block) && block["@type"] === "Person");
    expect(person).toEqual(expectedJsonLd);
    // A second parse (what a crawler would do) stays valid JSON.
    expect(parseJson(JSON.stringify(person))).toEqual(expectedJsonLd);
  });

  test("robots.txt and the sitemap stay valid and use the site origin", async ({ request }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.status()).toBe(200);
    const robotsText = await robots.text();
    expect(robotsText).toMatch(/^User-agent: \*\nAllow: \/\n\nSitemap: /u);
    const sitemapLine = robotsText.split("\n").find((line) => line.startsWith("Sitemap: "));
    expect(sitemapLine).toBeDefined();
    const sitemapUrl = sitemapLine?.slice("Sitemap: ".length).trim() ?? "";
    expect(sitemapUrl).toBe(new URL("sitemap-index.xml", site).href);

    const indexRes = await request.get("/sitemap-index.xml");
    expect(indexRes.status()).toBe(200);
    const indexXml = await indexRes.text();
    expect(indexXml).toContain("<sitemapindex");
    const child = /<loc>([^<]+)<\/loc>/u.exec(indexXml)?.[1];
    expect(child).toBeDefined();
    expect(child?.startsWith(site)).toBe(true);

    const childPath = new URL(child ?? "").pathname;
    const childRes = await request.get(childPath);
    expect(childRes.status()).toBe(200);
    const childXml = await childRes.text();
    expect(childXml).toContain("<urlset");
    const locs = locValues(childXml);
    expect(locs.length).toBeGreaterThanOrEqual(1);
    expect(locs.every((loc) => loc.startsWith(site))).toBe(true);
    expect(locs).toContain(homeCanonical);
  });
});
