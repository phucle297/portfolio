/**
 * PF-13 (M3-AC8) as amended by PF-58: pure contact-form helpers — field checks and the prefilled mailto.
 */
import { describe, expect, it } from "vitest";
import {
  buildMailtoHref,
  fieldValid,
  type ContactValues,
} from "../../src/_pages/home/lib/contact-form";

const values: ContactValues = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  brief: "A small marketing site by next month.",
};

describe("fieldValid", () => {
  it("accepts a non-empty name and brief, and a simple email", () => {
    expect(fieldValid.name("Ada")).toBe(true);
    expect(fieldValid.name("  ")).toBe(false);
    expect(fieldValid.brief("A sentence.")).toBe(true);
    expect(fieldValid.brief("")).toBe(false);
    expect(fieldValid.email("ada@example.com")).toBe(true);
    expect(fieldValid.email("not-an-email")).toBe(false);
    expect(fieldValid.email("ada@company")).toBe(false);
  });
});

describe("buildMailtoHref", () => {
  it("uses PF-58's subject 'Project: {name}' and a Name/Email/brief body", () => {
    const href = buildMailtoHref("phucle.2971.dd@gmail.com", values);
    expect(href.startsWith("mailto:phucle.2971.dd@gmail.com?")).toBe(true);
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain("subject=Project: Ada Lovelace");
    expect(decoded).toContain(
      "body=Name: Ada Lovelace\nEmail: ada@example.com\n\nA small marketing site by next month.",
    );
    expect(decoded).not.toContain("Project type:");
  });
});
