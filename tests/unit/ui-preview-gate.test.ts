import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { uiPreviewEnabled } from "../../src/_pages/ui-preview/model/gate";

/** PF-28: /ui-preview/ is built in dev and PR previews only, never on the production path. */
describe("ui-preview gate", () => {
  it("builds in dev and when PUBLIC_UI_PREVIEW=1 on a pull request", () => {
    expect(uiPreviewEnabled({ DEV: true })).toBe(true);
    expect(
      uiPreviewEnabled({
        DEV: false,
        PUBLIC_UI_PREVIEW: "1",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/28/merge",
      }),
    ).toBe(true);
  });

  it("does not build in a plain production build", () => {
    expect(uiPreviewEnabled({ DEV: false })).toBe(false);
    expect(uiPreviewEnabled({ DEV: false, PUBLIC_UI_PREVIEW: "0" })).toBe(false);
    expect(uiPreviewEnabled({ DEV: false, PUBLIC_UI_PREVIEW: "true" })).toBe(false);
  });

  it("never builds on the production deploy path, even if the flag is set", () => {
    for (const env of [
      { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
      { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/other" },
      { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" },
    ]) {
      expect(uiPreviewEnabled({ DEV: false, PUBLIC_UI_PREVIEW: "1", ...env })).toBe(false);
    }
  });

  it("deploy.yml sets the flag only for pull_request builds", () => {
    const yml = readFileSync(
      resolve(import.meta.dirname, "../../.github/workflows/deploy.yml"),
      "utf8",
    );
    const lines = yml.split("\n").filter((l) => l.includes("PUBLIC_UI_PREVIEW"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("github.event_name == 'pull_request' && '1' || '0'");
  });
});
