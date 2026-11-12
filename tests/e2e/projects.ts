/**
 * Which e2e specs and tests run on which engine (PF-05, M3-AC11). Shared by
 * `playwright.config.ts` and the guard in `tests/unit/e2e-projects.test.ts`.
 *
 * Convention: every `tests/e2e/**\/*.spec.ts` runs on chromium, firefox and webkit by default. A
 * new spec is cross-browser without touching the config. Opting out is explicit and needs a reason:
 * - a whole spec that needs the WebGL scene (or Chromium-only APIs): add it to CHROMIUM_ONLY_SPECS;
 * - a single test: tag it `@chromium-only` (`test("…", { tag: "@chromium-only" }, …)`) and say
 *   why in a comment next to it;
 * - tests in files this card may not edit (PR #3's list): a title pattern in CHROMIUM_ONLY_TESTS.
 * Chromium stays the full suite. SwiftShader stands in for a GPU there; full tier on real Firefox
 * and Safari is the manual matrix.
 */
export interface OptOut {
  /** Matched against the absolute spec path (specs) or the full test title (tests). */
  readonly pattern: RegExp;
  readonly reason: string;
  /** The spec or test is not on `main` yet: the PR that brings it. An opt-out without it must match. */
  readonly pending?: string;
}

/** Tag for single tests that stay on Chromium. */
export const CHROMIUM_ONLY_TAG = "@chromium-only";

export const CHROMIUM_ONLY_SPECS: readonly OptOut[] = [
  {
    pattern: /[\\/]m2(-[\w-]+)?\.spec\.ts$/,
    reason:
      "M2 pinned copy, scrub and render loop on the full tier: needs the SwiftShader-backed scene",
    pending: "PR #3 (factory/TASK-20261112-08-m2)",
  },
  {
    pattern: /[\\/]probe-cost(-[\w-]+)?\.spec\.ts$/,
    reason:
      "probe cost per branch measured with Chromium flags (--disable-webgl) and a spoofed worker on SwiftShader",
  },
];

export const CHROMIUM_ONLY_TESTS: readonly OptOut[] = [
  {
    pattern: /tiers\.spec\.ts full tier /,
    reason:
      "full-tier scene, render loop and canvas placement need the SwiftShader stand-in; cross-browser.spec.ts checks Firefox/WebKit choose and mount the full tier",
  },
  {
    pattern: /hardware GPU, motion allowed: the scene chunk loads/,
    reason: "full-tier scene chunk; covered on Firefox/WebKit by cross-browser.spec.ts",
  },
  {
    pattern: /QA-5: copy-email button copies the address and announces it$/,
    reason:
      "grants clipboard permissions, which only Chromium supports; cross-browser.spec.ts stubs the clipboard",
  },
  {
    pattern: /M1-AC13 fonts: design faces, no fallback in the names/,
    reason:
      "relies on Chromium answering document.fonts.check() for unloaded faces; cross-browser.spec.ts loads then checks",
  },
  {
    pattern: /QA-7: the header is opaque once scrolled, so copy never shows through it/,
    reason:
      "main's version reads the header colour mid-transition; PR #3 replaces it with a poll (drop this entry then)",
  },
];

/** Playwright's Firefox does not report a `mailto:` navigation; the success status is checked instead. */
export const FIREFOX_ONLY_SKIP: readonly OptOut[] = [
  {
    pattern: /email switch: PUBLIC_EMAIL drives the contact link/,
    reason: "Playwright's Firefox does not report a mailto: navigation",
  },
];

const tagPattern = new RegExp(CHROMIUM_ONLY_TAG);
/** testIgnore for the Firefox and WebKit projects. */
export const crossBrowserIgnore: RegExp[] = CHROMIUM_ONLY_SPECS.map((o) => o.pattern);
/** grepInvert per cross-browser project. */
export const crossBrowserGrepInvert = (engine: "firefox" | "webkit"): RegExp[] => [
  tagPattern,
  ...CHROMIUM_ONLY_TESTS.map((o) => o.pattern),
  ...(engine === "firefox" ? FIREFOX_ONLY_SKIP.map((o) => o.pattern) : []),
];
