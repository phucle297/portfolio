/**
 * Which e2e specs and tests run on which engine (PF-05, M3-AC11). Shared by
 * `playwright.config.ts` and the guard in `tests/unit/e2e-projects.test.ts`.
 *
 * Convention: every `tests/e2e/**\/*.spec.ts` runs on chromium, firefox and webkit by default. A
 * new spec is cross-browser without touching the config. Opting out is explicit and needs a reason:
 * - a whole spec that needs the WebGL scene (or Chromium-only APIs): add it to CHROMIUM_ONLY_SPECS;
 * - a single test: tag it `@chromium-only` (`test("…", { tag: "@chromium-only" }, …)`) and say
 *   why in a comment next to it;
 * - a title pattern in CHROMIUM_ONLY_TESTS (all non-Chromium engines) or FIREFOX_ONLY_SKIP /
 *   WEBKIT_ONLY_SKIP (one engine). Prefer a title pattern over a whole-file opt-out.
 * Chromium stays the full suite. SwiftShader stands in for a GPU there; full tier on real Firefox
 * and Safari is the manual matrix.
 *
 * The unit guard derives the spec inventory from git (main baseline, HEAD, index) and pins the
 * exact patterns and engines below. Widening or adding a pattern, or deleting a spec, must fail
 * that test.
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

/** Whole-file opt-outs on Firefox and WebKit. Empty: remaining skips are title- or engine-specific. */
export const CHROMIUM_ONLY_SPECS: readonly OptOut[] = [];

export const CHROMIUM_ONLY_TESTS: readonly OptOut[] = [
  {
    // Exact title: the sibling "when the clipboard write fails…" case runs on every engine.
    pattern: /QA-5: copy-email button copies the address and announces it$/,
    reason:
      "grants clipboard permissions, which only Chromium supports; cross-browser.spec.ts stubs the clipboard",
  },
  {
    pattern: /M1-AC13 fonts: design faces, no fallback in the names/,
    reason:
      "relies on Chromium answering document.fonts.check() for unloaded faces; cross-browser.spec.ts loads then checks",
  },
];

/** Playwright's Firefox does not report a `mailto:` navigation; the success status is checked instead. */
export const FIREFOX_ONLY_SKIP: readonly OptOut[] = [
  {
    // Exact title after PF-13 (#22): the form no longer uses a mailto action.
    pattern: /email switch: PUBLIC_EMAIL drives the contact link and the JS mailto submit$/,
    reason: "Playwright's Firefox does not report a mailto: navigation",
  },
];

/**
 * Playwright's WebKit restores the scroll position of a reload only once the page has loaded, so a
 * test that holds the module scripts never sees the restored scroll it sets up. Real Safari is
 * part of the manual matrix (AC2). m2-keys and the WebGL-disabled probe need Chromium launch
 * flags that Playwright WebKit cannot apply; Firefox ran both.
 */
export const WEBKIT_ONLY_SKIP: readonly OptOut[] = [
  {
    pattern: /B-8: a reload while scrolled keeps the header opaque before its script runs/,
    reason:
      "Playwright WebKit restores the scroll of a reload only after load; with the scripts held, scrollY stays 0 (deterministic, 3/3 runs)",
  },
  {
    pattern: /WebGL disabled: the worker finds no context and the page keeps its stills/,
    reason:
      "launches with --disable-webgl --disable-3d-apis, which Playwright WebKit cannot apply; Firefox ran this file",
  },
  {
    // The whole file: every case needs the SwiftShader-backed scene and Chrome launch flags.
    pattern: /m2-keys\.spec\.ts/,
    reason:
      "needs the SwiftShader-backed full-tier scene and Chrome flags (--enable-unsafe-swiftshader, --disable-smooth-scrolling); Playwright WebKit has no equivalent; Firefox ran this file",
  },
];

const tagPattern = new RegExp(CHROMIUM_ONLY_TAG);
/** testIgnore for the Firefox and WebKit projects. */
export const crossBrowserIgnore: RegExp[] = CHROMIUM_ONLY_SPECS.map((o) => o.pattern);
/** grepInvert per cross-browser project. */
export const crossBrowserGrepInvert = (engine: "firefox" | "webkit"): RegExp[] => [
  tagPattern,
  ...CHROMIUM_ONLY_TESTS.map((o) => o.pattern),
  ...(engine === "firefox" ? FIREFOX_ONLY_SKIP : WEBKIT_ONLY_SKIP).map((o) => o.pattern),
];
