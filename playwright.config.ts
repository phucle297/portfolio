import { defineConfig, devices } from "@playwright/test";

const PORT = 4322;

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
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
