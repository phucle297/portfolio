/**
 * Real-hardware verification kit (backlog PF-08; build-plan M2-AC10, M2-AC11, M3-AC2, M3-AC5,
 * M3-AC6, §3 full-tier Lighthouse). Procedure and evidence format: tools/hw/README.md.
 *
 *   bun run hw:verify -- --device "MacBook Air M2 2022, 16 GB"
 *   bun run hw:verify -- --device "…" --only frames,hidden --url http://127.0.0.1:4321/
 *   bun run hw:verify -- --device "box smoke" --headless --spoof-probe   # smoke test, not evidence
 *
 * Every item runs in the machine's own Chrome (`channel: "chrome"`, or CHROME_PATH), headed, so
 * WebGL uses the real GPU. If the WebGL renderer is a software one (SwiftShader, llvmpipe), every
 * item is reported "UNVERIFIED" whatever its numbers: they are proxies, not hardware evidence.
 * Exit: 0 all PASS on hardware, 1 any FAIL, 2 anything unverified or not run.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

async function eachInOrder<T>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await items.reduce<Promise<void>>(
    (previous, item, index) => previous.then(() => fn(item, index)),
    Promise.resolve(),
  );
}

/** Async child process: the preview server lives in this process, so a blocking spawnSync would starve it. */
function runChild(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ status: null, stderr: String(error) });
    });
    child.on("close", (status) => {
      resolve({ status, stderr });
    });
  });
}
import {
  SOFTWARE_RENDERER,
  exitCode,
  fmt,
  frameStats,
  framesPass,
  jsPerFrame,
  lighthouseSummary,
  mainThreadBusy,
  median,
  percentile,
  traceEvents,
  verdict,
  type Result,
} from "./lib.ts";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ITEMS = ["frames", "lighthouse", "reduced-motion", "probe", "contrast", "hidden"] as const;
type Item = (typeof ITEMS)[number];
const only = option("--only")?.split(",") ?? [...ITEMS];
const skip = option("--skip")?.split(",") ?? [];
const wanted = (item: Item): boolean => only.includes(item) && !skip.includes(item);
const device = option("--device");
if (!device)
  throw new Error('Name the device: --device "<model, GPU, RAM>" (recorded as evidence).');
const headless = args.includes("--headless");
/** Smoke tests only: answer the probe "hardware GPU" so the full-tier paths run on SwiftShader. */
const spoofProbe = args.includes("--spoof-probe");
const port = Number(option("--port") ?? 4540);
const lhRuns = Number(option("--lh-runs") ?? 3);
const probeRuns = Number(option("--probe-runs") ?? 10);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
const slug = device
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "-")
  .replaceAll(/^-|-$/g, "");
const out = resolvePath(root, option("--out") ?? join("test-results/hw", `${stamp}-${slug}`));
mkdirSync(out, { recursive: true });

const print = (text: string): void => {
  process.stdout.write(`${text}\n`);
};
const save = (file: string, data: unknown): string => {
  writeFileSync(join(out, file), `${JSON.stringify(data, null, 2)}\n`);
  return file;
};
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---- Build + preview (unless --url) -----------------------------------------------------------
let base = option("--url");
let stopServer = async (): Promise<void> => {};
if (!base) {
  const { build, preview } = await import("astro");
  const outDir = join(root, "node_modules/.cache/hw/dist");
  if (!args.includes("--no-build") || !existsSync(join(outDir, "index.html"))) {
    await build({ root, outDir, logLevel: "warn" });
  }
  const server = await preview({
    root,
    outDir,
    logLevel: "warn",
    server: { host: "127.0.0.1", port },
  });
  stopServer = () => server.stop();
  base = `http://127.0.0.1:${port}/`;
}
const url = (path: string): string => new URL(path, base).href;

