import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { spoofHardwareGpu } from "./helpers";
import {
  MAX_FRAME_GAP_MS,
  MIN_FRAMES,
  WINDOW_MS,
  firstVisibleJumpFailure,
  maxFrameGapMs,
  movements,
  recordVisibleBoxes,
} from "./visible-jump";

/**
 * PF-50: a reload must not visibly move the header, the Hello H1 or the Hello copy.
 *
 * What it checks: on a reload, every animation frame for the first 3 s, the on-screen box
 * (`getBoundingClientRect()` top/left) of the header, the H1, the Hello body wrapper and the Hello
 * lede (at 1440 the wrapper is viewport-sized, so the lede is what shows a copy move). The
 * baseline is each one's first frame after first paint; the test fails if any of them later sits
 * more than 8 px away, or (at 1440) if the baseline frame is already pinned. This is the visitor's
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
 * PF-53: 1024×768 (between MIN_FULL_TIER_WIDTH 768 and the 1200 px pin breakpoint) is the full
 * tier but never pins, so it is checked with `pin: null` (no pinned-baseline assertion). A jump that
 * comes and goes inside one long frame stall is never sampled, so the run also needs at least
 * MIN_FRAMES sampled frames after first paint, and no single stall longer than MAX_FRAME_GAP_MS,
 * or it fails as "not enough frames" instead of passing.
 *
 * Real GPU (PF-53 AC1 / PF-62): `bun run e2e:visible-jump:gpu` (see docs/pf-62/RUN-ON-GPU.md)
 * runs this spec headed with Chrome's GPU and without the probe spoof (PF53_REAL_GPU=1); it
 * fails first with "no hardware GPU" if WebGL is still a software renderer (before the tier
 * check), and writes the JSON + traces to PF50_EVIDENCE_DIR.
 *
 * Evidence: the frame series is attached as JSON and a Playwright trace (with screenshots) is
 * attached; set PF50_EVIDENCE_DIR to also copy both there.
 */

const MAX_MOVE_PX = 8;
const REAL_GPU = process.env.PF53_REAL_GPU === "1";

const VIEWPORTS = [
  { width: 1440, height: 900, tier: "full", pin: "on" },
  // PF-53: full tier, below the pin breakpoint (min-width 1200px), so data-pin never turns on.
  { width: 1024, height: 768, tier: "full", pin: null },
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
    if (!REAL_GPU) await spoofHardwareGpu(page);
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
      renderer: (() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
      })(),
    }));
    const moved = movements(run.samples, run.firstPaint);
    const painted = run.samples.filter((s) => run.firstPaint === null || s.t >= run.firstPaint);
    const maxGapMs = maxFrameGapMs(painted.map((s) => s.t));
    const report = {
      viewport: `${vp.width}x${vp.height}`,
      windowMs: WINDOW_MS,
      maxMovePx: MAX_MOVE_PX,
      minFrames: MIN_FRAMES,
      maxFrameGapCapMs: MAX_FRAME_GAP_MS,
      framesAfterFirstPaint: painted.length,
      maxFrameGapMs: maxGapMs,
      realGpu: REAL_GPU,
      renderer: run.renderer,
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
    testInfo.annotations.push({
      type: "frames",
      description: `${vp.width}x${vp.height}: ${painted.length} frames after first paint (min ${MIN_FRAMES}), longest gap ${maxGapMs} ms (cap ${MAX_FRAME_GAP_MS} ms), renderer ${run.renderer}`,
    });
    for (const m of moved) {
      testInfo.annotations.push({
        type: "movement",
        description: `${vp.width}x${vp.height} ${m.name}: max |Δtop| ${m.maxDTop}px, |Δleft| ${m.maxDLeft}px (baseline t=${m.baselineT} ms, worst t=${m.worstT} ms, ${m.frames} frames)`,
      });
    }

    // PF-62: on a GPU run the software-renderer guard runs first, so llvmpipe/SwiftShader
    // fails with "no hardware GPU" before the tier check. A single stall longer than
    // MAX_FRAME_GAP_MS also fails as "not enough frames".
    const guardFailure = firstVisibleJumpFailure({
      realGpu: REAL_GPU,
      renderer: run.renderer,
      expectedTier: vp.tier,
      actualTier: run.tier,
      expectedPin: vp.pin,
      actualPin: run.pin,
      firstPaint: run.firstPaint,
      framesAfterFirstPaint: painted.length,
      maxFrameGapMs: maxGapMs,
    });
    expect(guardFailure, guardFailure ?? "visible-jump guards").toBeNull();
    if (vp.pin !== null) {
      // The baseline must come before the pin, or a pin jump folds into it and passes unseen.
      const baselineT = Math.max(...moved.map((m) => m.baselineT ?? Infinity));
      const atBaseline = run.samples.find((s) => s.t === baselineT);
      expect(
        atBaseline?.pin ?? null,
        `data-pin at the baseline frame (t=${baselineT} ms)`,
      ).toBeNull();
    }
    for (const m of moved) {
      expect(m.baseline, `${m.name} is on screen after first paint`).not.toBeNull();
      expect.soft(m.maxDTop, `${m.name} |Δtop| after first paint`).toBeLessThanOrEqual(MAX_MOVE_PX);
      expect
        .soft(m.maxDLeft, `${m.name} |Δleft| after first paint`)
        .toBeLessThanOrEqual(MAX_MOVE_PX);
    }
  });
}
