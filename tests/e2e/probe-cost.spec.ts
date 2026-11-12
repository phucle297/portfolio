/**
 * PF-01 (M3-AC6, F4): what the capability probe costs, per branch, and the cheap gates that skip
 * it. Repeatable: every branch is loaded RUNS times in a fresh context; the table (median / p95)
 * is printed and written to test-results/probe-cost/probe-cost.md (override with PROBE_COST_OUT).
 *
 * Branches on this box (no GPU): the "hardware pass" worker is spoofed (it posts `true`), so its
 * numbers are the probe plumbing only and the hardware decision time is UNVERIFIED ON HARDWARE.
 * The software reject is the real worker on SwiftShader. The WebGL-disabled branch needs its own
 * browser flags, so it lives in probe-cost-webgl-disabled.spec.ts. Runner setup stays in the specs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, type BrowserContextOptions } from "@playwright/test";
import {
  expectBranch,
  fulfil,
  load,
  ProbeCostTable,
  repeat,
  RUNS,
  tbt,
  type Setup,
} from "./probe-cost.lib";

const table = new ProbeCostTable("probe-cost");

/** Runs in the page: requestAnimationFrame callbacks during one second. */
async function countFramesForOneSecond(): Promise<number> {
  const t0 = performance.now();
  let frames = 0;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      frames += 1;
      if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  return frames;
}

// Not serial: every test loads its own fresh browser contexts and shares nothing but the report
// table, which survives a worker restart (ProbeCostTable). One failure no longer skips the rest.