// ---- Browser ----------------------------------------------------------------------------------
const browser: Browser = await chromium.launch({
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : { channel: "chrome" }),
  headless,
  // Headed (the real run) uses stock flags so the tier is the one a visitor's Chrome picks;
  // the headless smoke needs SwiftShader enabled to have WebGL at all.
  args: headless ? ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] : [],
});
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const isScene = (u: string): boolean => /\/_astro\/stage\.[\w-]+\.js/.test(u);
const isProbe = (u: string): boolean => u.includes("probe.worker");

async function fresh(
  options: BrowserContextOptions = DESKTOP,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(options);
  if (spoofProbe) {
    await context.route(/probe\.worker/, (route) =>
      route.fulfill({ contentType: "text/javascript", body: "postMessage(true);" }),
    );
  }
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function waitTier(page: Page, tier: "full" | "static", timeout = 20_000): Promise<boolean> {
  try {
    await page.locator(`html[data-tier='${tier}']`).waitFor({ state: "attached", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Counts every rAF callback and its duration (per-frame JS), and WebGL contexts created. */
const INSTRUMENT = `(() => {
  const raf = window.requestAnimationFrame.bind(window);
  const hw = { callbacks: [], rafs: 0, webgl: 0 };
  Object.defineProperty(window, "hwProbe", { value: hw });
  window.requestAnimationFrame = (fn) => raf((t) => {
    const s = performance.now();
    hw.rafs += 1;
    try { fn(t); } finally { hw.callbacks.push([t, performance.now() - s]); }
  });
  for (const proto of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype]) {
    if (!proto) continue;
    const get = proto.getContext;
    proto.getContext = function (type, ...rest) {
      if (/webgl/i.test(String(type))) hw.webgl += 1;
      return get.call(this, type, ...rest);
    };
  }
})();`;

interface Row {
  id: Item | "device";
  ac: string;
  result: Result;
  numbers: string;
  evidence: string[];
}
const rows: Row[] = [];

// ---- Device -----------------------------------------------------------------------------------
const info = await (async () => {
  const { page, close } = await fresh();
  await page.goto(url("/"));
  const gpu = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return { renderer: "no WebGL2", vendor: "" };
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
      vendor: String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR)),
    };
  });
  const client = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    screen: `${screen.width}×${screen.height}`,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
  }));
  await close();
  return {
    device,
    recordedAt: new Date().toISOString(),
    browser: `Chrome ${browser.version()}${headless ? " (headless)" : ""}`,
    os: `${platform()} ${release()}`,
    cpu: `${cpus()[0]?.model ?? "?"} × ${cpus().length}`,
    memoryGB: Math.round(totalmem() / 1e9),
    gpu,
    ...client,
    commit: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    url: base,
  };
})();
const hardware =
  !spoofProbe && !SOFTWARE_RENDERER.test(info.gpu.renderer) && info.gpu.renderer !== "no WebGL2";
save("device.json", info);
print(
  `Device: ${device} · ${info.gpu.renderer} · ${info.browser} · ${hardware ? "hardware GPU" : "SOFTWARE RENDERER: results are proxies"}`,
);

