/**
 * PF-13 follow-up: a form action="mailto:…" on an HTTPS page makes Chrome log
 * MixedContentWarning, which fails Lighthouse is-on-https and inspector-issues (BP 0.77).
 * The built homepage must not contain that attribute. A visible <a href="mailto:"> is fine.
 */
import { describe, expect, it } from "vitest";
import { ensureBuiltIndex, formMailtoActions } from "../../tools/no-mailto-action";

describe("built HTML has no mailto form action", () => {
  // Cold-tree `astro build` takes ~6–7 s, past Vitest's 5 s default (QA Low on #22).
  it("does not render form[action^=mailto] in dist/index.html", { timeout: 60_000 }, () => {
    const html = ensureBuiltIndex();
    expect(formMailtoActions(html)).toEqual([]);
    expect(html).toMatch(/<form\b[^>]*\bdata-contact-form\b/u);
    expect(html).toMatch(/<a\b[^>]*\bhref="mailto:/u);
  });
});
