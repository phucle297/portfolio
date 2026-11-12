/**
 * Contrast findings filed in PR #12 under PF-03 AC3 ("a violation that lives in a PR #3 file is
 * filed as a finding in the PR, not fixed here, and fixed in wave 2"), carded as PF-40 (fix the
 * three Services contrasts, then delete this list). Matched by stable selector and only off the
 * full tier (backdrop = the Services poster still, not the canvas); each is printed with its
 * measured ratio in every run, and anything else that fails, fails.
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
}

export const FILED_FINDINGS_CARD = "PF-40";

/** The only selectors that may ever be exempted (frozen; PF-40 removes them). */
export const ALLOWED_FINDING_SELECTORS: readonly string[] = [
  ".services__subline",
  ".services__head > .eyebrow",
  "#services-title > em",
];

export const FILED_FINDINGS: readonly FiledFinding[] = [
  {
    selector: ".services__subline",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services sub-line over the Services still (static tier, 1440)",
  },
  {
    selector: ".services__head > .eyebrow",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services eyebrow over the Services still (static tier, 1440)",
  },
  {
    selector: "#services-title > em",
    card: "PF-40",
    file: "src/_pages/home/ui/ServicesSection.astro",
    note: "Services title accent (#FF7A3D) over the Services still (static tier, 1440)",
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
    if (!ALLOWED_FINDING_SELECTORS.includes(f.selector))
      problems.push(`selector not allowed: ${JSON.stringify(f.selector)}`);
    if (f.card !== FILED_FINDINGS_CARD)
      problems.push(
        `${JSON.stringify(f.selector)} must reference ${FILED_FINDINGS_CARD}, has ${JSON.stringify(f.card)}`,
      );
  }
  for (const s of ALLOWED_FINDING_SELECTORS)
    if (!selectors.includes(s)) problems.push(`missing entry: ${JSON.stringify(s)}`);
  const dupes = selectors.filter((s, i) => selectors.indexOf(s) !== i);
  if (dupes.length > 0) problems.push(`duplicate entries: ${dupes.join(", ")}`);
  return problems;
}

/** Throws unless `list` is exactly the three PF-40 Services selectors. */
export function assertFiledFindings(list: readonly FiledFinding[]): void {
  const problems = filedFindingsProblems(list);
  if (problems.length > 0)
    throw new Error(
      `FILED_FINDINGS must be exactly the 3 PF-40 Services selectors (reviewer condition, PR #12): ${problems.join("; ")}`,
    );
}
