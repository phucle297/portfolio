/**
 * Size budgets (build-plan §3, M1-AC17): one command that prints every size budget as a number
 * with PASS/FAIL and exits 1 when any fails.
 *
 *   bun run budget:check                 # build (hidden source maps) + measure
 *   bun run budget:check -- --no-build   # re-measure the last budget build
 *   bun run budget:check -- --json out.json
 *
 * Method
 * - Its own production build in node_modules/.cache/budget/dist, identical to `astro build` except
 *   for hidden source maps (no sourceMappingURL comment, so the chunks are byte-identical). The
 *   maps split the lazy chunk into three.js vs scene code.
 * - JS budgets: gzip -9 of each chunk. "Initial" = the HTML's module scripts plus their static
 *   imports; "lazy" = chunks only reached through import(). Inline <script> bytes are part of the
 *   HTML and so of the transfer budgets.
 * - Transfer, fonts, textures: Chromium loads the built page (served from disk through request
 *   interception; no port, no server). Every distinct URL it fetches is counted at gzip -9 for text
 *   and at raw size for woff2/avif/png. Static tier = probe answers "no hardware GPU"; full tier =
 *   probe answers "hardware GPU" (the scene then runs on SwiftShader), measured after idle.
 *
 * Set CHROME_PATH to use a system Chrome instead of Playwright's Chromium.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContextOptions } from "@playwright/test";
import {
  KB,
  attributeBySource,
  formatTable,
  gzip9,
  isSourceMap,
  kb,
  scriptSources,
  status,
  walkChunks,
  wireBytes,
  type BudgetRow,
} from "./lib.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "node_modules/.cache/budget/dist");
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** §3 limits, bytes (KB = 1000 B, as in the QA reports). */
const LIMIT = {
  initialJs: 15 * KB,
  three: 160 * KB,
  scene: 40 * KB,
  stage: 200 * KB,
  probe: 1 * KB,
  fonts: 150 * KB,
  stillDesktop: 60 * KB,
  stillMobile: 25 * KB,
  transferDesktop: 300 * KB,
  transferMobile: 250 * KB,
  transferFull: 550 * KB,
  textures: 0,
} as const;

if (!args.includes("--no-build") || !existsSync(join(outDir, "index.html"))) {
  const { build } = await import("astro");
  await build({
    root,
    outDir,
    logLevel: "warn",
    vite: { build: { sourcemap: "hidden" } },
  });
}

const read = (rel: string): string => readFileSync(join(outDir, rel), "utf8");
const bytes = (rel: string): Uint8Array => readFileSync(join(outDir, rel));
const toRel = (url: string): string => url.replace(/^\//, "").replace(/[?#].*$/, "");
const html = read("index.html");
const assets = readdirSync(join(outDir, "_astro"));

// ---- JS chunks ---------------------------------------------------------------------------------
const entries = scriptSources(html)
  .filter((src) => src.startsWith("/_astro/"))
  .map(toRel);
const { initial, lazy } = walkChunks(entries, read, (from, specifier) =>
  posix.join(posix.dirname(from), specifier),
);
const gz = (rel: string): number => gzip9(bytes(rel));
const initialJs = initial.reduce((sum, f) => sum + gz(f), 0);
const stageJs = lazy.reduce((sum, f) => sum + gz(f), 0);

const threeParts: string[] = [];
const sceneParts: string[] = [];
let unmapped = 0;
for (const file of lazy) {
  const mapFile = `${file}.map`;
  if (!existsSync(join(outDir, mapFile))) throw new Error(`No source map for ${file}`);
  const map: unknown = JSON.parse(read(mapFile));
  if (!isSourceMap(map)) throw new Error(`${mapFile} is not a v3 source map`);
  const mapDir = dirname(join(outDir, mapFile));
  for (const [source, text] of attributeBySource(read(file), map)) {
    // Map sources are relative to the map file; resolve them to find the package they came from.
    const path = source === null ? "" : resolve(mapDir, source).replaceAll("\\", "/");
    if (path.includes("/node_modules/three/")) threeParts.push(text);
    else {
      sceneParts.push(text);
      if (source === null) unmapped += text.length;
    }
  }
}
const threeJs = gzip9(threeParts.join(""));
const sceneJs = gzip9(sceneParts.join(""));
const probeFile = assets.find((f) => /^probe\.worker[.-].*\.js$/.test(f));
const probeJs = probeFile ? gz(`_astro/${probeFile}`) : 0;

// ---- Stills ------------------------------------------------------------------------------------
const stills = (prefix: string): { name: string; size: number }[] =>
  assets
    .filter((f) => f.startsWith(prefix) && f.endsWith(".avif"))
    .map((name) => ({ name, size: bytes(`_astro/${name}`).byteLength }))
    .toSorted((a, b) => b.size - a.size);
const desktopStills = stills("d-");
const mobileStills = stills("m-");

// ---- Browser: what each tier actually fetches --------------------------------------------------
const ORIGIN = "http://budget.test";
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".json": "application/json",
};

