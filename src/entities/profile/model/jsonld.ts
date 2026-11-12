import { profile } from "./profile";

/**
 * JSON-LD `Person` for the document head. Only CV facts listed by PF-17 / M4-AC4: name, role,
 * city, LinkedIn, GitHub, and the public email when it is switched on. Nothing else is invented.
 */
export interface PersonJsonLd {
  readonly "@context": "https://schema.org";
  readonly "@type": "Person";
  readonly name: string;
  readonly jobTitle: string;
  readonly address: {
    readonly "@type": "PostalAddress";
    readonly addressLocality: string;
  };
  readonly sameAs: readonly string[];
  readonly email?: string;
}

export const personJsonLd = (): PersonJsonLd => {
  const sameAs = profile.socials
    .filter((social) => social.label === "LinkedIn" || social.label === "GitHub")
    .map((social) => social.href);

  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.name,
    jobTitle: profile.role,
    address: {
      "@type": "PostalAddress",
      addressLocality: profile.city,
    },
    sameAs,
    ...(profile.email ? { email: `mailto:${profile.email}` } : {}),
  };
};
