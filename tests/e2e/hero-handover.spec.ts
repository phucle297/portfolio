import fs from "node:fs";
import path from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import sharp from "sharp";
import { hideLoader, spoofHardwareGpu } from "./helpers";

/**
 * PF-84: when the developed intro still hands over to the live 3D tray, the visitor sees no jump
 * (design/hero-handover/design.md, QA tolerance).
 *
 * Every composited frame is recorded (CDP screencast) from the cold load until 1 s after the
 * swap, together with a per-rAF log of what is on top: the still (displayed, opaque), a crossfade,
 * or the live canvas. Each frame shown from the swap to swap + 1 s (and the settled frame after
 * swap + 2 s) is compared with the last still frame before the swap:
 * - print present: luminance std-dev in the tray crop >= 80 % of the still's (blank paper fails);
 * - tone: tray-crop mean dE2000 <= 3 and no 8x8 cell over dE 6; whole-frame mean luminance
 *   within +-3 % (catches the dark dip of a canvas shown before it has faded in);
 * - geometry: the tray crop's best alignment with the still is within 2 px;
 * - monotonic: exactly one still -> live transition, never live -> still.
 * Phones (390) never mount the scene: the in-flow still stays and nothing swaps.
 *
 * The loader cover is hidden (helpers.hideLoader) so the swap is always visible: the check holds
 * for any loader and is the strict case, the canvas fading in over the still. PF-75 AC4 adds the
 * other branch: the instant swap under the opaque iris cover (0 changed pixels). Chromium
 * only: it needs the SwiftShader-backed scene, CDP screencast and CPU throttling.
 */

const DESKTOP_WIDTHS = [1440, 1280, 1024] as const;
const HEIGHT = 900;
const WINDOW_MS = 1000;
const STD_RATIO = 0.8;
const MAX_MEAN_DE = 3;
const MAX_CELL_DE = 6;
const MAX_LUMA_DELTA = 0.03;
const MAX_SHIFT_PX = 2;
/** Optional evidence output (numbers JSON + frames), e.g. HERO_HANDOVER_OUT=/tmp/pf84. */
const OUT = process.env.HERO_HANDOVER_OUT;

/** Tray print crop in the 1440x900 still (design: 500-880 x 300-450 at 1024 wide). */
const TRAY_1440 = { x0: 703, y0: 422, x1: 1237, y1: 633 };

interface Sample {
  t: number;
  still: number;
  canvas: number;
  pin: string | null;
  tier: string | null;
}

interface Frame {
  t: number;
  png: Buffer;
}

interface Metrics {
  t: number;
  std: number;
  meanDE: number;
  maxCellDE: number;
  luma: number;
}

declare global {
  interface Window {
    pf84Log?: Sample[];
    /** PF-75 AC4: when the held loader cover froze (epoch ms), and its release. */
    pf75Frozen?: number;
    pf75Release?: () => void;
  }
}

const INIT = `(() => {
  const log = [];
  window.pf84Log = log;
  const opacity = (el) => {
    if (!el) return 0;
    let o = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      o *= Number(cs.opacity);
    }
    return o;
  };
  const loop = () => {
    const html = document.documentElement;
    const still = document.querySelector('[data-still="0"] img');
    const canvas = document.querySelector(".darkroom-scene__canvas");
    if (html) log.push({
      t: performance.timeOrigin + performance.now(),
      still: opacity(still),
      canvas: opacity(canvas),
      pin: html.dataset.pin ?? null,
      tier: html.dataset.tier ?? null,
    });
    if (log.length < 20000) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();`;

/**
 * PF-75 AC4: hold the loader cover in its wait state until window.pf75Release(): the fonts gate
 * (document.fonts.ready) stays pending, the loader's 2.6 s ready cap is dropped (only that timer:
 * its callback sets `done = true`), and from 900 ms the cover's animations (pulse, failsafe) are
 * paused, so the cover is static and opaque while the scene mounts under it.
 */
/** The lazily imported scene module (DarkroomScene → stage.ts). */
const STAGE_CHUNK = /\/_astro\/stage\.[\w-]+\.js/;

