import { expect, test } from "@playwright/test";

/** Throwaway PF-73 diag plant: this file is intentionally not listed in ci.yml. */
test("PF-73 planted unlisted spec", () => {
  expect(true).toBe(true);
});
