import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { scrollThrough, spoofHardwareGpu } from "./helpers";
import { layoutShifts, recordLayoutShifts, shiftScore } from "./layout-shift";

// TASK-20261112-14 investigation only: the M1-AC15 D flow, with every shift's sources recorded.
test("probe layout shifts D full tier", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await spoofHardwareGpu(page);
  await recordLayoutShifts(page);
  await page.goto("/");
  await page.waitForTimeout(1500);
  const early = await layoutShifts(page);
  await scrollThrough(page);
  const shifts = await layoutShifts(page);
  const report = { early: shiftScore(early), total: shiftScore(shifts), shifts };
  writeFileSync(
    process.env.PROBE_OUT ?? test.info().outputPath("cls-probe.json"),
    JSON.stringify(report, null, 2),
  );
  process.stdout.write(`PROBE_JSON ${JSON.stringify(report)}\n`);
  await context.close();
});
