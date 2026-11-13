/**
 * Motion-safety (flash) check, build-plan M3-AC10 (backlog PF-14). Run it LOCALLY before merging
 * anything that changes the scene, its lighting or the scroll timeline; it is CI-ready (headless, no
 * port, exit 1 on fail) but deliberately NOT wired into a workflow yet (reviewer decision on PF-14:
 * the CI job goes to #4's reopened scope or a follow-up card). See tools/flash/README.md.
 *
 *   bun run flash:check                               # build, capture 384 frames, analyse
 *   bun run flash:check -- --no-build                 # reuse the cached build
 *   bun run flash:check -- --frames <dir>             # analyse an existing capture (f000.png …)
 *   bun run flash:check -- --series <file>            # re-analyse a saved series.json (no capture)
 *   options: --out <dir> (test-results/flash) · --seconds 16 · --grid 8x8 · --mode page|scene
 *
 * Capture: the same 384-frame scroll capture as tools/smooth/capture.mjs (1280×800, frame i at
 * p = i / 383, driven through the scene test hook, full tier on a "hardware GPU" probe answer;
 * SwiftShader on GPU-less hosts). Its own production build in node_modules/.cache/flash/dist is
 * served to Chromium from disk via request interception: no port, no server.
 *
 * Analysis (tools/flash/lib.ts): each frame is split into a grid of regions (default 8×8, i.e.
 * 160×100 px, smaller than WCAG's 341×256 px flash area, so it is stricter than the area rule).
 * Per region, WCAG 2.2 general transitions (Δ relative luminance ≥ 0.1, darker < 0.8) and red
 * transitions (Δ saturated red > 20) are found; a flash is two opposing transitions. Frames carry
 * no wall-clock time, so p is mapped to time in these scenarios:
 * 1. "scroll": a constant-rate 0 → 100 % scroll in `--seconds` (16 s, M2-AC11's scripted scroll);
 * 2. fast inputs, replayed at 60 fps through the stage's own catch-up (`catchUpStep`, imported
 *    from src/_pages/home/lib/catch-up.ts, snap at 1.5 s): End and Home, every section link
 *    (jump between any two section starts), scrollbar drags between any two section starts or
 *    the page end (0.25–12 s), and mixed input (End right after a scroll, End / Home in turn).
 *    A sweep is assumed to show every captured frame it passes (strict); a cut shows only its end.
 * Pass: no region over 3 flashes in any 1 s window in any scenario, and the lights-on ramp
 * spans ≥ 4 % of scroll. Also reported: the shortest constant-rate full scroll that stays safe,
 * and (not gated) what the pre-fix plain-exponential catch-up would do on End.
 *
 * Output: summary.md, summary.json, regions.csv (worst flashes/s per region and scenario),
 * luminance.csv (mean luminance per frame), series.json (per-region values per frame, for
 * --series), heatmap.png. Exit 0 pass, 1 fail.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import {
  CATCH_UP_SECONDS,
  catchUpStep,
  CUT_GAP,
  MAX_SWEEP_PER_SECOND,
  MIN_CUT_SECONDS,
  QUIET_SECONDS,
} from "../../src/_pages/home/lib/catch-up.ts";
import { SECTIONS } from "../../src/shared/lib/timeline/timeline.ts";
import {
  MAX_FLASHES_PER_SECOND,
  minSafeSeconds,
  pathFlashesPerSecond,
  rampSpan,
  regionMeans,
  replayCatchUp,
  sweepStates,
  transitions,
  worstFlashesPerSecond,
  type CatchUpStepFn,
  type Kind,
  type RegionFrame,
} from "./lib.ts";

/** Mirrors `IDLE_BUDGET_MS` in src/_pages/home/lib/stage.ts (unit-tested). */
export const SNAP_SECONDS = 1.5;
/** Scrollbar drag durations (fast flick to slow drag), between any two section starts or ends. */
export const DRAG_SECONDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12];
export const FRAMES = 384;
export const MIN_RAMP = 0.04;

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const outDir = resolvePath(root, option("--out", "test-results/flash"));
const framesDir = args.includes("--frames") ? resolvePath(option("--frames", "")) : null;
const seriesFile = args.includes("--series") ? resolvePath(option("--series", "")) : null;
const seconds = Number(option("--seconds", "16"));
const [cols = 8, rows = 8] = option("--grid", "8x8").split("x").map(Number);
const mode = option("--mode", "page");
const grid = { cols, rows };
const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
mkdirSync(outDir, { recursive: true });

