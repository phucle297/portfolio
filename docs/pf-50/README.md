# PF-50 evidence: visible layout jumps that CLS misses

Check: `tests/e2e/visible-jump.spec.ts` (samples `getBoundingClientRect()` of `.site-header`,
`#hello-title`, `#hello [data-copy-body]` and `#hello .hello__lede` every animation frame for 3 s of a reload; fails if
any moves more than 8 px from its first frame after first paint; at 1440 it also fails if that
baseline frame is already pinned).

Full tier on this GPU-less box (and in CI): the WebGL probe worker is spoofed to answer
"hardware WebGL2" (`spoofHardwareGpu`, as in `tiers.spec.ts`) and the scene renders on
SwiftShader. A real GPU run would be stronger.

| Build                               | Viewport | Tier / pin            | header | H1           | Hello copy    | Result            |
| ----------------------------------- | -------- | --------------------- | ------ | ------------ | ------------- | ----------------- |
| 25711dd (before the PR #33 pin fix) | 1440×900 | full / on             | 0 px   | 98 / 16.6 px | 177.7 / 80 px | fails (3/3 runs)  |
| main 9a54513                        | 1440×900 | full / on             | 0 px   | 0 px         | 0 px          | passes (4/4 runs) |
| main 9a54513                        | 390×844  | static (below 768 px) | 0 px   | 0 px         | 0 px          | passes (4/4 runs) |

Movement is max |Δtop| / |Δleft| after first paint. Chrome CLS for the 25711dd reload was 0 to
0.000157 (QA on PR #33), so CLS is not the evidence for this class of jump.

Files: `*.json` is the per-frame box series plus the summary; `*.trace.zip` opens with
`bunx playwright show-trace <file>` (screenshots and DOM snapshots of the reload).

## Attempt 2: the lede is watched too (QA PARTIAL on #34)

At 1440 `#hello [data-copy-body]` is the viewport-sized wrapper (0,0 1440×900), so a move of the
copy text alone was invisible to it. The spec now also watches `#hello .hello__lede`, the visible
copy (576×82 at 1440, inside the pinned body, so it moves with both the body and the text).

| Build                   | Plant                                                                                                       | Result                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| merge with main fb6821b | `.hello__lede` `position: relative; top: 20px` at 1.5 s (script in `<head>` of a copy of `dist/index.html`) | fails: lede Δtop 20 px at t=1509 ms; header/H1/wrapper 0 px (1/1 run) |
| merge with main fb6821b | none                                                                                                        | passes, 0 px for all four (2/2 runs)                                  |

Files: `plant-lede-20px-1500-1440x900.json`, `plant-lede-20px-1500-1440x900.trace.zip`,
`plant-lede-20px-1500.log`, `main-fb6821b-1440x900.json`.
