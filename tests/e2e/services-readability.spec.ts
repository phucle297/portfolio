/**
 * PF-92: Services text stays readable while scrolling. Heading plate + header-edge clip.
 * Owner case: the accent at the worst Services scroll point fails on main and passes on the fix.
 */
import { expect, test, type Page } from "@playwright/test";

import { hideLoader, openScene, scrollToP, waitForLoader } from "./helpers";
import {
  boxDelta,
  JUMP_PX,
  LUM_SWING_MAX,
  measureContrast,
  readBoxes,
  scrollToProgress,
  SERVICES_TEXT_TARGETS,
  servicesPixelsInHeader,
  setPlateOpacity,
  type ContrastRow,
} from "./services-contrast";

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

/** Work → Services boundary (static / in-flow). */
const OWNER_P = 0.52;
/** Services hold on the full-tier pin (HOLDS[3] = [0.57, 0.63]); copy is fully on. */
const OWNER_FULL_P = 0.58;

const failing = (rows: ContrastRow[]): ContrastRow[] =>
  rows.filter((row) => row.opacity >= 0.5 && row.visible >= 0.5 && !row.pass && row.pixels > 0);

const formatFail = (rows: ContrastRow[]): string =>
  failing(rows)
    .map(
      (row) =>
        `${row.selector} "${row.text}" p1=${row.p1?.toFixed(2)} need=${row.required} (${row.reason})`,
    )
    .join("; ");

test.describe("PF-92 services readability", () => {
  test(
    "full tier: the accent stays readable over the live scene at the Services hold @chromium-only",
    { tag: "@chromium-only" },
    async ({ page }) => {
      test.setTimeout(90_000);
      await hideLoader(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openScene(page);
      await scrollToP(page, OWNER_FULL_P);
      const rows = await measureContrast(page, [{ selector: "#services-title em" }]);
      const row = rows[0];
      expect(
        row?.pass,
        `full-tier accent at p=${OWNER_FULL_P} must pass, got ${JSON.stringify(row)}`,
      ).toBe(true);
    },
  );

  test("the accent at the 1440 Services start fails without the plate and passes with it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await hideLoader(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await waitForLoader(page);
    await scrollToProgress(page, OWNER_P);

    const accent = { selector: "#services-title em" as const };
    await setPlateOpacity(page, 0);
    const planted = await measureContrast(page, [accent]);
    const plantedRow = planted[0];
    // Designer 1440-01: accent is 3.23:1 over the Work still (AA large is 3, aim is 4.5).
    // The planted check is the aim, so it fails on main and passes once the plate is on.
    expect(
      plantedRow && plantedRow.p1 !== null && plantedRow.p1 < 4.5,
      `planted failure: without the plate the 1440 p=${OWNER_P} accent must be under the 4.5 aim, got ${JSON.stringify(plantedRow)}`,
    ).toBe(true);

    await setPlateOpacity(page, 0.94);
    const fixed = await measureContrast(page, [accent]);
    const fixedRow = fixed[0];
    expect(
      fixedRow?.pass,
      `with the plate the same accent frame must pass AA, got ${JSON.stringify(fixedRow)}`,
    ).toBe(true);
  });

  for (const vp of VIEWPORTS) {
    test(`heading contrast, steady plate, header clip and no jump at ${vp.name}`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await hideLoader(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await waitForLoader(page);

      // First Services-visible frame: record boxes, then confirm the plate does not move them.
      const startP = await firstVisibleProgress(page, ".services__head");
      await scrollToProgress(page, startP);
      const withPlate = await readBoxes(page);
      await setPlateOpacity(page, 0);
      const withoutPlate = await readBoxes(page);
      await setPlateOpacity(page, 0.94);
      const restored = await readBoxes(page);
      expect(
        boxDelta(withPlate, withoutPlate),
        `AC3: adding the backing must move Services boxes 0 px (≤ ${JUMP_PX}) at ${vp.name}`,
      ).toBeLessThanOrEqual(JUMP_PX);
      expect(boxDelta(withPlate, restored)).toBeLessThanOrEqual(JUMP_PX);

      const plate = await page.evaluate(() => {
        const el = document.querySelector("[data-services-plate]");
        if (!el) return null;
        const opacity = Number.parseFloat(
          getComputedStyle(el).getPropertyValue("--services-plate-opacity").trim() || "0",
        );
        const bg = getComputedStyle(el, "::before").backgroundColor;
        return { opacity, bg };
      });
      expect(plate, "heading plate is present").not.toBeNull();
      expect(plate?.opacity ?? 0, "plate opacity ≥ 0.92 (prefer 0.94)").toBeGreaterThanOrEqual(
        0.92,
      );

      const samples = await sampleProgress(page, startP);
      const lumBySelector = new Map<string, number[]>();
      const failures: string[] = [];
      let headerHits = 0;

      for (const p of samples) {
        // oxlint-disable-next-line no-await-in-loop -- one scroll position at a time
        await scrollToProgress(page, p);
        // oxlint-disable-next-line no-await-in-loop
        const rows = await measureContrast(page, SERVICES_TEXT_TARGETS);
        for (const row of rows) {
          if (row.opacity >= 0.5 && row.visible >= 0.5 && row.bgLumMean !== null) {
            const list = lumBySelector.get(row.selector) ?? [];
            list.push(row.bgLumMean);
            lumBySelector.set(row.selector, list);
          }
        }
        const bad = failing(rows);
        if (bad.length > 0) failures.push(`p=${p.toFixed(3)} ${formatFail(bad)}`);
        // oxlint-disable-next-line no-await-in-loop
        headerHits = Math.max(headerHits, await servicesPixelsInHeader(page));
      }

      expect(failures, `AC1: Services text contrast at ${vp.name}`).toEqual([]);

      const swings: string[] = [];
      for (const [selector, values] of lumBySelector) {
        if (values.length < 2) continue;
        const swing = Math.max(...values) - Math.min(...values);
        if (swing > LUM_SWING_MAX) {
          swings.push(`${selector} lum swing ${swing.toFixed(4)} > ${LUM_SWING_MAX}`);
        }
      }
      expect(swings, `AC2: backdrop luminance behind Services text at ${vp.name}`).toEqual([]);

      expect(
        headerHits,
        `AC2: Services copy must not stay readable through the sticky header at ${vp.name} (${headerHits} matching px)`,
      ).toBeLessThanOrEqual(25);
    });
  }
});