test.describe("PF-01 probe cost per branch (SwiftShader box)", () => {
  test.setTimeout(300_000);

  test("worker branches: hardware (spoofed), software reject, 404, throws", async ({ browser }) => {
    const hw = await repeat(RUNS, () => load(browser, fulfil("postMessage(true);")));
    table.record("hardware pass (spoofed worker; UNVERIFIED on hardware)", hw);
    expectBranch(hw, ["worker"], true);
    const sw = await repeat(RUNS, () => load(browser, null));
    table.record("software renderer reject (real worker, SwiftShader)", sw);
    expectBranch(sw, ["worker", "worker-timeout"], false);
    const missing = await repeat(RUNS, () => load(browser, fulfil("not found", 404)));
    table.record("worker 404", missing);
    expectBranch(missing, ["worker-error"], false);
    const throws = await repeat(RUNS, () => load(browser, fulfil('throw new Error("probe");')));
    table.record("worker throws", throws);
    expectBranch(throws, ["worker-error"], false);
  });

  test("worker hangs: decides at 3000 ± 50 ms, the page stays usable, TBT within ±10 ms of probe disabled", async ({
    browser,
  }) => {
    const hang = await repeat(RUNS, () =>
      load(browser, fulfil("// never answers"), { tbtEndMs: 6000, heartbeat: true }),
    );
    // Probe disabled: same page with the probe skipped by a cheap gate (Save-Data), same window.
    const disabled = await repeat(RUNS, () =>
      load(
        browser,
        async (page) => {
          await page.addInitScript(() => {
            Object.defineProperty(navigator, "connection", { value: { saveData: true } });
          });
        },
        { waitMs: 6000, tbtEndMs: 6000, heartbeat: true },
      ),
    );
    // Diagnostic only (not asserted): how late the page's own 10 ms timers ran at the 3000 ms
    // deadline, next to each decision time, so a miss can be told apart from a late timer.
    const diagnostic = hang.map((r) => ({
      probeMs: Math.round(r.probeMs * 10) / 10,
      heartbeatAtDeadlineMs: r.heartbeat?.atDeadlineMs,
      heartbeatMaxGapMs: r.heartbeat?.maxGapMs,
    }));
    test.info().annotations.push({
      type: "hang heartbeat (diagnostic)",
      description: JSON.stringify(diagnostic),
    });
    process.stdout.write(`worker hangs, heartbeat diagnostic: ${JSON.stringify(diagnostic)}\n`);
    table.record("worker hangs (timeout)", hang);
    table.record("probe disabled (baseline for TBT)", disabled);
    expectBranch(hang, ["worker-timeout"], false);
    for (const r of hang) expect(Math.abs(r.probeMs - 3000)).toBeLessThanOrEqual(50);
    for (const r of disabled) expect(r.probeRequests).toBe(0);
    expect(
      Math.abs(tbt(hang) - tbt(disabled)),
      `median TBT hang ${tbt(hang)} vs disabled ${tbt(disabled)}`,
    ).toBeLessThanOrEqual(10);

    // Usable while the probe hangs: frames keep coming, a key press moves focus and the page scrolls.
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await fulfil("// never answers")(page);
    await page.goto("/");
    await page.waitForLoadState("load");
    const during = {
      frames: await page.evaluate(countFramesForOneSecond),
      decided: await page.evaluate(() => performance.getEntriesByName("darkroom:probe").length > 0),
    };
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? "");
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const stillUndecided = await page.evaluate(
      () => performance.getEntriesByName("darkroom:probe").length === 0,
    );
    await context.close();
    expect(during.decided).toBe(false);
    expect(stillUndecided).toBe(true);
    expect(focused).not.toBe("BODY");
    // Frame rate while the probe hangs vs the same second with the probe disabled, back to back:
    // an absolute fps floor only measures how busy the shared box is.
    const base = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const basePage = await base.newPage();
    await basePage.addInitScript(() => {
      Object.defineProperty(navigator, "connection", { value: { saveData: true } });
    });
    await basePage.goto("/");
    await basePage.waitForLoadState("load");
    const baseline = await basePage.evaluate(countFramesForOneSecond);
    await base.close();
    expect(
      during.frames,
      `frames in 1 s: ${during.frames} while hanging vs ${baseline} with the probe disabled`,
    ).toBeGreaterThanOrEqual(Math.min(20, Math.floor(baseline * 0.75)));
  });

  // PF-01 option b (Orchestrator decision): without Worker or OffscreenCanvas there is no
  // main-thread WebGL probe at all; the page keeps the static tier.
  const missing: [string, string[]][] = [
    ["no Worker", ["Worker"]],
    ["no OffscreenCanvas", ["OffscreenCanvas"]],
    ["no Worker, no OffscreenCanvas", ["Worker", "OffscreenCanvas"]],
  ];
  for (const [label, globals] of missing) {
    test(`${label}: static tier, no main-thread WebGL context, no long task, branch "no-offscreen"`, async ({
      browser,
    }) => {
      const runs = await repeat(RUNS, () =>
        load(browser, async (page) => {
          await page.addInitScript((names: string[]) => {
            for (const name of names) Reflect.deleteProperty(window, name);
          }, globals);
        }),
      );
      table.record(`${label} (no-offscreen → static, no probe)`, runs);
      for (const r of runs) {
        expect(r).toMatchObject({
          branch: "no-offscreen",
          hardware: false,
          tier: "static",
          mainThreadWebGL: 0,
          probeRequests: 0,
          longTasks: [],
        });
        expect(r.mainThreadMs).toBeLessThanOrEqual(1);
      }
    });
  }

  test("the probe worker is ≤ 1 KB gzipped", () => {
    const dir = join(process.cwd(), "dist", "_astro");
    const files = readdirSync(dir).filter((f) => /^probe\.worker.*\.js$/u.test(f));
    expect(files).toHaveLength(1);
    const gz = gzipSync(readFileSync(join(dir, files[0] ?? ""))).length;
    table.note(`\nProbe worker ${files[0]}: ${gz} B gzipped (≤ 1024 B).`);
    expect(gz).toBeLessThanOrEqual(1024);
  });
});

test.describe("PF-01 cheap gates skip the probe entirely (M1-AC14)", () => {
  const gates: [string, Setup | null, BrowserContextOptions][] = [
    ["reduced motion", async (page) => page.emulateMedia({ reducedMotion: "reduce" }), {}],
    [
      "coarse pointer (1440 wide)",
      async (page) => {
        await page.addInitScript(() => {
          const real = window.matchMedia.bind(window);
          window.matchMedia = (q: string): MediaQueryList => {
            const list = real(q);
            if (q.includes("pointer: fine"))
              Object.defineProperty(list, "matches", { value: false });
            return list;
          };
        });
      },
      {},
    ],
    ["width 767", null, { viewport: { width: 767, height: 900 } }],
    [
      "Save-Data",
      async (page) => {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "connection", { value: { saveData: true } });
        });
      },
      {},
    ],
    [
      "Motion off (site toggle)",
      async (page) => {
        await page.addInitScript(() => {
          localStorage.setItem("motion", "off");
        });
      },
      {},
    ],
  ];
  for (const [name, setup, context] of gates) {
    test(`${name}: no probe request, no probe run`, async ({ browser }) => {
      const r = await load(browser, setup, { waitMs: 4500, context });
      expect(r.probeRequests).toBe(0);
      expect(r.branch).toBe("none");
    });
  }
});

test.afterAll(() => {
  table.write();
});
