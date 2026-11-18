/**
 * PF-73: every tests/e2e/*.spec.ts file must appear in some CI job
 * (a blocking e2e / e2e-xb / load-stability job, or a PF-70 quarantine job).
 * A new spec that is only on disk, or only named in a ci.yml comment, fails this
 * guard and is named in the assertion. Playwright project membership is a
 * different check (tests/unit/e2e-projects.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const e2eDir = join(root, "tests/e2e");
const ciYmlPath = ".github/workflows/ci.yml";
const SPEC_RE = /tests\/e2e\/[A-Za-z0-9._/-]+\.spec\.ts/g;

/** Drop YAML comments so a mention only in a comment does not count as coverage. */
const stripYamlComments = (src: string): string =>
  src
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return "";
      let out = "";
      let quote: '"' | "'" | null = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          out += ch;
          if (ch === quote && line[i - 1] !== "\\") quote = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          out += ch;
          continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) break;
        out += ch;
      }
      return out;
    })
    .join("\n");

const listedSpecs = (ciYml: string): string[] =>
  [...new Set(stripYamlComments(ciYml).match(SPEC_RE) ?? [])].toSorted((a, b) =>
    a.localeCompare(b),
  );

const specsOnDisk = (): string[] =>
  readdirSync(e2eDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => relative(root, join(e2eDir, f)))
    .toSorted((a, b) => a.localeCompare(b));

describe("PF-73 e2e specs are in a CI job", () => {
  const ciYml = readFileSync(join(root, ciYmlPath), "utf8");
  const listed = listedSpecs(ciYml);

  it("ignores a spec path that only appears in a comment", () => {
    const src = `
# tests/e2e/comment-only.spec.ts is only mentioned here
    args: tests/e2e/real.spec.ts
    # trailing: tests/e2e/trailing-comment.spec.ts
    run: bunx playwright test tests/e2e/real.spec.ts
`;
    expect(listedSpecs(src)).toEqual(["tests/e2e/real.spec.ts"]);
  });

  it("names a planted spec that is not in the workflow text", () => {
    const planted = "tests/e2e/pf73-unlisted-plant.spec.ts";
    const fromFixture = listedSpecs("    args: tests/e2e/real.spec.ts\n");
    const missing = [planted, "tests/e2e/real.spec.ts"].filter((f) => !fromFixture.includes(f));
    expect(missing, "e2e specs not in any CI job (blocking or quarantined)").toEqual([planted]);
  });

  it("fails, naming the spec, when any tests/e2e/*.spec.ts is missing from every CI job", () => {
    const onDisk = specsOnDisk();
    expect(onDisk.length).toBeGreaterThan(0);
    const missing = onDisk.filter((f) => !listed.includes(f));
    expect(
      missing,
      "e2e specs not in any CI job (blocking or quarantined); add the file to a job in .github/workflows/ci.yml",
    ).toEqual([]);
  });

  it("points every ci.yml e2e path at a file that still exists", () => {
    const onDisk = new Set(specsOnDisk());
    expect(
      listed.filter((f) => !onDisk.has(f)),
      "ci.yml lists e2e paths that are not on disk",
    ).toEqual([]);
  });

  it("counts a quarantine-only spec (visible-jump) as covered", () => {
    expect(listed).toContain("tests/e2e/visible-jump.spec.ts");
  });
});
