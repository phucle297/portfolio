import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { hideLoader, inSequence, isSceneChunk, spoofHardwareGpu } from "./helpers";
import { gray, poseDelta, type Gray, type PoseDelta } from "./tray-pose";

/**
 * PF-87 (Owner 2026-11-23, prod Firefox ~1024 px, a short window): the hero must settle once and
 * never move. The Owner's shots showed the live tray smaller and lower-left of the still (bottom
 * edge ~y495 -> ~465, right edge moved): the 8:5 intro still was shown with object-fit: cover, so
 * on a viewport wider than 8:5 it was width-fitted, while the live camera keeps its vertical FOV.
 * PF-84's check ran only at height 900 (narrower than 8:5), where both are height-fitted.
 *
 * The Owner's case, 1024×540 (wider than 8:5), from first paint to 60 s with no input:
 * - text (no GPU needed, blocking on Chromium and Firefox): heading, subtitle, lede, both buttons,
 *   the brand and the nav links move 0 px (<= 0.5 px rounding), sampled on every frame;
 * - pose (needs the live scene; title says "full tier", so the no-GPU Firefox CI job leaves it to
 *   the manual GPU set, PF-81; Chromium runs it on SwiftShader in the blocking job): the first
 *   still frame vs the live tray after the swap and every ~10 s to 60 s: each tray corner within
 *   2 px of the still and tilt within 0.5° (Designer, PF-87), and 0 px (<= 1 px) frame to frame.
 *
 * Pose = a similarity transform fitted on the tray's edges (tests/e2e/tray-pose.ts): tone may
 * differ between the AVIF still and the live render (PF-84 judges tone), geometry may not. The copy is hidden (visibility only: no layout change) for the frames.
 * Evidence: HERO_SETTLE_OUT=/path writes the frames and numbers.
 */

const VIEWPORT = { width: 1024, height: 540 } as const;
const IDLE_MS = 60_000;
const SAMPLE_EVERY_MS = 10_000;
const MAX_TEXT_PX = 0.5;
const MAX_CORNER_PX = 2;
const MAX_TILT_DEG = 0.5;
const MAX_DRIFT_PX = 1;
/** Below this the fit found no real match (another pose or scale). Fixed build: 0.92-0.95. */
const MIN_MATCH = 0.8;
const OUT = process.env.HERO_SETTLE_OUT;

const TEXT = {
  h1: "#hello-title",
  subtitle: ".hello__subtitle",
  lede: ".hello__lede",
  primary: ".hello .button--primary",
  ghost: ".hello .button--ghost",
  header: "body > header",
  navLinks: "body > header nav a",
  brand: "body > header a",
} as const;

const HIDE_COPY = `body * { visibility: hidden !important; }
  [data-still], [data-still] *, .darkroom-scene, .darkroom-scene * { visibility: visible !important; }`;

interface TextLog {
  frames: number;
  first: Record<string, number[]> | null;
  maxMove: Record<string, number>;
  missing: string[];
}

declare global {
  interface Window {
    pf87Text?: TextLog;
    pf87Stop?: () => void;
  }
}

/** Every frame from the first one with the Hello heading: each watched box vs its first box. */
const TEXT_SAMPLER = (watched: Record<string, string>): void => {
  const log: TextLog = { frames: 0, first: null, maxMove: {}, missing: [] };
  window.pf87Text = log;
  let on = true;
  window.pf87Stop = () => {
    on = false;
  };
  const read = (): Record<string, number[]> | null => {
    if (!document.querySelector(watched.h1 ?? "")) return null;
    const out: Record<string, number[]> = {};
    for (const [name, selector] of Object.entries(watched)) {
      document.querySelectorAll(selector).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        out[`${name}${i}`] = [r.x, r.y, r.width, r.height];
      });
    }
    return out;
  };
  const loop = (): void => {
    if (!on) return;
    const now = read();
    if (now) {
      log.frames += 1;
      log.first ??= now;
      for (const [key, box] of Object.entries(log.first)) {
        const cur = now[key];
        if (!cur) {
          if (!log.missing.includes(key)) log.missing.push(key);
          continue;
        }
        const d = Math.max(...box.map((v, i) => Math.abs(v - (cur[i] ?? v))));
        log.maxMove[key] = Math.max(log.maxMove[key] ?? 0, d);
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

async function frame(page: Page): Promise<Buffer> {
  const style = await page.addStyleTag({ content: HIDE_COPY });
  const png = await page.screenshot({ type: "png" });
  await style.evaluate((el: Element) => {
    el.remove();
  });
  return png;
}

/** Hold the scene chunk until `release()`, so the first still frame is always on screen. */
async function holdScene(page: Page): Promise<() => void> {
  const { promise: held, resolve: release } = Promise.withResolvers<null>();
  await page.route(
    (url) => isSceneChunk(url.href),
    async (route: Route) => {
      await held;
      await route.continue();
    },
  );
  return () => {
    release(null);
  };
}

/** The intro still has arrived and finished its fade-in (the sharp print, not the placeholder). */
async function stillShown(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>('[data-still="0"] img');
    return (
      img !== null &&
      img.complete &&
      img.classList.contains("is-loaded") &&
      Number(getComputedStyle(img).opacity) === 1
    );
  });
}

function save(name: string, data: Buffer | string): void {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), data);
}

