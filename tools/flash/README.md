# Flash (motion-safety) check: PF-14 / M3-AC10

Checks that no part of the page flashes more than 3 times per second (WCAG 2.2 general and red flash thresholds) during the scroll capture, and that the "lights on" ramp spans at least 4 % of scroll.

## Run it locally

```sh
CHROME_PATH=/usr/bin/google-chrome bun run flash:check                  # build, capture 384 frames, analyse
CHROME_PATH=/usr/bin/google-chrome bun run flash:check -- --no-build    # reuse the cached build
bun run flash:check -- --frames <dir>                                   # analyse an existing capture
bun run flash:check -- --series <out>/series.json                       # re-analyse a saved run, no capture
# options: --out <dir> (default test-results/flash) · --seconds 16 · --grid 8x8 · --mode page|scene
```

- **No server or port.** The build is served to Chromium from disk.
- **Takes a few minutes.** On a shared box, run it under the heavy-run lock.
- **Exit code:** 0 on pass, 1 on fail.
- **Output** goes to `--out`:
  - `summary.md` / `summary.json`: the verdict, worst region per scenario, ramp span and the shortest safe scroll;
  - `regions.csv`: the worst flashes per second per region and scenario;
  - `reversals.csv`: per reversal pattern, the worst flashes per second now and with the pre-fix catch-up;
  - `luminance.csv`;
  - `series.json`: per-region values per frame (input for `--series`);
  - `heatmap.png`.

**When to run it:** before merging any change to the darkroom scene, its lights or materials, the scroll timeline, or the stage's catch-up timing.

## How it decides

The method is in the header of `check.ts`, and the model is in `lib.ts` (unit-tested in `tests/unit/flash.test.ts`):

- **Regions:** an 8×8 grid of regions per frame, each smaller than WCAG's flash area, so this is stricter.
- **Flashes:** opposing luminance transitions per region, with hysteresis.
- **Timing scenarios:**
  - a 16 s constant scroll;
  - fast inputs replayed at 60 fps through the stage's own per-frame step (`stageStep` in `src/_pages/home/lib/catch-up.ts`, the whole transition the stage applies, nothing else): End, Home, every section link, scrollbar drags between any two section starts or the page end (0.25–12 s), and mixed input (End right after a scroll, End / Home pressed in turn).
- **Back-and-forth input (reversals):** outside the 3/s gate (PF-14 PM ruling), but gated against the pre-fix catch-up over QA's 2079-pattern reversal grid (`reversals.ts`: sine, triangle and square; centres 0.1–0.9; ±1–15 %; periods 0.15–3 s). Every pattern must stay ≤ the pre-fix rate + 0.5/s, and the grid's mean and worst case ≤ the pre-fix ones. Per-pattern numbers go to `reversals.csv`.
- **Big jumps are cut, not swept (PF-14):** a lead follows the scroll position with the pre-fix τ 0.15 s exponential, and the scene walks the lead's path, never faster than 1/8 of the page per second and never faster than the lead moved (so it shows the pre-fix path, only later). A gap over 10 % of the page is not swept: the scene holds, then crosses it with one cut once the lead is within 1 % of the scroll position, no sooner than 1 s after its last sweep and 0.5 s after its last cut. A sweep straight through the page used to strobe the red safelight at 7 flashes/s on End/Home.
- **The stage is guarded (PF-14, QA M1):** `stage.ts` applies `stageStep` as is. `tests/e2e/catch-up.spec.ts` presses End on the built page and asserts the hold and a single cut, and replays every recorded stage frame through `stageStep` bit for bit; a unit test checks statically that the stage has no easing of its own.

## CI

The check is CI-ready but **not wired into CI**. The reviewer decided that PF-14 ships without a workflow job. Wiring it in belongs to #4's reopened scope or a follow-up card.