// ---- Frames ------------------------------------------------------------------------------------
interface Frame {
  regions: RegionFrame;
  mean: number;
  /** Scene light level (tiles' uLit), when captured live. */
  lit: number | null;
}

async function analyseImage(png: Buffer): Promise<RegionFrame & { mean: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const regions = regionMeans(data, info.width, info.height, info.channels, grid);
  const whole = regionMeans(data, info.width, info.height, info.channels, { cols: 1, rows: 1 });
  return { ...regions, mean: whole.luminance[0] ?? 0 };
}

const ORIGIN = "http://flash.test";
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".webmanifest": "application/manifest+json",
};

async function serve(page: Page, distDir: string): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      await route.abort();
      return;
    }
    if (url.pathname.includes("probe.worker")) {
      await route.fulfill({ contentType: "text/javascript", body: "postMessage(true);" });
      return;
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html";
    if (!extname(rel)) rel = posix.join(rel, "index.html");
    const file = join(distDir, rel);
    if (!existsSync(file) || relative(distDir, file).startsWith("..")) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    await route.fulfill({
      body: readFileSync(file),
      contentType: MIME[extname(rel)] ?? "application/octet-stream",
    });
  });
}

const HIDE_COPY = `main > section, body > header, body > footer, .home-scrim, .home-progress, .rail,
  .skip-link { visibility: hidden !important; }`;

async function captureFrame(page: Page, p: number): Promise<Frame> {
  await page.evaluate((target) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    window.scrollTo({ top: target * max, behavior: "instant" });
    window.darkroomTest?.set(target);
  }, p);
  // Let the scroll-driven rAF and style updates land, then render exactly p once more.
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
  );
  const lit = await page.evaluate((target) => {
    window.darkroomTest?.set(target);
    return window.darkroomTest?.state().tiles[0]?.lit ?? null;
  }, p);
  const { mean, ...regions } = await analyseImage(await page.screenshot());
  return { regions, mean, lit };
}

async function capture(): Promise<{ frames: Frame[]; renderer: string }> {
  const distDir = join(root, "node_modules/.cache/flash/dist");
  if (!args.includes("--no-build") || !existsSync(join(distDir, "index.html"))) {
    const { build } = await import("astro");
    await build({ root, outDir: distDir, logLevel: "warn" });
  }
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      reducedMotion: "no-preference",
    });
    await serve(page, distDir);
    await page.goto(`${ORIGIN}/?scene-test`, { waitUntil: "load" });
    await page.waitForFunction(() => window.darkroomTest !== undefined, null, {
      timeout: 120_000,
    });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector(".darkroom-scene__canvas");
        return canvas !== null && getComputedStyle(canvas).opacity === "1";
      },
      null,
      { timeout: 30_000 },
    );
    if (mode === "scene") await page.addStyleTag({ content: HIDE_COPY });
    const renderer = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
    });
    const frames: Frame[] = [];
    for (let i = 0; i < FRAMES; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one page, one p at a time, in order
      frames.push(await captureFrame(page, i / (FRAMES - 1)));
    }
    return { frames, renderer };
  } finally {
    await browser.close();
  }
}

async function load(dir: string): Promise<Frame[]> {
  const files = readdirSync(dir)
    .filter((f) => /^f\d+\.png$/.test(f))
    .toSorted();
  const frames: Frame[] = [];
  for (const f of files) {
    // oxlint-disable-next-line no-await-in-loop -- decode one PNG at a time (memory)
    const { mean, ...regions } = await analyseImage(readFileSync(join(dir, f)));
    frames.push({ regions, mean, lit: null });
  }
  return frames;
}

// ---- Analysis ----------------------------------------------------------------------------------
/** Per-frame region values as saved in series.json (re-analyse without a new capture). */
interface SavedSeries {
  renderer: string;
  frames: { luminance: number[]; red: number[]; mean: number; lit: number | null }[];
}
const isSavedSeries = (x: unknown): x is SavedSeries =>
  typeof x === "object" &&
  x !== null &&
  "renderer" in x &&
  typeof x.renderer === "string" &&
  "frames" in x &&
  Array.isArray(x.frames);
function loadSeries(file: string): { frames: Frame[]; renderer: string } {
  const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isSavedSeries(saved)) throw new Error(`${file}: not a flash-check series.json`);
  return {
    renderer: `${saved.renderer} (from ${file})`,
    frames: saved.frames.map((f) => ({
      regions: { luminance: Float64Array.from(f.luminance), red: Float64Array.from(f.red) },
      mean: f.mean,
      lit: f.lit,
    })),
  };
}
const { frames, renderer } = seriesFile
  ? loadSeries(seriesFile)
  : framesDir
    ? { frames: await load(framesDir), renderer: `from ${framesDir}` }
    : await capture();