// ---- M2-AC11 frame budget ---------------------------------------------------------------------
if (wanted("frames")) {
  const { page, close } = await fresh();
  await page.addInitScript({ content: INSTRUMENT });
  await page.goto(url("/?scene-test"));
  const full = await waitTier(page, "full");
  if (full) {
    await sleep(2000);
    await browser.startTracing(page, { path: join(out, "frames-trace.json"), screenshots: false });
    const run = await page.evaluate<{
      stamps: number[];
      callbacks: [number, number][];
    }>(`new Promise((done) => {
      const hw = window.hwProbe;
      hw.callbacks.length = 0;
      const max = document.documentElement.scrollHeight - innerHeight;
      const stamps = [];
      let start = 0;
      const step = (t) => {
        if (!start) start = t;
        const f = Math.min(1, (t - start) / 16000);
        window.scrollTo(0, f * max);
        stamps.push(t);
        if (f < 1) requestAnimationFrame(step);
        else done({ stamps, callbacks: hw.callbacks.slice() });
      };
      requestAnimationFrame(step);
    })`);
    await browser.stopTracing();
    const { stamps, callbacks } = run;
    const stats = frameStats(stamps, jsPerFrame(callbacks));
    save("frames.json", {
      method: "16 s linear 0→100 % scroll at 1440×900, rAF timestamps",
      stats,
      stamps,
      callbacks,
    });
    rows.push({
      id: "frames",
      ac: "M2-AC11",
      result: verdict(true, framesPass(stats), hardware),
      numbers: `${stats.frames} frames · p95 ${fmt(stats.p95)} ms (≤ 16.7) · > 33 ms ${fmt(stats.over33 * 100)} % (≤ 2) · JS p95 ${fmt(stats.jsP95, 2)} ms (≤ 4) · p50 ${fmt(stats.p50)} · max ${fmt(stats.max)}`,
      evidence: ["frames.json", "frames-trace.json"],
    });
  } else {
    rows.push({
      id: "frames",
      ac: "M2-AC11",
      result: "NOT RUN",
      numbers: "full tier not chosen on this device",
      evidence: [],
    });
  }
  await close();
}

// ---- M3-AC2 reduced motion on a GPU: zero three.js ------------------------------------------
if (wanted("reduced-motion")) {
  const { page, close } = await fresh({ ...DESKTOP, reducedMotion: "reduce" });
  await page.addInitScript({ content: INSTRUMENT });
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto(url("/"));
  await sleep(4000);
  await page.mouse.click(300, 300);
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await sleep(3000);
  const webgl = await page.evaluate(
    () => (window as Window & { hwProbe?: { webgl: number } }).hwProbe?.webgl ?? -1,
  );
  const reduce = {
    sceneRequests: urls.filter(isScene).length,
    probeRequests: urls.filter(isProbe).length,
    webglContexts: webgl,
  };
  await close();

  // Mid-session switch: full tier, then the OS preference flips to reduce.
  const live = await fresh({ ...DESKTOP, reducedMotion: "no-preference" });
  await live.page.addInitScript({ content: INSTRUMENT });
  await live.page.goto(url("/"));
  const full = await waitTier(live.page, "full");
  let switchResult: { frames: number; ms: number; tier: string | null; poster: boolean } | null =
    null;
  if (full) {
    await live.page.evaluate(`(() => {
      const hw = window.hwProbe;
      const mq = matchMedia("(prefers-reduced-motion: reduce)");
      hw.switch = { at: 0, rafsAt: 0, doneAt: 0, rafsDone: 0 };
      mq.addEventListener("change", () => { hw.switch.at = performance.now(); hw.switch.rafsAt = hw.rafs; });
      new MutationObserver(() => {
        if (document.documentElement.dataset.tier === "static" && !hw.switch.doneAt) {
          hw.switch.doneAt = performance.now(); hw.switch.rafsDone = hw.rafs;
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-tier"] });
    })()`);
    await live.page.emulateMedia({ reducedMotion: "reduce" });
    await sleep(1000);
    const s = await live.page.evaluate<{
      at: number;
      rafsAt: number;
      doneAt: number;
      rafsDone: number;
    }>("window.hwProbe.switch");
    switchResult = {
      frames: s.doneAt ? s.rafsDone - s.rafsAt : Number.NaN,
      ms: s.doneAt ? s.doneAt - s.at : Number.NaN,
      tier: await live.page.locator("html").getAttribute("data-tier"),
      poster: await live.page.locator("#hello .still img").isVisible(),
    };
  }
  await live.close();
  const passed =
    reduce.sceneRequests === 0 &&
    reduce.probeRequests === 0 &&
    reduce.webglContexts === 0 &&
    switchResult !== null &&
    switchResult.tier === "static" &&
    switchResult.frames <= 1 &&
    switchResult.poster;
  save("reduced-motion.json", { reduce, switchToReduce: switchResult });
  rows.push({
    id: "reduced-motion",
    ac: "M3-AC2 (hardware)",
    result: verdict(true, passed, hardware && full),
    numbers: `reduce: ${reduce.sceneRequests} scene / ${reduce.probeRequests} probe requests, ${reduce.webglContexts} WebGL contexts · switch: ${switchResult ? `${fmt(switchResult.frames, 0)} frame(s), ${fmt(switchResult.ms)} ms → ${switchResult.tier}, poster ${switchResult.poster ? "shown" : "missing"}` : "not run (full tier not chosen)"}`,
    evidence: ["reduced-motion.json"],
  });
}

