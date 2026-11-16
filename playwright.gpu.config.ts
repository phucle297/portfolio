import { defineConfig } from "@playwright/test";

import base from "./playwright.config.ts";

/**
 * PF-53: run the visible-jump check on a machine with a real GPU (`bun run e2e:visible-jump:gpu`,
 * see docs/pf-53/README.md). Same as playwright.config.ts, but Chromium runs headed with its normal
 * GPU path instead of SwiftShader, so the full tier comes from the real WebGL probe (the spec skips
 * its spoof when PF53_REAL_GPU=1).
 */
const chromium = base.projects?.find((project) => project.name === "chromium");

export default defineConfig({
  ...base,
  projects: [
    {
      ...chromium,
      name: "chromium",
      use: {
        ...chromium?.use,
        headless: false,
        launchOptions: {
          ...chromium?.use?.launchOptions,
          args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
        },
      },
    },
  ],
});