writeFileSync(
  join(outDir, "series.json"),
  JSON.stringify({
    renderer,
    frames: frames.map((f) => ({
      luminance: [...f.regions.luminance],
      red: [...f.regions.red],
      mean: f.mean,
      lit: f.lit,
    })),
  } satisfies SavedSeries),
);
const n = frames.length;
if (n < 2) throw new Error("need at least 2 frames");
const ps = frames.map((_, i) => i / (n - 1));
const cells = cols * rows;

// Fast inputs, replayed through the stage's own catch-up (catchUpStep, imported from the product):
// End / Home, every section link (jump from one section's start to another's), and scrollbar drags
// across the whole page at several speeds, both ways.
interface Input {
  name: string;
  p0: number;
  target: (t: number) => number;
  inputEnd: number;
}
const jump = (name: string, p0: number, p1: number): Input => ({
  name,
  p0,
  target: () => p1,
  inputEnd: 0,
});
const drag = (duration: number, p0: number, p1: number): Input => ({
  name: `drag ${p0} → ${p1} in ${duration} s`,
  p0,
  target: (t) => p0 + (p1 - p0) * Math.min(1, t / duration),
  inputEnd: duration,
});
/** Section starts plus the page end: where links land and drags start or stop. */
const STOPS = [...SECTIONS.map((section) => section.start), 1];
const JUMP_KEYS = ["jumpDown", "jumpUp", "anchor", "drag", "combo"] as const;
type JumpKey = (typeof JUMP_KEYS)[number];
const SCENARIOS: Record<JumpKey, Input[]> = {
  jumpDown: [jump("End (top → bottom)", 0, 1)],
  jumpUp: [jump("Home (bottom → top)", 1, 0)],
  anchor: SECTIONS.flatMap((from) =>
    SECTIONS.filter((to) => to !== from).map((to) =>
      jump(`#${from.id} → #${to.id}`, from.start, to.start),
    ),
  ),
  drag: DRAG_SECONDS.flatMap((sec) =>
    STOPS.flatMap((p0) => STOPS.filter((p1) => p1 !== p0).map((p1) => drag(sec, p0, p1))),
  ),
  // Mixed input: End shortly after a small scroll, and End / Home pressed in turn.
  combo: [
    ...[0.1, 0.3, 0.6, 1, 1.5].map((after) => ({
      name: `scroll 0 → 0.05 in 0.5 s, End ${after} s later`,
      p0: 0,
      target: (t: number) => (t < 0.5 + after ? 0.1 * Math.min(t, 0.5) : 1),
      inputEnd: 0.5 + after,
    })),
    ...[0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5].map((every) => ({
      name: `End / Home in turn every ${every} s for 4 s`,
      p0: 0,
      target: (t: number) => (Math.floor(t / every) % 2 === 0 ? 1 : 0),
      inputEnd: 4,
    })),
  ],
};
type Key = "scroll" | JumpKey;
const KEYS: Key[] = ["scroll", ...JUMP_KEYS];
const replay = (step: CatchUpStepFn, input: Input) =>
  sweepStates(
    replayCatchUp(step, input.p0, input.target, input.inputEnd, { snapSeconds: SNAP_SECONDS }),
    n,
  );
interface Run {
  name: string;
  states: { t: number; p: number }[];
}
const runAll = (inputs: Input[]): Run[] =>
  inputs.map((input) => ({ name: input.name, states: replay(catchUpStep, input) }));
const runs: Record<JumpKey, Run[]> = {
  jumpDown: runAll(SCENARIOS.jumpDown),
  jumpUp: runAll(SCENARIOS.jumpUp),
  anchor: runAll(SCENARIOS.anchor),
  drag: runAll(SCENARIOS.drag),
  combo: runAll(SCENARIOS.combo),
};
/** The catch-up before PF-14's fix (plain exponential, τ 0.15 s): reported, not gated. */
const legacyStep: CatchUpStepFn = (shown, target, dt) => ({
  shown: shown + (target - shown) * (1 - Math.exp(-dt / CATCH_UP_SECONDS)),
  cut: false,
  swept: true,
});
const legacyEnd = replay(legacyStep, jump("End (top → bottom)", 0, 1));