// ---- M3-AC6 probe, hardware branch ------------------------------------------------------------
if (wanted("probe")) {
  const runs: Record<string, number | boolean | null>[] = [];
  await eachInOrder(
    Array.from({ length: probeRuns }, (_, n) => n),
    async (i) => {
      const { page, close } = await fresh();
      await page.addInitScript({
        content: `window.hwLongTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.hwLongTasks.push([e.startTime, e.duration]); }).observe({ type: "longtask", buffered: true });`,
      });
      const tracing = i === 0;
      if (tracing)
        await browser.startTracing(page, {
          path: join(out, "probe-trace.json"),
          screenshots: false,
        });
      await page.goto(url("/"));
      const full = await waitTier(page, "full", 10_000);
      const t = await page.evaluate(() => {
        const entries = performance
          .getEntriesByType("resource")
          .filter((e): e is PerformanceResourceTiming => e instanceof PerformanceResourceTiming);
        const probe = entries.find((e) => e.name.includes("probe.worker"));
        const scene = entries.find((e) => e.name.includes("/_astro/stage."));
        const load =
          performance
            .getEntriesByType("navigation")
            .find((e): e is PerformanceNavigationTiming => e instanceof PerformanceNavigationTiming)
            ?.loadEventEnd ?? null;
        const longTasks =
          (window as Window & { hwLongTasks?: [number, number][] }).hwLongTasks ?? [];
        return {
          loadEnd: load,
          probeStart: probe?.startTime ?? null,
          probeBytes: probe ? probe.transferSize || probe.encodedBodySize : null,
          decision: scene?.startTime ?? null,
          longTasksInWindow:
            probe && scene
              ? longTasks.filter(([s, d]) => s + d > probe.startTime && s < scene.startTime).length
              : null,
          timeOrigin: performance.timeOrigin,
        };
      });
      if (tracing) await browser.stopTracing();
      runs.push({ full, ...t });
      await close();
    },
  );
  const decisions = runs.map((r) => r.decision).filter((d): d is number => typeof d === "number");
  const probeMs = runs
    .map((r) =>
      typeof r.decision === "number" && typeof r.probeStart === "number"
        ? r.decision - r.probeStart
        : null,
    )
    .filter((d): d is number => d !== null);
  let busy = Number.NaN;
  const first = runs[0];
  if (
    first &&
    typeof first.probeStart === "number" &&
    typeof first.decision === "number" &&
    existsSync(join(out, "probe-trace.json"))
  ) {
    const events = traceEvents(JSON.parse(readFileSync(join(out, "probe-trace.json"), "utf8")));
    const nav = events.find((e) => e.name === "navigationStart");
    if (nav?.ts !== undefined)
      busy = mainThreadBusy(events, nav.ts, first.probeStart, first.decision);
  }
  const allFull = runs.every((r) => r.full === true);
  const longTasks = runs.reduce(
    (n, r) => n + (typeof r.longTasksInWindow === "number" ? r.longTasksInWindow : 0),
    0,
  );
  const p95 = percentile(decisions, 0.95);
  const bytes = typeof first?.probeBytes === "number" ? first.probeBytes : Number.NaN;
  const passed = allFull && p95 <= 300 && longTasks === 0 && bytes <= 1024;
  save("probe.json", {
    runs,
    decisionP95: p95,
    probeOnlyP95: percentile(probeMs, 0.95),
    mainThreadBusyRun1: busy,
  });
  rows.push({
    id: "probe",
    ac: "M3-AC6 (hardware branch)",
    result: verdict(runs.length > 0, passed, hardware && allFull),
    numbers: `${runs.length} loads, full tier in ${runs.filter((r) => r.full === true).length} · navigation → decision p95 ${fmt(p95, 0)} ms (≤ 300) · probe start → decision p95 ${fmt(percentile(probeMs, 0.95), 0)} ms · long tasks in probe window ${longTasks} · main thread busy in the window (run 1, all tasks, upper bound for ≤ 5 ms) ${fmt(busy, 2)} ms · worker ${fmt(bytes, 0)} B`,
    evidence: ["probe.json", "probe-trace.json"],
  });
}

