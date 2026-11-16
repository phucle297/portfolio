/**
 * PF-13 (M3-AC8) as amended by PF-58 (Contact Option B): the contact form has three labelled
 * fields (Name, Email, "What are you building?") and no select or radio, shows the exact §5
 * error strings (icon + text, tied to the field, announced politely, cleared once valid), opens
 * a prefilled mailto ("Project: {name}", Name/Email/brief) on a valid submit, and the Start a
 * project / Get a quote buttons land on Contact with focus on Name, on both tiers.
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
import { knownEngineFailure } from "./known-failures";

const errors = contact.form.errors;
const success = contact.form.success;

const nameInput = (page: Page) => page.locator("#contact-name");
const emailInput = (page: Page) => page.locator("#contact-email");
const briefInput = (page: Page) => page.locator("#contact-brief");
const submit = (page: Page) => page.getByRole("button", { name: contact.form.submit });
const status = (page: Page) => page.locator("[data-form-status]");
const errorOf = (page: Page, field: "name" | "email" | "brief") =>
  page.locator(`[data-error-for="${field}"]`);

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
  test("Option B: three labelled fields with autofill hints, no select or radio, and the B copy", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    const section = page.locator("#contact");

    await expect(page.locator('label[for="contact-name"]')).toHaveText(contact.form.name.label);
    await expect(page.locator('label[for="contact-email"]')).toHaveText(contact.form.email.label);
    await expect(page.locator('label[for="contact-brief"]')).toHaveText(contact.form.brief.label);
    await expect(nameInput(page)).toHaveAttribute("autocomplete", "name");
    await expect(emailInput(page)).toHaveAttribute("autocomplete", "email");
    await expect(emailInput(page)).toHaveAttribute("type", "email");

    await expect(section.locator("input, textarea")).toHaveCount(3);
    await expect(section.locator("select")).toHaveCount(0);
    await expect(section.locator('input[type="radio"]')).toHaveCount(0);
    await expect(section.locator("dl")).toHaveCount(0);

    await expect(section.locator(".eyebrow")).toHaveText(contact.eyebrow);
    await expect(section.locator(".contact__sub")).toHaveText(contact.copy);
    await expect(section.locator(".contact__note")).toHaveText(contact.form.note);
    await expect(submit(page)).toHaveText(contact.form.submit);
    const copy = section.getByRole("button", { name: contact.form.copyEmail });
    await expect(copy).toHaveText(contact.form.copyShort);
  });

  // Needs the SwiftShader-backed full-tier scene so data-pin is on: the 33vw column (and this
  // 1280 wrap) only applies while pinned.
  test(
    "PF-60: the reply note stays on the same row as Send brief at 1280 and 1440 @chromium-only",
    {
      tag: "@chromium-only",
    },
    async ({ browser }) => {
      const viewports = [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
      ] as const;

      await inSequence(viewports, async (viewport) => {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        await openScene(page);
        await scrollToP(page, KEY_PROGRESS[5] ?? 0.96);
        await expect(page.locator("html")).toHaveAttribute("data-pin", "on");

        const geometry = await page.evaluate(() => {
          const button = document.querySelector(".contact__submit")?.getBoundingClientRect();
          const note = document.querySelector(".contact__note")?.getBoundingClientRect();
          const column = document.querySelector("#contact .contact")?.getBoundingClientRect();
          if (!button || !note || !column) return null;
          return {
            button: {
              top: button.top,
              right: button.right,
              bottom: button.bottom,
              left: button.left,
            },
            note: { top: note.top, right: note.right, bottom: note.bottom, left: note.left },
            column: { right: column.right },
          };
        });
        expect(
          geometry,
          `button, note and column boxes at ${viewport.width}×${viewport.height}`,
        ).toBeTruthy();
        if (!geometry) return;
        const { button, note, column } = geometry;

        expect(
          note.top,
          `note top is within the button row at ${viewport.width}`,
        ).toBeGreaterThanOrEqual(button.top - 1);
        expect(
          note.top,
          `note top is within the button row at ${viewport.width}`,
        ).toBeLessThanOrEqual(button.bottom);
        expect(
          note.left,
          `note sits to the right of the button at ${viewport.width}`,
        ).toBeGreaterThanOrEqual(button.right - 0.5);

        const overlapX = Math.min(button.right, note.right) - Math.max(button.left, note.left);
        const overlapY = Math.min(button.bottom, note.bottom) - Math.max(button.top, note.top);
        expect(
          overlapX > 0 && overlapY > 0,
          `button and note do not overlap at ${viewport.width}`,
        ).toBe(false);
        expect(note.right, `note stays inside the column at ${viewport.width}`).toBeLessThanOrEqual(
          column.right + 0.5,
        );
        expect(
          button.right,
          `button stays inside the column at ${viewport.width}`,
        ).toBeLessThanOrEqual(column.right + 0.5);

        await context.close();
      });
    },
  );

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
    knownEngineFailure(["firefox"], "Playwright's Firefox does not report the mailto: navigation");
    expect(PUBLIC_EMAIL, "PUBLIC_EMAIL must be set for this AC").toBeTruthy();
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await fillValid(page);
    const pending = waitForMailto(page);
    await submit(page).click();
    const url = await pending;
    expect(url.startsWith(`mailto:${PUBLIC_EMAIL}?`)).toBe(true);
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("subject=Project: Ada Lovelace");
    expect(decoded).toContain(
      "body=Name: Ada Lovelace\nEmail: ada@example.com\n\nA small marketing site by next month.",
    );
    expect(decoded).not.toContain("Project type:");
    await expect(status(page)).toHaveText(success);
    await expect(status(page)).toHaveAttribute("role", "status");
    await expect(status(page)).toHaveAttribute("aria-live", "polite");
  });

  test("Start a project and Get a quote work by mouse and keyboard on the static tier", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-tier", "static");

    await page.locator("#hello [data-start-project]").click();
    await expect(nameInput(page)).toBeFocused();
    // The jump still leaves #contact in the address bar, and Name stays focused after the
    // scroll settles (Firefox used to clear focus after its fragment jump).
    await expect(page).toHaveURL(/#contact$/u);
    await page.waitForTimeout(300);
    await expect(nameInput(page)).toBeFocused();

    await page.locator("#hello [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await expect(nameInput(page)).toBeFocused();

    await page.locator("#services [data-start-project]").click();
    await expect(nameInput(page)).toBeFocused();

    await page.locator("#services [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await expect(nameInput(page)).toBeFocused();
  });

  test("Start a project and Get a quote work by mouse and keyboard on the full tier", async ({
    page,
  }) => {
    await openScene(page);
    await expect(page.locator("html")).toHaveAttribute("data-tier", "full");

    // Leave Contact with focus elsewhere before each landing, so the check proves the CTA moved it.
    const leaveContact = async (): Promise<void> => {
      await scrollToP(page, KEY_PROGRESS[5] ?? 0.96);
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      });
      await expect(nameInput(page)).not.toBeFocused();
    };

    await leaveContact();
    await scrollToP(page, KEY_PROGRESS[0] ?? 0.03);
    await page.locator("#hello [data-start-project]").click();
    await settle(page);
    await expect(nameInput(page)).toBeFocused();

    await leaveContact();
    await scrollToP(page, KEY_PROGRESS[0] ?? 0.03);
    await page.locator("#hello [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await settle(page);
    await expect(nameInput(page)).toBeFocused();

    // Get a quote lives on Services beat 4. KEY_PROGRESS[3] (0.6) is beat 2 (the
    // four service cards), so the list would intercept a click on the CTA.
    const servicesQuoteP = beatProgress(3, 4, 5);

    await leaveContact();
    await scrollToP(page, servicesQuoteP);
    await page.locator("#services [data-start-project]").click();
    await settle(page);
    await expect(nameInput(page)).toBeFocused();

    await leaveContact();
    await scrollToP(page, servicesQuoteP);
    await page.locator("#services [data-start-project]").focus();
    await page.keyboard.press("Enter");
    await settle(page);
    await expect(nameInput(page)).toBeFocused();
  });

  test("the fields take touch on a phone and every control is at least 44px tall", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await nameInput(page).tap();
    await expect(nameInput(page)).toBeFocused();
    await briefInput(page).tap();
    await expect(briefInput(page)).toBeFocused();
    const small = await page.locator("#contact").evaluate((root) =>
      [...root.querySelectorAll<HTMLElement>("a, button, input, textarea")]
        .filter((el) => el.getClientRects().length > 0 && !el.hidden)
        .map((el) => ({ el: el.outerHTML.slice(0, 60), h: el.getBoundingClientRect().height }))
        .filter((item) => item.h < 44),
    );
    expect(small).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("with JS the no-JS mailto note is not in the layout", async ({ page }) => {
    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();
    await expect(page.locator("[data-contact-nojs-note]")).toBeHidden();
    await expect(page.locator("form[data-contact-form]")).toBeVisible();
  });

  test("without JS the form is visible, cannot post back, and the mailto note and link are shown", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const documentRequests: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("mailto:")) documentRequests.push(`mailto ${url}`);
      const method = request.method();
      if (method === "POST" || method === "PUT") documentRequests.push(`${method} ${url}`);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !frame.url().startsWith("http")) {
        documentRequests.push(frame.url());
      }
    });

    await page.goto("/");
    await page.locator("#contact").scrollIntoViewIfNeeded();

    if (PUBLIC_EMAIL === null) {
      await expect(page.locator('#contact a[href^="mailto:"]')).toHaveCount(0);
      await context.close();
      return;
    }

    const form = page.locator("form[data-contact-form]");
    await expect(form).toBeVisible();
    const action = await form.getAttribute("action");
    expect((action ?? "").toLowerCase().startsWith("mailto:")).toBe(false);
    await expect(form.locator('button[type="submit"]')).toBeDisabled();

    const note = page.locator("[data-contact-nojs-note]");
    await expect(note).toBeVisible();
    await expect(note).toHaveText(contact.form.noJsNote);

    const mailtoLink = page.locator(`#contact a[href="mailto:${PUBLIC_EMAIL}"]`);
    await expect(mailtoLink).toBeVisible();
    await expect(mailtoLink).toHaveText(PUBLIC_EMAIL);

    // Inert + disabled submit + no action: a forced click must not post back.
    const urlBefore = page.url();
    try {
      await form.locator('button[type="submit"]').click({ force: true });
    } catch {
      // Disabled or not hittable: the no-JS visitor cannot submit.
    }
    await page.waitForTimeout(400);
    expect(page.url()).toBe(urlBefore);
    expect(documentRequests.filter((item) => !item.startsWith("mailto "))).toEqual([]);

    await context.close();
  });
});
