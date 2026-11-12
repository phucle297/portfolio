/**
 * Public contact email: the ONE switch for showing an address on the site.
 *
 * Set by the Owner's decision (2026-11-12): the address below is shown publicly, with a working
 * `mailto:` link in the Contact section. The form itself has no `action` (a `mailto:` form action
 * fails Lighthouse Best Practices over HTTPS). Without JS the form is hidden and the link is the
 * path; with JS, `buildMailto()` opens a prefilled mailto on submit. Set the address to `null` to
 * hide it again: every place then shows the visible `[Owner: email]` placeholder and the form
 * explains that email sending is not switched on. Nothing else needs to change.
 */
export const PUBLIC_EMAIL: string | null = "phucle.2971.dd@gmail.com";
