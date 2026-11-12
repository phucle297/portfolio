/**
 * Fail if the built homepage HTML contains a form whose action starts with mailto:.
 * Chrome flags that as MixedContentWarning on HTTPS, which drops Lighthouse Best Practices
 * to 0.77 (is-on-https + inspector-issues). The visible <a href="mailto:"> is fine.
 *
 * Used by tests/unit/no-mailto-action.test.ts. Rebuilds dist/ with `astro build` when it is
 * missing or older than the contact section source. Call `astro build` directly so this
 * cannot recurse through `bun run build`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

export const ensureBuiltIndex = (root = process.cwd()): string => {
  const dist = builtIndexPath(root);
  const source = join(root, "src/_pages/home/ui/ContactSection.astro");
  const stale =
    !existsSync(dist) || (existsSync(source) && statSync(source).mtimeMs > statSync(dist).mtimeMs);
  if (stale) {
    const result = spawnSync("bun", ["x", "astro", "build"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
    });
    if (result.status !== 0) {
      throw new Error(`astro build failed with status ${result.status}`);
    }
  }
  return readFileSync(dist, "utf8");
};