interface RegionResult extends Record<Key, number> {
  region: number;
  kind: Kind;
  transitions: number;
  /** Worst input per jump scenario. */
  input: Record<JumpKey, string>;
  legacyEnd: number;
}
const results: RegionResult[] = [];
const perRegion: number[][] = [];
for (const kind of ["general", "red"] as const)
  for (let c = 0; c < cells; c += 1) {
    const series = frames.map(
      (f) => (kind === "general" ? f.regions.luminance : f.regions.red)[c] ?? 0,
    );
    const down = transitions(series, kind);
    const up = transitions(series.toReversed(), kind).map((i) => n - 1 - i);
    perRegion.push(down, up);
    const worstRun = (key: JumpKey): { fps: number; name: string } =>
      runs[key]
        .map((run) => ({ fps: pathFlashesPerSecond(series, run.states, kind), name: run.name }))
        .reduce((x, y) => (y.fps > x.fps ? y : x));
    const jumpDown = worstRun("jumpDown");
    const jumpUp = worstRun("jumpUp");
    const anchor = worstRun("anchor");
    const dragged = worstRun("drag");
    const combo = worstRun("combo");
    const r: RegionResult = {
      region: c,
      kind,
      transitions: down.length,
      scroll: Math.max(
        worstFlashesPerSecond(down, (i) => (ps[i] ?? 0) * seconds),
        worstFlashesPerSecond(up, (i) => (1 - (ps[i] ?? 0)) * seconds),
      ),
      jumpDown: jumpDown.fps,
      jumpUp: jumpUp.fps,
      anchor: anchor.fps,
      drag: dragged.fps,
      combo: combo.fps,
      input: {
        jumpDown: jumpDown.name,
        jumpUp: jumpUp.name,
        anchor: anchor.name,
        drag: dragged.name,
        combo: combo.name,
      },
      legacyEnd: pathFlashesPerSecond(series, legacyEnd, kind),
    };
    results.push(r);
  }
const worst = (key: Key | "legacyEnd"): RegionResult =>
  results.reduce((a, b) => (b[key] > a[key] ? b : a));
const safeSeconds = minSafeSeconds(perRegion, n);

const lits = frames.map((f) => f.lit);
const litKnown = lits.every((v) => v !== null);
const litRamp = litKnown ? rampSpan(ps, lits.map(Number), 0, 1) : null;
const litRamp1090 = litKnown ? rampSpan(ps, lits.map(Number), 0.1, 0.9) : null;
// Measured: the frame's mean luminance over the last morph (Process → Contact, p .79–.92 plus
// margin), 0 → 100 % of its rise.
const tail = ps.map((p, i) => ({ p, v: frames[i]?.mean ?? 0 })).filter(({ p }) => p >= 0.76);
const lumRamp = rampSpan(
  tail.map((t) => t.p),
  tail.map((t) => t.v),
  0.05,
  0.95,
);

const fmt = (x: number, d = 2): string => x.toFixed(d);
const failures: string[] = [];
for (const key of KEYS) {
  const w = worst(key);
  if (w[key] > MAX_FLASHES_PER_SECOND)
    failures.push(
      `${key}: region ${w.region} (${w.kind}${key === "scroll" ? "" : `, ${w.input[key]}`}) flashes ${fmt(w[key], 1)}/s > 3`,
    );
}
const rampValue = litRamp?.span ?? lumRamp.span;
if (rampValue < MIN_RAMP) failures.push(`lights-on ramp ${fmt(rampValue * 100, 1)} % < 4 %`);

