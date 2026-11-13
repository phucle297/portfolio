/**
 * PF-13 follow-up: a form action="mailto:…" on an HTTPS page makes Chrome log
 * MixedContentWarning, which fails Lighthouse is-on-https and inspector-issues (BP 0.77).
 * The Contact section source must not contain that attribute. A visible <a href="mailto:"> is fine.
 * The built homepage is checked after `astro build` by `bun tools/no-mailto-action.ts` (CI build job).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertContactFormContract,
  contactSectionPath,
  formMailtoActions,
  mailtoAction,
} from "../../tools/no-mailto-action";

describe("mailto form-action parser", () => {
  it("finds mailto actions in double, single, and unquoted form attributes", () => {
    expect(formMailtoActions('<form action="mailto:a@b.c">')).toEqual(["mailto:a@b.c"]);
    expect(formMailtoActions("<form action='mailto:a@b.c'>")).toEqual(["mailto:a@b.c"]);
    expect(formMailtoActions("<form action=mailto:a@b.c>")).toEqual(["mailto:a@b.c"]);
    expect(mailtoAction('<form action="MAILTO:A@B.C">')).toBe("MAILTO:A@B.C");
  });

  it("ignores mailto links and forms without a mailto action", () => {
    const html = `
      <a href="mailto:a@b.c">email</a>
      <form data-contact-form class="card">
      <form action="/submit">
    `;
    expect(formMailtoActions(html)).toEqual([]);
    expect(mailtoAction("<form data-contact-form>")).toBeNull();
  });
});

describe("Contact section source has no mailto form action", () => {
  it("keeps form[data-contact-form] and a mailto link, with no form mailto action", () => {
    const source = readFileSync(contactSectionPath(), "utf8");
    expect(formMailtoActions(source)).toEqual([]);
    expect(source).toMatch(/<form\b[^>]*\bdata-contact-form\b/u);
    expect(source).toMatch(/<a\b[^>]*mailto:/u);
    expect(() => {
      assertContactFormContract(source, "ContactSection.astro");
    }).not.toThrow();
  });
});
