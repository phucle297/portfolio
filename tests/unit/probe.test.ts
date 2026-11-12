/**
 * PF-01 option b (Orchestrator decision): the probe never creates a WebGL context on the main
 * thread. Without Worker or OffscreenCanvas, or when the worker cannot be built, it answers "no"
 * (static tier) and names the reason in its performance.measure entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_MEASURE, probeHardwareWebGL } from "@shared/lib/webgl";

function lastReport(): { branch: string; hardware: boolean } | undefined {
  const entry = performance.getEntriesByName(PROBE_MEASURE).at(-1);
  const detail: unknown = entry instanceof PerformanceMeasure ? entry.detail : undefined;
  if (detail === null || typeof detail !== "object") return undefined;
  return {
    branch: String(Reflect.get(detail, "branch")),
    hardware: Reflect.get(detail, "hardware") === true,
  };
}

describe("probeHardwareWebGL without off-main-thread support", () => {
  const createElement = vi.fn(() => {
    throw new Error("the probe must not touch the DOM / create a canvas on the main thread");
  });

  beforeEach(() => {
    performance.clearMeasures(PROBE_MEASURE);
    vi.stubGlobal("document", { createElement });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    createElement.mockClear();
  });

  it.each([
    ["no Worker", { OffscreenCanvas: vi.fn() }],
    ["no OffscreenCanvas", { Worker: vi.fn() }],
    ["neither", {}],
  ])("%s: static, branch no-offscreen, no main-thread canvas", async (_label, globals) => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);
    for (const [name, value] of Object.entries(globals)) vi.stubGlobal(name, value);
    await expect(probeHardwareWebGL()).resolves.toBe(false);
    expect(createElement).not.toHaveBeenCalled();
    expect(lastReport()).toMatchObject({ branch: "no-offscreen", hardware: false });
  });

  it("worker constructor throws: static, branch worker-unavailable, no main-thread canvas", async () => {
    vi.stubGlobal("OffscreenCanvas", vi.fn());
    vi.stubGlobal(
      "Worker",
      vi.fn(() => {
        throw new Error("blocked by CSP");
      }),
    );
    await expect(probeHardwareWebGL()).resolves.toBe(false);
    expect(createElement).not.toHaveBeenCalled();
    expect(lastReport()).toMatchObject({ branch: "worker-unavailable", hardware: false });
  });
});
