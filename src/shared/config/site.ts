/**
 * Site-wide metadata and navigation. Owner identity and page copy live in `@entities/profile`.
 */
export const siteConfig = {
  description:
    "Phúc Lê, Senior Frontend Developer in Ho Chi Minh City: React and TypeScript products, design systems and Feature-Sliced architecture. Freelance projects from $500 USD.",
  locale: "en",
  themeColor: "#0E0A08",
  ogImage: "/og.png",
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
