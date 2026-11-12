/**
 * PF-07 (M4-AC1, build plan §4): every Owner decision is applied in the content module, and no
 * `[Owner: …]` placeholder or invented value is left in any copy that ships.
 */
import { describe, expect, it } from "vitest";
import * as content from "../../src/entities/profile/model/content";
import { profile } from "../../src/entities/profile/model/profile";
import { PUBLIC_EMAIL } from "../../src/shared/config/contact";

/** Every string reachable from a value (objects, arrays, nested), with its path. */
function strings(value: unknown, path: string): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

const all = [...strings(content, "content"), ...strings(profile, "profile")];

describe("PF-07 owner content", () => {
  it("no copy string carries an [Owner: …] placeholder or a TODO", () => {
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter(([, s]) => /\[owner:|todo/iu.test(s))).toEqual([]);
  });

  it("Q2: the public email is the Owner-confirmed address; no phone number is published", () => {
    expect(PUBLIC_EMAIL).toBe("phucle.2971.dd@gmail.com");
    expect(profile.email).toBe(PUBLIC_EMAIL);
    // Vietnamese mobile numbers (+84 / 0 followed by 9 digits, any separators).
    expect(all.filter(([, s]) => /(?:\+84|\b0)[\s.-]?\d(?:[\s.-]?\d){8}\b/u.test(s))).toEqual([]);
  });

  it("Q3: the reply promise is worded the same in Process step 1, the form note and the success text", () => {
    expect(content.REPLY_PROMISE).toBe("I reply within 4 hours, Asia/Saigon (UTC+7)");
    const places = [
      content.process.steps[0]?.copy ?? "",
      content.contact.form.note,
      content.contact.form.success,
    ];
    for (const text of places) expect(text).toContain(`${content.REPLY_PROMISE}.`);
    // Nowhere else promises a different window.
    const promises = all.filter(([, s]) => /\breply\b/iu.test(s));
    for (const [path, text] of promises)
      expect(text, path).toMatch(
        /I reply within 4 hours, Asia\/Saigon \(UTC\+7\)|^I reply within 4 hours$/u,
      );
  });

  it("Q1 no photo, Q4 no case links or screenshots, Q9 CV on LinkedIn", () => {
    expect(profile.photo).toBeNull();
    expect(content.work.cases.map((c) => c.href)).toEqual([null, null, null, null]);
    expect(profile.cvUrl).toBeNull();
    expect(content.hello.secondaryCtaFallback).toBe("CV on LinkedIn");
    expect(profile.socials.find((s) => s.label === "LinkedIn")?.href).toBe(
      "https://www.linkedin.com/in/dp2907",
    );
  });
});
