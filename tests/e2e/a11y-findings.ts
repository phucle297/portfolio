/**
 * Contrast findings filed in PR #12 under PF-03 AC3 ("a violation that lives in a PR #3 file is
 * filed as a finding in the PR, not fixed here, and fixed in wave 2"), carded as PF-40 (fix the
 * three Services contrasts, then delete this list). Matched by stable selector, and exempt ONLY
 * in the exact states named in `floors` (reduced motion 1440×900, no JS 1440×900, contact form
 * 1440×900: the Services poster still behind the text, never the canvas), and only while the
 * measured ratio stays at or above its floor (the filed value minus 0.1). Each is printed with its
 * measured ratio in every run; anything else that fails, fails, and so does an exempt node that
 * gets worse than its floor.
 *
 * Reviewer condition (Cat, PR #12): the list is frozen to exactly these three selectors, each
 * carded PF-40. `assertFiledFindings` fails the a11y spec (and tests/unit/a11y-findings.test.ts)
 * on any extra, missing, duplicated or changed entry, so the exemption can only shrink via PF-40.
 */
export interface FiledFinding {
  readonly selector: string;
  readonly card: string;
  readonly file: string;
  readonly note: string;
  /** state name (exactly as the spec names it) → minimum ratio; exempt in no other state. */
  readonly floors: Readonly<Record<string, number>>;
}

export const FILED_FINDINGS_CARD = "PF-40";

/** The exact states the exemption may apply in (all at 1440, over the Services still). */
export const RM_1440 = "reduced motion 1440×900";
export const NOJS_1440 = "no JS 1440×900";
export const CONTACT_1440 = "contact form, 3 errors, 1440×900";

/** Floor = the filed ratio (1st-percentile judge, attempt 5, truncated to 2 dp) minus this margin. */
export const FLOOR_MARGIN = 0.1;

/**
 * Frozen reference: selector → (state → filed ratio). The guard compares FILED_FINDINGS to this,
 * so the exemption can only shrink (via PF-40), never grow, move or loosen.
 */
const FILED_AT: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  ".services__subline": { [RM_1440]: 3.04, [NOJS_1440]: 3.04, [CONTACT_1440]: 2.81 },
  ".services__head > .eyebrow": { [RM_1440]: 4.08, [NOJS_1440]: 4.08 },
  "#services-title > em": { [RM_1440]: 2.41, [NOJS_1440]: 2.41 },
};

const floorsOf = (filed: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(
    Object.entries(filed).map(([state, ratio]) => [
      state,
      Math.round((ratio - FLOOR_MARGIN) * 100) / 100,
    ]),
  );

/** The only selectors that may ever be exempted (frozen; PF-40 removes them). */
export const ALLOWED_FINDING_SELECTORS: readonly string[] = Object.keys(FILED_AT);

export const FILED_FINDINGS: readonly FiledFinding[] = [
  {
    selector: ".services__subline",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services sub-line over the Services still (reduced motion, no JS and contact form, 1440)",
    floors: { [RM_1440]: 2.94, [NOJS_1440]: 2.94, [CONTACT_1440]: 2.71 },
  },
  {
    selector: ".services__head > .eyebrow",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services eyebrow over the Services still (reduced motion and no JS, 1440)",
    floors: { [RM_1440]: 3.98, [NOJS_1440]: 3.98 },
  },
  {
    selector: "#services-title > em",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services title accent (#FF7A3D) over the Services still (reduced motion and no JS, 1440)",
    floors: { [RM_1440]: 2.31, [NOJS_1440]: 2.31 },
  },
];

/** Every way `list` differs from the frozen PF-40 set; empty when it is exactly that set. */
export function filedFindingsProblems(list: readonly FiledFinding[]): string[] {
  const problems: string[] = [];
  const selectors = list.map((f) => f.selector);
  if (list.length !== ALLOWED_FINDING_SELECTORS.length)
    problems.push(
      `expected exactly ${ALLOWED_FINDING_SELECTORS.length} entries, got ${list.length}`,
    );
  for (const f of list) {
    const filed = FILED_AT[f.selector];
    if (filed === undefined) {
      problems.push(`selector not allowed: ${JSON.stringify(f.selector)}`);
      continue;
    }
    if (f.card !== FILED_FINDINGS_CARD)
      problems.push(
        `${JSON.stringify(f.selector)} must reference ${FILED_FINDINGS_CARD}, has ${JSON.stringify(f.card)}`,
      );
    const want = JSON.stringify(
      Object.entries(floorsOf(filed)).toSorted(([x], [y]) => x.localeCompare(y)),
    );
    const got = JSON.stringify(Object.entries(f.floors).toSorted(([x], [y]) => x.localeCompare(y)));
    if (want !== got)
      problems.push(
        `${JSON.stringify(f.selector)} floors must be exactly ${want} (filed ratio − ${FLOOR_MARGIN} in the named states), has ${got}`,
      );
  }
  for (const s of ALLOWED_FINDING_SELECTORS)
    if (!selectors.includes(s)) problems.push(`missing entry: ${JSON.stringify(s)}`);
  const dupes = selectors.filter((s, i) => selectors.indexOf(s) !== i);
  if (dupes.length > 0) problems.push(`duplicate entries: ${dupes.join(", ")}`);
  return problems;
}

/** Throws unless `list` is exactly the three PF-40 Services selectors with their frozen floors. */
export function assertFiledFindings(list: readonly FiledFinding[]): void {
  const problems = filedFindingsProblems(list);
  if (problems.length > 0)
    throw new Error(
      `FILED_FINDINGS must be exactly the 3 PF-40 Services selectors (reviewer condition, PR #12): ${problems.join("; ")}`,
    );
}
