# PF-62: run the visible-jump check on a hardware GPU

This is the one-command path from [docs/pf-53/README.md](../pf-53/README.md), written as a
copy-paste guide for the Owner's own machine. The factory box and standard GitHub runners have
no hardware GPU, so this run has to happen on a computer you already have. It does not start a
paid runner.

The script is headed Chromium (a real window), so you need a desktop session. Running it over SSH
on a headless box usually will not work unless that box already has a display / GPU desktop.

## Prerequisites

- **OS:** Linux, macOS, or Windows, with a logged-in desktop (not a headless SSH session).
- **Hardware GPU:** a discrete or integrated GPU. SwiftShader, llvmpipe, or any "Software Adapter"
  does not count. Quick check: open `chrome://gpu` in Chrome and confirm **GL_RENDERER** (or
  "Graphics Feature Status") names your GPU, not SwiftShader / llvmpipe / Software.
- **Bun** 1.3 or newer (the repo pins `bun@1.4.4`). Install from https://bun.sh if needed:
  `bun --version`
- **Git** and either Playwright's Chromium (installed below) or an installed Chrome
  (`CHROME_PATH` pointing at it).

## Clone, install, run

Use this PR branch so the PF-62 guards are included (`factory/PF-62-gpu-run`). After it merges,
`main` is fine.

```sh
git clone https://github.com/phucle297/portfolio
cd portfolio
git checkout factory/PF-62-gpu-run   # or main, once PF-62 is merged

bun install
bunx playwright install chromium

bun run e2e:visible-jump:gpu
```

If you already have Chrome and prefer that binary:

```sh
# Linux example; on macOS this is usually
# "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CHROME_PATH=/usr/bin/google-chrome bun run e2e:visible-jump:gpu
```

`e2e:visible-jump:gpu` builds the site, then runs `tests/e2e/visible-jump.spec.ts` in **headed**
Chromium with the normal GPU path (`playwright.gpu.config.ts`: no SwiftShader flags) and without
the WebGL-probe spoof (`PF53_REAL_GPU=1`). The full tier has to come from the real probe.

## What "pass" and "fail" look like

- **Pass:** all three viewports (1440×900, 1024×768, 390×844) stay within 8 px, report a hardware
  `renderer`, and meet the frame budget (at least 30 frames after first paint in 3 s, and no
  single stall longer than **1000 ms**).
- **No hardware GPU:** the run must fail first with `no hardware GPU: WebGL renderer is …`
  (llvmpipe / SwiftShader / software), before any `data-tier` mismatch. If you see that, the
  browser is not using your GPU — check `chrome://gpu` and drivers, then rerun.
- **A long stall:** a single gap over 1000 ms fails as `not enough frames: … longest gap N ms, cap 1000 ms`
  even if the total frame count is still above 30.

## Where the files land

Output is git-ignored, under `pf-53-gpu/` in the repo root (same path the PF-53 script already
used):

| File                                    | What it is                                     |
| --------------------------------------- | ---------------------------------------------- |
| `pf-53-gpu/visible-boxes-1440x900.json` | frames, `renderer`, movements, `maxFrameGapMs` |
| `pf-53-gpu/visible-boxes-1024x768.json` | same, unpinned full tier                       |
| `pf-53-gpu/visible-boxes-390x844.json`  | same, static / phone                           |
| `pf-53-gpu/trace-1440x900.zip`          | Playwright trace (screenshots)                 |
| `pf-53-gpu/trace-1024x768.zip`          |                                                |
| `pf-53-gpu/trace-390x844.zip`           |                                                |

Preview a trace with:

```sh
bunx playwright show-trace pf-53-gpu/trace-1440x900.zip
```

## What to send back

Please send all six files above (the three JSON reports and the three traces), plus:

1. Your **OS** and **GPU** (for example "macOS 15, M3 Pro" or "Windows 11, RTX 4070"). A
   `chrome://gpu` screenshot or the `renderer` string from any of the JSON files is enough if the
   model name is unclear.
2. The **command exit status** (pass / fail) and, on a fail, the first error line.

You can zip the folder and attach it to the PF-62 card, or drop the files in the chat:

```sh
zip -r pf-53-gpu-results.zip pf-53-gpu
```
