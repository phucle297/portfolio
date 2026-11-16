# PF-53 evidence: visible-jump check at 1024×768, minimum frame count, real-GPU run

Check: `tests/e2e/visible-jump.spec.ts` (PF-50, see `docs/pf-50/README.md`). PF-53 adds:

- **1024×768** (AC2). Between `MIN_FULL_TIER_WIDTH` (768) and the pin breakpoint
  (`min-width: 1200px`), so it is the full tier but `data-pin` never turns on. The test expects
  `data-tier="full"` and no pin, and skips the "baseline frame not pinned" check there.
- **Minimum frame count** (AC3). A jump that comes and goes inside one long frame stall is never
  sampled, so each run needs at least **30 frames after first paint in the 3 s window** (10 fps),
  or it fails with `not enough frames: N sampled after first paint in 3000 ms (need >= 30, …)`.
  The JSON now records `framesAfterFirstPaint`, `maxFrameGapMs` and the WebGL `renderer`.
- **A one-command real-GPU run** (AC1, which this box can't do). The Owner copy-paste guide is
  in [docs/pf-62/RUN-ON-GPU.md](../pf-62/RUN-ON-GPU.md) (PF-62).

## Results on this box (SwiftShader, spoofed full tier, base main 2b80200)

| Run        | 1440×900 frames / longest gap | 1024×768 frames / longest gap | 390×844 frames / longest gap | Movement     | Result |
| ---------- | ----------------------------- | ----------------------------- | ---------------------------- | ------------ | ------ |
| main run 1 | 97 / 534 ms                   | 137 / 321 ms                  | 176 / 17 ms                  | 0 px for all | passes |
| main run 2 | 101 / 510 ms                  | 135 / 253 ms                  | 173 / 18 ms                  | 0 px for all | passes |

Threshold: 30 is about a third of the slowest viewport seen here (97 frames at 1440, where the
scene mounts and pins). It is meant to catch a starved run, not to measure smoothness, so a slower
CI runner should not make it flaky. CI counts are in the PR.

## Plants (into a copy of `dist/index.html`, 1024×768 only)

| Plant                                                                     | Result                                                                                               |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `.hello__lede` `position: relative; top: 20px` at 1.5 s                   | fails: lede Δtop 20 px at t=1502 ms (106 frames); header/H1/copy 0 px                                |
| main thread blocked 250 ms every 260 ms for the first 3.5 s (starves rAF) | fails: `not enough frames: 11 sampled after first paint in 3000 ms (need >= 30, longest gap 288 ms)` |

Plant scripts: lede jump
`<script>setTimeout(() => { lede.style.position='relative'; lede.style.top='20px' }, 1500 - performance.now())</script>`;
starve `<script>setInterval(() => { busy-wait 250 ms }, 260)</script>` (both injected after `<head>`).
Files: `main-2b80200-1024x768.json`, `plant-lede-20px-1500-1024x768.{json,trace.zip}`,
`plant-lede-20px-1500.log`, `plant-starve-250ms-1024x768.json`, `plant-starve-250ms.log`.

## Real-GPU run (AC1): for the Owner, on any machine with a GPU

Not run: this box and the standard GitHub runners have no GPU, and a paid GPU runner needs the
Owner's approval. On a Linux, macOS or Windows machine with a real GPU and a desktop session:

```sh
git clone https://github.com/phucle297/portfolio && cd portfolio
bun install && bunx playwright install chromium   # or set CHROME_PATH to an installed Chrome
bun run e2e:visible-jump:gpu
```

`e2e:visible-jump:gpu` builds the site, runs `visible-jump.spec.ts` in **headed** Chromium with its
normal GPU path (`playwright.gpu.config.ts`: no SwiftShader flags) and without the WebGL-probe spoof
(`PF53_REAL_GPU=1`), so the full tier comes from the real probe. It fails first with
`no hardware GPU` if WebGL is still a software renderer (SwiftShader / llvmpipe), before the tier
check. A single stall longer than **1000 ms** fails as `not enough frames` even when the total
frame count is still at least 30. Output for all three viewports goes to `pf-53-gpu/`
(git-ignored): `visible-boxes-<w>x<h>.json` (frames, renderer, movements) and
`trace-<w>x<h>.zip` (`bunx playwright show-trace pf-53-gpu/trace-1440x900.zip`). Attach both to the
PF-62 card.

Step-by-step (prerequisites, checkout, what to send back): [docs/pf-62/RUN-ON-GPU.md](../pf-62/RUN-ON-GPU.md).
