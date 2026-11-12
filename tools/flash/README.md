# Flash (motion-safety) check: PF-14 / M3-AC10

Checks that no part of the page flashes more than 3 times per second (WCAG 2.2 general and red flash thresholds) during the scroll capture, and that the "lights on" ramp spans at least 4 % of scroll.

## Run it locally

```sh
CHROME_PATH=/usr/bin/google-chrome bun run flash:check                  # build, capture 384 frames, analyse
CHROME_PATH=/usr/bin/google-chrome bun run flash:check -- --no-build    # reuse the cached build
bun run flash:check -- --frames <dir>                                   # analyse an existing capture
# options: --out <dir> (default test-results/flash) · --seconds 16 · --grid 8x8 · --mode page|scene
```

- **No server or port.** The build is served to Chromium from disk.
- **Takes a few minutes.** On a shared box, run it under the heavy-run lock.
- **Exit code:** 0 on pass, 1 on fail.
- **Output** goes to `--out`:
  - `summary.md` / `summary.json`: the verdict, worst region per scenario, ramp span and the shortest safe scroll;
  - `regions.csv`: the worst flashes per second per region and scenario;
  - `luminance.csv`;
  - `heatmap.png`.

**When to run it:** before merging any change to the darkroom scene, its lights or materials, the scroll timeline, or the stage's catch-up timing.

## How it decides

The method is in the header of `check.ts`, and the model is in `lib.ts` (unit-tested in `tests/unit/flash.test.ts`):

- **Regions:** an 8×8 grid of regions per frame, each smaller than WCAG's flash area, so this is stricter.
- **Flashes:** opposing luminance transitions per region, with hysteresis.
- **Two timing scenarios:**
  - a 16 s constant scroll;
  - a top↔bottom jump replayed through the stage's catch-up curve.

## CI

The check is CI-ready but **not wired into CI**. The reviewer decided that PF-14 ships without a workflow job. Wiring it in belongs to #4's reopened scope or a follow-up card.
