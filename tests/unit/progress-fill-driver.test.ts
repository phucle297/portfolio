/**
 * PF-27 QA L1 (attempt 3): accessing document.fonts.ready during HTML parse flushes
 * style/layout. The fill driver must still remasure on fonts.ready, but only after
 * registering that promise from a rAF or load handler, never in the parse-time IIFE.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/_pages/home/ui/HomePage.astro"), "utf8");

const inlineScripts = [...source.matchAll(/<script is:inline>([\s\S]*?)<\/script>/gu)].map(
  (match) => match[1] ?? "",
);

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");

/** Drop rAF and load callbacks that may legally touch document.fonts. */
const withoutDeferredCallbacks = (text: string): string =>
  text
    .replaceAll(
      /requestAnimationFrame\s*\(\s*function\s*\([^)]*\)\s*\{[\s\S]*?document\.fonts[\s\S]*?\}\s*\)\s*;/gu,
      "",
    )
    .replaceAll(
      /addEventListener\s*\(\s*(["'])load\1\s*,\s*function\s*\([^)]*\)\s*\{[\s\S]*?document\.fonts[\s\S]*?\}\s*(?:,\s*\{[^}]*\})?\s*\)\s*;/gu,
      "",
    );

describe("PF-27 fill-driver parse-time layout", () => {
  it("registers document.fonts.ready from a rAF or load, never during parse", () => {
    const driver = inlineScripts.find(
      (script) => script.includes("[data-progress]") && script.includes("remeasure"),
    );
    expect(driver, "fill-driver inline script is in HomePage.astro").toBeTruthy();
    const stripped = stripComments(driver ?? "");

    expect(stripped, "fonts.ready is still registered so a font swap remasures").toMatch(
      /document\.fonts\.ready/,
    );
    expect(
      stripped,
      "registration is deferred with requestAnimationFrame or the load handler",
    ).toMatch(
      /requestAnimationFrame\s*\(\s*function\s*\([^)]*\)\s*\{[^}]*document\.fonts|addEventListener\s*\(\s*(["'])load\1[\s\S]*document\.fonts/,
    );

    expect(
      withoutDeferredCallbacks(stripped),
      "the parse-time IIFE must not touch document.fonts (it flushes layout)",
    ).not.toMatch(/document\.fonts/);
  });
});
