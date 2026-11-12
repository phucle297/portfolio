/**
 * QA follow-up on PR #3 (TASK-08 attempt 3): real mouse clicks reach the pinned copy (B-1),
 * focus never lands mid-morph (B-5), the render loop idles ≤ 1.5 s after scrolling stops
 * (B-4); attempt 4: every copy card is fully shown inside its section's hold while scrolling
 * (B-7), and every control is shown and takes the click in its hold. Full tier (`?scene-test`, SwiftShader standing in for the GPU), pinned layout.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { beatAt, beatProgress, HOLDS, KEY_PROGRESS, SECTIONS } from "../../src/shared/lib/timeline";
import { inSequence, openScene, scrollToP, settle } from "./helpers";

interface B4Watch {
  lastScroll: number;
  /** `darkroomTest.rafs()` when the last scroll event ran: later ticks come after it. */
  rafsAtScroll: number;
  /**
   * Stage ticks (rAF callbacks that advanced `darkroomTest.rafs()`): callback start time and tick
   * number.
   */
  ticks: { at: number; n: number }[];
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

/**
 * Where control `el` of section `index` is shown: the middle of its own beat's fully-shown
 * stretch of the hold, or the section's key p when the section has a single beat.
 */
async function shownAt(control: Locator, index: number): Promise<number> {
  const { own, count } = await control.evaluate((el) => {
    const body = el.closest("[data-copy-body]");
    const all = Array.from(body?.querySelectorAll<HTMLElement>("[data-beat]") ?? []).flatMap((b) =>
      (b.dataset.beat ?? "").split(/\s+/u).filter(Boolean).map(Number),
    );
    const mine = el.closest<HTMLElement>("[data-beat]")?.dataset.beat?.split(/\s+/u)[0];
    return {
      own: mine === undefined ? 0 : Number(mine),
      count: all.length ? Math.max(...all) + 1 : 1,
    };
  });
  return beatProgress(index, own, count);
}

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

    test("every control is fully shown, unobstructed and the hit-test target in its hold", async ({
      page,
    }) => {
      const misses: string[] = [];
      let audited = 0;
      await inSequence(SECTIONS, async (section, index) => {
        const controls = page.locator(
          `#${section.id} [data-copy-body] :is(a[href], button, input, select, textarea)`,
        );
        const count = await controls.count();
        await inSequence(
          Array.from({ length: count }, (_, i) => i),
          async (i) => {
            const control = controls.nth(i);
            // No control is skipped: each one is checked where its card is shown, which must
            // be inside its section's hold (scene at rest).
            const p = await shownAt(control, index);
            if (holdOf(p) !== index)
              misses.push(`${section.id} #${i}: shown at p=${p} outside the hold`);
            await scrollToP(page, p);
            audited += 1;
            const state = await control.evaluate((el) => {
              // A radio's visible box is its label (the input itself is styled away).
              const box =
                el instanceof HTMLInputElement && el.type === "radio"
                  ? (el.closest("label") ?? el)
                  : el;
              const r = box.getBoundingClientRect();
              let o = 1;
              for (let n: Element | null = box; n; n = n.parentElement)
                o *= Number(getComputedStyle(n).opacity);
              const style = getComputedStyle(box);
              return {
                opacity: o,
                inView: r.width > 0 && r.height > 0 && r.top >= 72 && r.bottom <= innerHeight,
                visible: style.visibility !== "hidden" && style.display !== "none",
                label: `${el.tagName.toLowerCase()}#${el.id} "${(el.textContent ?? "").trim().slice(0, 24)}"`,
              };
            });
            const where = `${section.id} #${i} ${state.label} at p=${p.toFixed(4)}`;
            if (state.opacity < 0.999) misses.push(`${where}: opacity ${state.opacity.toFixed(3)}`);
            if (!state.inView) misses.push(`${where}: not inside the viewport below the header`);
            if (!state.visible) misses.push(`${where}: hidden`);
            const hit = await hitAtCentre(control);
            if (!hit.ok) misses.push(`${where}: hit ${hit.hit} (pointer-events ${hit.pe})`);
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
            if (covered > 0) misses.push(`${where}: ${covered} of 4 edge points covered`);
          },
        );
      });
      // 14 controls in the copy (Hello 2, Services 1, Contact 11).
      expect(audited).toBeGreaterThanOrEqual(14);
      expect(misses).toEqual([]);
    });

    test("Services: 'Get a quote' takes a real mouse click in the Services hold", async ({
      page,
    }) => {
      const quote = page.locator("#services [data-start-project]");
      const p = await shownAt(quote, 3);
      expect(holdOf(p), `p=${p}`).toBe(3);
      await scrollToP(page, p);
      expect(holdOf(await pFromScroll(page))).toBe(3);
      const opacity = await quote.evaluate((el) => {
        let o = 1;
        for (let n: Element | null = el; n; n = n.parentElement)
          o *= Number(getComputedStyle(n).opacity);
        return o;
      });
      expect(opacity).toBeGreaterThanOrEqual(0.999);
      const hit = await hitAtCentre(quote);
      expect(hit, hit.hit).toMatchObject({ ok: true });
      await page.mouse.click(hit.x, hit.y);
      await settle(page);
      expect(await pFromScroll(page)).toBeGreaterThan(SECTIONS[5]?.start ?? 0.84);
      await expect(page.locator("#contact-name")).toBeFocused();
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
      // The project-type select (freelance mode, the default) takes the click and focus;
      // Escape closes its picker if one opened.
      await clickAt(page.locator("#contact-type"));
      await expect(page.locator("#contact-type")).toBeFocused();
      await page.keyboard.press("Escape");
      const fullTime = page.locator('#contact input[data-mode="1"]');
      await clickAt(fullTime);
      await expect(fullTime).toBeChecked();
      // Full-time mode has no project type.
      await expect(page.locator("#contact-type")).toBeHidden();
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

/** One B-7 card result: max opacity seen inside the hold, max outside it, and the p it peaked at. */
interface SweepCard {
  label: string;
  inHold: number;
  outside: number;
  at: number;
}

/**
 * B-7 sweep of one section: continuous scrolling from just before the hold to just after, one
 * scroll step per frame (the scene and copy follow their smoothed p), every card sampled each
 * frame. Δp 4e-4 per frame where cards step (≥ 10 samples per card's fully-shown stretch), 2e-3
 * elsewhere. Each section's sweep starts with its own scrollToP, so sections are independent and
 * run as separate tests (TASK-20261113-16: one 6-section test took 3-5 min on SwiftShader and
 * hit its 300 s cap).
 */
async function sweepSection(
  page: Page,
  index: number,
  positions: readonly number[],
): Promise<SweepCard[]> {
  const section = SECTIONS[index];
  if (!section) throw new Error(`no section ${index}`);
  const hold = HOLDS[index] ?? [0, 0];
  await scrollToP(page, positions[0] ?? Math.max(0, hold[0] - 0.006));
  return page.evaluate(
    async ({ id, ps, holdFrom, holdTo }) => {
      const body = document.querySelector(`#${id} [data-copy-body]`);
      if (!body) return [];
      const beatEls = Array.from(body.querySelectorAll<HTMLElement>("[data-beat]"));
      const els: Element[] = beatEls.length ? beatEls : [body];
      const best = els.map(() => ({ inHold: 0, outside: 0, at: -1 }));
      const max = document.documentElement.scrollHeight - innerHeight;
      for (const p of ps) {
        window.scrollTo({ top: p * max, behavior: "instant" });
        // oxlint-disable-next-line no-await-in-loop -- one sample per frame, in order
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        const shown = window.darkroomTest?.shown() ?? -1;
        const scrolled = scrollY / max;
        els.forEach((el, i) => {
          let o = 1;
          for (let n: Element | null = el; n; n = n.parentElement)
            o *= Number(getComputedStyle(n).opacity);
          const entry = best[i];
          if (!entry) return;
          const inHold =
            shown >= holdFrom && shown <= holdTo && scrolled >= holdFrom && scrolled <= holdTo;
          if (inHold && o > entry.inHold) {
            entry.inHold = o;
            entry.at = shown;
          } else if (!inHold) entry.outside = Math.max(entry.outside, o);
        });
      }
      return els.map((el, i) => ({
        label: `${el.tagName.toLowerCase()}.${el.className.split(" ")[0] ?? ""}[data-beat="${el.getAttribute("data-beat") ?? "-"}"]`,
        inHold: best[i]?.inHold ?? 0,
        outside: best[i]?.outside ?? 0,
        at: best[i]?.at ?? -1,
      }));
    },
    { id: section.id, ps: positions, holdFrom: hold[0], holdTo: hold[1] },
  );
}

/**
 * The scroll positions of section `index`'s sweep, computed exactly as the original single loop
 * did (`for (let p = from; p <= to; p += dp)`, same float accumulation): from just before the
 * hold to just after, Δp 4e-4 where cards step (≥ 10 samples per card's fully-shown stretch),
 * 2e-3 elsewhere.
 */
function sweepPositions(index: number, stepped: boolean): number[] {
  const hold = HOLDS[index] ?? [0, 0];
  const from = Math.max(0, hold[0] - 0.006);
  const to = Math.min(1, hold[1] + 0.006);
  const dp = stepped ? 4e-4 : 2e-3;
  const ps: number[] = [];
  for (let p = from; p <= to; p += dp) ps.push(p);
  return ps;
}

/**
 * Sections whose sweep is split into one test per beat. Journey is 230 frames and took 105-211 s
 * alone on ubuntu-24.04 + SwiftShader at 1600×1000 (TASK-20261113-16 diag run 43274462813),
 * too close to the 300 s cap. A chunk is every sweep position where `beatAt` is that beat, so the
 * chunks partition the positions exactly, and each beat's fully-shown stretch (which ends half a
 * crossfade before the handover) lies inside its own chunk.
 */
const SPLIT_BY_BEAT: ReadonlyMap<string, number> = new Map([["journey", 3]]);

/**
 * Cards B-7 samples in each section, in sweep order: every [data-beat] element (with its first
 * beat), or the copy body (beat 0) when it has none.
 */
async function cardInventory(page: Page): Promise<number[][]> {
  return page.evaluate(
    (ids) =>
      ids.map((id) => {
        const body = document.querySelector(`#${id} [data-copy-body]`);
        if (!body) return [];
        const beats = Array.from(body.querySelectorAll<HTMLElement>("[data-beat]"));
        if (!beats.length) return [0];
        return beats.map((el) => Number((el.dataset.beat ?? "0").split(/\s+/u)[0]));
      }),
    SECTIONS.map((s) => s.id),
  );
}

test.describe("B-7 every copy card is fully shown inside its section's hold while scrolling", () => {
  for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
    const size = viewport ?? { width: 1600, height: 1000 };
    const at = `${size.width}×${size.height}`;

    test(`card inventory at ${at}`, async ({ page }) => {
      await page.setViewportSize(size);
      await openScene(page);
      await expect(page.locator("html")).toHaveAttribute("data-pin", "on");
      const cards = (await cardInventory(page)).reduce((n, section) => n + section.length, 0);
      // 6 sections; Journey and Services step through their cards.
      expect(cards).toBeGreaterThanOrEqual(13);
    });

    SECTIONS.forEach((section, index) => {
      const beats = SPLIT_BY_BEAT.get(section.id);
      const chunks: (number | undefined)[] = beats
        ? Array.from({ length: beats }, (_, b) => b)
        : [undefined];
      for (const chunk of chunks) {
        const name = chunk === undefined ? section.id : `${section.id} beat ${chunk}`;
        test(`scroll sweep at ${at}: ${name}`, async ({ page }) => {
          test.setTimeout(300_000);
          await page.setViewportSize(size);
          await openScene(page);
          await expect(page.locator("html")).toHaveAttribute("data-pin", "on");
          const cardBeats = (await cardInventory(page))[index] ?? [];
          const stepped =
            (await page.locator(`#${section.id} [data-copy-body] [data-beat]`).count()) > 0;
          const all = sweepPositions(index, stepped);
          const count = Math.max(...cardBeats) + 1;
          const positions =
            chunk === undefined ? all : all.filter((p) => beatAt(p, index, count) === chunk);
          expect(positions.length).toBeGreaterThan(0);
          const result = await sweepSection(page, index, positions);
          // Every card of the section was sampled.
          expect(result).toHaveLength(cardBeats.length);
          expect(result.length).toBeGreaterThanOrEqual(1);
          // A split section asserts each card in the chunk of its own (first) beat; together the
          // chunks assert every card once, over exactly the positions of the unsplit sweep.
          const failures = result
            .filter((_, i) => chunk === undefined || cardBeats[i] === chunk)
            .filter((card) => (card.inHold ?? 0) < 0.999)
            .map(
              (card) =>
                `${section.id} ${card.label}: max opacity in hold ${card.inHold?.toFixed(3)} (outside ${card.outside?.toFixed(3)})`,
            );
          expect(failures).toEqual([]);
        });
      }
    });
  }
});

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

/** M2-AC10 idle budget: 0 rAF callbacks later than this after the last scroll event. */
const B4_BUDGET_MS = 1500;
/** M2-AC10: after stopping, 0 rAF callbacks in the next 2 s. */
const B4_QUIET_MS = 2000;

interface B4Verdict {
  gap: number;
  ticksAfterScroll: number;
}

/**
 * M2-AC10 / PF-15 AC2, as agreed for B-4 (TASK-20261113-19): "0 rAF after 1.5 s idle" means the
 * last stage rAF callback *starts* ≤ 1500 ms after the last scroll event (definition 1). The
 * time is taken at callback start, not when its draw work finishes or a poll notices it, so a
 * slow draw on a loaded host does not count. The bound is strict 1500 ms, slow frames included:
 * no host-stall allowance. Measured from scroll stop, not from settle.
 */
function b4Verdict(w: B4Watch): B4Verdict {
  // "After" is by tick number, not time: performance.now() is coarse enough that the last scroll
  // event and the tick right after it can carry the same timestamp.
  const after = w.ticks.filter((tick) => tick.n > w.rafsAtScroll);
  const last = after.at(-1);
  return { gap: last ? last.at - w.lastScroll : Number.NaN, ticksAfterScroll: after.length };
}

function b4Check(r: B4Watch & B4Verdict, label: string): void {
  const summary = JSON.stringify({ label, ...r, ticks: r.ticks.length });
  expect(r.lastScroll, summary).toBeGreaterThan(0);
  expect(r.ticksAfterScroll, summary).toBeGreaterThan(0);
  expect(r.gap, summary).toBeLessThanOrEqual(B4_BUDGET_MS);
}

test.describe("B-4 the render loop idles within 1.5 s of scrolling stopping", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("last rAF callback ≤ 1.5 s after the last scroll event (wheel and a long jump)", async ({
    page,
  }) => {
    // Time every stage tick where its callback starts (definition 1, see b4Verdict), not when a
    // poll notices it, so a slow draw or a late poll on a loaded host does not count.
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) =>
        raf((ts) => {
          const at = performance.now();
          const before = window.darkroomTest?.rafs() ?? 0;
          try {
            callback(ts);
          } finally {
            // Recorded even if the callback throws, so no tick goes uncounted.
            const w = window.b4Watch;
            const n = window.darkroomTest?.rafs() ?? 0;
            if (w && !w.stop && n !== before) w.ticks.push({ at, n });
          }
        });
    });
    await openScene(page);
    await scrollToP(page, 0.03);
    // Measured from the last scroll event (scroll stop), not from "caught up".
    const watch = async (): Promise<void> => {
      await page.evaluate(() => {
        const w: B4Watch = { lastScroll: 0, rafsAtScroll: 0, ticks: [], stop: false };
        window.b4Watch = w;
        window.addEventListener("scroll", () => {
          w.lastScroll = performance.now();
          w.rafsAtScroll = window.darkroomTest?.rafs() ?? 0;
        });
      });
    };
    const result = async (label: string): Promise<B4Watch & B4Verdict> => {
      // Watch ≥ 3.5 s after the last scroll and until the loop has been quiet for 2 s; a loop
      // that never idles never gets there and fails here.
      await page
        .waitForFunction(
          ({ quiet, min }) => {
            const w = window.b4Watch;
            if (!w || w.lastScroll === 0) return false;
            const now = performance.now();
            const lastTick = w.ticks.at(-1)?.at ?? 0;
            return now - w.lastScroll >= min && now - Math.max(lastTick, w.lastScroll) >= quiet;
          },
          { quiet: B4_QUIET_MS, min: 3500 },
          { timeout: 20_000, polling: 100 },
        )
        .catch(() => {
          throw new Error(`${label}: the render loop did not go quiet for ${B4_QUIET_MS} ms`);
        });
      const w = await page.evaluate(() => {
        const watched = window.b4Watch;
        if (!watched) throw new Error("no watch");
        watched.stop = true;
        return {
          lastScroll: watched.lastScroll,
          rafsAtScroll: watched.rafsAtScroll,
          ticks: watched.ticks,
          stop: true,
        };
      });
      const verdict = { ...w, ...b4Verdict(w) };
      test.info().annotations.push({
        type: `B-4 ${label}`,
        description: JSON.stringify({ ...verdict, ticks: w.ticks.length }),
      });
      return verdict;
    };

    await watch();
    await page.mouse.move(800, 500);
    await inSequence([1, 2, 3, 4, 5], async () => {
      await page.mouse.wheel(0, 900);
    });
    b4Check(await result("wheel"), "wheel");

    await watch();
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    b4Check(await result("jump"), "jump");
  });
});
