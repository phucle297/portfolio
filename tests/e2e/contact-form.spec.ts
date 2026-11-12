/**
 * PF-13 (M3-AC8, Q8): the contact form is usable with mouse, touch and keyboard, shows the
 * exact §5 error strings (icon + text, tied to the field, announced politely, cleared once
 * valid), opens a prefilled mailto on a valid submit, and the Start a project / Get a quote
 * buttons land on Contact with Freelance selected and focus on Name, on both tiers.
 *
 * The axe scan of the error and success states (AC 5 / M3-AC4) is not in this spec:
 * `@axe-core/playwright` is not on main (it lands with PF-03 / PR #12). PF-03 already covers
 * the error state; the success state should be added there or here once the dependency is on
 * main.
 */
import { expect, test, type Page } from "@playwright/test";
import { contact } from "../../src/entities/profile/model/content";
import { PUBLIC_EMAIL } from "../../src/shared/config/contact";
import { KEY_PROGRESS, beatProgress } from "../../src/shared/lib/timeline";
import { inSequence, openScene, scrollToP, settle } from "./helpers";

const errors = contact.form.errors;
const modes = contact.form.modes;
const success = contact.form.success;

const nameInput = (page: Page) => page.locator("#contact-name");
const emailInput = (page: Page) => page.locator("#contact-email");
const briefInput = (page: Page) => page.locator("#contact-brief");
const projectType = (page: Page) => page.locator("[data-project-type]");
const projectSelect = (page: Page) => page.locator("#contact-type");
const submit = (page: Page) => page.getByRole("button", { name: contact.form.submit });
const status = (page: Page) => page.locator("[data-form-status]");
const errorOf = (page: Page, field: "name" | "email" | "brief") =>
  page.locator(`[data-error-for="${field}"]`);
const freelance = (page: Page) => page.locator('#contact input[data-mode="0"]');
const fullTime = (page: Page) => page.locator('#contact input[data-mode="1"]');

const rgbToHex = (rgb: string): string => {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(rgb);
  if (!match) return rgb;
  const hex = match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
};

const waitForMailto = async (page: Page): Promise<string> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for mailto navigation"));
    }, 5_000);
    const done = (url: string): void => {
      if (!url.startsWith("mailto:")) return;
      clearTimeout(timer);
      resolve(url);
    };
    page.on("framenavigated", (frame) => {
      done(frame.url());
    });
    page.on("request", (request) => {
      done(request.url());
    });
  });

const fillValid = async (page: Page): Promise<void> => {
  await nameInput(page).fill("Ada Lovelace");
  await emailInput(page).fill("ada@example.com");
  await briefInput(page).fill("A small marketing site by next month.");
};