const HOLD_LOADER = `(() => {
  const ready = Object.getOwnPropertyDescriptor(FontFaceSet.prototype, "ready");
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  Object.defineProperty(FontFaceSet.prototype, "ready", {
    configurable: true,
    get() { return gate.then(() => ready.get.call(this)); },
  });
  const timeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) =>
    typeof ms === "number" && ms > 2000 && ms <= 2600 && String(fn).includes("done = true")
      ? 0
      : timeout(fn, ms, ...rest);
  const freeze = new CSSStyleSheet();
  freeze.replaceSync("html:not(.is-ready) .loader, html:not(.is-ready) .loader::before, html:not(.is-ready) .loader::after, html:not(.is-ready) .loader i { animation-play-state: paused !important; }");
  timeout(() => {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, freeze];
    window.pf75Frozen = performance.timeOrigin + performance.now() + 100;
  }, 900);
  window.pf75Release = () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== freeze);
    release();
  };
})();`;

async function startScreencast(cdp: CDPSession, width: number, height: number): Promise<Frame[]> {
  const frames: Frame[] = [];
  cdp.on("Page.screencastFrame", (event) => {
    frames.push({
      t: (event.metadata.timestamp ?? 0) * 1000,
      png: Buffer.from(event.data, "base64"),
    });
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => null);
  });
  await cdp.send("Page.startScreencast", {
    format: "png",
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });
  return frames;
}

async function throttle(cdp: CDPSession): Promise<void> {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: Math.floor((1.6 * 1024 * 1024) / 8),
    uploadThroughput: Math.floor((0.75 * 1024 * 1024) / 8),
    latency: 150,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
}

// --- colour maths -------------------------------------------------------------------------------

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.040_45 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const labF = (t: number): number => (t > 216 / 24_389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);

function lab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = labF;
  const x = f((0.412_456_4 * R + 0.357_576_1 * G + 0.180_437_5 * B) / 0.950_47);
  const y = f(0.212_672_9 * R + 0.715_152_2 * G + 0.072_175 * B);
  const z = f((0.019_333_9 * R + 0.119_192 * G + 0.950_304_1 * B) / 1.088_83);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 (Sharma et al. 2005). */
function de2000(a: [number, number, number], b: [number, number, number]): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (x: number, y: number): number => {
    if (x === 0 && y === 0) return 0;
    const d = Math.atan2(y, x) / rad;
    return d < 0 ? d + 360 : d;
  };
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (hpm + 360) / 2 : (hpm - 360) / 2;
    else hpm /= 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hpm - 30) * rad) +
    0.24 * Math.cos(2 * hpm * rad) +
    0.32 * Math.cos((3 * hpm + 6) * rad) -
    0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

async function raw(png: Buffer): Promise<Raw> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

const luma = (d: Buffer, i: number): number =>
  0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);

/** The tray crop for a viewport: the 1440x900 still is shown with object-fit: cover, centred. */
function trayCrop(
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const s = Math.max(width / 1440, height / 900);
  const ox = (width - 1440 * s) / 2;
  const oy = (height - 900 * s) / 2;
  const clampX = (v: number): number => Math.max(0, Math.min(width - 8, Math.round(v)));
  const clampY = (v: number): number => Math.max(0, Math.min(height - 8, Math.round(v)));
  return {
    x0: clampX(ox + TRAY_1440.x0 * s),
    y0: clampY(oy + TRAY_1440.y0 * s),
    x1: clampX(ox + TRAY_1440.x1 * s),
    y1: clampY(oy + TRAY_1440.y1 * s),
  };
}

function meanLuma(img: Raw): number {
  let sum = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i += 1) sum += luma(img.data, i * 3);
  return sum / n;
}

function cropStd(img: Raw, c: ReturnType<typeof trayCrop>): number {
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let y = c.y0; y < c.y1; y += 1)
    for (let x = c.x0; x < c.x1; x += 1) {
      const v = luma(img.data, (y * img.width + x) * 3);
      sum += v;
      sq += v * v;
      n += 1;
    }
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

