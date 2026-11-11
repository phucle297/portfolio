/**
 * Site-wide content and metadata. Edit this file to personalise the portfolio.
 * Values marked TODO are placeholders.
 */
export const site = {
  name: "Phuc Le",
  role: "Software Engineer",
  title: "Phuc Le — Software Engineer",
  description:
    "Portfolio of Phuc Le, a software engineer building fast, accessible and delightful web experiences.",
  locale: "en",
  /** TODO: replace with a real contact address. */
  email: "hello@example.com",
  socials: [
    { label: "GitHub", href: "https://github.com/phucle297" },
    // TODO: add LinkedIn, X, etc.
  ],
  nav: [
    { label: "About", href: "#about" },
    { label: "Projects", href: "#projects" },
    { label: "Contact", href: "#contact" },
  ],
} as const;

export type Site = typeof site;
