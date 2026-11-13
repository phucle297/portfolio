/**
 * Fail if the built homepage HTML contains a form whose action starts with mailto:.
 * Chrome flags that as MixedContentWarning on HTTPS, which drops Lighthouse Best Practices
 * to 0.77 (is-on-https + inspector-issues). The visible <a href="mailto:"> is fine.
 *
 * Unit tests cover the parser and the Contact section source (no production build). After
 * `astro build`, run this file as a CLI (`bun tools/no-mailto-action.ts`) to check dist/index.html.
 * It does not invoke a build, so Vitest's default 5 s cap cannot be blown on a clean tree.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const mailtoAction = (tag: string): string | null => {
  const match = /\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return value.toLowerCase().startsWith("mailto:") ? value : null;
};

export const formMailtoActions = (html: string): string[] => {
  const found: string[] = [];
  const formTag = /<form\b[^>]*>/giu;
  for (const match of html.matchAll(formTag)) {
    const action = mailtoAction(match[0]);
    if (action) found.push(action);
  }
  return found;
};

export const builtIndexPath = (root = process.cwd()): string => join(root, "dist/index.html");

export const contactSectionPath = (root = process.cwd()): string =>
  join(root, "src/_pages/home/ui/ContactSection.astro");

/** Built-page contract: no form mailto action, contact form present, mailto link present. */
export const assertContactFormContract = (html: string, label: string): void => {
  const found = formMailtoActions(html);
  if (found.length > 0) {
    throw new Error(`${label} contains form mailto action(s): ${found.join(", ")}`);
  }
  if (!/<form\b[^>]*\bdata-contact-form\b/u.test(html)) {
    throw new Error(`${label} is missing form[data-contact-form]`);
  }
  if (!/<a\b[^>]*\bhref="mailto:/u.test(html) && !/<a\b[^>]*mailto:/u.test(html)) {
    throw new Error(`${label} is missing a mailto: link`);
  }
};

/** Read dist/index.html. Does not build — call this only after `astro build`. */
export const readBuiltIndex = (root = process.cwd()): string => {
  const dist = builtIndexPath(root);
  if (!existsSync(dist)) {
    throw new Error(`missing ${dist}; run astro build first`);
  }
  return readFileSync(dist, "utf8");
};

const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  assertContactFormContract(readBuiltIndex(), "dist/index.html");
  process.stdout.write("no-mailto-action: dist/index.html ok\n");
}