async function servicesRange(page: Page): Promise<{ start: number; end: number }> {
  return page.evaluate(() => {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- runs in the page
    const fraction = (sel: string): number => {
      const el = document.querySelector(sel);
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      return r.width * r.height > 0 ? (visW * visH) / (r.width * r.height) : 0;
    };
    const copyVisible = (): number =>
      Math.max(
        fraction(".services__head"),
        fraction(".services__list"),
        fraction(".services__price"),
        fraction("#services-title"),
      );
    let start = 0.52;
    let end = 0.52;
    let found = false;
    for (let i = 0; i <= 80; i += 1) {
      const p = i / 80;
      window.scrollTo({ top: p * max, behavior: "instant" });
      const vis = copyVisible();
      if (vis >= 0.5) {
        if (!found) {
          start = p;
          found = true;
        }
        end = p;
      } else if (found) {
        break;
      }
    }
    return { start: found ? start : 0.52, end: found ? end : 0.68 };
  });
}

async function firstVisibleProgress(page: Page, _selector: string): Promise<number> {
  const range = await servicesRange(page);
  return range.start;
}

async function sampleProgress(page: Page, startP: number): Promise<number[]> {
  const range = await servicesRange(page);
  const endP = range.end;
  const mid = (startP + endP) / 2;
  const points = [startP, mid, endP];
  if (startP < OWNER_P && OWNER_P < endP) points.push(OWNER_P);
  return [...new Set(points.map((p) => Math.round(p * 1000) / 1000))].toSorted((a, b) => a - b);
}
