/**
 * Copy contrast over the live scene (build-plan M3-AC5 / F3, M1-AC12; backlog PF-04).
 *
 *   bun run contrast:measure                          # D, D2, M at p = 0…1 step .005
 *   bun run contrast:measure -- --viewports D --step 0.05 --no-build
 *   bun run contrast:measure -- --gpu                 # real GPU, headed (PF-08 hardware run)
 *
 * Method (M3-AC5)
 * - Its own production build (node_modules/.cache/contrast/dist), served to Chromium from disk
 *   through request interception: no port, no server. CHROME_PATH picks a system Chrome.
 * - Tier: D (1440×900) and D2 (1280×800) run the full tier (the probe is answered "hardware GPU";
 *   on a GPU-less host the scene renders on SwiftShader, so these numbers are a proxy until the
 *   real-GPU run in PF-08). M (390×844) is the static tier (posters), as on phones. `--tier
 *   full|static` forces one tier everywhere.
 * - For each p the page is scrolled to p × (scrollHeight − innerHeight) and settles (the scene's
 *   smoothed progress reaches p when the test hook is present, then two frames and `--settle`
 *   ms). The copy glyphs are made transparent (`-webkit-text-fill-color`, decorations, shadows),
 *   so one screenshot shows exactly the background behind every glyph, while each element keeps
 *   its computed colour and layout.
 * - Measured: every visible text element whose effective (ancestor-multiplied) opacity is ≥ .5,
 *   using its glyph line boxes (Range client rects), clipped to the viewport and minus any fixed
 *   or sticky bar (header, footer) drawn over it. Worst case = the background pixel at the 95th
 *   luminance percentile (5th for dark-on-light text) against the text colour composited at its
 *   alpha × opacity.
 * - Bar: ≥ 4.5:1 below 24 px, ≥ 3:1 for H1/H2 and ≥ 24 px. The #FF7A3D italic accent is reported
 *   on its own. Exit 1 if any element misses its bar at any p.
 *
 * Output (default test-results/contrast/): contrast.csv (every sample), summary.md and
 * summary.json (min ratio per element and the p where it occurs), worst/*.png (with-copy and
 * background-only crops of each element's worst p: all failures plus the lowest margins).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import {
  csv,
  isAccent,
  parseCssColor,
  pixelsIn,
  requiredRatio,
  worstCase,
  type Box,
  type RGB,
} from "./lib.ts";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const VIEWPORTS = {
  D: { width: 1440, height: 900, tier: "full" },
  D2: { width: 1280, height: 800, tier: "full" },
  M: { width: 390, height: 844, tier: "static" },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
const isViewport = (v: string): v is ViewportName => v in VIEWPORTS;

const viewports = option("--viewports", "D,D2,M")
  .split(",")
  .map((v) => v.trim())
  .filter(isViewport);
const step = Number(option("--step", "0.005"));
const from = Number(option("--from", "0"));
const to = Number(option("--to", "1"));
const settleMs = Number(option("--settle", "250"));
const forcedTier = option("--tier", "auto");
const worstShots = Number(option("--worst", "3"));
const outDir = resolvePath(root, option("--out", "test-results/contrast"));
const distDir = join(root, "node_modules/.cache/contrast/dist");
if (!(step > 0) || viewports.length === 0) throw new Error("Bad --step or --viewports");

if (!args.includes("--no-build") || !existsSync(join(distDir, "index.html"))) {
  const { build } = await import("astro");
  await build({ root, outDir: distDir, logLevel: "warn" });
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "worst"), { recursive: true });

const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
async function eachInOrder<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => fn(item)),
    Promise.resolve(),
  );
}

// ---- Page plumbing -------------------------------------------------------------------------------
const ORIGIN = "http://contrast.test";
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const HIDE_ID = "contrast-hide-glyphs";
const HIDE_CSS = `*, *::before, *::after, *::marker, *::placeholder {
  -webkit-text-fill-color: transparent !important; text-decoration-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; }`;

async function serve(page: Page, hardwareGpu: boolean): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      await route.abort();
      return;
    }
    let rel = decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html";
    if (!extname(rel)) rel = posix.join(rel, "index.html");
    const file = join(distDir, rel);
    if (!existsSync(file) || relative(distDir, file).startsWith("..")) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    if (rel.includes("probe.worker")) {
      await route.fulfill({ contentType: "text/javascript", body: `postMessage(${hardwareGpu});` });
      return;
    }
    await route.fulfill({
      body: readFileSync(file),
      contentType: MIME[extname(rel)] ?? "application/octet-stream",
    });
  });
}

interface Measured {
  key: string;
  section: string;
  text: string;
  tag: string;
  heading: string | null;
  fontSize: number;
  color: string;
  opacity: number;
  boxes: Box[];
}

/** In the page: every visible text element with opacity ≥ .5 and its unoccluded glyph boxes. */
function collect(): Measured[] {
  const w = window as Window & { contrastKeys?: number };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Fixed/sticky bars with text of their own AND a painted background (header, footer) draw over
  // the copy: glyph boxes under them are skipped. Transparent fixed layers are not occluders: on
  // the full tier every section's pinned copy is a full-viewport `position: fixed` layer, and
  // treating those as bars would drop all text (the first post-PR #3 run measured 0 elements).
  const bars = [...document.querySelectorAll<HTMLElement>("body *")]
    .filter((el) => {
      const s = getComputedStyle(el);
      if (s.position !== "fixed" && s.position !== "sticky") return false;
      if (el.innerText.trim() === "" || s.visibility !== "visible") return false;
      const bg = s.backgroundColor;
      const alpha = bg.startsWith("rgba(") ? Number(bg.slice(5, -1).split(",")[3]) : 1;
      return s.backgroundImage !== "none" || (bg !== "transparent" && alpha > 0);
    })
    .map((el) => ({ el, box: el.getBoundingClientRect() }));
  const out = new Map<Element, Measured>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim()) continue;
    if (parent.closest("script, style, noscript, template, [hidden]")) continue;
    const style = getComputedStyle(parent);
    if (style.visibility !== "visible" || style.display === "none") continue;
    let opacity = 1;
    for (let e: Element | null = parent; e; e = e.parentElement) {
      opacity *= Number(getComputedStyle(e).opacity);
    }
    if (opacity < 0.5) continue;
    // Clip to every ancestor that clips its overflow (this also drops visually-hidden text,
    // which sits in a 1 px clipped box) and to the viewport.
    let clipL = 0;
    let clipT = 0;
    let clipR = vw;
    let clipB = vh;
    for (let e: Element | null = parent; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const clips =
        cs.overflowX !== "visible" ||
        cs.overflowY !== "visible" ||
        cs.clipPath !== "none" ||
        !["auto", ""].includes(cs.getPropertyValue("clip"));
      if (!clips) continue;
      const b = e.getBoundingClientRect();
      clipL = Math.max(clipL, b.left);
      clipT = Math.max(clipT, b.top);
      clipR = Math.min(clipR, b.right);
      clipB = Math.min(clipB, b.bottom);
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const boxes: Box[] = [];
    for (const raw of range.getClientRects()) {
      const left = Math.max(raw.left, clipL);
      const top = Math.max(raw.top, clipT);
      const right = Math.min(raw.right, clipR);
      const bottom = Math.min(raw.bottom, clipB);
      if (right - left < 2 || bottom - top < 4) continue;
      const r = { left, top, right, bottom };
      const under = bars.some(
        ({ el, box }) =>
          !el.contains(parent) &&
          r.left < box.right &&
          box.left < r.right &&
          r.top < box.bottom &&
          box.top < r.bottom,
      );
      if (under) continue;
      boxes.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
    if (boxes.length === 0) continue;
    const existing = out.get(parent);
    if (existing) {
      existing.boxes.push(...boxes);
      continue;
    }
    if (!parent.dataset.contrastKey) {
      w.contrastKeys = (w.contrastKeys ?? 0) + 1;
      parent.dataset.contrastKey = String(w.contrastKeys);
    }
    const region = parent.closest("section[id], header, footer, nav, aside, form");
    const section =
      region && region.id !== "" ? region.id : (region?.tagName.toLowerCase() ?? "page");
    const text = (parent.textContent ?? "").replaceAll(/\s+/g, " ").trim().slice(0, 48);
    const cls = parent.classList[0] ? `.${parent.classList[0]}` : "";
    out.set(parent, {
      key: `${section} ${parent.tagName.toLowerCase()}${cls} #${parent.dataset.contrastKey}`,
      section,
      text,
      tag: parent.tagName,
      heading: parent.closest("h1, h2, h3, h4, h5, h6")?.tagName ?? null,
      fontSize: Number.parseFloat(style.fontSize),
      color: style.color,
      opacity,
      boxes,
    });
  }
  return [...out.values()];
}

