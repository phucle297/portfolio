import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * PF-28: the component preview (/ui-preview/) exists in dev and PR-preview builds only.
 * 1. The production build (the e2e server's `bun run build`) has no trace of it: no file in
 *    dist/, no markup or CSS of it in any file, a 404 at its URL, not in the sitemap or robots.
 * 2. A PUBLIC_UI_PREVIEW=1 build (what PR previews deploy) renders it, noindex, with no JS, and
 *    meets the a11y baseline: axe 0 serious/critical, tap targets ≥ 44 px, focus ring ≥ 3:1,
 *    instant motion under prefers-reduced-motion.
 */
const root = resolvePath(import.meta.dirname, "../..");
const dist = join(root, "dist");
const PATH = "/ui-preview/";
/** Strings only the preview page and its component previews render. */
const MARKERS = ["ui-preview__", "Component library", "Keyboard focus (forced here)"];

/** WCAG 2 contrast ratio of two #rrggbb colours. */
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = c.map((v) =>
    v <= 0.039_28 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].toSorted((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f));

test.describe("production build", () => {
  test("ships no file, markup or CSS of the component preview", () => {
    const files = walk(dist);
    expect(files.filter((f) => f.includes("ui-preview"))).toEqual([]);
    const leaks = files
      .filter((f) => statSync(f).isFile() && /\.(html|css|js|xml|txt)$/u.test(f))
      .flatMap((f) => {
        const text = readFileSync(f, "utf8");
        return MARKERS.filter((m) => text.includes(m)).map((m) => `${f}: ${m}`);
      });
    expect(leaks).toEqual([]);
  });

  test("serves the 404 page at /ui-preview/ and lists it nowhere", async ({ page, request }) => {
    const response = await page.goto(PATH);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).not.toHaveText(/Component library/u);
    const sitemap = await (await request.get("/sitemap-0.xml")).text();
    expect(sitemap).toContain("<loc>");
    expect(sitemap).not.toContain("ui-preview");
    expect(await (await request.get("/robots.txt")).text()).not.toContain("ui-preview");
  });
});

test.describe("PR-preview build", () => {
  const port = Number(process.env.E2E_PORT ?? 4510) + 1;
  const base = `http://127.0.0.1:${port}`;
  let out = "";
  let server: Server | undefined;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    out = mkdtempSync(join(tmpdir(), "ui-preview-dist-"));
    execFileSync("node", ["node_modules/astro/bin/astro.mjs", "build", "--outDir", out], {
      cwd: root,
      // What the pull_request deploy build sets (the gate refuses on a push / main build).
      env: {
        ...process.env,
        PUBLIC_UI_PREVIEW: "1",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/0/merge",
      },
      stdio: "pipe",
    });
    const types: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".svg": "image/svg+xml",
      ".woff2": "font/woff2",
    };
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? "/", base).pathname;
      const file = normalize(join(out, url.endsWith("/") ? `${url}index.html` : url));
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server = srv;
    await new Promise<void>((resolve) => {
      srv.listen(port, "127.0.0.1", resolve);
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.close(() => {
          resolve();
        });
      } else resolve();
    });
    if (out) rmSync(out, { recursive: true, force: true });
  });

  test("renders every component preview, noindex, no JS, not in the sitemap", async ({ page }) => {
    const scripts: string[] = [];
    page.on("request", (r) => {
      if (r.resourceType() === "script") scripts.push(r.url());
    });
    const response = await page.goto(`${base}${PATH}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/u);
    await expect(page.locator("h1")).toHaveText("Component library");
    await expect(page.locator("section h2")).toHaveText(["Tokens", "SkipLink"]);
    // Each preview renders on --bg and on --surface.
    await expect(page.locator('[data-ground="bg"] .skip-link')).toHaveCount(2);
    await expect(page.locator('[data-ground="surface"] .skip-link')).toHaveCount(2);
    expect(scripts).toEqual([]);
    expect(readFileSync(join(out, "sitemap-0.xml"), "utf8")).not.toContain("ui-preview");
  });

  test("meets the a11y baseline", async ({ page }) => {
    await page.goto(`${base}${PATH}`);
    await page.evaluate(() => document.fonts.ready);

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const blocking = axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(blocking).toEqual([]);

    // Tap targets: every visible link and button, and the forced-focus skip link.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("a, button")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.bottom > 0 && getComputedStyle(el).transform === "none";
        })
        .map((el) => ({ text: el.textContent.trim(), h: el.getBoundingClientRect().height }))
        .filter((t) => t.h < 44),
    );
    expect(small).toEqual([]);

    // Keyboard: the first Tab stop is the skip link, visible, with the focus token ring at ≥ 3:1
    // against both grounds.
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement)) return undefined;
      const s = getComputedStyle(el);
      return {
        cls: el.className,
        transform: s.transform,
        width: s.outlineWidth,
        colour: s.outlineColor,
        tokens: ["--focus", "--bg", "--surface"].map((n) =>
          getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
        ),
      };
    });
    if (!ring) throw new Error("nothing focused after Tab");
    expect(ring.cls).toContain("skip-link");
    expect(ring.transform).toBe("none");
    expect(ring.width).toBe("2px");
    expect(ring.colour).toBe("rgb(255, 225, 181)");
    const [focus = "", bg = "", surface = ""] = ring.tokens;
    expect(ratio(focus, bg)).toBeGreaterThanOrEqual(3);
    expect(ratio(focus, surface)).toBeGreaterThanOrEqual(3);
  });

  test("motion is instant under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${base}${PATH}`);
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll(".chip")].map((el) => getComputedStyle(el).transitionDuration),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      for (const part of d.split(",")) expect(Number.parseFloat(part)).toBeLessThanOrEqual(0.01);
    }
  });
});
