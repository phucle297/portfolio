/** The portfolio owner. Values marked TODO are placeholders. */
export interface Profile {
  name: string;
  role: string;
  /** TODO: replace with a real contact address. */
  email: string;
  socials: readonly { label: string; href: string }[];
}

export const profile: Profile = {
  name: "Phuc Le",
  role: "Software Engineer",
  email: "hello@example.com",
  socials: [
    { label: "GitHub", href: "https://github.com/phucle297" },
    // TODO: add LinkedIn, X, etc.
  ],
};
