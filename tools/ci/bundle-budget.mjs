// @ts-check
/**
 * Bundle-size budget check for the built site (build plan §3 Budgets), run in CI on `dist/`.
 * Sizes are gzip -9 bytes; 1 KB = 1024 B. Exits 1 when any budget is exceeded.
 *
 * - Initial JS (before the island): module scripts in index.html, their static imports and
 *   inline scripts. Budget 15 KB gz.
 * - Lazy island (three.js + scene, emitted as one chunk): every other JS chunk except the probe
 *   worker. Budget 200 KB gz (three.js 160 KB + scene code 40 KB).
 * - Probe worker: 1 KB gz.
 * - Poster stills: each desktop AVIF ≤ 60 KB, each mobile AVIF ≤ 25 KB.
 *
 * Usage: node tools/ci/bundle-budget.mjs [distDir]
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const KB = 1024;
const dist = resolve(process.argv[2] ?? "dist");
const astroDir = join(dist, "_astro");

/** @param {string | Buffer} data */
const gz = (data) => gzipSync(data, { level: 9 }).length;
/** @param {number} bytes */
const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

const html = readFileSync(join(dist, "index.html"), "utf8");
const files = readdirSync(astroDir);

/** Resolve a script URL from index.html to a file in dist. @param {string} src */
const fromSrc = (src) => join(dist, src.replace(/^\//, "").split(/[?#]/)[0] ?? "");

/** Initial module graph: <script type=module src> + modulepreload, then static imports. */
const queue = [
  ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g),
  ...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g),
].map((match) => fromSrc(match[1] ?? ""));
const staticImport = /\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;
/** @type {Set<string>} */
const initial = new Set();
while (queue.length > 0) {
  const file = queue.pop();
  if (file === undefined || initial.has(file) || !existsSync(file)) continue;
  initial.add(file);
  for (const match of readFileSync(file, "utf8").matchAll(staticImport)) {
    queue.push(resolve(dirname(file), match[1] ?? ""));
  }
}
const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((match) => !/application\/(?:ld\+)?json/.test(match[1] ?? ""))
  .map((match) => match[2] ?? "")
  .join("\n");

const initialExternal = [...initial].reduce((sum, file) => sum + gz(readFileSync(file)), 0);
const initialInline = inlineScripts.trim() === "" ? 0 : gz(inlineScripts);
const jsFiles = files.filter((name) => name.endsWith(".js")).map((name) => join(astroDir, name));
const workers = jsFiles.filter((file) => basename(file).includes("worker"));
const lazy = jsFiles.filter((file) => !initial.has(file) && !workers.includes(file));
const lazyTotal = lazy.reduce((sum, file) => sum + gz(readFileSync(file)), 0);
const workerMax = Math.max(0, ...workers.map((file) => gz(readFileSync(file))));

const posters = files.filter((name) => /^[dm]-\d.*\.avif$/.test(name));
/** @param {"d" | "m"} kind */
const posterMax = (kind) =>
  Math.max(
    0,
    ...posters
      .filter((name) => name.startsWith(`${kind}-`))
      .map((name) => statSync(join(astroDir, name)).size),
  );

/** @type {[string, number, number][]} label, actual, budget */
const rows = [
  ["Initial JS (external + inline), gz", initialExternal + initialInline, 15 * KB],
  ["Lazy island JS (three.js + scene), gz", lazyTotal, 200 * KB],
  ["Probe worker, gz", workerMax, 1 * KB],
  ["Largest desktop poster (AVIF)", posterMax("d"), 60 * KB],
  ["Largest mobile poster (AVIF)", posterMax("m"), 25 * KB],
];

const lines = [
  "## Bundle-size budget",
  "",
  "| Budget | Actual | Limit | Result |",
  "|---|---|---|---|",
  ...rows.map(
    ([label, actual, limit]) =>
      `| ${label} | ${kb(actual)} | ${kb(limit)} | ${actual <= limit ? "pass" : "**FAIL**"} |`,
  ),
  "",
  `Initial chunks: ${[...initial].map((file) => relative(dist, file)).join(", ") || "none"}; inline ${kb(initialInline)}.`,
  `Lazy chunks: ${lazy.map((file) => relative(dist, file)).join(", ") || "none"}.`,
  `Posters found: ${posters.length}.`,
  "",
];
const report = lines.join("\n");
process.stdout.write(`${report}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

const failed = rows.filter(([, actual, limit]) => actual > limit);
if (posters.length === 0) {
  console.error("No poster stills found in dist/_astro (expected d-*.avif / m-*.avif).");
  process.exit(1);
}
if (failed.length > 0) {
  console.error(`Bundle budget exceeded: ${failed.map(([label]) => label).join("; ")}`);
  process.exit(1);
}
