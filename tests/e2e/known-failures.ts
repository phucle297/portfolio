/**
 * Known engine failures (PF-05 → PF-45). A test that also fails on main in one engine is marked
 * expected-to-fail for that engine only: it still runs everywhere, Playwright reports it as an
 * expected failure, and it turns red ("expected to fail, but passed") once the engine passes, so
 * PF-45 can close it. Never use skip/fixme or file excludes for these.
 */
import { test } from "@playwright/test";

/** Follow-up card for the known engine failures (no GitHub issue yet; see backlog.md PF-45). */
export const PF45 = "PF-45 · Real-device check and known engine failures";

export type Engine = "chromium" | "firefox" | "webkit";

/** Call at the start of the test body (or the beforeEach that fails) of one listed test. */
export function knownEngineFailure(engines: readonly Engine[], reason: string): void {
  const info = test.info();
  if (!engines.some((engine) => engine === info.project.name)) return;
  info.annotations.push({ type: "issue", description: PF45 });
  test.fail(true, `PF-45: ${reason}`);
}
