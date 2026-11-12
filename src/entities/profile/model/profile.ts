import { PUBLIC_EMAIL } from "@shared/config";

/**
 * The portfolio owner. Facts come from the owner's CV (design.md copy deck, round 7).
 * `null` means "not supplied yet": the UI renders a visible `[Owner: …]` placeholder instead of
 * inventing a value.
 */
export interface SocialLink {
  label: string;
  /** Display text, e.g. `github.com/phucle297`. */
  handle: string;
  href: string;
}

export interface Profile {
  name: string;
  fullName: string;
  role: string;
  city: string;
  timezone: string;
  /** Public email, from the single switch `PUBLIC_EMAIL` in `@shared/config`. */
  email: string | null;
  /**
   * TODO(owner): public CV PDF URL. The private CV contains a phone number, so it is not shipped;
   * until then the CV button reads "CV on LinkedIn" (build plan Q9).
   */
  cvUrl: string | null;
  /** TODO(owner): 4:5 photo. No photo at launch (build plan Q1). */
  photo: string | null;
  socials: readonly SocialLink[];
}

export const profile: Profile = {
  name: "Phúc Lê",
  fullName: "Lê Đàm Duy Phúc",
  role: "Senior Frontend Developer",
  city: "Ho Chi Minh City",
  timezone: "Asia/Saigon (UTC+7)",
  email: PUBLIC_EMAIL,
  cvUrl: null,
  photo: null,
  socials: [
    {
      label: "LinkedIn",
      handle: "linkedin.com/in/dp2907",
      href: "https://www.linkedin.com/in/dp2907",
    },
    { label: "GitHub", handle: "github.com/phucle297", href: "https://github.com/phucle297" },
  ],
};

/** Visible placeholder text for owner-supplied values that are still missing. */
export const ownerPlaceholder = (what: string): string => `[Owner: ${what}]`;
