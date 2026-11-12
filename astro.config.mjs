// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// Public origin used for canonical URLs, Open Graph and the sitemap.
// Override at build time with SITE_URL=https://your.domain npm run build
const site = process.env.SITE_URL ?? "https://phucle297.github.io";

export default defineConfig({
  site,
  output: "static",
  trailingSlash: "ignore",
  // The dev / PR-preview component page is never listed (PF-28); prod does not build it at all.
  integrations: [sitemap({ filter: (page) => !page.includes("/ui-preview/") })],
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
