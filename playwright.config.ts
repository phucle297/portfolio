import { defineConfig, devices } from "@playwright/test";

/**
 * Preview port for the e2e server. Its own port (default 4510, override with E2E_PORT) so it never
 * collides with another preview on the shared box (QA uses 4400); never reuse a server that is
 * already listening, so a run always tests its own fresh build.
 */
const PORT = Number(process.env.E2E_PORT ?? 4510);

/**
 * End-to-end tests against the production build (`astro build` + `astro preview`).
 * Uses the system Chrome when CHROME_PATH is set (the box has no Playwright browser download);
 * otherwise Playwright's bundled Chromium. SwiftShader stands in for a GPU: the tests spoof the
 * hardware-WebGL probe where they need the full tier.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `bun run build && bun run preview -- --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
