import { expect, test, type Page } from "@playwright/test";
import { layoutShifts, recordLayoutShifts, shiftScore } from "./layout-shift";

/**
 * PF-83: the first section must not move while JS, fonts and the loader settle.
 *
 * The Owner-visible failure on the pre-fix code is the Hello ghost button ("CV on LinkedIn"):
 * one size-adjust on Be Vietnam Pro Button Fallback left that string 6.61 px wider than
 * Be Vietnam Pro 600, so the button shrank when the inlined Critical face (or the full file)
 * replaced the fallback. The primary button was already within 2 px. This file has a
 * deterministic metric check that reproduces that gap (and would fail on the pre-fix CSS)
 * plus a load check at the four PF-83 widths for CLS and first-ink movement.
 */

const MAX_MOVE_PX = 2;
const MAX_CLS = 0.02;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 900 },
  { width: 1024, height: 900 },
  { width: 390, height: 844 },
] as const;

const WATCHED = {
  h1: "#hello-title",
  subtitle: ".hello__subtitle",
  lede: ".hello__lede",
  primary: ".hello .button--primary",
  ghost: ".hello .button--ghost",
  still: '[data-still="0"]',
} as const;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const readBoxes = async (page: Page): Promise<Record<string, Box>> =>
  page.evaluate((watched) => {
    const out: Record<string, Box> = {};
    for (const [name, selector] of Object.entries(watched)) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out[name] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, WATCHED);

const maxDelta = (a: Box, b: Box): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.w - b.w), Math.abs(a.h - b.h));

test("PF-83: each Hello button's fallback face matches Be Vietnam Pro 600 to 2 px", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#hello-title").waitFor({ state: "attached" });
  await page.evaluate(() => document.fonts.ready);

  const report = await page.evaluate(() => {
    // These have to live in this function: page.evaluate serialises only this callback.
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const widthOf = (font: string, text: string): number => {
      const span = document.createElement("span");
      span.style.cssText = `position:absolute;left:-9999px;top:0;font:${font};white-space:nowrap`;
      span.textContent = text;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const unquote = (name: string): string => name.trim().replace(/^["']|["']$/g, "");
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const textOf = (el: Element | null): string => {
      if (!el) return "";
      return Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
    };

    const rows = [
      {
        name: "primary",
        el: document.querySelector(".hello .button--primary"),
        text: textOf(document.querySelector(".hello .button--primary")),
      },
      {
        name: "ghost",
        el: document.querySelector(".hello .button--ghost"),
        text: textOf(document.querySelector(".hello .button--ghost")),
      },
    ] as const;

    return rows.map((row) => {
      const names = row.el ? getComputedStyle(row.el).fontFamily.split(",").map(unquote) : [];
      const fallback = names.find((name) => /Fallback/u.test(name)) ?? null;
      const web = widthOf('600 1rem/1 "Be Vietnam Pro"', row.text);
      const crit = widthOf('600 1rem/1 "Be Vietnam Pro Critical"', row.text);
      const fallbackWidth = fallback ? widthOf(`600 1rem/1 "${fallback}"`, row.text) : Number.NaN;
      return {
        name: row.name,
        text: row.text,
        fallback,
        web,
        crit,
        fallbackWidth,
        delta: Math.abs(fallbackWidth - web),
      };
    });
  });

  expect(report, "both Hello buttons should be on the page").toHaveLength(2);
  for (const row of report) {
    expect(row.text, `${row.name} label`).not.toBe("");
    expect(row.fallback, `${row.name} stack lists a Fallback face`).toBeTruthy();
    expect(
      Math.abs(row.web - row.crit),
      `${row.name}: Critical vs Be Vietnam Pro for "${row.text}"`,
    ).toBeLessThanOrEqual(MAX_MOVE_PX);
    expect(
      row.delta,
      `${row.name} "${row.text}" ${row.fallback} ${row.fallbackWidth.toFixed(2)}px vs Be Vietnam Pro ${row.web.toFixed(2)}px`,
    ).toBeLessThanOrEqual(MAX_MOVE_PX);
  }
});

for (const vp of VIEWPORTS) {
  test(`PF-83 ${vp.width}×${vp.height}: home CLS ≤ ${MAX_CLS} and Hello does not move more than ${MAX_MOVE_PX}px after first ink`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await recordLayoutShifts(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("#hello-title").waitFor({ state: "attached" });
    await page.evaluate(() => document.fonts.ready);
    const first = await readBoxes(page);
    await page.waitForFunction(() => document.documentElement.classList.contains("is-ready"));
    // Loader exit is 240 ms; give the pin/scene a moment if the idle callback fires early.
    await page.waitForTimeout(400);
    const later = await readBoxes(page);
    const cls = shiftScore(await layoutShifts(page));
    expect(cls, `${vp.width}×${vp.height} CLS ${cls}`).toBeLessThanOrEqual(MAX_CLS);
    for (const name of Object.keys(WATCHED)) {
      const a = first[name];
      const b = later[name];
      if (!a || !b) continue;
      expect(
        maxDelta(a, b),
        `${vp.width}×${vp.height} ${name} moved from ${JSON.stringify(a)} to ${JSON.stringify(b)}`,
      ).toBeLessThanOrEqual(MAX_MOVE_PX);
    }
  });
}
