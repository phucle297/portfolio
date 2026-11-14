import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHROMIUM_ONLY_SPECS,
  CHROMIUM_ONLY_TESTS,
  FIREFOX_ONLY_SKIP,
  WEBKIT_ONLY_SKIP,
} from "../../tests/e2e/projects.ts";

/**
 * Guard for the cross-browser convention (PF-05): every e2e spec on disk runs on Firefox and WebKit
 * unless CHROMIUM_ONLY_SPECS opts it out with a reason. It asks Playwright itself (`--list`, no
 * browser, no server), so a config change that narrows the projects fails here.
 *
 * The derived inventory must fail if a spec is deleted; the pattern pins must fail if an opt-out
 * is widened or added.
 */
const root = resolve(import.meta.dirname, "../..");
const e2eDir = join(root, "tests/e2e");
const ENGINES = ["chromium", "firefox", "webkit"] as const;

/**
 * Derived spec inventory (no hand pin). A spec counts as expected when git knows it: it is in the
 * tree at the merge-base with main (so a spec that main has must not disappear in a branch, even
 * in a committed deletion), in HEAD, or in the index (so an uncommitted deletion fails too). New
 * specs from main arrive with the merge and need no edit here. Removing a spec on purpose means
 * listing it in RETIRED_SPECS with a reason, which a reviewer sees.
 *
 * The baseline ref is E2E_SPEC_BASELINE_REF, else origin/main, else main. With no baseline (for
 * example a shallow CI clone) the guard fails and says so; set E2E_SPEC_BASELINE_REF=HEAD to
 * accept the weaker HEAD-only check explicitly, or fetch main (`fetch-depth: 0`).
 */
const RETIRED_SPECS: readonly { spec: string; reason: string }[] = [];

const git = (...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { ok: r.status === 0, out: r.status === 0 ? r.stdout.trim() : r.stderr.trim() };
};

const specLines = (out: string): string[] =>
  out
    .split("\n")
    .map((line) => line.trim())
    .filter((f) => f.startsWith("tests/e2e/") && f.endsWith(".spec.ts"))
    .map((f) => relative(e2eDir, join(root, f)));

interface Baseline {
  ref: string;
  base: string;
  specs: string[];
}

function baselineSpecs(): Baseline | string {
  const candidates = process.env.E2E_SPEC_BASELINE_REF
    ? [process.env.E2E_SPEC_BASELINE_REF]
    : ["origin/main", "main"];
  for (const ref of candidates) {
    if (!git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).ok) continue;
    const base = git("merge-base", "HEAD", ref);
    if (!base.ok) return `no merge-base between HEAD and ${ref}: ${base.out}`;
    const tree = git("ls-tree", "-r", "--name-only", base.out, "--", "tests/e2e");
    if (!tree.ok) return `git ls-tree ${base.out} failed: ${tree.out}`;
    return { ref, base: base.out, specs: specLines(tree.out) };
  }
  return `no baseline ref (${candidates.join(", ")}); fetch main or set E2E_SPEC_BASELINE_REF=HEAD`;
}

function derivedInventory(): { baseline: Baseline | string; expected: string[] } {
  const baseline = baselineSpecs();
  const head = specLines(git("ls-tree", "-r", "--name-only", "HEAD", "--", "tests/e2e").out);
  const index = specLines(git("ls-files", "--", "tests/e2e").out);
  const fromBase = typeof baseline === "string" ? [] : baseline.specs;
  const retired = new Set(RETIRED_SPECS.map((r) => r.spec));
  const expected = [...new Set([...fromBase, ...head, ...index])]
    .filter((f) => !retired.has(f))
    .toSorted((a, b) => a.localeCompare(b));
  return { baseline, expected };
}

