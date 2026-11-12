/**
 * Site-wide metadata and navigation. Owner identity (name, role, contact) lives in
 * `@entities/profile`.
 */
export const siteConfig = {
  description:
    "Portfolio of Phuc Le, a software engineer building fast, accessible and delightful web experiences.",
  locale: "en",
  themeColor: "#0b0d12",
  ogImage: "/og.png",
  nav: [
    { label: "About", href: "#about" },
    { label: "Projects", href: "#projects" },
    { label: "Contact", href: "#contact" },
  ],
} as const;

export type SiteConfig = typeof siteConfig;
