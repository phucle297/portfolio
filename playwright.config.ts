import { defineConfig, devices } from "@playwright/test";

/**
 * Preview port for the e2e server. Its own port (default 4510, override with E2E_PORT) so it never
 * collides with another preview on the shared box (QA uses 4400); never reuse a server that is
 * already listening, so a run always tests its own fresh build.
 */
const PORT = Number(process.env.E2E_PORT ?? 4510);

const DESKTOP = { width: 1440, height: 900 };

/**
 * The static-tier suite (M3-AC11, PF-05): what every engine must pass. Full-tier tests need a
 * WebGL scene and stay on Chromium (SwiftShader stands in for a GPU there); full tier on real
 * Firefox and Safari is the manual matrix.
 */
const STATIC_TIER_SPECS = [
  "static.spec.ts",
  "structure.spec.ts",
  "tiers.spec.ts",
  "cross-browser.spec.ts",
];
/**
 * Tests that stay Chromium-only, each with an engine-neutral stand-in in cross-browser.spec.ts:
 * - full-tier behaviour (scene, render loop, canvas placement): needs the SwiftShader stand-in;
 *   cross-browser.spec.ts checks that Firefox/WebKit choose and mount the full tier;
 * - "QA-5: copy-email button copies…": grants clipboard permissions, which only Chromium supports;
 * - "M1-AC13 fonts…": relies on Chromium answering `document.fonts.check()` for unloaded faces;
 * - "QA-7…" (main's version): reads the header colour mid-transition; PR #3 replaces it with a
 *   poll. Drop this entry once PR #3 is merged.
 */
const CHROMIUM_ONLY = [
  /tiers\.spec\.ts full tier /,
  /hardware GPU, motion allowed: the scene chunk loads/,
  /QA-5: copy-email button copies the address and announces it$/,
  /M1-AC13 fonts: design faces, no fallback in the names/,
  /QA-7: the header is opaque once scrolled, so copy never shows through it/,
];
/** Playwright's Firefox does not report a `mailto:` navigation; the success status is checked instead. */
const FIREFOX_NO_MAILTO = /email switch: PUBLIC_EMAIL drives the contact link/;

/**
 * End-to-end tests against the production build (`astro build` + `astro preview`).
 *
 * Projects (pick one with `--project=chromium|firefox|webkit`; all three run by default):
 * - chromium: the whole suite. Uses the system Chrome when CHROME_PATH is set (the box has no
 *   Playwright Chromium download), otherwise Playwright's bundled Chromium. SwiftShader stands in
 *   for a GPU: the tests spoof the hardware-WebGL probe where they need the full tier.
 * - firefox, webkit: the static-tier suite on Playwright's Firefox and WebKit
 *   (`bunx playwright install firefox webkit`, plus `--with-deps` on a fresh Linux host).
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
      testMatch: STATIC_TIER_SPECS,
      grepInvert: [...CHROMIUM_ONLY, FIREFOX_NO_MAILTO],
      use: { ...devices["Desktop Firefox"], viewport: DESKTOP },
    },
    {
      name: "webkit",
      testMatch: STATIC_TIER_SPECS,
      grepInvert: CHROMIUM_ONLY,
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