interface Fetched {
  readonly path: string;
  readonly bytes: number;
  readonly afterStage: boolean;
  /** Fetched by an `<img loading="lazy">` (a below-the-fold still), so not part of first load. */
  lazyImage: boolean;
}

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});

async function load(
  options: BrowserContextOptions,
  hardwareGpu: boolean,
): Promise<{ fetched: Fetched[]; external: string[] }> {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  const page = await context.newPage();
  const seen = new Map<string, Fetched>();
  const external: string[] = [];
  let stageRequested = false;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) {
      external.push(url.href);
      await route.abort();
      return;
    }
    let rel = toRel(decodeURIComponent(url.pathname)) || "index.html";
    if (!extname(rel)) rel = posix.join(rel, "index.html");
    const file = join(outDir, rel);
    if (!existsSync(file) || relative(outDir, file).startsWith("..")) {
      await route.fulfill({ status: 404, body: "" });
      return;
    }
    const body = readFileSync(file);
    if (/^_astro\/stage[.-]/.test(rel)) stageRequested = true;
    if (!seen.has(rel)) {
      seen.set(rel, {
        path: rel,
        bytes: wireBytes(rel, body),
        afterStage: stageRequested,
        lazyImage: false,
      });
    }
    // The probe's real bytes are counted above; its answer is pinned so the tier is deterministic.
    if (rel.includes("probe.worker")) {
      await route.fulfill({ contentType: "text/javascript", body: `postMessage(${hardwareGpu});` });
      return;
    }
    await route.fulfill({ body, contentType: MIME[extname(rel)] ?? "application/octet-stream" });
  });
  await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  if (hardwareGpu) {
    // Full tier: the island loads on idle (or first input); wait for it, then for the network to settle.
    await page.waitForRequest(/\/_astro\/stage[.-]/, { timeout: 20_000 });
  }
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(hardwareGpu ? 3000 : 2000);
  await page.waitForLoadState("networkidle");
  const lazySources = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')]
      .map((img) => img.currentSrc)
      .filter(Boolean)
      .map((src) => new URL(src).pathname),
  );
  for (const src of lazySources) {
    const entry = seen.get(toRel(decodeURIComponent(src)));
    if (entry) entry.lazyImage = true;
  }
  await context.close();
  return { fetched: [...seen.values()], external };
}

const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const mobile: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const staticDesktop = await load(desktop, false);
const staticMobile = await load(mobile, false);
const fullDesktop = await load(desktop, true);
await browser.close();

const total = (list: readonly Fetched[]): number => list.reduce((s, f) => s + f.bytes, 0);
/** §3 "initial transfer": HTML + CSS + JS + fonts + the first (eager) poster; lazy stills excluded. */
const firstLoad = (list: readonly Fetched[]): Fetched[] => list.filter((f) => !f.lazyImage);
const lazyNote = (list: readonly Fetched[]): string => {
  const below = list.filter((f) => f.lazyImage);
  return below.length ? `; ${below.length} lazy still(s) (${kb(total(below))}) not counted` : "";
};
const isPageFont = (f: Fetched): boolean => /\.woff2?$/.test(f.path) && !f.path.includes("anton-");
const fontBytes = (list: readonly Fetched[]): number => total(list.filter(isPageFont));
const isImage = (f: Fetched): boolean => /\.(?:png|jpe?g|webp|avif|ktx2|basis|gif)$/i.test(f.path);
const textures = fullDesktop.fetched.filter((f) => f.afterStage && isImage(f));
const fontsDesktop = fontBytes(staticDesktop.fetched);
const fontsMobile = fontBytes(staticMobile.fetched);
const stageLoaded = fullDesktop.fetched.some((f) => /^_astro\/stage[.-]/.test(f.path));
if (!stageLoaded) throw new Error("The full tier never requested the scene chunk.");
if (staticDesktop.fetched.some((f) => /^_astro\/stage[.-]/.test(f.path))) {
  throw new Error("The static tier fetched the scene chunk.");
}

