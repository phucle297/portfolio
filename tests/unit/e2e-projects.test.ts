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
 * The inventory and pattern pins must fail if a spec is deleted or an opt-out is widened or added.
 */
const root = resolve(import.meta.dirname, "../..");
const e2eDir = join(root, "tests/e2e");
const ENGINES = ["chromium", "firefox", "webkit"] as const;

/** Pinned inventory of tests/e2e/*.spec.ts. Deleting a spec must fail this list. */
const EXPECTED_SPECS: readonly string[] = [
  "cross-browser.spec.ts",
  "m2-keys.spec.ts",
  "m2-qa-b.spec.ts",
  "m2.spec.ts",
  "owner-content.spec.ts",
  "probe-cost-webgl-disabled.spec.ts",
  "probe-cost.spec.ts",
  "seo.spec.ts",
  "serif-once.spec.ts",
  "static-stills.spec.ts",
  "static.spec.ts",
  "structure.spec.ts",
  "tiers.spec.ts",
  "ui-preview.spec.ts",
];

/** Pinned opt-out pattern sources, per engine group. Widening or adding a pattern must fail. */
const EXPECTED_PATTERNS = {
  chromiumOnlySpecs: [] as const,
  chromiumOnlyTests: [
    "/QA-5: copy-email button copies the address and announces it$/",
    "/M1-AC13 fonts: design faces, no fallback in the names/",
  ],
  firefoxOnlySkip: ["/email switch: PUBLIC_EMAIL drives the contact link/"],
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

  it("pins the e2e spec inventory", () => {
    expect(specs.map((f) => relative(e2eDir, f)).toSorted((a, b) => a.localeCompare(b))).toEqual([
      ...EXPECTED_SPECS,
    ]);
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