// ---- Report ------------------------------------------------------------------------------------
const cellName = (c: number): string => `r${Math.floor(c / cols)}c${c % cols}`;
const lines = [
  "# Motion-safety (flash) check, M3-AC10",
  "",
  `- Frames: ${n} (1280×800, p = i / ${n - 1}, ${mode} mode) · renderer: ${renderer}`,
  `- Regions: ${cols}×${rows} grid · bar: ≤ ${MAX_FLASHES_PER_SECOND} flashes in any 1 s, per region (WCAG 2.2 general + red)`,
  "",
  "| scenario | worst region | flashes / s (worst 1 s) | result |",
  "|---|---|---|---|",
  ...KEYS.map((key) => {
    const w = worst(key);
    const label = {
      scroll: `constant scroll, 0 → 100 % in ${seconds} s`,
      jumpDown: "jump top → bottom (End)",
      jumpUp: "jump bottom → top (Home)",
      anchor: `section links (${SCENARIOS.anchor.length} jumps between section starts)`,
      drag: `scrollbar drags between any two section starts / page end (${SCENARIOS.drag.length} drags, ${DRAG_SECONDS.join(", ")} s)`,
      combo: `mixed input (${SCENARIOS.combo.length}: End right after a scroll, End / Home in turn)`,
    }[key];
    const which = key === "scroll" ? "" : `; worst: ${w.input[key]}`;
    return `| ${label} | ${cellName(w.region)} (${w.kind}, ${w.transitions} transitions over the page${which}) | ${fmt(w[key], 1)} | ${w[key] <= MAX_FLASHES_PER_SECOND ? "pass" : "FAIL"} |`;
  }),
  "",
  `- Catch-up: exponential τ ${CATCH_UP_SECONDS} s, sweep ≤ ${MAX_SWEEP_PER_SECOND} of the page per s, gaps > ${CUT_GAP} held then cut (≥ ${QUIET_SECONDS} s after a sweep, ≥ ${MIN_CUT_SECONDS} s between cuts), snap ${SNAP_SECONDS} s after the last input`,
  `- Pre-fix catch-up (plain τ ${CATCH_UP_SECONDS} s exponential) on this capture, End: ${cellName(worst("legacyEnd").region)} (${worst("legacyEnd").kind}) ${fmt(worst("legacyEnd").legacyEnd, 1)} flashes/s (not gated; shows the check still catches it)`,
  "",
  `- Shortest constant-rate full scroll that stays ≤ 3 flashes/s: **${fmt(safeSeconds)} s**`,
  `- Most transitions in one region over the whole page: ${Math.max(...results.map((r) => r.transitions))}`,
  litRamp
    ? `- Lights-on ramp (scene light level 0 → 100 %): **${fmt(litRamp.span * 100, 1)} % of scroll** (p ${fmt(litRamp.from, 3)} → ${fmt(litRamp.to, 3)}); 10 → 90 %: ${fmt((litRamp1090?.span ?? 0) * 100, 1)} % · bar ≥ 4 %`
    : "- Lights-on ramp: scene light level not available (frames loaded from disk)",
  `- Lights-on, measured on the frames (mean luminance 5 → 95 % of its rise after p .76): ${fmt(lumRamp.span * 100, 1)} % of scroll (p ${fmt(lumRamp.from, 3)} → ${fmt(lumRamp.to, 3)})`,
  "",
  failures.length === 0 ? "**PASS**" : `**FAIL**\n\n${failures.map((f) => `- ${f}`).join("\n")}`,
  "",
];
writeFileSync(join(outDir, "summary.md"), lines.join("\n"));
writeFileSync(
  join(outDir, "summary.json"),
  JSON.stringify(
    {
      frames: n,
      grid,
      seconds,
      renderer,
      worst: Object.fromEntries(KEYS.map((key) => [key, worst(key)])),
      legacyEnd: worst("legacyEnd"),
      safeSeconds,
      lightsOnRamp: litRamp,
      lightsOnRamp1090: litRamp1090,
      lightsOnLuminance: lumRamp,
      failures,
      pass: failures.length === 0,
    },
    null,
    2,
  ),
);
writeFileSync(
  join(outDir, "regions.csv"),
  [
    `region,kind,transitions,${KEYS.map((k) => `${k}_fps`).join(",")},legacy_end_fps`,
    ...results.map(
      (r) =>
        `${cellName(r.region)},${r.kind},${r.transitions},${KEYS.map((k) => fmt(r[k], 2)).join(",")},${fmt(r.legacyEnd, 2)}`,
    ),
  ].join("\n"),
);
writeFileSync(
  join(outDir, "luminance.csv"),
  [
    "frame,p,mean_luminance,lit",
    ...frames.map((f, i) => `${i},${fmt(ps[i] ?? 0, 4)},${fmt(f.mean, 4)},${f.lit ?? ""}`),
  ].join("\n"),
);
// Heatmap of the worst flashes/s per region (any scenario, general or red): black 0, white ≥ 3.
const heat = Buffer.alloc(cells);
for (let c = 0; c < cells; c += 1) {
  const v = Math.max(
    ...results.filter((r) => r.region === c).map((r) => Math.max(...KEYS.map((k) => r[k]))),
  );
  heat[c] = Math.min(255, Math.round((v / MAX_FLASHES_PER_SECOND) * 255));
}
await sharp(heat, { raw: { width: cols, height: rows, channels: 1 } })
  .resize(cols * 40, rows * 25, { kernel: "nearest" })
  .png()
  .toFile(join(outDir, "heatmap.png"));

print(lines.join("\n"));
print(`Output: ${outDir}`);
process.exitCode = failures.length === 0 ? 0 : 1;
