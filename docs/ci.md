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

## Flaky-test quarantine (PF-70)

Known-flaky checks are listed in `tools/ci/quarantine.json` (id, file, title, date, reason, follow-up card, known run). They still run on every PR, in jobs named `quarantine (e2e)`, `quarantine (webkit phone LCP)`, `quarantine (webkit loader)`, and `quarantine (lh mobile TBT)`. Those jobs show on the PR. They are **not** inputs to `ci-ok`, which is the blocking gate.

The blocking jobs exclude only the listed items (Playwright `--grep-invert` or, for Lighthouse mobile, moving `total-blocking-time` and `categories:performance` into `tools/ci/lighthouserc.mobile-tbt.json`). Thresholds and test assertions are unchanged. Other Lighthouse mobile budgets (LCP, CLS, a11y, best-practices, SEO, sizes) stay in the blocking `lighthouse (mobile)` job.

To take a test off the list: delete its entry from `tools/ci/quarantine.json`, remove the matching exclude from `.github/workflows/ci.yml` (and, for TBT, move the asserts back into `lighthouserc.mobile.json`), and drop the quarantine job step that ran it. It then returns to the blocking gate.

Do not skip, delete, or weaken a quarantined test. The unit test `tests/unit/quarantine.test.ts` checks that listed titles still exist and that `ci-ok` does not depend on the quarantine jobs.

Rollback: revert the PR that added the list and the quarantine jobs.

## e2e spec coverage (PF-73)

Every `tests/e2e/*.spec.ts` file must appear in some job in `.github/workflows/ci.yml`
(a blocking e2e / e2e-xb / load-stability job, or a PF-70 quarantine job). The unit
test `tests/unit/e2e-ci-coverage.test.ts` fails and names any spec that is missing
(or that is only mentioned in a comment). A green CI therefore means every e2e spec
was included in a job; it does not, by itself, mean every test _title_ in that file
ran on every engine.

A spec may be omitted from every CI job only via an explicit entry in
`EXCLUDED_FROM_CI` in `tests/unit/e2e-ci-coverage.test.ts`, with a reason.
`tests/e2e/reduced-motion-live.spec.ts` is excluded (Owner decision 2026-11-18:
reduced motion not needed). The file is not deleted.

Rollback: revert the PR that added the guard and the exclusion list.