function compare(
  ref: Raw,
  img: Raw,
  c: ReturnType<typeof trayCrop>,
): Omit<Metrics, "t" | "luma" | "std"> {
  let total = 0;
  let n = 0;
  let maxCell = 0;
  for (let cy = c.y0; cy + 8 <= c.y1; cy += 8)
    for (let cx = c.x0; cx + 8 <= c.x1; cx += 8) {
      const ma = [0, 0, 0];
      const mb = [0, 0, 0];
      for (let y = cy; y < cy + 8; y += 1)
        for (let x = cx; x < cx + 8; x += 1) {
          const i = (y * img.width + x) * 3;
          for (let k = 0; k < 3; k += 1) {
            ma[k] = (ma[k] ?? 0) + (ref.data[i + k] ?? 0);
            mb[k] = (mb[k] ?? 0) + (img.data[i + k] ?? 0);
          }
          // Per-pixel dE on every other pixel keeps the cost down without losing the mean.
          if ((x + y) % 2 === 0) {
            total += de2000(
              lab(ref.data[i] ?? 0, ref.data[i + 1] ?? 0, ref.data[i + 2] ?? 0),
              lab(img.data[i] ?? 0, img.data[i + 1] ?? 0, img.data[i + 2] ?? 0),
            );
            n += 1;
          }
        }
      const cell = de2000(
        lab((ma[0] ?? 0) / 64, (ma[1] ?? 0) / 64, (ma[2] ?? 0) / 64),
        lab((mb[0] ?? 0) / 64, (mb[1] ?? 0) / 64, (mb[2] ?? 0) / 64),
      );
      maxCell = Math.max(maxCell, cell);
    }
  return { meanDE: total / n, maxCellDE: maxCell };
}

/** Best integer alignment (|dx|, |dy| <= 4) of the frame's tray crop with the still's. */
function bestShift(ref: Raw, img: Raw, c: ReturnType<typeof trayCrop>): number {
  let best = { d: Number.POSITIVE_INFINITY, s: 0 };
  for (let dy = -4; dy <= 4; dy += 1)
    for (let dx = -4; dx <= 4; dx += 1) {
      let diff = 0;
      let n = 0;
      for (let y = c.y0 + 4; y < c.y1 - 4; y += 2)
        for (let x = c.x0 + 4; x < c.x1 - 4; x += 2) {
          const yy = y + dy;
          const xx = x + dx;
          if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) continue;
          diff += Math.abs(
            luma(ref.data, (y * ref.width + x) * 3) - luma(img.data, (yy * img.width + xx) * 3),
          );
          n += 1;
        }
      const d = diff / Math.max(1, n);
      // Prefer the smaller shift on a tie.
      if (d < best.d - 0.05 || (Math.abs(d - best.d) <= 0.05 && Math.hypot(dx, dy) < best.s))
        best = { d, s: Math.hypot(dx, dy) };
    }
  return best.s;
}

/** On top of the page: the still (opaque), a crossfade, or the live canvas. */
const shows = (s: Sample): "still" | "fade" | "live" | "none" =>
  s.still >= 0.999 ? "still" : s.still > 0.001 ? "fade" : s.canvas > 0.001 ? "live" : "none";

function sampleAt(log: Sample[], t: number): Sample | undefined {
  let found: Sample | undefined;
  for (const s of log) {
    if (s.t > t) break;
    found = s;
  }
  return found;
}