// ---- M2-AC10 a real hidden tab renders nothing ---------------------------------------------
if (wanted("hidden")) {
  const { page, close: closeHidden } = await fresh();
  const context = page.context();
  await page.goto(url("/?scene-test"));
  const full = await waitTier(page, "full");
  let result: Record<string, unknown> = { full };
  let passed = false;
  let real = false;
  if (full) {
    const frames = (): Promise<number> =>
      page.evaluate(
        () =>
          (window as Window & { darkroomTest?: { frames: () => number } }).darkroomTest?.frames() ??
          -1,
      );
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight * 0.3);
    });
    await sleep(3000);
    const other = await context.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    await sleep(500);
    const state = await page.evaluate(() => document.visibilityState);
    real = state === "hidden";
    const before = await frames();
    await page.evaluate(() => {
      window.scrollBy(0, 600);
    });
    await sleep(3000);
    const hiddenFrames = (await frames()) - before;
    await page.bringToFront();
    await sleep(500);
    const resumeStart = await frames();
    await page.evaluate(() => {
      window.scrollBy(0, 400);
    });
    await sleep(1000);
    const resumed = (await frames()) - resumeStart;
    result = { full, visibilityState: state, hiddenFrames, framesAfterReturn: resumed };
    passed = real && hiddenFrames === 0 && resumed > 0;
  }
  await closeHidden();
  save("hidden-tab.json", result);
  rows.push({
    id: "hidden",
    ac: "M2-AC10 (real hidden tab)",
    result: verdict(full && real, passed, hardware),
    numbers: full
      ? real
        ? `visibilityState ${String(result.visibilityState)} · ${String(result.hiddenFrames)} frames while hidden (= 0) · ${String(result.framesAfterReturn)} after return (> 0)`
        : `the browser did not report the tab as hidden (${String(result.visibilityState)}); run headed`
      : "full tier not chosen on this device",
    evidence: ["hidden-tab.json"],
  });
}

await browser.close();

