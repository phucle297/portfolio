/**
 * PF-70: the quarantine list stays in sync with the tests and with ci.yml.
 * Removing an entry from the list (and the matching ci.yml exclude) returns
 * that test to the blocking gate. This guard fails if a listed title disappears
 * or if ci-ok starts depending on a quarantine job.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");

interface Item {
  id: string;
  file: string;
  title: string;
  project: string;
  date: string;
  reason: string;
  follow_up: string;
  known_run: string;
  source_title?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isItem = (value: unknown): value is Item => {
  if (!isRecord(value)) return false;
  const strings = ["id", "file", "title", "project", "date", "reason", "follow_up", "known_run"];
  if (strings.some((key) => typeof value[key] !== "string")) return false;
  return value.source_title === undefined || typeof value.source_title === "string";
};

const parseList = (raw: string): { items: Item[] } => {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.items) || !parsed.items.every(isItem)) {
    throw new Error("tools/ci/quarantine.json is missing a valid items array");
  }
  return { items: parsed.items };
};

const list = parseList(readFileSync(join(root, "tools/ci/quarantine.json"), "utf8"));

const ciYml = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

const requiredIds = [
  "tiers-m1-ac16",
  "lh-mobile-tbt",
  "static-stills-webkit-phone-lcp",
  "m2-qa-b-b4-idle",
  "visible-jump-chromium",
  "loader-webkit-early-ready",
  "loader-webkit-late-exit-frames",
] as const;

describe("PF-70 quarantine list", () => {
  it("names every seeded flaky check with date, reason, and follow-up card", () => {
    const ids = list.items.map((i) => i.id);
    expect(ids).toEqual([...requiredIds]);
    for (const item of list.items) {
      expect(item.date.trim().length, item.id).toBeGreaterThan(0);
      expect(item.reason.trim().length, item.id).toBeGreaterThan(20);
      expect(item.follow_up, item.id).toMatch(/^PF-\d+$/);
      expect(item.known_run, item.id).toMatch(/^\d+$/);
      expect(item.title.trim().length, item.id).toBeGreaterThan(10);
    }
  });

  it("points each e2e entry at a file that still contains that title", () => {
    for (const item of list.items) {
      if (item.project === "lighthouse-mobile") continue;
      const source = readFileSync(join(root, item.file), "utf8");
      expect(source, item.id).toContain(item.source_title ?? item.title);
    }
  });

  it("keeps quarantine jobs out of the ci-ok blocking gate", () => {
    expect(ciYml).toContain("name: quarantine (e2e)");
    expect(ciYml).toContain("name: quarantine (webkit phone LCP)");
    expect(ciYml).toContain("name: quarantine (webkit loader)");
    expect(ciYml).toContain("name: quarantine (lh mobile TBT)");
    const needs = /  ci-ok:[\s\S]*?needs: \[([^\]]+)\]/.exec(ciYml);
    expect(needs, "ci-ok needs").not.toBeNull();
    const jobs = needs?.[1] ?? "";
    expect(jobs).not.toMatch(/quarantine/);
    expect(jobs).toContain("e2e");
    expect(jobs).toContain("lighthouse");
  });

  it("excludes the quarantined e2e tests from the blocking jobs", () => {
    expect(ciYml).toContain(
      'tests/e2e/tiers.spec.ts --grep-invert "render loop is on demand|M1-AC16 there is no Motion toggle"',
    );
    expect(ciYml).toContain(
      'tests/e2e/m2-qa-b.spec.ts --grep-invert "scroll sweep at 1600|B-4 the render loop idles"',
    );
    expect(ciYml).toContain(
      "phone: the first still is the eager, high-priority, first-fetched LCP candidate",
    );
    expect(ciYml).toContain("ready at 200-300 ms|ready after the content is fully in");
    // The visible-jump group must not remain in the fail-fast e2e matrix.
    expect(ciYml).not.toMatch(
      /- group: visible-jump\s*\n\s*args: tests\/e2e\/visible-jump\.spec\.ts/,
    );
  });

  it("keeps PF-67 loader.spec blocking on Chromium and Firefox; only the two WebKit titles are quarantined", () => {
    const webkitLoader = list.items.filter((i) => i.file === "tests/e2e/loader.spec.ts");
    expect(webkitLoader.map((i) => i.id)).toEqual([
      "loader-webkit-early-ready",
      "loader-webkit-late-exit-frames",
    ]);
    expect(webkitLoader.every((i) => i.project === "webkit" && i.follow_up === "PF-81")).toBe(true);
    // Chromium app-features and the e2e-xb file list still include the spec.
    expect(ciYml).toContain("tests/e2e/progress-top.spec.ts tests/e2e/loader.spec.ts");
    expect(ciYml).toContain("tests/e2e/a11y.spec.ts tests/e2e/loader.spec.ts");
    // The invert that drops the two titles is only in the WebKit branch.
    const webkitIf = ciYml.indexOf("= webkit ]; then");
    expect(webkitIf, "webkit invert block").toBeGreaterThan(0);
    const before = ciYml.slice(0, webkitIf);
    const after = ciYml.slice(webkitIf, webkitIf + 800);
    expect(before).not.toContain("ready at 200-300 ms|ready after the content is fully in");
    expect(after).toContain("ready at 200-300 ms|ready after the content is fully in");
  });
});