async function settle(page: Page, p: number): Promise<number> {
  const shown = await page.evaluate(
    async ({ target, ms }) => {
      const max = document.documentElement.scrollHeight - innerHeight;
      window.scrollTo(0, Math.round(target * max));
      const actual = max > 0 ? window.scrollY / max : 0;
      const hook = (window as Window & { darkroomTest?: { shown?: () => number } }).darkroomTest;
      const t0 = performance.now();
      const waitShown = async (): Promise<void> => {
        if (!hook?.shown || Math.abs(hook.shown() - actual) <= 5e-4) return;
        if (performance.now() - t0 > 5000) return;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
        await waitShown();
      };
      await waitShown();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, ms);
          });
        });
      });
      return actual;
    },
    { target: p, ms: settleMs },
  );
  return shown;
}

const hex = (c: RGB): string =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

interface Sample {
  viewport: ViewportName;
  tier: string;
  p: number;
  key: string;
  section: string;
  text: string;
  accent: boolean;
  fontSize: number;
  required: number;
  ratio: number;
  polarity: string;
  textColor: string;
  background: string;
  opacity: number;
  boxes: Box[];
}

// ---- Run ---------------------------------------------------------------------------------------
// `--gpu` (the PF-08 real-hardware run): a headed browser on the machine's own GPU. Otherwise
// headless with SwiftShader, so the full tier also renders on GPU-less hosts (a proxy).
const useGpu = args.includes("--gpu");
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  headless: !useGpu,
  args: useGpu
    ? ["--ignore-gpu-blocklist"]
    : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const steps = Array.from({ length: Math.floor((to - from) / step + 1e-9) + 1 }, (_, i) =>
  Number((from + i * step).toFixed(6)),
);
const samples: Sample[] = [];
const tiersRun: Partial<Record<ViewportName, string>> = {};
let renderer = "unknown";