/** Pinned opt-out pattern sources, per engine group. Widening or adding a pattern must fail. */
const EXPECTED_PATTERNS = {
  chromiumOnlySpecs: [] as const,
  chromiumOnlyTests: [
    "/QA-5: copy-email button copies the address and announces it$/",
    "/M1-AC13 fonts: design faces, no fallback in the names/",
  ],
  firefoxOnlySkip: [
    "/email switch: PUBLIC_EMAIL drives the contact link and the JS mailto submit$/",
  ],
  webkitOnlySkip: [
    "/B-8: a reload while scrolled keeps the header opaque before its script runs/",
    "/WebGL disabled: the worker finds no context and the page keeps its stills/",
    "/m2-keys\\.spec\\.ts/",
  ],
} as const;

const patternSources = (opts: readonly { pattern: RegExp }[]): string[] =>
  opts.map((o) => String(o.pattern));

const titleOptOuts = (engine: "firefox" | "webkit") => [
  ...CHROMIUM_ONLY_TESTS,
  ...(engine === "firefox" ? FIREFOX_ONLY_SKIP : WEBKIT_ONLY_SKIP),
];

const specsOnDisk = (): string[] =>
  readdirSync(e2eDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => join(e2eDir, f))
    .toSorted((a, b) => a.localeCompare(b));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const optedOut = (file: string): boolean => CHROMIUM_ONLY_SPECS.some((o) => o.pattern.test(file));

interface Listed {
  file: string;
  title: string;
  project: string;
}

/** Flattens Playwright's JSON report into (file, full title, project) rows. */
function flatten(suite: unknown, file: string, titles: readonly string[]): Listed[] {
  if (!isRecord(suite)) return [];
  const here = typeof suite.file === "string" ? suite.file : file;
  const path =
    typeof suite.title === "string" && suite.title !== here ? [...titles, suite.title] : titles;
  const fromSpecs = list(suite.specs).flatMap((spec) => {
    if (!isRecord(spec)) return [];
    const title = [...path, String(spec.title)].join(" ");
    return list(spec.tests).flatMap((t) =>
      isRecord(t) && typeof t.projectName === "string"
        ? [{ file: join(e2eDir, here), title, project: t.projectName }]
        : [],
    );
  });
  return [...fromSpecs, ...list(suite.suites).flatMap((s) => flatten(s, here, path))];
}