async function record(page: Page, width: number, throttled: boolean, label: string) {
  await page.setViewportSize({ width, height: HEIGHT });
  await hideLoader(page);
  await spoofHardwareGpu(page);
  await page.addInitScript(INIT);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (throttled) await throttle(cdp);
  const frames = await startScreencast(cdp, width, HEIGHT);
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-scene-load", "ready", { timeout: 90_000 });
  await expect(html).toHaveAttribute("data-scene-shown", "", { timeout: 30_000 });
  // swap + 1 s, in page time (throttled timers run late, so poll the log).
  await page.waitForFunction(
    (windowMs) => {
      const log = window.pf84Log ?? [];
      const live = log.find((s) => s.still <= 0.001 && s.canvas > 0.001);
      const swap = log.find((s) => s.still < 0.999 && s.canvas > 0.001);
      const last = log.at(-1);
      return Boolean(live && swap && last && last.t - Math.max(swap.t, live.t) > windowMs);
    },
    WINDOW_MS,
    { timeout: 30_000, polling: 100 },
  );
  await page.waitForTimeout(WINDOW_MS);
  const settled = await page.screenshot({ type: "png" });
  await cdp.send("Page.stopScreencast");
  if (throttled) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const log = await page.evaluate(() => window.pf84Log ?? []);

  // Transitions between still and live (crossfade samples sit in between and are not a state).
  const states = log.map(shows).filter((s) => s === "still" || s === "live");
  const flips = { stillToLive: 0, liveToStill: 0 };
  for (let i = 1; i < states.length; i += 1) {
    if (states[i - 1] === "still" && states[i] === "live") flips.stillToLive += 1;
    if (states[i - 1] === "live" && states[i] === "still") flips.liveToStill += 1;
  }
  const swapAt = log.find((s) => s.still < 0.999 && s.canvas > 0.001)?.t ?? Number.NaN;

  // Reference: the last frame shown before the swap while the still was on top.
  const before = frames.filter((f) => {
    const at = sampleAt(log, f.t);
    return f.t < swapAt && at !== undefined && shows(at) === "still";
  });
  const refFrame = before.at(-1);
  if (!refFrame) throw new Error(`${label}: no still frame was shown before the swap`);
  const ref = await raw(refFrame.png);
  const crop = trayCrop(ref.width, ref.height);
  const refStd = cropStd(ref, crop);
  const refLuma = meanLuma(ref);
  const shown = frames.filter((f) => f.t >= refFrame.t && f.t <= swapAt + WINDOW_MS);
  const checked = [...shown.slice(1), { t: Number.POSITIVE_INFINITY, png: settled }];
  const metrics: Metrics[] = [];
  let worst: { m: Metrics; img: Raw; png: Buffer } | null = null;
  const decoded = await Promise.all(checked.map(async (f) => ({ f, img: await raw(f.png) })));
  for (const { f, img } of decoded) {
    const m: Metrics = {
      t: Number.isFinite(f.t) ? Math.round(f.t - swapAt) : -1,
      std: cropStd(img, crop),
      luma: meanLuma(img),
      ...compare(ref, img, crop),
    };
    metrics.push(m);
    if (!worst || m.meanDE > worst.m.meanDE) worst = { m, img, png: f.png };
  }
  const shift = worst ? bestShift(ref, worst.img, crop) : 0;
  const summary = {
    label,
    swapAt: Math.round(swapAt - (log[0]?.t ?? swapAt)),
    frames: { total: frames.length, checked: checked.length },
    flips,
    ref: { std: refStd, luma: refLuma },
    minStdRatio: Math.min(...metrics.map((m) => m.std / refStd)),
    maxMeanDE: Math.max(...metrics.map((m) => m.meanDE)),
    maxCellDE: Math.max(...metrics.map((m) => m.maxCellDE)),
    maxLumaDelta: Math.max(...metrics.map((m) => Math.abs(m.luma / refLuma - 1))),
    worstShiftPx: shift,
    metrics,
  };
  if (OUT) {
    const dir = path.join(OUT, label);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ ...summary, log }, null, 1));
    fs.writeFileSync(path.join(dir, "still.png"), refFrame.png);
    if (worst) fs.writeFileSync(path.join(dir, "worst.png"), worst.png);
    fs.writeFileSync(path.join(dir, "settled.png"), settled);
  }
  return summary;
}