async function open(
  name: ViewportName,
): Promise<{ page: Page; tier: string; close: () => Promise<void> }> {
  const vp = VIEWPORTS[name];
  const tier = forcedTier === "auto" ? vp.tier : forcedTier;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await serve(page, tier === "full");
  await page.goto(`${ORIGIN}/?scene-test`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (tier === "full") {
    await page.locator("html[data-tier='full']").waitFor({ state: "attached", timeout: 45_000 });
  } else {
    await page.waitForTimeout(1000);
  }
  renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return "no WebGL2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
  const actualTier = (await page.locator("html").getAttribute("data-tier")) ?? "unknown";
  if (actualTier !== tier) throw new Error(`${name}: expected the ${tier} tier, got ${actualTier}`);
  return { page, tier, close: () => context.close() };
}

async function hideGlyphs(page: Page, hide: boolean): Promise<void> {
  await page.evaluate(
    ({ id, css, on }) => {
      document.getElementById(id)?.remove();
      if (!on) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = css;
      document.head.append(style);
    },
    { id: HIDE_ID, css: HIDE_CSS, on: hide },
  );
}

await eachInOrder(viewports, async (name) => {
  const { page, tier, close } = await open(name);
  tiersRun[name] = tier;
  await hideGlyphs(page, true);
  const started = Date.now();
  await eachInOrder(steps, async (p) => {
    const actual = await settle(page, p);
    const elements = await page.evaluate(collect);
    const shot = await page.screenshot({ type: "png" });
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const image = { data, width: info.width, height: info.height, channels: info.channels };
    for (const el of elements) {
      const color = parseCssColor(el.color);
      if (!color) continue;
      const worst = worstCase(color.rgb, color.alpha * el.opacity, pixelsIn(image, el.boxes));
      if (!worst) continue;
      const accent = isAccent(color.rgb);
      samples.push({
        viewport: name,
        tier,
        p: Number(actual.toFixed(4)),
        key: accent ? `${el.key} [accent]` : el.key,
        section: el.section,
        text: el.text,
        accent,
        fontSize: el.fontSize,
        required: requiredRatio(el),
        ratio: worst.ratio,
        polarity: worst.polarity,
        textColor: hex(worst.text),
        background: hex(worst.background),
        opacity: el.opacity,
        boxes: el.boxes,
      });
    }
  });
  print(
    `${name} (${tier}): ${steps.length} p values in ${((Date.now() - started) / 1000).toFixed(0)} s`,
  );
  await close();
});

// ---- Report ------------------------------------------------------------------------------------
interface Summary {
  viewport: ViewportName;
  key: string;
  text: string;
  accent: boolean;
  required: number;
  minRatio: number;
  atP: number;
  samples: number;
  pass: boolean;
  worst: Sample;
}
const byElement = new Map<string, Sample[]>();
for (const s of samples) {
  const id = `${s.viewport}\u0000${s.key}`;
  const list = byElement.get(id);
  if (list) list.push(s);
  else byElement.set(id, [s]);
}
const summaries: Summary[] = [...byElement.values()].map((list) => {
  const worst = list.reduce((a, b) => (b.ratio / b.required < a.ratio / a.required ? b : a));
  return {
    viewport: worst.viewport,
    key: worst.key,
    text: worst.text,
    accent: worst.accent,
    required: worst.required,
    minRatio: worst.ratio,
    atP: worst.p,
    samples: list.length,
    pass: list.every((s) => s.ratio >= s.required),
    worst,
  };
});

const header = [
  "viewport",
  "tier",
  "p",
  "element",
  "text",
  "accent",
  "font_px",
  "opacity",
  "required",
  "ratio",
  "polarity",
  "text_color",
  "background_p95",
  "pass",
];
const lines = samples.map((s) =>
  [
    s.viewport,
    s.tier,
    s.p,
    s.key,
    s.text,
    s.accent ? 1 : 0,
    s.fontSize,
    s.opacity.toFixed(3),
    s.required,
    s.ratio.toFixed(2),
    s.polarity,
    s.textColor,
    s.background,
    s.ratio >= s.required ? 1 : 0,
  ]
    .map(csv)
    .join(","),
);
writeFileSync(join(outDir, "contrast.csv"), `${[header.join(","), ...lines].join("\n")}\n`);

// Worst-case crops: every failure, plus the `--worst` lowest margins per viewport.
const shots: Summary[] = [];
for (const name of viewports) {
  const list = summaries
    .filter((s) => s.viewport === name)
    .toSorted((a, b) => a.minRatio / a.required - b.minRatio / b.required);
  shots.push(...list.filter((s) => !s.pass), ...list.filter((s) => s.pass).slice(0, worstShots));
}
const shotFiles = new Map<Summary, string>();
await eachInOrder(viewports, async (name) => {
  const mine = shots.filter((s) => s.viewport === name);
  if (mine.length === 0) return;
  const { page, close } = await open(name);
  await eachInOrder(mine, async (s) => {
    const xs = s.worst.boxes;
    const x0 = Math.max(0, Math.floor(Math.min(...xs.map((b) => b.x)) - 16));
    const y0 = Math.max(0, Math.floor(Math.min(...xs.map((b) => b.y)) - 16));
    const vp = VIEWPORTS[name];
    const x1 = Math.min(vp.width, Math.ceil(Math.max(...xs.map((b) => b.x + b.width)) + 16));
    const y1 = Math.min(vp.height, Math.ceil(Math.max(...xs.map((b) => b.y + b.height)) + 16));
    const clip = { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
    const base = `${name}-p${s.atP.toFixed(3)}-${s.key.replaceAll(/[^\w.-]+/g, "_")}`.slice(0, 120);
    await hideGlyphs(page, false);
    await settle(page, s.atP);
    await page.screenshot({ path: join(outDir, "worst", `${base}-text.png`), clip });
    await hideGlyphs(page, true);
    await settle(page, s.atP);
    await page.screenshot({ path: join(outDir, "worst", `${base}-background.png`), clip });
    shotFiles.set(s, `worst/${base}-text.png`);
  });
  await close();
});
await browser.close();

const failures = summaries.filter((s) => !s.pass);
const table = (list: readonly Summary[]): string[] => [
  "| viewport | element | text | bar | min ratio | at p | samples | result | worst case |",
  "|---|---|---|---|---|---|---|---|---|",
  ...list.map(
    (s) =>
      `| ${s.viewport} | \`${s.key}\` | ${s.text.replaceAll("|", "\\|")} | ${s.required}:1 | ${s.minRatio.toFixed(2)} | ${s.atP.toFixed(3)} | ${s.samples} | ${s.pass ? "PASS" : "**FAIL**"} | ${shotFiles.get(s) ?? ""} |`,
  ),
];
const sorted = summaries.toSorted(
  (a, b) =>
    a.viewport.localeCompare(b.viewport) || a.minRatio / a.required - b.minRatio / b.required,
);
const md = [
  "# Copy contrast over the live scene (M3-AC5)",
  "",
  `Steps: p = ${from}…${to} step ${step}. Tiers: ${viewports.map((v) => `${v} ${tiersRun[v] ?? "?"}`).join(", ")}.`,
  `WebGL renderer: ${renderer}.${/swiftshader|llvmpipe|software/i.test(renderer) ? " Software renderer: the full-tier numbers are a proxy for the real-GPU run (PF-08)." : ""}`,
  "",
  `**${failures.length === 0 ? "PASS" : `FAIL (${failures.length} element/viewport pairs below their bar)`}** · ${samples.length} samples, ${summaries.length} element/viewport pairs.`,
  "",
  "## Text (accent excluded)",
  "",
  ...table(sorted.filter((s) => !s.accent)),
  "",
  "## Italic accent #FF7A3D (reported separately)",
  "",
  ...table(sorted.filter((s) => s.accent)),
  "",
];
writeFileSync(join(outDir, "summary.md"), md.join("\n"));
writeFileSync(
  join(outDir, "summary.json"),
  `${JSON.stringify(
    {
      step,
      from,
      to,
      tiers: tiersRun,
      renderer,
      pass: failures.length === 0,
      elements: summaries.map((s) => ({
        viewport: s.viewport,
        key: s.key,
        text: s.text,
        accent: s.accent,
        required: s.required,
        minRatio: Number(s.minRatio.toFixed(3)),
        atP: s.atP,
        samples: s.samples,
        pass: s.pass,
        screenshot: shotFiles.get(s) ?? null,
      })),
    },
    null,
    2,
  )}\n`,
);

for (const name of viewports) {
  const mine = sorted.filter((s) => s.viewport === name);
  const lowest = mine[0];
  print(
    `${name}: ${mine.length} elements, ${mine.filter((s) => !s.pass).length} below bar` +
      (lowest
        ? `; lowest margin ${lowest.minRatio.toFixed(2)}:1 (bar ${lowest.required}:1) at p ${lowest.atP} — ${lowest.key} "${lowest.text}"`
        : ""),
  );
}
print(`Report: ${relative(root, join(outDir, "summary.md"))}`);
print(
  failures.length === 0
    ? "All text meets its contrast bar."
    : `${failures.length} element/viewport pair(s) below their bar.`,
);
// A run that measured nothing proves nothing: an empty viewport is a failure, never a pass.
const empty = viewports.filter((name) => !sorted.some((s) => s.viewport === name));
if (empty.length > 0) print(`No text measured at ${empty.join(", ")}: the run is invalid.`);
process.exitCode = failures.length === 0 && empty.length === 0 ? 0 : 1;
