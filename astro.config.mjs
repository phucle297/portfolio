// @ts-check
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import { DEFAULT_SITE_URL } from "./src/shared/config/site.ts";

// Public origin used for canonical URLs, Open Graph and the sitemap.
// Override at build time with SITE_URL=https://your.domain bun run build
const site = process.env.SITE_URL ?? DEFAULT_SITE_URL;

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  integrations: [sitemap()],
  build: {
    // Inline all CSS (it is small) so there are no render-blocking stylesheet requests.
    inlineStylesheets: "always",
  },
  prefetch: false,
  vite: {
    build: {
      // Keep three.js out of the main entry; it is only reached via dynamic import().
      chunkSizeWarningLimit: 700,
    },
  },
});
