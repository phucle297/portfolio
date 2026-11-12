import { describe, expect, it } from "vitest";
import {
  assertFiledFindings,
  FILED_FINDINGS,
  type FiledFinding,
  filedFindingsProblems,
  RM_1440,
} from "../e2e/a11y-findings";

// Guard on the a11y spec's contrast exemptions (PR #12 reviewer condition): exactly the three
// PF-40 Services selectors, nothing added, removed, duplicated or re-carded.
const extra: FiledFinding = {
  selector: ".hello__lede",
  card: "PF-40",
  file: "src/_pages/home/ui/HelloSection.astro",
  note: "planted",
  floors: { [RM_1440]: 1 },
};

/** A copy of the committed list with one entry's fields overridden. */
function replaceAt(index: number, patch: Partial<FiledFinding>): FiledFinding[] {
  const copy = [...FILED_FINDINGS];
  const target = copy[index];
  if (target !== undefined) copy[index] = Object.assign({}, target, patch);
  return copy;
}

describe("FILED_FINDINGS guard", () => {
  it("accepts the frozen list as committed", () => {
    expect(filedFindingsProblems(FILED_FINDINGS)).toEqual([]);
    expect(() => {
      assertFiledFindings(FILED_FINDINGS);
    }).not.toThrow();
  });

  it("fails on an extra entry", () => {
    expect(() => {
      assertFiledFindings([...FILED_FINDINGS, extra]);
    }).toThrow(/selector not allowed/);
  });

  it("fails on a missing entry", () => {
    expect(() => {
      assertFiledFindings(FILED_FINDINGS.slice(1));
    }).toThrow(/missing entry/);
  });

  it("fails on a changed selector", () => {
    const changed = replaceAt(0, { selector: ".services" });
    expect(() => {
      assertFiledFindings(changed);
    }).toThrow(/selector not allowed.*missing entry/);
  });

  it("fails on a duplicated entry replacing another", () => {
    const duped = [FILED_FINDINGS[0], FILED_FINDINGS[0], FILED_FINDINGS[1]].filter(
      (f): f is FiledFinding => f !== undefined,
    );
    expect(() => {
      assertFiledFindings(duped);
    }).toThrow(/duplicate entries/);
  });

  it("fails when a floor is lowered", () => {
    expect(() => {
      assertFiledFindings(
        replaceAt(0, {
          floors: {
            [RM_1440]: 1,
            "no JS 1440×900": 3.88,
            "contact form, 3 errors, 1440×900": 2.74,
          },
        }),
      );
    }).toThrow(/floors must be exactly/);
  });

  it("fails when the exemption is widened to another state", () => {
    const first = FILED_FINDINGS[1];
    const widened = first ? { ...first.floors, "static tier 390×844": 4.01 } : {};
    expect(() => {
      assertFiledFindings(replaceAt(1, { floors: widened }));
    }).toThrow(/floors must be exactly/);
  });

  it("fails when an entry does not reference PF-40", () => {
    const recarded = replaceAt(2, { card: "PF-03" });
    expect(() => {
      assertFiledFindings(recarded);
    }).toThrow(/must reference PF-40/);
  });
});