// Lighthouse and the contrast script launch their own Chrome: close ours first so only one
// browser runs at a time (and the GPU is not shared between two processes).
// ---- §3 full-tier Lighthouse (desktop) --------------------------------------------------------
if (wanted("lighthouse")) {
  const scores: { perf: number; a11y: number; bp: number; seo: number; full: boolean }[] = [];
  const files: string[] = [];
  const runIndexes = Array.from({ length: lhRuns }, (_, k) => k + 1);
  // No --ignore-gpu-blocklist here: Lighthouse should see the tier a visitor's Chrome picks.
  const flags = headless ? "--headless=new --no-sandbox --disable-dev-shm-usage" : "";
  const lhEnv = {
    ...process.env,
    CHROME_PATH: process.env.CHROME_PATH ?? chromium.executablePath(),
  };
  await eachInOrder(runIndexes, async (i) => {
    const prefix = join(out, `lighthouse-desktop-r${i}`);
    const r = await runChild(
      "npx",
      [
        "--yes",
        "lighthouse@13.6.0",
        url("/"),
        "--preset=desktop",
        "--quiet",
        ...(flags ? [`--chrome-flags=${flags}`] : []),
        "--output=json",
        "--output=html",
        `--output-path=${prefix}`,
      ],
      lhEnv,
    );
    const jsonFile = `${prefix}.report.json`;
    if (r.status !== 0 || !existsSync(jsonFile)) {
      print(`Lighthouse run ${i} failed: ${r.stderr.slice(-400)}`);
      return;
    }
    const report = lighthouseSummary(JSON.parse(readFileSync(jsonFile, "utf8")));
    scores.push({
      perf: report.perf,
      a11y: report.a11y,
      bp: report.bp,
      seo: report.seo,
      full: report.requests.some(isScene),
    });
    files.push(relative(out, jsonFile), relative(out, `${prefix}.report.html`));
  });
  const m = (k: "perf" | "a11y" | "bp" | "seo"): number => median(scores.map((s) => s[k]));
  const allFull = scores.length > 0 && scores.every((s) => s.full);
  const passed = allFull && m("perf") >= 90 && m("a11y") >= 95 && m("bp") >= 95 && m("seo") >= 95;
  save("lighthouse.json", { runs: scores });
  rows.push({
    id: "lighthouse",
    ac: "§3 full-tier LH",
    result: verdict(scores.length > 0, passed, hardware && allFull),
    numbers: `${scores.length}/${lhRuns} runs · median Perf ${fmt(m("perf"), 0)} (≥ 90) · A11y ${fmt(m("a11y"), 0)} · BP ${fmt(m("bp"), 0)} · SEO ${fmt(m("seo"), 0)} (≥ 95) · full tier in ${scores.filter((s) => s.full).length}/${scores.length} runs`,
    evidence: ["lighthouse.json", ...files],
  });
}

// ---- M3-AC5 full-tier contrast (PF-04's script) ----------------------------------------------
if (wanted("contrast")) {
  const script = join(root, "tools/contrast/measure.ts");
  if (existsSync(script)) {
    const r = spawnSync(
      process.execPath,
      [script, "--gpu", "--viewports", "D,D2", "--tier", "full", "--out", join(out, "contrast")],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    writeFileSync(join(out, "contrast.log"), `${r.stdout}\n${r.stderr}`);
    const tail = r.stdout.trim().split("\n").slice(-4).join(" · ");
    rows.push({
      id: "contrast",
      ac: "M3-AC5 (full tier)",
      result: verdict(r.status === 0 || r.status === 1, r.status === 0, hardware),
      numbers: tail || `exit ${r.status}`,
      evidence: ["contrast.log", "contrast/summary.md", "contrast/contrast.csv"],
    });
  } else {
    rows.push({
      id: "contrast",
      ac: "M3-AC5 (full tier)",
      result: "NOT RUN",
      numbers: "tools/contrast/measure.ts missing (PF-04 not merged yet)",
      evidence: [],
    });
  }
}

await stopServer();

const md = [
  `# Real-hardware verification · ${device}`,
  "",
  `Recorded ${info.recordedAt} · ${info.browser} · ${info.os} · ${info.cpu} · ${info.memoryGB} GB · DPR ${info.devicePixelRatio} · commit \`${info.commit}\``,
  `WebGL: ${info.gpu.renderer} (${info.gpu.vendor}) · ${hardware ? "**hardware GPU**" : "**software renderer: every item is UNVERIFIED on hardware**"}`,
  "",
  "| item | AC | result | numbers | evidence |",
  "|---|---|---|---|---|",
  ...rows
    .toSorted((a, b) => ITEMS.findIndex((x) => x === a.id) - ITEMS.findIndex((x) => x === b.id))
    .map(
      (r) =>
        `| ${r.id} | ${r.ac} | ${r.result === "PASS" ? "PASS" : `**${r.result}**`} | ${r.numbers.replaceAll("|", "\\|")} | ${r.evidence.join(", ")} |`,
    ),
  "",
];
writeFileSync(join(out, "SUMMARY.md"), md.join("\n"));
save("summary.json", { device: info, hardware, rows });
print(md.join("\n"));
print(`Evidence: ${relative(root, out)}`);
process.exitCode = exitCode(rows.map((r) => r.result));
