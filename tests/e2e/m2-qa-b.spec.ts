/**
 * QA follow-up on PR #3 (TASK-08 attempt 3): real mouse clicks reach the pinned copy (B-1),
 * focus never lands mid-morph (B-5), and the render loop idles ≤ 1.5 s after scrolling stops
 * (B-4). Full tier (`?scene-test`, SwiftShader standing in for the GPU), pinned layout.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { HOLDS, KEY_PROGRESS, SECTIONS } from "../../src/shared/lib/timeline";
import { inSequence, openScene, scrollToP, settle } from "./helpers";

interface B4Watch {
  lastScroll: number;
  lastRaf: number;
  stop: boolean;
}
declare global {
  interface Window {
    b4Watch?: B4Watch;
  }
}

/** The element the browser hit-tests at the centre of `target`, and whether it is `target`. */
async function hitAtCentre(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const result = await target.evaluate(
    (el, [px, py]) => {
      const hit = document.elementFromPoint(px ?? 0, py ?? 0);
      // A radio's hit box is its label (the input itself is styled away).
      const label = el.closest("label");
      const ok = hit !== null && (el === hit || el.contains(hit) || label?.contains(hit) === true);
      return {
        ok,
        hit: hit
          ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}.${[...hit.classList].join(".")}`
          : "null",
        pe: hit ? getComputedStyle(hit).pointerEvents : "",
      };
    },
    [x, y],
  );
  return { ...result, x, y };
}

const holdOf = (p: number): number => HOLDS.findIndex(([a, b]) => p >= a - 1e-6 && p <= b + 1e-6);

async function pFromScroll(page: Page): Promise<number> {
  return page.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight));
}

const VIEWPORTS = [
  { width: 1600, height: 1000 },
  { width: 1280, height: 800 },
  // The smallest viewport that pins (PIN_QUERY).
  { width: 1200, height: 760 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`B-1 mouse clicks reach the pinned copy at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page, context }) => {
      // External links (CV on LinkedIn) open in a stub instead of the network.
      await context.route(
        (url) => url.hostname !== "127.0.0.1",
        (route) => route.fulfill({ contentType: "text/html", body: "<title>stub</title>" }),
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await openScene(page);
      await expect(page.locator("html")).toHaveAttribute("data-pin", "on");
    });

    test("every visible control in each hold is the hit-test target at its centre", async ({
      page,
    }) => {
      const misses: string[] = [];
      await inSequence(KEY_PROGRESS, async (p, index) => {
        await scrollToP(page, p);
        const id = SECTIONS[index]?.id ?? "";
        const controls = page.locator(
          `#${id} [data-copy-body] :is(a[href], button, input, select, textarea)`,
        );
        const count = await controls.count();
        await inSequence(
          Array.from({ length: count }, (_, i) => i),
          async (i) => {
            const control = controls.nth(i);
            const shown = await control.evaluate((el) => {
              const r = el.getBoundingClientRect();
              let o = 1;
              for (let n: Element | null = el; n; n = n.parentElement)
                o *= Number(getComputedStyle(n).opacity);
              const style = getComputedStyle(el);
              return (
                o > 0.99 &&
                r.width > 0 &&
                r.height > 0 &&
                r.top >= 72 &&
                r.bottom <= innerHeight &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              );
            });
            if (!shown) return;
            const hit = await hitAtCentre(control);
            if (!hit.ok) misses.push(`${id} #${i}: hit ${hit.hit} (pointer-events ${hit.pe})`);
            // Nothing (the sticky footer, other copy) covers any part of it: points at 15 % / 85 %
            // across and 25 % / 75 % down (inside rounded pill corners).
            const covered = await control.evaluate((el) => {
              const r = el.getBoundingClientRect();
              const label = el.closest("label");
              const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
              return [
                [r.left + r.width * 0.15, cy],
                [r.right - r.width * 0.15, cy],
                [cx, r.top + r.height * 0.25],
                [cx, r.bottom - r.height * 0.25],
              ].filter(([x, y]) => {
                const at = document.elementFromPoint(x ?? 0, y ?? 0);
                return !(at && (el === at || el.contains(at) || label?.contains(at) === true));
              }).length;
            });
            if (covered > 0) misses.push(`${id} #${i}: ${covered} of 4 edge points covered`);
          },
        );
      });
      expect(misses).toEqual([]);
    });

    test("Hello: Start a project and the CV link take real mouse clicks", async ({ page }) => {
      await scrollToP(page, KEY_PROGRESS[0] ?? 0.03);
      const cv = page.locator("#hello a[target='_blank']");
      const cvHit = await hitAtCentre(cv);
      expect(cvHit, cvHit.hit).toMatchObject({ ok: true });
      const popup = page.waitForEvent("popup");
      await page.mouse.click(cvHit.x, cvHit.y);
      const opened = await popup;
      expect(opened.url()).toBe(await cv.getAttribute("href"));
      await opened.close();

      const start = page.locator("#hello [data-start-project]");
      const startHit = await hitAtCentre(start);
      expect(startHit, startHit.hit).toMatchObject({ ok: true });
      await page.mouse.click(startHit.x, startHit.y);
      await settle(page);
      expect(await pFromScroll(page)).toBeGreaterThan(SECTIONS[5]?.start ?? 0.84);
      await expect(page.locator("#contact-name")).toBeFocused();
    });

    test("Contact: fields, mode, Send brief and Copy email take real mouse clicks and typing", async ({
      page,
    }) => {
      await scrollToP(page, KEY_PROGRESS[5] ?? 0.96);
      const clickAt = async (target: Locator): Promise<void> => {
        const hit = await hitAtCentre(target);
        expect(hit, hit.hit).toMatchObject({ ok: true });
        await page.mouse.click(hit.x, hit.y);
      };
      await clickAt(page.locator("#contact-name"));
      await expect(page.locator("#contact-name")).toBeFocused();
      await page.keyboard.type("Ada");
      await expect(page.locator("#contact-name")).toHaveValue("Ada");
      await clickAt(page.locator("#contact-email"));
      await page.keyboard.type("not-an-email");
      await expect(page.locator("#contact-email")).toHaveValue("not-an-email");
      await clickAt(page.locator("#contact-brief"));
      await page.keyboard.type("A small site.");
      await expect(page.locator("#contact-brief")).toHaveValue("A small site.");
      const fullTime = page.locator('#contact input[data-mode="1"]');
      await clickAt(fullTime);
      await expect(fullTime).toBeChecked();
      await clickAt(page.locator("#contact-type")).catch(() => undefined);
      // Send brief: the click submits, validation flags the email and focuses it.
      await clickAt(page.locator(".contact__submit"));
      await expect(page.locator("#contact-email-error")).toBeVisible();
      await expect(page.locator("#contact-email")).toBeFocused();
      // Copy email.
      await clickAt(page.locator("[data-copy-email]"));
      await expect(page.locator("[data-copy-status]")).toHaveText("Email copied.");
      // Nothing moved the page out of the Contact hold.
      expect(await pFromScroll(page)).toBeGreaterThanOrEqual(HOLDS[5]?.[0] ?? 0.92);
    });
  });
}

