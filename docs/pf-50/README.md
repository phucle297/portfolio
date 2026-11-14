# PF-50 evidence: visible layout jumps that CLS misses

Check: `tests/e2e/visible-jump.spec.ts` (samples `getBoundingClientRect()` of `.site-header`,
`#hello-title` and `#hello [data-copy-body]` every animation frame for 3 s of a reload; fails if
any moves more than 8 px from its first frame after first paint).

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
