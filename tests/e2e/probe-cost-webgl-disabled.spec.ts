/**
 * PF-01 (M3-AC6): the "WebGL disabled" probe branch. Chrome is launched with WebGL turned off, which
 * needs its own launch options, so this branch has its own file (a describe-level launchOptions
 * would force a second worker). Runner setup stays in this spec; playwright.config.ts is untouched.
 */
import { test } from "@playwright/test";
import { expectBranch, load, ProbeCostTable, repeat, RUNS, SWIFTSHADER } from "./probe-cost.lib";

const table = new ProbeCostTable("probe-cost-webgl-disabled");

test.use({
  launchOptions: {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [...SWIFTSHADER, "--disable-webgl", "--disable-3d-apis"],
  },
});

test("WebGL disabled: the worker finds no context and the page keeps its stills", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const runs = await repeat(RUNS, () => load(browser, null));
  table.record("WebGL disabled (--disable-3d-apis)", runs);
  // The worker finds no WebGL context (or, on a saturated box, is still starting at 3 s): static.
  expectBranch(runs, ["worker", "worker-timeout"], false);
});

test.afterAll(() => {
  table.write();
});
