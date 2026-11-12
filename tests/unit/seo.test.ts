/**
 * PF-17 (M4-AC4): title/description/canonical/OG source of truth, Person JSON-LD uses CV facts
 * only, and the 1200×630 share image is the cropped Hello key-state still.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { personJsonLd } from "../../src/entities/profile/model/jsonld";
import { profile } from "../../src/entities/profile/model/profile";
import { DEFAULT_SITE_URL, siteConfig } from "../../src/shared/config/site";

const ROOT = join(process.cwd());

/** PNG IHDR width and height (no image library). */
function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.subarray(0, 8).toString("binary") !== "\u0089PNG\r\n\u001a\n") {
    throw new Error("not a PNG");
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

describe("PF-17 site metadata", () => {
  it("the default site origin is the TASK-13 production URL, and the title facts match the CV", () => {
    expect(DEFAULT_SITE_URL).toBe("https://portfolio.dppermees.workers.dev");
    expect(new URL(DEFAULT_SITE_URL).protocol).toBe("https:");
    expect(`${profile.name} — ${profile.role}`).toBe("Phúc Lê — Senior Frontend Developer");
    expect(siteConfig.description).toContain(profile.name);
    expect(siteConfig.description).toContain(profile.role);
    expect(siteConfig.description).toContain(profile.city);
    expect(siteConfig.ogImage).toBe("/og.png");
    expect(siteConfig.ogImageWidth).toBe(1200);
    expect(siteConfig.ogImageHeight).toBe(630);
  });
});

describe("PF-17 Person JSON-LD", () => {
  const data = personJsonLd();

  it("describes a Person with only the listed CV facts", () => {
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@type"]).toBe("Person");
    expect(data.name).toBe("Phúc Lê");
    expect(data.name).toBe(profile.name);
    expect(data.jobTitle).toBe("Senior Frontend Developer");
    expect(data.jobTitle).toBe(profile.role);
    expect(data.address).toEqual({
      "@type": "PostalAddress",
      addressLocality: "Ho Chi Minh City",
    });
    expect(data.address.addressLocality).toBe(profile.city);
    expect(data.sameAs).toEqual([
      "https://www.linkedin.com/in/dp2907",
      "https://github.com/phucle297",
    ]);
    expect(data.email).toBe("mailto:phucle.2971.dd@gmail.com");
    expect(data.email).toBe(`mailto:${profile.email}`);

    // No invented facts: the object may only carry these keys (email is optional).
    expect(Object.keys(data).toSorted()).toEqual(
      ["@context", "@type", "address", "email", "jobTitle", "name", "sameAs"].toSorted(),
    );
    expect(Object.keys(data.address).toSorted()).toEqual(["@type", "addressLocality"].toSorted());
  });

  it("is valid JSON-LD and uses mailto: for the public email", () => {
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.email?.startsWith("mailto:")).toBe(true);
    expect(() => new URL(data.email ?? "")).not.toThrow();
    for (const href of data.sameAs) expect(() => new URL(href)).not.toThrow();
  });
});

describe("PF-17 OG image", () => {
  it("is a 1200×630 PNG cropped from the Hello key-state still (d-0.png)", () => {
    const og = readFileSync(join(ROOT, "public/og.png"));
    const still = readFileSync(join(ROOT, "src/_pages/home/ui/stills/d-0.png"));
    expect(pngSize(og)).toEqual({ width: 1200, height: 630 });
    expect(pngSize(still)).toEqual({ width: 1440, height: 900 });
    // Recipe lock: if the still is re-rendered, run `python3 tools/og-image.py` and update these.
    expect(sha256(still)).toBe("8c9b6dc8aa0846fee119a69d0f16eefde444287db4e5c02540477c2ea556dc08");
    expect(sha256(og)).toBe("249c5ae578620d8244c04a3ca5d63edc47b8ef00b4fd0a40532293da6fb49035");
  });
});
