# Real-hardware verification kit (PF-08)

Some build-plan claims need a real GPU. The shared build box only has SwiftShader, so these get measured once on a reference laptop with the evidence saved. Until that run happens, each item is reported as **unverified on hardware**, never as passed.

| item             | AC                       | what is measured                                                                                                                                                                                                                                      | bar                                                                       |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `frames`         | M2-AC11                  | Frame-time distribution of a scripted 16 s, 0 → 100 % scroll at 1440×900 (rAF timestamps, plus a Chrome trace). Per-frame JS is the time of all rAF callbacks in a frame (`set(p)` + render submit).                                                  | p95 ≤ 16.7 ms · ≤ 2 % of frames > 33 ms · JS p95 ≤ 4 ms                   |
| `lighthouse`     | §3                       | Desktop Lighthouse 13.6 on the **full tier**, 3 runs, median. Each run must show the scene chunk in its network requests.                                                                                                                             | Perf ≥ 90 · A11y / BP / SEO ≥ 95                                          |
| `reduced-motion` | M3-AC2 (hardware branch) | `prefers-reduced-motion: reduce` on a GPU: scene and probe requests, and WebGL contexts created. Then on a live full tier, the OS preference flips to reduce mid-session.                                                                             | 0 / 0 / 0 · static within ≤ 1 frame · poster shown                        |
| `probe`          | M3-AC6 (hardware branch) | 10 fresh loads. Navigation → tier decision (scene chunk fetch start), probe start → decision, long tasks in the probe window, main-thread busy time from a trace of run 1, and probe worker bytes.                                                    | decision p95 ≤ 300 ms · no long task · main thread ≤ 5 ms · worker ≤ 1 KB |
| `contrast`       | M3-AC5 (full tier)       | PF-04's `tools/contrast/measure.ts --gpu` at D and D2 on the full tier (NOT RUN until PF-04 is merged).                                                                                                                                               | ≥ 4.5:1 < 24 px · ≥ 3:1 H1/H2                                             |
| `hidden`         | M2-AC10                  | A **real** hidden tab: another tab is brought to the front, so the browser itself reports `visibilityState = "hidden"`. This is not a synthetic event. Frames rendered while hidden are counted, then rendering is checked to resume after returning. | 0 frames hidden · > 0 after return                                        |

## Procedure

1. **Device.** Use the Owner's laptop, or whatever reference laptop the Owner names. The §3 target class is an integrated GPU (Intel Iris Xe or Apple M1), with the display at its native resolution. Plug in the power, close other apps, and turn off battery saver and Low Power Mode.
2. **Software.** Use Google Chrome stable, Bun 1.4 and Node ≥ 22. Check out the commit you want to verify (after PR #3 is merged), then run `bun install`.
3. **Run.** In a desktop session (the browser opens visibly, which is what puts WebGL on the real GPU):
   ```sh
   bun run hw:verify -- --device "MacBook Air M1 2020, 8-core GPU, 16 GB, macOS 15.4"
   ```
   - The script builds the site and serves it on `127.0.0.1:4540` (`--port` to change; `--url` to test an already running preview or a deployed URL).
   - Leave the machine alone while it runs: about 3 minutes, plus about 10 for the contrast run.
   - `--only frames,hidden` or `--skip contrast` pick items. `--lh-runs` and `--probe-runs` change the repeat counts.
   - `CHROME_PATH` points at a specific Chrome; otherwise Playwright's `chrome` channel is used.
4. **Check the header line.** The script prints the WebGL renderer. If it names SwiftShader, llvmpipe or "software", the run is **not hardware evidence**: every item reads `UNVERIFIED`. Fix the GPU setup (for example `chrome://gpu`, or turn hardware acceleration on in Chrome settings) and run again.
5. **Evidence.** Everything lands in `test-results/hw/<time>-<device>/`, which is gitignored:
   - `SUMMARY.md` and `summary.json`: one row per item with PASS / FAIL / UNVERIFIED / NOT RUN, its numbers and its evidence files;
   - `device.json`: device label, OS, CPU, RAM, Chrome, GPU renderer and vendor, DPR, screen, commit and URL;
   - `frames.json` + `frames-trace.json`, `lighthouse-desktop-r*.report.{json,html}` + `lighthouse.json`, `reduced-motion.json`, `probe.json` + `probe-trace.json`, `hidden-tab.json`, and `contrast/` (+ `contrast.log`).
6. **Report.** Attach the evidence folder (zip) to the PR, or upload it to the PR as a release asset. Paste `SUMMARY.md` into the PR, and record the reference device model in the PR as well. Exit code: 0 if every item passed on hardware, 1 if any failed, 2 if anything is unverified or not run.

## Smoke test (no evidence)

`bun run hw:verify -- --device "smoke" --headless --spoof-probe` checks that the scripts work on any machine, including the GPU-less box.

- `--spoof-probe` answers the probe "hardware GPU", so the full-tier paths run on SwiftShader.
- Every row is `UNVERIFIED` or `NOT RUN`, by design. `--spoof-probe` also forces `UNVERIFIED`, whatever the renderer says.
