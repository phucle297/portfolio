/**
 * PF-71: the Playwright version CI uses must match bun.lock. These tests
 * plant mismatches in fixture strings (they do not edit the repo) and
 * assert the check names both versions.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPlaywrightVersion,
  ciPinsInYaml,
  driftMessages,
  lockfilePlaywrightVersion,
  stripYamlComments,
} from "../../tools/ci/check-playwright-version.mjs";

const lockWith = (versions: { test?: string; playwright?: string; core?: string }) => `{
  "packages": {
    "@playwright/test": ["@playwright/test@${versions.test ?? "1.65.0"}", "", {}],
    "playwright": ["playwright@${versions.playwright ?? "1.65.0"}", "", {}],
    "playwright-core": ["playwright-core@${versions.core ?? "1.65.0"}", "", {}],
  }
}
`;

const workflow = (env: string, image: string) => `
env:
  PLAYWRIGHT_VERSION: "${env}"
jobs:
  e2e-xb:
    container:
      image: mcr.microsoft.com/playwright:v${image}-noble
`;

describe("PF-71 Playwright version matches the lockfile", () => {
  it("reads the resolved bun.lock versions and ignores workspace ranges", () => {
    const text = `    "@playwright/test": "^1.64.0",
    "@playwright/test": ["@playwright/test@1.65.0", "", { "dependencies": { "playwright": "1.65.0" } }],
    "playwright": ["playwright@1.65.0", "", {}],
    "playwright-core": ["playwright-core@1.65.0", "", {}],
    "peerDependencies": { "playwright-core": ">= 1.0.0" }
`;
    expect(lockfilePlaywrightVersion(text)).toBe("1.65.0");
  });

  it("fails when bun.lock Playwright packages disagree", () => {
    expect(() =>
      lockfilePlaywrightVersion(lockWith({ test: "1.65.0", playwright: "1.64.0", core: "1.65.0" })),
    ).toThrow(
      /bun.lock Playwright packages disagree.*@playwright\/test=1\.65\.0.*playwright=1\.64\.0/,
    );
  });

  it("ignores a container tag that only appears in a comment", () => {
    const src = `
# image: mcr.microsoft.com/playwright:v1.64.0-noble
env:
  PLAYWRIGHT_VERSION: "1.65.0"
  # PLAYWRIGHT_VERSION: "1.64.0"
jobs:
  e2e-xb:
    container:
      image: mcr.microsoft.com/playwright:v1.65.0-noble
`;
    expect(stripYamlComments(src)).not.toContain("1.64.0");
    const pins = ciPinsInYaml(".github/workflows/ci.yml", src);
    expect(pins.map((p) => p.version)).toEqual(["1.65.0", "1.65.0"]);
  });

  it("names both versions when PLAYWRIGHT_VERSION drifts from bun.lock", () => {
    const pins = ciPinsInYaml(".github/workflows/ci.yml", workflow("1.64.0", "1.65.0"));
    expect(driftMessages("1.65.0", pins)).toEqual([
      "Playwright version drift: bun.lock has 1.65.0 but .github/workflows/ci.yml PLAYWRIGHT_VERSION is 1.64.0",
    ]);
  });

  it("names both versions when a container image tag drifts from bun.lock", () => {
    const pins = ciPinsInYaml(".github/workflows/ci.yml", workflow("1.65.0", "1.64.0"));
    expect(driftMessages("1.65.0", pins)).toEqual([
      "Playwright version drift: bun.lock has 1.65.0 but .github/workflows/ci.yml image mcr.microsoft.com/playwright:v1.64.0-noble is 1.64.0",
    ]);
  });

  it("passes when every CI pin matches bun.lock, and fails a planted tree", () => {
    const root = mkdtempSync(join(tmpdir(), "pf-71-"));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, "bun.lock"), lockWith({}));
    writeFileSync(join(root, ".github/workflows/ci.yml"), workflow("1.65.0", "1.65.0"));
    const ok = checkPlaywrightVersion(root);
    expect(ok).toEqual({ ok: true, version: "1.65.0", pinCount: 2 });

    writeFileSync(join(root, ".github/workflows/ci.yml"), workflow("1.64.0", "1.64.0"));
    const planted = checkPlaywrightVersion(root);
    expect(planted.ok).toBe(false);
    if (planted.ok) throw new Error("expected planted mismatch to fail");
    expect(planted.message).toContain(
      "bun.lock has 1.65.0 but .github/workflows/ci.yml PLAYWRIGHT_VERSION is 1.64.0",
    );
    expect(planted.message).toContain(
      "bun.lock has 1.65.0 but .github/workflows/ci.yml image mcr.microsoft.com/playwright:v1.64.0-noble is 1.64.0",
    );
  });

  it("the real repo lockfile matches the CI pins", () => {
    const result = checkPlaywrightVersion(join(import.meta.dirname, "../.."));
    expect(result).toMatchObject({ ok: true, version: "1.65.0" });
    if (!result.ok) throw new Error(result.message);
    expect(result.pinCount).toBeGreaterThan(0);
  });
});