test.describe("B-5 focus never lands mid-morph", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("Focusing 'Get a quote' scrolls into the Services hold with its beat shown", async ({
    page,
  }) => {
    await openScene(page);
    const quote = page.locator("#services [data-start-project]");
    await scrollToP(page, 0.5);
    await quote.focus();
    await settle(page);
    const p = await pFromScroll(page);
    expect(holdOf(p), `p=${p}`).toBe(3);
    const state = await quote.evaluate((el) => {
      const beat = el.closest<HTMLElement>("[data-beat]");
      const others = Array.from(
        document.querySelectorAll<HTMLElement>("#services [data-beat]"),
      ).filter((b) => !b.contains(el) && !el.contains(b) && !b.contains(beat));
      return {
        own: beat ? Number(getComputedStyle(beat).opacity) : -1,
        othersMax: Math.max(0, ...others.map((b) => Number(getComputedStyle(b).opacity))),
      };
    });
    expect(state.own).toBe(1);
    expect(state.othersMax).toBe(0);
  });

  test("every Tab stop inside the copy sits in its section's hold (scene at rest)", async ({
    page,
  }) => {
    await openScene(page);
    await scrollToP(page, 0);
    const bad: string[] = [];
    let inCopy = 0;
    await inSequence(
      Array.from({ length: 70 }, (_, i) => i),
      async () => {
        await page.keyboard.press("Tab");
        const where = await page.evaluate(() => {
          const el = document.activeElement;
          const section = el?.closest("section[id]");
          const inBody =
            el?.closest("[data-copy-body]") !== null &&
            el?.closest("[data-copy-body]") !== undefined;
          return {
            id: section?.id ?? "",
            inBody,
            label: el?.textContent?.trim().slice(0, 30) ?? "",
          };
        });
        if (!where.inBody) return;
        inCopy += 1;
        await settle(page);
        const p = await pFromScroll(page);
        const k = holdOf(p);
        const index = SECTIONS.findIndex((s) => s.id === where.id);
        if (k !== index) bad.push(`${where.id} "${where.label}" at p=${p.toFixed(4)}`);
      },
    );
    expect(inCopy).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});

test.describe("B-4 the render loop idles within 1.5 s of scrolling stopping", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("last rAF callback ≤ 1.5 s after the last scroll event (wheel and a long jump)", async ({
    page,
  }) => {
    await openScene(page);
    await scrollToP(page, 0.03);
    // Measured from the last scroll event (scroll stop), not from "caught up".
    const watch = async (): Promise<void> => {
      await page.evaluate(() => {
        const w: B4Watch = { lastScroll: 0, lastRaf: 0, stop: false };
        window.b4Watch = w;
        window.addEventListener("scroll", () => {
          w.lastScroll = performance.now();
        });
        let seen = window.darkroomTest?.rafs() ?? 0;
        const poll = (): void => {
          const n = window.darkroomTest?.rafs() ?? 0;
          if (n !== seen) {
            seen = n;
            w.lastRaf = performance.now();
          }
          if (!w.stop) setTimeout(poll, 10);
        };
        poll();
      });
    };
    const result = async (): Promise<B4Watch & { gap: number }> => {
      await page.waitForTimeout(3500);
      return page.evaluate(() => {
        const w = window.b4Watch;
        if (!w) throw new Error("no watch");
        w.stop = true;
        return { ...w, gap: w.lastRaf - w.lastScroll };
      });
    };
    await watch();
    await page.mouse.move(800, 500);
    await inSequence([1, 2, 3, 4, 5], async () => {
      await page.mouse.wheel(0, 900);
    });
    const wheel = await result();
    expect(wheel.lastScroll).toBeGreaterThan(0);
    expect(wheel.lastRaf).toBeGreaterThan(wheel.lastScroll);
    expect(wheel.gap, JSON.stringify(wheel)).toBeLessThanOrEqual(1500);

    await watch();
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    const jump = await result();
    expect(jump.lastScroll).toBeGreaterThan(0);
    expect(jump.lastRaf).toBeGreaterThan(jump.lastScroll);
    expect(jump.gap, JSON.stringify(jump)).toBeLessThanOrEqual(1500);
  });
});
