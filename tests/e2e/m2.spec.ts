/**
 * M2 behaviour on the full tier (SwiftShader stands in for the GPU): pinned copy and its scrub
 * (AC8), native keys / anchors / Tab (AC9) and the idle render loop (AC10).
 */
import { expect, test, type Page } from "@playwright/test";
import { COPY_TRAVEL_PX, copyState, KEY_PROGRESS } from "../../src/shared/lib/timeline";
import { inSequence, openScene, scrollToP, SECTION_IDS, settle } from "./helpers";

test.use({ viewport: { width: 1600, height: 1000 } });

async function copyStyles(page: Page) {
  return page.evaluate((ids) => {
    return ids.map((id) => {
      const body = document.querySelector<HTMLElement>(`#${id} [data-copy-body]`);
      if (!body) throw new Error(`no body for ${id}`);
      const cs = getComputedStyle(body);
      const matrix = new DOMMatrixReadOnly(cs.transform === "none" ? undefined : cs.transform);
      return {
        id,
        opacity: Number(cs.opacity),
        y: matrix.m42,
        position: cs.position,
        display: cs.display,
        visibility: cs.visibility,
      };
    });
  }, SECTION_IDS);
}

test.describe("M2-AC8 pinned copy and scrub", () => {
  test("copy is pinned over the scene and follows the scrub table", async ({ page }) => {
    await openScene(page);
    await expect(page.locator("html")).toHaveAttribute("data-pin", "on");
    expect(await page.evaluate(() => window.darkroomTest?.pinned())).toBe(true);
    // Holds, exits (t .1/.3), the empty middle (t .5) and enters (t .7/.9) of morphs 1, 3 and 5.
    const samples = [
      ...KEY_PROGRESS,
      0.071,
      0.093,
      0.115,
      0.137,
      0.159,
      0.468,
      0.505,
      0.54,
      0.575,
      0.802,
      0.83,
      0.88,
      0.906,
    ];
    await inSequence(samples, async (p) => {
      await scrollToP(page, p);
      const shown = await page.evaluate(() => window.darkroomTest?.shown() ?? -1);
      const styles = await copyStyles(page);
      styles.forEach((s, index) => {
        const expected = copyState(shown, index);
        expect(s.position, `${s.id} at p=${p}`).toBe("fixed");
        expect(s.display).not.toBe("none");
        expect(s.visibility).toBe("visible");
        expect(
          Math.abs(s.opacity - expected.opacity),
          `${s.id} opacity at p=${p}`,
        ).toBeLessThanOrEqual(0.01);
        expect(Math.abs(s.y - expected.y), `${s.id} y at p=${p}`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(s.y)).toBeLessThanOrEqual(COPY_TRAVEL_PX);
      });
      expect(styles.filter((s) => s.opacity > 0).length).toBeLessThanOrEqual(1);
    });
  });

  test("nav aria-current switches at 12/30/52/68/84 % (±.5)", async ({ page }) => {
    await openScene(page);
    const boundaries = [0.12, 0.3, 0.52, 0.68, 0.84];
    const checks = boundaries.flatMap((b, i) => [
      [b - 0.005, SECTION_IDS[i] ?? ""] as const,
      [b + 0.005, SECTION_IDS[i + 1] ?? ""] as const,
    ]);
    await inSequence(checks, async ([p, id]) => {
      {
        await page.evaluate((target) => {
          window.scrollTo({
            top: target * (document.documentElement.scrollHeight - innerHeight),
            behavior: "instant",
          });
        }, p);
        await expect(page.locator(`.site-header__nav a[aria-current="true"]`)).toHaveAttribute(
          "data-section-link",
          id,
        );
      }
    });
  });

  test("focus inside hidden copy brings it on screen; focus-within forces opacity 1", async ({
    page,
  }) => {
    await openScene(page);
    await scrollToP(page, 0.03);
    const link = page.locator("#contact a[href^='mailto:']").first();
    await link.focus();
    await settle(page);
    const state = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>("#contact [data-copy-body]");
      return {
        opacity: body ? Number(getComputedStyle(body).opacity) : -1,
        p: scrollY / (document.documentElement.scrollHeight - innerHeight),
      };
    });
    expect(state.opacity).toBe(1);
    expect(state.p).toBeGreaterThan(0.84);
    // focus-within: even mid-morph (no copy scheduled) the focused section is opaque.
    await page.evaluate(() => {
      window.darkroomTest?.set(0.5);
    });
    const services = page
      .locator(
        "#services [data-beat='0'] a, #services [data-beat='0'] button, #services a, #services button",
      )
      .first();
    if ((await services.count()) > 0) {
      await services.focus();
      await page.evaluate(() => window.darkroomTest?.set(0.5));
      const opacity = await page.evaluate(() =>
        Number(
          getComputedStyle(document.querySelector("#services [data-copy-body]") ?? document.body)
            .opacity,
        ),
      );
      expect(opacity).toBe(1);
    }
  });

  test("pinned layouts fit: nothing overflows the viewport at 1600×1000 and 1280×800", async ({
    page,
  }) => {
    const sizes = [
      [1600, 1000],
      [1280, 800],
    ] as const;
    await inSequence(sizes, async ([w, h]) => {
      await page.setViewportSize({ width: w, height: h });
      await openScene(page);
      await expect(page.locator("html")).toHaveAttribute("data-pin", "on");
      await inSequence(KEY_PROGRESS, async (p, index) => {
        await scrollToP(page, p);
        const overflow = await page.evaluate((id) => {
          const body = document.querySelector<HTMLElement>(`#${id} [data-copy-body]`);
          if (!body) return ["no body"];
          return Array.from(body.querySelectorAll<HTMLElement>("*"))
            .filter((el) => getComputedStyle(el).opacity !== "0" && el.getClientRects().length > 0)
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 0 &&
                (r.left < -1 ||
                  r.right > innerWidth + 1 ||
                  r.top < -1 ||
                  r.bottom > innerHeight + 1)
              );
            })
            .map((el) => `${el.tagName}.${el.className}`);
        }, SECTION_IDS[index] ?? "");
        expect(overflow, `${w}×${h} ${SECTION_IDS[index]}`).toEqual([]);
      });
    });
  });

  test("below the pin query (1280×720) the copy keeps the normal flow", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openScene(page);
    await expect(page.locator("html")).not.toHaveAttribute("data-pin", "on");
    const position = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector("#work [data-copy-body]") ?? document.body)
          .position,
    );
    expect(position).toBe("relative");
  });
});

