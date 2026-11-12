/**
 * PF-24 (M1-AC13): source-level guards that Instrument Serif is one file per style, declared
 * with font-display: swap and no unicode-range, and not preloaded (a preload plus the
 * stylesheet made WebKit download each file twice).
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

describe("PF-24 Instrument Serif source", () => {
  it("ships two merged woff2 files and no longer imports the fontsource faces", () => {
    const normal = statSync(join(ROOT, "src/app/fonts/instrument-serif-400.woff2"));
    const italic = statSync(join(ROOT, "src/app/fonts/instrument-serif-400-italic.woff2"));
    // latin + latin-ext merged is ~25 KB each; fail if a file is missing or looks like a stub.
    expect(normal.size).toBeGreaterThan(20_000);
    expect(italic.size).toBeGreaterThan(20_000);
    // Combined still well under the 150 KB page-font budget on its own.
    expect(normal.size + italic.size).toBeLessThan(80_000);

    const global = read("src/app/styles/global.css");
    expect(global).toContain("./fonts-instrument-serif.css");
    expect(global).not.toContain("@fontsource/instrument-serif");

    const css = read("src/app/styles/fonts-instrument-serif.css");
    const faces = css.match(/@font-face\s*\{[^}]+\}/g) ?? [];
    expect(faces).toHaveLength(2);
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
      expect(face).not.toMatch(/unicode-range/);
      expect(face).not.toMatch(/format\("woff"\)/);
    }
    expect(css).toContain("instrument-serif-400.woff2");
    expect(css).toContain("instrument-serif-400-italic.woff2");

    const layout = read("src/app/layouts/BaseLayout.astro");
    expect(layout).not.toContain("@fontsource/instrument-serif");
    expect(layout).not.toMatch(
      /rel=["']preload["'][\s\S]*instrument-serif|instrument-serif[\s\S]*rel=["']preload["']/,
    );
    expect(layout).not.toContain("serifWoff2");
    expect(layout).not.toContain("serifItalicWoff2");
  });
});
