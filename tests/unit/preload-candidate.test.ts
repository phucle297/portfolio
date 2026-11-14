import { describe, expect, it } from "vitest";
import {
  assertExactPreloadCandidate,
  computeSrcsetPick,
  parseSrcset,
  preloadPickedCandidate,
} from "../e2e/preload-candidate";

const A = "https://example.test/_astro/d-0.960w.avif";
const B = "https://example.test/_astro/d-0.1440w.avif";
const BASE = "https://example.test/";

describe("assertExactPreloadCandidate", () => {
  it("accepts currentSrc equal to the preload-picked candidate", () => {
    expect(() => {
      assertExactPreloadCandidate(A, A);
    }).not.toThrow();
  });

  it("fails when currentSrc is a different srcset candidate than the preload picked", () => {
    expect(() => {
      assertExactPreloadCandidate(B, A);
    }).toThrow(/not the preload-picked candidate/);
  });

  it("fails when either side is missing", () => {
    expect(() => {
      assertExactPreloadCandidate("", A);
    }).toThrow(/preload candidate missing/);
    expect(() => {
      assertExactPreloadCandidate(A, "");
    }).toThrow(/preload candidate missing/);
  });
});

describe("preloadPickedCandidate", () => {
  it("prefers the resource with initiatorType link over a later img fetch of another candidate", () => {
    expect(
      preloadPickedCandidate({
        href: "",
        candidateUrls: [A, B],
        resources: [
          { name: B, initiatorType: "img", startTime: 12 },
          { name: A, initiatorType: "link", startTime: 1 },
        ],
      }),
    ).toBe(A);
  });

  it("does not adopt a non-link candidate resource when no link entry is recorded", () => {
    expect(() => {
      preloadPickedCandidate({
        href: "",
        candidateUrls: [A, B],
        resources: [
          { name: B, initiatorType: "img", startTime: 8 },
          { name: A, initiatorType: "other", startTime: 2 },
        ],
      });
    }).toThrow(/preload was never fetched/);
  });

  it("throws when no link-initiated entry is recorded", () => {
    expect(() => {
      preloadPickedCandidate({
        href: "",
        candidateUrls: [A, B],
        resources: [{ name: A, initiatorType: "img", startTime: 1 }],
      });
    }).toThrow(/preload was never fetched/);
  });
});

describe("parseSrcset / computeSrcsetPick", () => {
  it("parses w-descriptors relative to a base URL", () => {
    expect(parseSrcset("/_astro/d-0.960w.avif 960w, /_astro/d-0.1440w.avif 1440w", BASE)).toEqual([
      { url: A, width: 960 },
      { url: B, width: 1440 },
    ]);
  });

  it("picks the lowest density at or above DPR for sizes=100vw", () => {
    const candidates = parseSrcset(
      "/_astro/d-0.960w.avif 960w, /_astro/d-0.1440w.avif 1440w",
      BASE,
    );
    expect(computeSrcsetPick({ candidates, viewportWidth: 1440, dpr: 1 })).toBe(B);
    expect(computeSrcsetPick({ candidates, viewportWidth: 768, dpr: 1 })).toBe(A);
  });
});
