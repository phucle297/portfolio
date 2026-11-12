/**
 * PF-11 (M3-AC3, M3-AC4, M1-AC15): the phone header is logo + Freelance pill + MENU, which
 * opens a full-screen sheet. Focus stays inside the sheet, Esc and Close return it to MENU, a
 * section link closes the sheet and lands on that section, every control is ≥ 44×44 px, and
 * opening or closing does not shift the layout (CLS ≤ 0.02).
 *
 * The axe scan of the open sheet (AC 4 / M3-AC4) is not in this spec: `@axe-core/playwright` is
 * not on main (it lands with PF-03 / PR #12). Selectors the scan should use: `[data-menu-open]`
 * and `[data-menu-sheet]`.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { inSequence } from "./helpers";

const PHONES = [
  { name: "390×844", width: 390, height: 844 },
  { name: "360×740", width: 360, height: 740 },
] as const;

const SECTIONS = ["Hello", "Journey", "Work", "Services", "Process", "Contact"] as const;

const menuButton = (page: Page): Locator => page.locator("[data-menu-open]");
const sheet = (page: Page): Locator => page.locator("[data-menu-sheet]");
const closeButton = (page: Page): Locator => page.locator("[data-menu-close]");

const openPhone = async (page: Page, width: number, height: number): Promise<void> => {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-tier", "static");
};

const openSheet = async (page: Page): Promise<void> => {
  await menuButton(page).click();
  await expect(sheet(page)).toBeVisible();
};

const boxAtLeast44 = async (locator: Locator, label: string): Promise<void> => {
  const box = await locator.boundingBox();
  expect(box, `${label} should be visible`).not.toBeNull();
  if (!box) return;
  expect(box.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${label} height`).toBeGreaterThanOrEqual(44);
};

const focusIsInsideSheet = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const dialog = document.querySelector("[data-menu-sheet]");
    return dialog instanceof HTMLElement && dialog.contains(document.activeElement);
  });

/**
 * Cumulative layout-shift during `action`, including entries with `hadRecentInput`. Official
 * CLS would drop those, which would hide a shift caused by the same click that opens the sheet.
 */
type ClsWindow = Window & { menuCls?: number; menuClsObserver?: PerformanceObserver };

const clsDuring = async (page: Page, action: () => Promise<void>): Promise<number> => {
  await page.evaluate(() => {
    const w = window as ClsWindow;
    w.menuCls = 0;
    w.menuClsObserver?.disconnect();
    w.menuClsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const value = "value" in entry && typeof entry.value === "number" ? entry.value : 0;
        w.menuCls = (w.menuCls ?? 0) + value;
      }
    });
    w.menuClsObserver.observe({ type: "layout-shift", buffered: false });
  });
  await action();
  await page.evaluate(
    async () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
  return page.evaluate(() => {
    const w = window as ClsWindow;
    w.menuClsObserver?.disconnect();
    return w.menuCls ?? 0;
  });
};

