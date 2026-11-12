/// <reference types="vitest/config" />
import { getViteConfig } from "astro/config";

// Unit tests (Vitest) share Astro's Vite config, so the FSD path aliases resolve the same way.
export default getViteConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
