import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { spoofHardwareGpu } from "./helpers";
import { movements, recordVisibleBoxes } from "./visible-jump";

/**
 * PF-50: a reload must not visibly move the header, the Hello H1 or the Hello copy.
 *
 * What it checks: on a reload, every animation frame for the first 3 s, the on-screen box
 * (`getBoundingClientRect()` top/left) of each element. The baseline is its first frame after
 * first paint; the test fails if any of them later sits more than 8 px away. This is the visitor's
 * view; Chrome CLS and Lighthouse CLS are not, because a jump caused by `position: fixed` under
 * opacity/translate3d (the PR #33 pin jump: H1 98 px, copy 178 px, CLS 0) is not a layout shift.
 *
 * Full tier: this box and CI have no GPU. As in tiers.spec.ts, the WebGL probe worker is spoofed
 * to answer "hardware WebGL2" (`spoofHardwareGpu`) and the scene renders on SwiftShader, so
 * `data-tier="full"` mounts and `data-pin` turns on as it would on a GPU. A run on a real GPU is
 * stronger (real timings); Lighthouse in CI runs on a GPU-less preview that stays static and never
 * pins, so its CLS cannot catch this class of jump.
 *
 * 390×844 is below MIN_FULL_TIER_WIDTH (768), so the phone stays on the static tier even with the
 * spoof; it is still sampled, since a visitor on a phone sees that.
 *
 * Evidence: the frame series is attached as JSON and a Playwright trace (with screenshots) is
 * attached; set PF50_EVIDENCE_DIR to also copy both there.
 */

const WINDOW_MS = 3000;
const MAX_MOVE_PX = 8;

const VIEWPORTS = [
  { width: 1440, height: 900, tier: "full", pin: "on" },
  { width: 390, height: 844, tier: "static", pin: null },
] as const;

// Needs the SwiftShader-backed full-tier scene and Chrome's paint timing; Chromium is the
// reference engine for the probe spoof (same as tiers.spec.ts).
for (const vp of VIEWPORTS) {
  test(`PF-50 reload at ${vp.width}×${vp.height}: header, H1 and Hello copy stay within ${MAX_MOVE_PX}px after first paint @chromium-only`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await spoofHardwareGpu(page);
    await recordVisibleBoxes(page, WINDOW_MS);

    await page.goto("/");
    await page.waitForLoadState("load");
    // Reload at the top: the visitor's case in the PR #33 evidence.
    await context.tracing.start({ screenshots: true, snapshots: true, title: testInfo.title });
    await page.reload();
    await page.waitForFunction(() => window.visibleJump?.done === true, null, {
      timeout: WINDOW_MS + 20_000,
    });
    const tracePath = testInfo.outputPath(`trace-${vp.width}x${vp.height}.zip`);
    await context.tracing.stop({ path: tracePath });

    const run = await page.evaluate(() => ({
      samples: window.visibleJump?.samples ?? [],
      firstPaint: window.visibleJump?.firstPaint ?? null,
      tier: document.documentElement.dataset.tier ?? null,
      pin: document.documentElement.dataset.pin ?? null,
    }));
    const moved = movements(run.samples, run.firstPaint);
    const report = {
      viewport: `${vp.width}x${vp.height}`,
      windowMs: WINDOW_MS,
      maxMovePx: MAX_MOVE_PX,
      firstPaint: run.firstPaint,
      finalTier: run.tier,
      finalPin: run.pin,
      movements: moved,
      samples: run.samples,
    };
    const json = JSON.stringify(report, null, 2);
    await testInfo.attach(`visible-boxes-${vp.width}x${vp.height}.json`, {
      body: json,
      contentType: "application/json",
    });
    await testInfo.attach(`trace-${vp.width}x${vp.height}.zip`, {
      path: tracePath,
      contentType: "application/zip",
    });
    const out = process.env.PF50_EVIDENCE_DIR;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `visible-boxes-${vp.width}x${vp.height}.json`), json);
      copyFileSync(tracePath, join(out, `trace-${vp.width}x${vp.height}.zip`));
    }
    for (const m of moved) {
      testInfo.annotations.push({
        type: "movement",
        description: `${vp.width}x${vp.height} ${m.name}: max |Δtop| ${m.maxDTop}px, |Δleft| ${m.maxDLeft}px (baseline t=${m.baselineT} ms, worst t=${m.worstT} ms, ${m.frames} frames)`,
      });
    }

    // The full tier must actually mount, or the check proves nothing at desktop.
    expect(run.tier, "data-tier at the end of the window").toBe(vp.tier);
    // …and at desktop the scene must have pinned the copy, the state that jumped in PR #33.
    expect(run.pin, "data-pin at the end of the window").toBe(vp.pin);
    expect(run.firstPaint, "first-paint timing").not.toBeNull();
    for (const m of moved) {
      expect(m.baseline, `${m.name} is on screen after first paint`).not.toBeNull();
      expect.soft(m.maxDTop, `${m.name} |Δtop| after first paint`).toBeLessThanOrEqual(MAX_MOVE_PX);
      expect
        .soft(m.maxDLeft, `${m.name} |Δleft| after first paint`)
        .toBeLessThanOrEqual(MAX_MOVE_PX);
    }
  });
}