test.describe("PF-84 hero still-to-live handover", () => {
  test.describe.configure({ timeout: 180_000 });

  for (const throttled of [false, true]) {
    for (const width of DESKTOP_WIDTHS) {
      const label = `${width}-${throttled ? "throttled" : "normal"}`;
      // Chromium only: SwiftShader full-tier scene, CDP screencast and CPU throttling.
      test(
        `${label}: the live tray arrives looking like the still, one swap @chromium-only`,
        { tag: "@chromium-only" },
        async ({ page }) => {
          const s = await record(page, width, throttled, label);
          const { metrics: _, ...brief } = s;
          test.info().annotations.push({ type: "pf84", description: JSON.stringify(brief) });
          expect(s.flips, `${label}: exactly one still->live, no live->still`).toEqual({
            stillToLive: 1,
            liveToStill: 0,
          });
          expect(
            s.minStdRatio,
            `${label}: the print is present (tray std vs still)`,
          ).toBeGreaterThanOrEqual(STD_RATIO);
          expect(s.maxMeanDE, `${label}: tray mean dE2000`).toBeLessThanOrEqual(MAX_MEAN_DE);
          expect(s.maxCellDE, `${label}: worst 8x8 cell dE2000`).toBeLessThanOrEqual(MAX_CELL_DE);
          expect(s.maxLumaDelta, `${label}: whole-hero mean luminance`).toBeLessThanOrEqual(
            MAX_LUMA_DELTA,
          );
          expect(s.worstShiftPx, `${label}: tray alignment`).toBeLessThanOrEqual(MAX_SHIFT_PX);
        },
      );
    }
  }

  // PF-75 AC4: the other branch of the swap. While the loader cover is opaque (iris states 0-1)
  // the still → live swap is instant and changes 0 pixels on screen; the open then reveals the
  // live tray with one swap and no dip. The cover is held in its wait state (fonts gate + the
  // 2.6 s cap and the CSS failsafe held, its animations frozen once the iris is in) so the scene
  // can mount under it on SwiftShader, then released.
  test(
    "1440: under the opaque loader cover the swap is instant, 0 changed pixels @chromium-only",
    {
      tag: "@chromium-only",
    },
    async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: HEIGHT });
      await spoofHardwareGpu(page);
      await page.addInitScript(INIT);
      await page.addInitScript(HOLD_LOADER);
      const cdp = await page.context().newCDPSession(page);
      // The scene module waits until the cover is frozen, so the swap always lands under a static
      // cover (a fast scene must not swap during the 300-620 ms fade-in of the iris).
      const { promise: frozen, resolve: unfreeze } = Promise.withResolvers<null>();
      await page.route(STAGE_CHUNK, async (route) => {
        await frozen;
        await route.continue();
      });
      const frames = await startScreencast(cdp, 1440, HEIGHT);
      await page.goto("/", { waitUntil: "commit" });
      await page.waitForFunction(() => typeof window.pf75Frozen === "number", undefined, {
        timeout: 10_000,
      });
      unfreeze(null);
      const html = page.locator("html");
      await expect(html).toHaveAttribute("data-scene-load", "ready", { timeout: 90_000 });
      await expect(html).toHaveAttribute("data-scene-shown", "", { timeout: 30_000 });
      const atSwap = await page.evaluate(() => ({
        ready: document.documentElement.classList.contains("is-ready"),
        cover: Boolean(document.querySelector(".loader")),
        frozen: window.pf75Frozen ?? null,
      }));
      expect(atSwap.ready, "the swap happened before the loader was ready").toBe(false);
      expect(atSwap.cover, "the cover was up at the swap").toBe(true);
      await page.waitForTimeout(500);
      const log1 = await page.evaluate(() => window.pf84Log ?? []);
      const swapAt = log1.find((x) => x.still < 0.999 && x.canvas > 0.001)?.t ?? Number.NaN;
      expect(
        log1.some((x) => x.canvas > 0.001 && x.still > 0.001 && x.still < 0.999),
        "instant swap: no crossfade sample (canvas shown, still part-faded) under the cover",
      ).toBe(false);
      // 0 changed pixels: every frame from the swap to swap + 500 ms (and a screenshot after it) vs
      // the last frame before the swap, once the cover is frozen (static and opaque).
      const frozenAt = atSwap.frozen ?? Number.POSITIVE_INFINITY;
      expect(frozenAt, "frozen before the swap").toBeLessThan(swapAt);
      const beforeSwap = frames.filter((f) => f.t >= frozenAt && f.t < swapAt);
      const under = frames.filter((f) => f.t >= swapAt);
      const refFrame = beforeSwap.at(-1) ?? frames.findLast((f) => f.t < swapAt);
      expect(refFrame, "a frame under the cover before the swap").toBeDefined();
      const ref = await raw(refFrame?.png ?? Buffer.alloc(0));
      let changed = 0;
      const tail = await Promise.all(
        [...under, { t: 0, png: await page.screenshot({ type: "png" }) }].map((f) => raw(f.png)),
      );
      const perFrame: number[] = [];
      for (const img of tail) {
        const before = changed;
        for (let i = 0; i < img.data.length; i += 3) {
          const d = Math.max(
            Math.abs((img.data[i] ?? 0) - (ref.data[i] ?? 0)),
            Math.abs((img.data[i + 1] ?? 0) - (ref.data[i + 1] ?? 0)),
            Math.abs((img.data[i + 2] ?? 0) - (ref.data[i + 2] ?? 0)),
          );
          if (d > 2) changed += 1;
        }
        perFrame.push(changed - before);
      }
      if (OUT) {
        fs.mkdirSync(path.join(OUT, "ac4"), { recursive: true });
        fs.writeFileSync(path.join(OUT, "ac4", "before.png"), refFrame?.png ?? Buffer.alloc(0));
        fs.writeFileSync(path.join(OUT, "ac4", "last.png"), under.at(-1)?.png ?? Buffer.alloc(0));
      }
      // Then the open reveals the live tray: one still → live, never back, no luminance dip.
      await page.evaluate(() => {
        window.pf75Release?.();
      });
      await page.waitForFunction(() => !document.querySelector(".loader"), undefined, {
        timeout: 10_000,
      });
      await page.waitForTimeout(WINDOW_MS);
      await cdp.send("Page.stopScreencast");
      const log = await page.evaluate(() => window.pf84Log ?? []);
      const states = log.map(shows).filter((x) => x === "still" || x === "live");
      const flips = { stillToLive: 0, liveToStill: 0 };
      for (let i = 1; i < states.length; i += 1) {
        if (states[i - 1] === "still" && states[i] === "live") flips.stillToLive += 1;
        if (states[i - 1] === "live" && states[i] === "still") flips.liveToStill += 1;
      }
      const after = await Promise.all(
        frames.filter((f) => f.t > swapAt + 500).map(async (f) => meanLuma(await raw(f.png))),
      );
      let worstDrop = 0;
      for (let i = 1; i < after.length; i += 1)
        worstDrop = Math.max(worstDrop, 1 - (after[i] ?? 0) / Math.max(1, after[i - 1] ?? 0));
      test.info().annotations.push({
        type: "pf75-ac4",
        description: JSON.stringify({
          before: beforeSwap.length,
          under: under.length,
          changed,
          perFrame,
          flips,
          afterFrames: after.length,
          worstDrop,
        }),
      });
      expect(changed, "pixels changed by the swap under the cover").toBe(0);
      expect(flips, "exactly one still->live, no live->still").toEqual({
        stillToLive: 1,
        liveToStill: 0,
      });
      expect(worstDrop, "frame-to-frame luminance drop across the open").toBeLessThanOrEqual(
        MAX_LUMA_DELTA,
      );
    },
  );

  test("390: phones keep the in-flow still, nothing swaps", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await hideLoader(page);
    await spoofHardwareGpu(page);
    await page.addInitScript(INIT);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-scene-load", "off", {
      timeout: 30_000,
    });
    await page.waitForTimeout(WINDOW_MS);
    const log = await page.evaluate(() => window.pf84Log ?? []);
    expect(
      log.some((s) => s.canvas > 0),
      "no live canvas on a phone",
    ).toBe(false);
    expect(log.at(-1)?.still, "the still stays shown").toBe(1);
  });
});
