/**
 * Public contact email: the ONE switch for showing an address on the site.
 *
 * `null` (the default) keeps the visible `[Owner: email]` placeholder everywhere (contact links,
 * form note) and the contact form cannot open a `mailto:`. Phúc has not yet confirmed which
 * address may be public; the build plan's proposed default is the CV address. To publish an
 * address, set it here, e.g. `export const PUBLIC_EMAIL: string | null = "name@example.com";`.
 * Nothing else needs to change.
 */
export const PUBLIC_EMAIL: string | null = null;
