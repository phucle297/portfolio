/* oxlint-disable -- PF-75 TEMP diagnostic, removed before the PR is ready */
// PF-75 TEMP diagnostic (removed before merge): WebKit frame rate per loader variant.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { chromium, webkit } from "@playwright/test";

const dist = "dist";
const orig = readFileSync(join(dist, "index.html"), "utf8");
const variants = {
  base: [],
  noRays: [[".loader:after{width:", ".loader:after{display:none;width:"]],
  openRaysNoMask: [[".is-open .loader:after{mask:", ".is-open .loader:after{-x:"]],
  raysPaused: [["8s linear .3s forwards ld-turn", "8s linear .3s paused ld-turn"]],
};
let html = orig;
const types = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".json": "application/json",
};
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (p === "/" || p === "/index.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
    return;
  }
  const f = join(dist, p);
  if (existsSync(f) && statSync(f).isFile()) {
    res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(4599, "127.0.0.1", r));
const browser = await (process.env.PROBE_ENGINE === "chromium" ? chromium : webkit).launch();
for (const [name, reps] of Object.entries(variants)) {
  html = orig;
  let ok = true;
  for (const [a, b] of reps) {
    if (!html.includes(a)) ok = false;
    html = html.replace(a, b);
  }
  for (let run = 0; run < 2; run += 1) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    let release;
    const gate = new Promise((r) => (release = r));
    await page.route(/\/_astro\/[dm]-0\.[\w-]+\.avif/, async (route) => {
      await gate;
      await route.continue().catch(() => {});
    });
    await page.addInitScript(() => {
      const o = { rafs: [], samples: [], ready: null, hidden: null };
      window.__p = o;
      const f = (t) => {
        o.rafs.push(performance.now());
        if (performance.now() < 4000) requestAnimationFrame(f);
      };
      requestAnimationFrame(f);
      const iv = setInterval(() => {
        const n = performance.now();
        if (n > 4000) return clearInterval(iv);
        const l = document.querySelector(".loader");
        const h = document.documentElement.classList;
        if (o.ready === null && h.contains("is-ready")) o.ready = n;
        if (!l) return;
        const cs = getComputedStyle(l);
        if (o.hidden === null && cs.visibility === "hidden") o.hidden = n;
        o.samples.push([
          Math.round(n),
          Math.round(document.timeline.currentTime ?? -1),
          cs.visibility,
          cs.getPropertyValue("--p").trim(),
          getComputedStyle(l, "::before").opacity,
        ]);
      }, 25);
    });
    await page.goto("http://127.0.0.1:4599/", { waitUntil: "commit" });
    await page.waitForTimeout(1300);
    release();
    await page.waitForTimeout(3000);
    const o = await page.evaluate(() => window.__p);
    const cnt = (a, b) => o.rafs.filter((t) => t >= a && t < b).length;
    const lag = Math.max(...o.samples.map((s) => s[0] - s[1]));
    const gaps = o.rafs.slice(1).map((t, i) => t - o.rafs[i]);
    const ready = o.ready ?? NaN;
    console.log(
      `PROBE ${name}${ok ? "" : "(PATTERN MISSING)"} run${run} waitFps(400-1200)=${(cnt(400, 1200) / 0.8).toFixed(1)} openFps=${(cnt(ready, ready + 600) / 0.6).toFixed(1)} maxGap=${Math.max(...gaps).toFixed(0)} ready=${ready.toFixed(0)} hidden=${(o.hidden ?? NaN).toFixed(0)} maxTimelineLag=${lag}`,
    );
    if (run === 0 && name === "base")
      console.log(
        "SAMPLES",
        JSON.stringify(o.samples.filter((s) => s[0] > ready - 100 && s[0] < ready + 900)),
      );
    await ctx.close();
  }
}
await browser.close();
server.close();
