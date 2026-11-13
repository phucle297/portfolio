/**
 * PF-13 (M3-AC8, Q8): pure contact-form helpers — field checks and the prefilled mailto.
 */
import { describe, expect, it } from "vitest";
import {
  buildMailtoHref,
  fieldValid,
  type ContactValues,
} from "../../src/_pages/home/lib/contact-form";

const freelance: ContactValues = {
  mode: "Freelance project",
  name: "Ada Lovelace",
  email: "ada@example.com",
  projectType: "Web app build",
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
  it("uses Q8's subject '{mode}: {name}' and includes the fields in the body", () => {
    const href = buildMailtoHref("phucle.2971.dd@gmail.com", freelance);
    expect(href.startsWith("mailto:phucle.2971.dd@gmail.com?")).toBe(true);
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain("subject=Freelance project: Ada Lovelace");
    expect(decoded).toContain("Name: Ada Lovelace");
    expect(decoded).toContain("Email: ada@example.com");
    expect(decoded).toContain("Project type: Web app build");
    expect(decoded).toContain("A small marketing site by next month.");
  });

  it("omits Project type when the mode is Full-time role", () => {
    const href = buildMailtoHref("phucle.2971.dd@gmail.com", {
      ...freelance,
      mode: "Full-time role",
    });
    const decoded = decodeURIComponent(href);
    expect(decoded).toContain("subject=Full-time role: Ada Lovelace");
    expect(decoded).not.toContain("Project type:");
  });
});
