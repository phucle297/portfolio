# CI browser cache (Firefox / WebKit)

Chromium e2e jobs use the runner image's `/usr/bin/google-chrome` and do not download a
Playwright browser. Firefox and WebKit jobs (`e2e-xb` shards and `e2e (webkit load-stability)`)
used to run `bunx playwright install --with-deps <browser>` on `ubuntu-24.04`. The apt
install of system libraries often took 17–20 minutes and cancelled the 20-minute job
before the tests started (CI-5; see `issues.md` in the factory ledger).

## What CI does now

- **System libraries:** those jobs run in the official image
  `mcr.microsoft.com/playwright:v1.65.0-noble` (Ubuntu 24.04), which already includes the
  Playwright OS dependencies. The tag's `v1.65.0` must match `PLAYWRIGHT_VERSION` in
  `.github/workflows/ci.yml` and the `@playwright/test` version in `bun.lock`. The install
  action fails the job if they drift. We do not build or publish our own image. The image does not ship `unzip`, which `setup-bun` needs; `.github/actions/setup` then installs Bun via npm instead of apt (host jobs still use `setup-bun`).
- **Browser binaries:** cached with `actions/cache` at `~/.cache/ms-playwright`.
  - Key: `<runner.os>-playwright-<exact @playwright/test version>-<browser>`
    (for example `Linux-playwright-1.65.0-webkit`).
  - Restore prefix: `<runner.os>-playwright-<version>-` (same Playwright version, any
    browser already in that cache).
  - Invalidation: bump `@playwright/test` in `bun.lock` and `PLAYWRIGHT_VERSION` / the
    container tag together. Changing only the browser name uses a different key.
    On a cache miss, the action copies that engine out of `/ms-playwright` in the image
    when the versions match, then runs `bunx playwright install <browser>` (no `--with-deps`)
    to confirm. The install step has a 5-minute timeout so it cannot consume the 20-minute
    job budget. Tests still reuse the workflow's `dist` artifact (`E2E_PREBUILT=1`).

Rollback: revert the PR that added the container, the cache action, and this file.

The Firefox/WebKit jobs set `HOME=/root` (Firefox will not launch when GHA's
`HOME=/github/home` is owned by a different user than the job) and `TMPDIR` to a
directory on the workspace volume (Astro's `rename` fails with `EXDEV` if the
preview build output is on `/tmp`).