function playwrightList(): Listed[] {
  const r = spawnSync(
    process.execPath,
    [join(root, "node_modules/@playwright/test/cli.js"), "test", "--list", "--reporter=json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } },
  );
  expect(r.status, r.stderr).toBe(0);
  const report: unknown = JSON.parse(r.stdout);
  return isRecord(report) ? list(report.suites).flatMap((s) => flatten(s, "", [])) : [];
}

describe("e2e projects: specs are cross-browser by default (PF-05)", () => {
  const listed = playwrightList();
  const files = (project: string): string[] => [
    ...new Set(listed.filter((t) => t.project === project).map((t) => t.file)),
  ];
  const specs = specsOnDisk();

  it("keeps every spec git knows about (derived inventory: main baseline, HEAD, index)", () => {
    const { baseline, expected } = derivedInventory();
    expect(typeof baseline === "string" ? baseline : "", "spec baseline").toBe("");
    const onDisk = new Set(specs.map((f) => relative(e2eDir, f)));
    const missing = expected.filter((f) => !onDisk.has(f));
    expect(missing, "e2e specs deleted (list them in RETIRED_SPECS with a reason)").toEqual([]);
    expect(expected.length).toBeGreaterThan(0);
    for (const r of RETIRED_SPECS) expect(r.reason.trim().length, r.spec).toBeGreaterThan(10);
  });

  it("pins opt-out patterns and the engines they apply to", () => {
    expect(patternSources(CHROMIUM_ONLY_SPECS), "CHROMIUM_ONLY_SPECS").toEqual([
      ...EXPECTED_PATTERNS.chromiumOnlySpecs,
    ]);
    expect(patternSources(CHROMIUM_ONLY_TESTS), "CHROMIUM_ONLY_TESTS").toEqual(
      EXPECTED_PATTERNS.chromiumOnlyTests,
    );
    expect(patternSources(FIREFOX_ONLY_SKIP), "FIREFOX_ONLY_SKIP").toEqual(
      EXPECTED_PATTERNS.firefoxOnlySkip,
    );
    expect(patternSources(WEBKIT_ONLY_SKIP), "WEBKIT_ONLY_SKIP").toEqual(
      EXPECTED_PATTERNS.webkitOnlySkip,
    );
  });

  it("finds the e2e specs and all three projects", () => {
    expect(specs.length).toBeGreaterThan(0);
    expect(
      [...new Set(listed.map((t) => t.project))].toSorted((a, b) => a.localeCompare(b)),
    ).toEqual([...ENGINES].toSorted((a, b) => a.localeCompare(b)));
  });

  it("runs every spec on Chromium", () => {
    expect(files("chromium").toSorted((a, b) => a.localeCompare(b))).toEqual(specs);
  });

  /** True when every Chromium test in the file is dropped by this engine's title opt-outs. */
  const allTestsDropped = (file: string, engine: "firefox" | "webkit"): boolean => {
    const tests = listed.filter((t) => t.project === "chromium" && t.file === file);
    if (tests.length === 0) return false;
    const allowed = titleOptOuts(engine);
    return tests.every(
      (t) =>
        t.title.includes("@chromium-only") ||
        allowed.some((o) => o.pattern.test(`${relative(e2eDir, t.file)} ${t.title}`)),
    );
  };

  it.each(["firefox", "webkit"] as const)(
    "runs every spec that is not opted out on %s",
    (engine) => {
      const expected = specs.filter((f) => !optedOut(f) && !allTestsDropped(f, engine));
      const missing = expected
        .filter((f) => !files(engine).includes(f))
        .map((f) => relative(root, f));
      expect(
        missing,
        `specs missing from ${engine}: opt them out in tests/e2e/projects.ts`,
      ).toEqual([]);
      const leaked = files(engine)
        .filter((f) => optedOut(f) || allTestsDropped(f, engine))
        .map((f) => relative(root, f));
      expect(leaked, `opted-out specs still listed on ${engine}`).toEqual([]);
    },
  );

  it("drops only documented tests on Firefox and WebKit", () => {
    const keys = (project: string): Set<string> =>
      new Set(listed.filter((t) => t.project === project).map((t) => `${t.file}\0${t.title}`));
    const chromium = listed.filter((t) => t.project === "chromium" && !optedOut(t.file));
    for (const engine of ["firefox", "webkit"] as const) {
      const present = keys(engine);
      const allowed = [
        ...CHROMIUM_ONLY_TESTS,
        ...(engine === "firefox" ? FIREFOX_ONLY_SKIP : WEBKIT_ONLY_SKIP),
      ];
      const undocumented = chromium
        .filter((t) => !present.has(`${t.file}\0${t.title}`))
        .filter(
          (t) =>
            !allowed.some((o) => o.pattern.test(`${relative(e2eDir, t.file)} ${t.title}`)) &&
            !t.title.includes("@chromium-only"),
        )
        .map((t) => `${relative(root, t.file)}: ${t.title}`);
      expect(undocumented, `${engine} drops tests without an opt-out`).toEqual([]);
    }
  });

  it("gives every opt-out a reason, and drops stale ones", () => {
    const all = [
      ...CHROMIUM_ONLY_SPECS,
      ...CHROMIUM_ONLY_TESTS,
      ...FIREFOX_ONLY_SKIP,
      ...WEBKIT_ONLY_SKIP,
    ];
    expect(all.filter((o) => o.reason.trim().length < 10).map((o) => String(o.pattern))).toEqual(
      [],
    );
    const stale = [
      ...CHROMIUM_ONLY_SPECS.filter((o) => !o.pending && !specs.some((f) => o.pattern.test(f))),
      ...[...CHROMIUM_ONLY_TESTS, ...FIREFOX_ONLY_SKIP, ...WEBKIT_ONLY_SKIP].filter(
        (o) =>
          !o.pending &&
          !listed.some(
            (t) =>
              t.project === "chromium" && o.pattern.test(`${relative(e2eDir, t.file)} ${t.title}`),
          ),
      ),
    ].map((o) => String(o.pattern));
    expect(stale, "opt-outs that match nothing: remove them or mark them pending").toEqual([]);
  });
});