test.describe("M2-AC10 render loop idles", () => {
  test("0 rAF callbacks in the 2 s after 1.5 s idle; none while hidden", async ({ page }) => {
    await openScene(page);
    await page.mouse.wheel(0, 1200);
    await settle(page);
    await page.waitForTimeout(1500);
    const { rafs, events } = await page.evaluate(async () => {
      const seen: string[] = [];
      const log = (e: Event): void => {
        seen.push(`${e.type}@${Math.round(performance.now())} y=${Math.round(scrollY)}`);
      };
      window.addEventListener("scroll", log);
      window.addEventListener("resize", log);
      const start = window.darkroomTest?.rafs() ?? -1;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      window.removeEventListener("scroll", log);
      window.removeEventListener("resize", log);
      return { rafs: (window.darkroomTest?.rafs() ?? -1) - start, events: seen };
    });
    expect(rafs, events.join(", ")).toBe(0);

    const hidden = await page.evaluate(async () => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const start = window.darkroomTest?.rafs() ?? 0;
      window.scrollBy(0, 800);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return (window.darkroomTest?.rafs() ?? 0) - start;
    });
    expect(hidden).toBe(0);
  });
});

test.describe("PF-49 no Safelight toggle", () => {
  test("header has no Safelight control, and a saved off value still leaves lights on", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem("safelight", "off");
    });
    await openScene(page);
    await expect(page.locator("[data-safelight-toggle]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /safelight|lights on|lights off/i })).toHaveCount(
      0,
    );
    await expect(page.locator("[data-motion-toggle]")).toBeVisible();
    await expect(page.locator(".site-header__pill")).toBeVisible();
    await expect(page.locator(".site-header__nav")).toBeVisible();
    expect(await page.evaluate(() => window.darkroomTest?.safelight())).toBe(true);
    // At the top of the page the designed glow is 1; the old "off" modifier would have left 0.12.
    const glow = await page.evaluate(() => window.darkroomTest?.state().lamp.glowOpacity ?? -1);
    expect(glow).toBeCloseTo(1, 2);
  });

  test("static tier also has no Safelight control", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.locator("[data-safelight-toggle]")).toHaveCount(0);
    await expect(page.locator("[data-motion-toggle]")).toBeVisible();
    await expect(page.locator(".site-header__pill")).toBeVisible();
  });
});
