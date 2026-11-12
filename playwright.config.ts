import { defineConfig, devices } from "@playwright/test";

import { crossBrowserGrepInvert, crossBrowserIgnore } from "./tests/e2e/projects.ts";

/**
 * Preview port for the e2e server. Its own port (default 4510, override with E2E_PORT) so it never
 * collides with another preview on the shared box (QA uses 4400); never reuse a server that is
 * already listening, so a run always tests its own fresh build.
 */
const PORT = Number(process.env.E2E_PORT ?? 4510);

const DESKTOP = { width: 1440, height: 900 };

/**
 * End-to-end tests against the production build (`astro build` + `astro preview`).
 *
 * Projects (pick one with `--project=chromium|firefox|webkit`; all three run by default):
 * - chromium: the whole suite. Uses the system Chrome when CHROME_PATH is set (the box has no
 *   Playwright Chromium download), otherwise Playwright's bundled Chromium. SwiftShader stands in
 *   for a GPU: the tests spoof the hardware-WebGL probe where they need the full tier.
 * - firefox, webkit: every spec too, minus explicit opt-outs (CHROMIUM_ONLY_SPECS, the
 *   `@chromium-only` tag, CHROMIUM_ONLY_TESTS) listed with reasons in tests/e2e/projects.ts. New
 *   specs are cross-browser by default; tests/unit/e2e-projects.test.ts guards it with `--list`.
 *   Needs `bunx playwright install firefox webkit` (plus `--with-deps` on a fresh Linux host).
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: DESKTOP,
        launchOptions: {
          ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
          args: [
            "--enable-unsafe-swiftshader",
            "--use-angle=swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
    {
      name: "firefox",
      testIgnore: crossBrowserIgnore,
      grepInvert: crossBrowserGrepInvert("firefox"),
      use: { ...devices["Desktop Firefox"], viewport: DESKTOP },
    },
    {
      name: "webkit",
      testIgnore: crossBrowserIgnore,
      grepInvert: crossBrowserGrepInvert("webkit"),
      use: { ...devices["Desktop Safari"], viewport: DESKTOP },
    },
  ],
  webServer: {
    command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
