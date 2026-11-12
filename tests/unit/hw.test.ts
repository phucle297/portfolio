import { describe, expect, it } from "vitest";
import {
  at,
  exitCode,
  frameStats,
  framesPass,
  jsPerFrame,
  lighthouseSummary,
  mainThreadBusy,
  percentile,
  traceEvents,
  verdict,
} from "../../tools/hw/lib.ts";

describe("hw kit: frame statistics (M2-AC11)", () => {
  it("turns rAF timestamps into frame intervals", () => {
    // 100 frames at 16 ms, then 2 frames of 40 ms.
    const stamps = [0];
    for (let i = 0; i < 100; i += 1) stamps.push((stamps.at(-1) ?? 0) + 16);
    stamps.push((stamps.at(-1) ?? 0) + 40, (stamps.at(-1) ?? 0) + 80);
    const s = frameStats(stamps, [1, 2, 3]);
    expect(s.frames).toBe(102);
    expect(s.p50).toBe(16);
    expect(s.p95).toBe(16);
    expect(s.max).toBe(40);
    expect(s.over33).toBeCloseTo(2 / 102, 6);
    expect(s.jsP95).toBe(3);
    expect(framesPass(s)).toBe(true);
  });

  it("fails on a slow p95, too many long frames, or slow per-frame JS", () => {
    const at60 = Array.from({ length: 101 }, (_, i) => i * 16);
    expect(framesPass(frameStats(at60, [5]))).toBe(false);
    const at30 = Array.from({ length: 101 }, (_, i) => i * 34);
    expect(framesPass(frameStats(at30, [1]))).toBe(false);
    expect(framesPass(frameStats([], []))).toBe(false);
  });

  it("sums rAF callbacks that ran in the same frame", () => {
    expect(
      jsPerFrame([
        [10, 1],
        [10, 2.5],
        [26, 0.5],
      ]).toSorted((a, b) => a - b),
    ).toEqual([0.5, 3.5]);
  });

  it("takes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.95)).toBe(5);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe("hw kit: verdicts (PF-08 AC3)", () => {
  it("never reports PASS off real hardware", () => {
    expect(verdict(true, true, true)).toBe("PASS");
    expect(verdict(true, false, true)).toBe("FAIL");
    expect(verdict(true, true, false)).toBe("UNVERIFIED");
    expect(verdict(true, false, false)).toBe("UNVERIFIED");
    expect(verdict(false, true, true)).toBe("NOT RUN");
  });

  it("exits 0 only when every item passed on hardware", () => {
    expect(exitCode(["PASS", "PASS"])).toBe(0);
    expect(exitCode(["PASS", "FAIL", "UNVERIFIED"])).toBe(1);
    expect(exitCode(["PASS", "UNVERIFIED"])).toBe(2);
    expect(exitCode(["PASS", "NOT RUN"])).toBe(2);
    expect(exitCode([])).toBe(2);
  });
});

describe("hw kit: reports and traces", () => {
  it("reads Lighthouse scores and requests without trusting the shape", () => {
    const report = {
      categories: {
        performance: { score: 0.93 },
        accessibility: { score: 1 },
        "best-practices": { score: 0.96 },
        seo: { score: null },
      },
      audits: { "network-requests": { details: { items: [{ url: "/_astro/stage.x.js" }, {}] } } },
    };
    expect(lighthouseSummary(report)).toEqual({
      perf: 93,
      a11y: 100,
      bp: 96,
      seo: 0,
      requests: ["/_astro/stage.x.js"],
    });
    expect(lighthouseSummary("nonsense").requests).toEqual([]);
    expect(at({ a: [{ b: 2 }] }, "a", 0, "b")).toBe(2);
    expect(at(null, "a")).toBeUndefined();
  });

  it("sums renderer main-thread tasks inside a window", () => {
    const trace = {
      traceEvents: [
        { ph: "M", name: "thread_name", pid: 1, tid: 7, args: { name: "CrRendererMain" } },
        { ph: "M", name: "thread_name", pid: 1, tid: 9, args: { name: "Compositor" } },
        // origin at 1_000_000 µs; window 10–20 ms → 1_010_000–1_020_000 µs.
        { ph: "X", name: "RunTask", pid: 1, tid: 7, ts: 1_008_000, dur: 4000 }, // 2 ms inside
        { ph: "X", name: "RunTask", pid: 1, tid: 7, ts: 1_015_000, dur: 1000 }, // 1 ms inside
        { ph: "X", name: "RunTask", pid: 1, tid: 9, ts: 1_015_000, dur: 3000 }, // other thread
        { ph: "X", name: "Paint", pid: 1, tid: 7, ts: 1_016_000, dur: 3000 }, // not a task
        { ph: "X", name: "RunTask", pid: 1, tid: 7, ts: 1_030_000, dur: 3000 }, // after
      ],
    };
    const events = traceEvents(trace);
    expect(events).toHaveLength(7);
    expect(mainThreadBusy(events, 1_000_000, 10, 20)).toBeCloseTo(3, 6);
    expect(traceEvents({ nope: 1 })).toEqual([]);
  });
});