test.describe("PF-11 mobile menu sheet", () => {
  for (const phone of PHONES) {
    test.describe(phone.name, () => {
      test(`header shows logo, Freelance pill and MENU; rail and skill chips are hidden`, async ({
        page,
      }) => {
        await openPhone(page, phone.width, phone.height);

        await expect(page.locator(".site-header__brand")).toBeVisible();
        await expect(page.locator(".site-header__brand")).toContainText("Phúc Lê");
        await expect(page.getByRole("link", { name: "Freelance", exact: true })).toBeVisible();
        await expect(menuButton(page)).toBeVisible();
        await expect(menuButton(page)).toHaveText(/MENU/u);
        await expect(page.locator(".site-header__nav")).toBeHidden();
        await expect(page.locator(".rail")).toBeHidden();
        await expect(page.locator(".journey__skills")).toBeHidden();
      });

      test("MENU opens a full-screen sheet; focus stays inside; Esc and Close return it to MENU", async ({
        page,
      }) => {
        await openPhone(page, phone.width, phone.height);
        await openSheet(page);

        const box = await sheet(page).boundingBox();
        expect(box, "sheet is on screen").not.toBeNull();
        if (box) {
          expect(box.width).toBeGreaterThanOrEqual(phone.width - 1);
          expect(box.height).toBeGreaterThanOrEqual(phone.height - 1);
        }

        await inSequence(SECTIONS, async (name) => {
          await expect(sheet(page).getByRole("link", { name })).toBeVisible();
        });

        expect(await focusIsInsideSheet(page)).toBe(true);
        const tabs = Array.from({ length: 16 }, (_, i) => i + 1);
        await inSequence(tabs, async (step) => {
          await page.keyboard.press("Tab");
          expect(await focusIsInsideSheet(page), `Tab ${step} stayed in the sheet`).toBe(true);
        });
        await inSequence(tabs, async (step) => {
          await page.keyboard.press("Shift+Tab");
          expect(await focusIsInsideSheet(page), `Shift+Tab ${step} stayed in the sheet`).toBe(
            true,
          );
        });

        await page.keyboard.press("Escape");
        await expect(sheet(page)).toBeHidden();
        await expect(menuButton(page)).toBeFocused();

        await openSheet(page);
        await closeButton(page).click();
        await expect(sheet(page)).toBeHidden();
        await expect(menuButton(page)).toBeFocused();
      });

      test("choosing a section link closes the sheet and lands on that section", async ({
        page,
      }) => {
        await openPhone(page, phone.width, phone.height);
        await openSheet(page);
        await sheet(page).getByRole("link", { name: "Journey" }).click();
        await expect(sheet(page)).toBeHidden();
        await expect(page).toHaveURL(/#journey/u);
        const inView = await page.locator("#journey").evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top < innerHeight && rect.bottom > 0;
        });
        expect(inView).toBe(true);
      });

      test("sheet controls are at least 44×44 px and the sheet works without a mouse", async ({
        page,
      }) => {
        await openPhone(page, phone.width, phone.height);

        await boxAtLeast44(menuButton(page), "MENU");
        await boxAtLeast44(
          page.getByRole("link", { name: "Freelance", exact: true }),
          "Freelance pill",
        );

        await menuButton(page).focus();
        await expect(menuButton(page)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(sheet(page)).toBeVisible();
        expect(await focusIsInsideSheet(page)).toBe(true);

        await boxAtLeast44(closeButton(page), "Close");
        await inSequence(SECTIONS, async (name) => {
          await boxAtLeast44(sheet(page).getByRole("link", { name }), `${name} link`);
        });

        await page.keyboard.press("Tab");
        const focusedHref = await page.evaluate(() => {
          const el = document.activeElement;
          return el instanceof HTMLAnchorElement ? el.getAttribute("href") : null;
        });
        expect(focusedHref).toMatch(/^#/u);
        await page.keyboard.press("Enter");
        await expect(sheet(page)).toBeHidden();
        await expect(page).toHaveURL(/#/u);
      });

      test("opening and closing the sheet keeps CLS at or under 0.02", async ({ page }) => {
        await openPhone(page, phone.width, phone.height);

        const openCls = await clsDuring(page, async () => {
          await openSheet(page);
        });
        expect(openCls, `CLS on open (${openCls})`).toBeLessThanOrEqual(0.02);

        const closeCls = await clsDuring(page, async () => {
          await closeButton(page).click();
          await expect(sheet(page)).toBeHidden();
        });
        expect(closeCls, `CLS on close (${closeCls})`).toBeLessThanOrEqual(0.02);
      });
    });
  }

  test("desktop header is unchanged: nav visible, MENU hidden", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator(".site-header__nav")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(6);
    await expect(page.getByRole("link", { name: "Open for freelance" })).toBeVisible();
    await expect(menuButton(page)).toBeHidden();
    await expect(sheet(page)).toBeHidden();
  });
});