const list = (files: readonly string[]): string =>
  files.map((f) => f.replace(/^_astro\//, "")).join(", ");
const rows: BudgetRow[] = [
  {
    id: "initial-js",
    label: "Initial JS (gz)",
    bytes: initialJs,
    limit: LIMIT.initialJs,
    detail: list(initial),
  },
  { id: "three", label: "three.js in the lazy chunk (gz)", bytes: threeJs, limit: LIMIT.three },
  {
    id: "scene",
    label: "Scene code in the lazy chunk (gz)",
    bytes: sceneJs,
    limit: LIMIT.scene,
    detail: `non-three bytes of ${list(lazy)}; ${unmapped} B unmapped counted here`,
  },
  {
    id: "stage",
    label: "Stage chunk, three + scene (gz)",
    bytes: stageJs,
    limit: LIMIT.stage,
    detail: list(lazy),
  },
  {
    id: "probe",
    label: "Probe worker (gz)",
    bytes: probeJs,
    limit: LIMIT.probe,
    detail: probeFile ?? "missing",
  },
  {
    id: "fonts",
    label: "Page fonts loaded (woff2, no Anton)",
    bytes: Math.max(fontsDesktop, fontsMobile),
    limit: LIMIT.fonts,
    detail: `desktop ${kb(fontsDesktop)}, mobile ${kb(fontsMobile)}`,
  },
  {
    id: "still-desktop",
    label: `Largest desktop still (${desktopStills.length} AVIF)`,
    bytes: desktopStills[0]?.size ?? 0,
    limit: LIMIT.stillDesktop,
    detail: desktopStills[0]?.name,
  },
  {
    id: "still-mobile",
    label: `Largest mobile still (${mobileStills.length} AVIF)`,
    bytes: mobileStills[0]?.size ?? 0,
    limit: LIMIT.stillMobile,
    detail: mobileStills[0]?.name,
  },
  {
    id: "transfer-desktop",
    label: "Initial transfer, static, desktop",
    bytes: total(firstLoad(staticDesktop.fetched)),
    limit: LIMIT.transferDesktop,
    detail: `${firstLoad(staticDesktop.fetched).length} requests${lazyNote(staticDesktop.fetched)}`,
  },
  {
    id: "transfer-mobile",
    label: "Initial transfer, static, mobile",
    bytes: total(firstLoad(staticMobile.fetched)),
    limit: LIMIT.transferMobile,
    detail: `${firstLoad(staticMobile.fetched).length} requests${lazyNote(staticMobile.fetched)}`,
  },
  {
    id: "transfer-full",
    label: "Total transfer, full tier after idle",
    bytes: total(fullDesktop.fetched),
    limit: LIMIT.transferFull,
    detail: `${fullDesktop.fetched.length} requests`,
  },
  {
    id: "textures",
    label: "Images fetched by the scene",
    bytes: total(textures),
    limit: LIMIT.textures,
    detail: textures.map((f) => f.path).join(", ") || "none",
  },
];

const print = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};
const externals = [...staticDesktop.external, ...staticMobile.external, ...fullDesktop.external];
print(formatTable(rows));
print("");
for (const r of rows) if (r.detail) print(`- ${r.label}: ${r.detail}`);
if (externals.length)
  print(`- Blocked cross-origin requests (not counted): ${externals.join(", ")}`);
if (args.includes("--verbose")) {
  for (const [name, run] of Object.entries({ staticDesktop, staticMobile, fullDesktop })) {
    print(`\n${name}:`);
    for (const f of run.fetched) {
      print(`  ${kb(f.bytes).padStart(9)}  ${f.path}${f.lazyImage ? "  (lazy)" : ""}`);
    }
  }
}

const failed = rows.filter((r) => status(r) === "fail");
const jsonPath = flag("--json");
if (jsonPath) {
  const report = {
    rows: rows.map((r) => Object.assign({ status: status(r) }, r)),
    requests: { staticDesktop, staticMobile, fullDesktop },
  };
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}
print(
  failed.length
    ? `\n${failed.length} budget(s) over: ${failed.map((r) => r.id).join(", ")}`
    : "\nAll budgets pass.",
);
process.exitCode = failed.length ? 1 : 0;