test.describe("PF-87 hero settles once at 1024×540", () => {
  test.use({ viewport: VIEWPORT });

  test("PF-87 AC3 text: heading, copy, buttons and nav move 0 px from first paint to 60 s", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(IDLE_MS + 60_000);
    // The scene may mount (live swap) where the engine has WebGL; the text must not move either way.
    await spoofHardwareGpu(page);
    await page.addInitScript(TEXT_SAMPLER, TEXT);
    const t0 = Date.now();
    await page.goto("/");
    await page.waitForTimeout(Math.max(0, IDLE_MS - (Date.now() - t0)));
    await page.evaluate(() => window.pf87Stop?.());
    const log = await page.evaluate(() => window.pf87Text);
    const tier = await page.evaluate(() => document.documentElement.dataset.tier ?? null);
    save(`text-${browserName}.json`, JSON.stringify({ tier, ...log }, null, 2));
    expect(log?.first, "the Hello heading was never painted").toBeTruthy();
    expect(log?.missing, "watched boxes that disappeared").toEqual([]);
    const moved = Object.entries(log?.maxMove ?? {}).filter(([, d]) => d > MAX_TEXT_PX);
    expect(moved, `boxes that moved > ${MAX_TEXT_PX} px over ${log?.frames} frames`).toEqual([]);
  });

  test("PF-87 AC3 pose: full tier, the live tray rests on the still's pose from the swap to 60 s", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(IDLE_MS + 90_000);
    await spoofHardwareGpu(page);
    // The swap must be visible (no cover over it), as in PF-84's hero-handover check.
    await hideLoader(page);
    const release = await holdScene(page);
    const t0 = Date.now();
    await page.goto("/");
    await stillShown(page);
    const stillPng = await frame(page);
    const still = await gray(stillPng);
    save(`pose-${browserName}-still.png`, stillPng);

    release();
    await page.waitForFunction(
      () =>
        document.documentElement.hasAttribute("data-scene-shown") &&
        document.querySelector<HTMLElement>('[data-still="0"] picture')?.getAnimations().length ===
          0,
      null,
      { timeout: 45_000 },
    );
    await page.waitForTimeout(1000);
    const report: { t: number; vsStill: PoseDelta | null; drift: PoseDelta | null }[] = [];
    let previous: Gray | null = null;
    // One frame now (swap + 1 s), then every 10 s, the last one at 60 s after navigation.
    const start = Date.now() - t0;
    const due = [start];
    for (let t = SAMPLE_EVERY_MS; t < IDLE_MS; t += SAMPLE_EVERY_MS) if (t > start) due.push(t);
    due.push(IDLE_MS);
    await inSequence(due, async (at) => {
      await page.waitForTimeout(Math.max(0, at - (Date.now() - t0)));
      const png = await frame(page);
      const t = Date.now() - t0;
      const live = await gray(png);
      report.push({
        t,
        vsStill: poseDelta(still, live),
        drift: previous ? poseDelta(previous, live) : null,
      });
      previous = live;
      save(`pose-${browserName}-live-${Math.round(t / 1000)}s.png`, png);
    });
    save(`pose-${browserName}.json`, JSON.stringify(report, null, 2));
    expect(report.at(-1)?.t ?? 0, "sampled through 60 s").toBeGreaterThanOrEqual(IDLE_MS);
    for (const { t, vsStill, drift } of report) {
      expect(vsStill, `lit tray in the still and at ${t} ms`).not.toBeNull();
      expect(vsStill?.match ?? 0, `tray edges match the still at ${t} ms`).toBeGreaterThanOrEqual(
        MIN_MATCH,
      );
      expect(vsStill?.corner ?? Infinity, `corner vs still at ${t} ms (px)`).toBeLessThanOrEqual(
        MAX_CORNER_PX,
      );
      expect(vsStill?.tilt ?? Infinity, `tilt vs still at ${t} ms (deg)`).toBeLessThanOrEqual(
        MAX_TILT_DEG,
      );
      if (drift)
        expect(drift.corner, `frame-to-frame drift at ${t} ms (px)`).toBeLessThanOrEqual(
          MAX_DRIFT_PX,
        );
    }
  });
});
