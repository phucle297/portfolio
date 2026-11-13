/**
 * Site-wide metadata and navigation. Owner identity and page copy live in `@entities/profile`.
 */

/**
 * Production origin used for canonical URLs, Open Graph and the sitemap when `SITE_URL` is not
 * set at build time. This is the origin the TASK-13 deploy workflow publishes
 * (https://portfolio.dppermees.workers.dev). No custom domain has been supplied by the Owner yet;
 * override with `SITE_URL=https://your.domain bun run build` when one is.
 */
export const DEFAULT_SITE_URL = "https://portfolio.dppermees.workers.dev";

export const siteConfig = {
  description:
    "Phúc Lê, Senior Frontend Developer in Ho Chi Minh City: React and TypeScript products, design systems and Feature-Sliced architecture. Freelance projects from $500 USD.",
  locale: "en",
  themeColor: "#0E0A08",
  ogImage: "/og.png",
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: "A darkroom print of Phúc Lê, Senior Frontend Developer, Ho Chi Minh City.",
  /** Section anchors, in page order (ids match `SECTION_IDS` in `@shared/lib/timeline`). */
  nav: [
    { id: "hello", number: "01", label: "Hello" },
    { id: "journey", number: "02", label: "Journey" },
    { id: "work", number: "03", label: "Work" },
    { id: "services", number: "04", label: "Services" },
    { id: "process", number: "05", label: "Process" },
    { id: "contact", number: "06", label: "Contact" },
  ],
} as const;

export type SiteConfig = typeof siteConfig;