test.describe("PF-13 contact form", () => {
  test("fields have visible labels and autofill hints; Project type hides for Full-time role", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();

    await expect(page.locator('label[for="contact-name"]')).toHaveText(contact.form.name.label);
    await expect(page.locator('label[for="contact-email"]')).toHaveText(contact.form.email.label);
    await expect(page.locator('label[for="contact-type"]')).toHaveText(
      contact.form.projectType.label,
    );
    await expect(page.locator('label[for="contact-brief"]')).toHaveText(contact.form.brief.label);
    await expect(nameInput(page)).toHaveAttribute("autocomplete", "name");
    await expect(emailInput(page)).toHaveAttribute("autocomplete", "email");

    await expect(freelance(page)).toBeChecked();
    await expect(page.locator(".contact__modes span").nth(0)).toHaveText(modes[0] ?? "");
    await expect(page.locator(".contact__modes span").nth(1)).toHaveText(modes[1] ?? "");
    await expect(projectType(page)).toBeVisible();
    await expect(projectSelect(page)).toBeEnabled();

    await page.locator(".contact__modes label").nth(1).click();
    await expect(fullTime(page)).toBeChecked();
    await expect(projectType(page)).toBeHidden();
    await expect(projectSelect(page)).toBeDisabled();

    await page.locator(".contact__modes label").nth(0).click();
    await expect(freelance(page)).toBeChecked();
    await expect(projectType(page)).toBeVisible();
    await expect(projectSelect(page)).toBeEnabled();
  });

  test("the mode group works from the keyboard and Project type is skipped when hidden", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await freelance(page).focus();
    await expect(freelance(page)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(fullTime(page)).toBeChecked();
    await expect(projectType(page)).toBeHidden();

    await nameInput(page).focus();
    await page.keyboard.press("Shift+Tab");
    const skippedSelect = await page.evaluate(() => document.activeElement?.id !== "contact-type");
    expect(skippedSelect).toBe(true);
    await expect(projectSelect(page)).toBeDisabled();

    await fullTime(page).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(freelance(page)).toBeChecked();
    await expect(projectType(page)).toBeVisible();
  });

  test("invalid submit shows the exact §5 strings with icon + text, tied and announced, and clears once valid", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();

    await expect(errorOf(page, "name")).toBeHidden();
    await expect(nameInput(page)).not.toHaveAttribute("aria-describedby");

    await submit(page).click();

    const expected = { name: errors.name, email: errors.email, brief: errors.brief } as const;
    const fields = ["name", "email", "brief"] as const;
    await inSequence(fields, async (field) => {
      const node = errorOf(page, field);
      await expect(node).toBeVisible();
      await expect(node).toHaveText(`!${expected[field]}`);
      await expect(node.locator("[aria-hidden='true']")).toHaveText("!");
      await expect(node).toHaveAttribute("aria-live", "polite");
      await expect(node).toHaveAttribute("role", "status");
      const color = rgbToHex(await node.evaluate((el) => getComputedStyle(el).color));
      expect(color).toBe("#ff8ba8");
      await expect(page.locator(`#contact-${field}`)).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator(`#contact-${field}`)).toHaveAttribute(
        "aria-describedby",
        `contact-${field}-error`,
      );
    });
    await expect(nameInput(page)).toBeFocused();

    await nameInput(page).fill("Ada");
    await expect(errorOf(page, "name")).toBeHidden();
    await expect(nameInput(page)).toHaveAttribute("aria-invalid", "false");
    await expect(nameInput(page)).not.toHaveAttribute("aria-describedby");
    await expect(errorOf(page, "email")).toBeVisible();
    await expect(errorOf(page, "brief")).toBeVisible();

    await emailInput(page).fill("ada@example.com");
    await expect(errorOf(page, "email")).toBeHidden();
    await briefInput(page).fill("A small marketing site.");
    await expect(errorOf(page, "brief")).toBeHidden();
  });

  test("a valid submit opens the prefilled mailto and announces what happened", async ({
    page,
  }) => {
    expect(PUBLIC_EMAIL, "PUBLIC_EMAIL must be set for this AC").toBeTruthy();
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await fillValid(page);
    const pending = waitForMailto(page);
    await submit(page).click();
    const url = await pending;
    expect(url.startsWith(`mailto:${PUBLIC_EMAIL}?`)).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("subject=Freelance project: Ada Lovelace");
    expect(decoded).toContain("Name: Ada Lovelace");
    expect(decoded).toContain("Email: ada@example.com");
    expect(decoded).toContain("Project type: Web app build");
    expect(decoded).toContain("A small marketing site by next month.");
    await expect(status(page)).toHaveText(success);
    await expect(status(page)).toHaveAttribute("role", "status");
    await expect(status(page)).toHaveAttribute("aria-live", "polite");
  });

  test("Start a project and Get a quote work by mouse and keyboard on the static tier", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");

    await fullTime(page).check();
    await page.locator("#hello [data-start-project]").click();
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();
    await expect(projectType(page)).toBeVisible();

    await fullTime(page).check();
    await page.locator("#hello [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();

    await fullTime(page).check();
    await page.locator("#services [data-start-project]").click();
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();

    await fullTime(page).check();
    await page.locator("#services [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();
  });

  test("Start a project and Get a quote work by mouse and keyboard on the full tier", async ({
    page,
  }) => {
    await openScene(page);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full");

    const setFullTime = async (): Promise<void> => {
      await scrollToP(page, KEY_PROGRESS[5] ?? 0.96);
      await fullTime(page).check();
      await expect(fullTime(page)).toBeChecked();
    };

    await setFullTime();
    await scrollToP(page, KEY_PROGRESS[0] ?? 0.03);
    await page.locator("#hello [data-start-project]").click();
    await settle(page);
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();

    await setFullTime();
    await scrollToP(page, KEY_PROGRESS[0] ?? 0.03);
    await page.locator("#hello [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await settle(page);
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();

    // Get a quote lives on Services beat 4. KEY_PROGRESS[3] (0.6) is beat 2 (the
    // four service cards), so the list would intercept a click on the CTA.
    const servicesQuoteP = beatProgress(3, 4, 5);

    await setFullTime();
    await scrollToP(page, servicesQuoteP);
    await page.locator("#services [data-start-project]").click();
    await settle(page);
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();

    await setFullTime();
    await scrollToP(page, servicesQuoteP);
    await page.locator("#services [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await settle(page);
    await expect(freelance(page)).toBeChecked();
    await expect(nameInput(page)).toBeFocused();
  });

  test("the mode group can be chosen by touch on a phone", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await page.locator(".contact__modes label").nth(1).tap();
    await expect(fullTime(page)).toBeChecked();
    await expect(projectType(page)).toBeHidden();
    await page.locator(".contact__modes label").nth(0).tap();
    await expect(freelance(page)).toBeChecked();
    await context.close();
  });
});
