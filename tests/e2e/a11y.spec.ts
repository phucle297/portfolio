/**
 * PF-03 (M3-AC4): automated accessibility scan with axe-core. Fails on any serious or critical
 * violation in each state a visitor can reach:
 * - full tier at 1440×900 at each of the 6 key scroll positions (hardware GPU spoofed; the scene
 *   renders on SwiftShader);
 * - static tier at 390×844;
 * - reduced motion (1440×900);
 * - no JS (1440×900 and 390×844; page scripts blocked by CSP so axe itself can still run);
 * - the contact form showing all three errors.
 * Every violation (any impact) is written to test-results/a11y/ (override with A11Y_OUT) so minor
 * and moderate ones are visible too. The open mobile menu state is added by PF-11.
 * Runner setup stays in this spec; playwright.config.ts is untouched.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";

const OUT = process.env.A11Y_OUT ?? join(process.cwd(), "test-results", "a11y");
/** Key scroll progress per section (`KEY_PROGRESS` in @shared/lib/timeline, kf-01…kf-06). */
const KEY_PROGRESS = [0.03, 0.21, 0.41, 0.6, 0.76, 0.96] as const;
const BLOCKING = new Set(["serious", "critical"]);

interface Finding {
  state: string;
  id: string;
  impact: string;
  help: string;
  targets: string[];
}

const findings: Finding[] = [];
const scanned: string[] = [];

async function open(
  browser: Browser,
  options: BrowserContextOptions & { gpu?: boolean; noJs?: boolean } = {},
): Promise<Page> {
  const { gpu = false, noJs = false, ...context } = options;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...context });
  const page = await ctx.newPage();
  if (noJs) {
    // "No JS" for the page, but not for axe: a context with JavaScript disabled also stops axe's own
    // timers (the scan never finishes). Serving the document with `script-src 'none'` blocks every
    // page script, inline or external, while the injected axe still runs. The site has no
    // <noscript> content, so this renders exactly what a no-JS visitor gets (checked below).
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() !== "document") return route.continue();
      const response = await route.fetch();
      return route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": "script-src 'none'" },
      });
    });
  } else {
    // Hardware GPU spoofed for the full tier; otherwise answer "no hardware WebGL" (static tier).
    await page.route(/probe\.worker/u, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `postMessage(${gpu ? "true" : "false"});`,
      }),
    );
  }
  await page.goto("/");
  await page.waitForLoadState("load");
  return page;
}

/** Scan the whole page; record every violation and return the serious/critical ones. */
async function scan(page: Page, state: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  scanned.push(state);
  for (const v of result.violations) {
    findings.push({
      state,
      id: v.id,
      impact: v.impact ?? "unknown",
      help: v.help,
      targets: v.nodes.map((n) => n.target.join(" ")),
    });
  }
  return result.violations
    .filter((v) => BLOCKING.has(v.impact ?? ""))
    .map(
      (v) =>
        `${state}: ${v.impact}: ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
    );
}

async function scrollToProgress(page: Page, p: number): Promise<void> {
  await page.evaluate(async (progress) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: max * progress, behavior: "instant" });
    // Let the scene and the copy layer catch up with the new position.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTimeout(resolve, 400);
        });
      });
    });
  }, p);
}

test.describe.configure({ mode: "serial" });

test("full tier at 1440×900, at each of the 6 key scroll positions", async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await open(browser, { gpu: true });
  await expect(page.locator("html")).toHaveAttribute("data-tier", "full", { timeout: 90_000 });
  const blocking: string[] = [];
  for (const [i, p] of KEY_PROGRESS.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    await scrollToProgress(page, p);
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full");
    // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
    blocking.push(...(await scan(page, `full tier, key ${i + 1} (p = ${p})`)));
  }
  await page.context().close();
  expect(blocking, "serious/critical axe violations").toEqual([]);
});

test("static tier at 390×844", async ({ browser }) => {
  const page = await open(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
  expect(await scan(page, "static tier 390×844"), "serious/critical axe violations").toEqual([]);
  await page.context().close();
});

test("reduced motion at 1440×900", async ({ browser }) => {
  const page = await open(browser, { reducedMotion: "reduce", gpu: true });
  await expect(page.locator("html")).not.toHaveClass(/motion-ok/u);
  await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
  expect(await scan(page, "reduced motion 1440×900"), "serious/critical axe violations").toEqual(
    [],
  );
  await page.context().close();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`no JS at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const page = await open(browser, { noJs: true, viewport });
    // No page script ran: the inline pre-paint script never added its "js" class.
    await expect(page.locator("html")).not.toHaveClass(/\bjs\b/u);
    expect(
      await scan(page, `no JS ${viewport.width}×${viewport.height}`),
      "serious/critical axe violations",
    ).toEqual([]);
    await page.context().close();
  });
}

test("contact form showing all three errors", async ({ browser }) => {
  const page = await open(browser);
  const form = page.locator("[data-contact-form]");
  await form.scrollIntoViewIfNeeded();
  await form.locator('button[type="submit"]').click();
  await expect(form.locator(".field__error:visible")).toHaveCount(3);
  await expect(form.locator('[aria-invalid="true"]')).toHaveCount(3);
  expect(await scan(page, "contact form, 3 errors"), "serious/critical axe violations").toEqual([]);
  await page.context().close();
});

test.afterAll(() => {
  if (scanned.length === 0) return;
  const rows = findings.map(
    (f) =>
      `| ${f.state} | ${f.impact} | ${f.id} | ${f.help} | ${f.targets.slice(0, 3).join("<br>")}${f.targets.length > 3 ? ` (+${f.targets.length - 3})` : ""} |`,
  );
  const md = [
    `axe-core scan: ${scanned.length} states, ${findings.length} violations (any impact), ${findings.filter((f) => BLOCKING.has(f.impact)).length} serious/critical.`,
    "",
    `States: ${scanned.join("; ")}.`,
    "",
    "| State | Impact | Rule | Help | Targets |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "a11y.md"), `${md}\n`);
  writeFileSync(join(OUT, "a11y.json"), JSON.stringify(findings, null, 1));
  process.stdout.write(`${md}\n`);
});
