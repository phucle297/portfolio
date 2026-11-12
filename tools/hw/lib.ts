/**
 * Statistics and verdicts for the real-hardware verification kit (PF-08). Pure functions,
 * unit-tested in tests/unit/hw.test.ts; the driver is tools/hw/verify.ts.
 */

/** Nearest-rank percentile (q in 0–1) of a list; NaN when empty. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export const median = (values: readonly number[]): number => percentile(values, 0.5);

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Share (0–1) of frames longer than 33 ms. */
  over33: number;
  /** Share (0–1) of frames longer than 16.7 ms. */
  over16: number;
  /** Per-frame JS (all rAF callbacks of one frame) p95, ms. */
  jsP95: number;
}

/**
 * Frame-time distribution from rAF timestamps (ms) and the per-frame rAF callback time (ms).
 * Intervals are between consecutive frames, so N timestamps give N − 1 frames.
 */
export function frameStats(
  timestamps: readonly number[],
  perFrameJs: readonly number[],
): FrameStats {
  const intervals = timestamps.slice(1).map((t, i) => t - (timestamps[i] ?? t));
  const n = intervals.length;
  return {
    frames: n,
    p50: median(intervals),
    p95: percentile(intervals, 0.95),
    p99: percentile(intervals, 0.99),
    max: n ? Math.max(...intervals) : Number.NaN,
    over33: n ? intervals.filter((d) => d > 33).length / n : Number.NaN,
    over16: n ? intervals.filter((d) => d > 16.7).length / n : Number.NaN,
    jsP95: percentile(perFrameJs, 0.95),
  };
}

/** M2-AC11 bar: p95 ≤ 16.7 ms, ≤ 2 % of frames > 33 ms, per-frame JS p95 ≤ 4 ms. */
export const framesPass = (s: FrameStats): boolean =>
  s.frames > 0 && s.p95 <= 16.7 && s.over33 <= 0.02 && s.jsP95 <= 4;

/** Sum rAF callback durations that ran in the same frame (same rAF timestamp). */
export function jsPerFrame(callbacks: readonly (readonly [number, number])[]): number[] {
  const byFrame = new Map<number, number>();
  for (const [t, ms] of callbacks) byFrame.set(t, (byFrame.get(t) ?? 0) + ms);
  return [...byFrame.values()];
}

export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export type Result = "PASS" | "FAIL" | "UNVERIFIED" | "NOT RUN";

/**
 * An item only counts as PASS or FAIL when it ran on a hardware GPU; on a software renderer its
 * numbers are a proxy and the item stays "unverified on hardware" (backlog PF-08 AC3).
 */
export function verdict(ran: boolean, passed: boolean, hardware: boolean): Result {
  if (!ran) return "NOT RUN";
  if (!hardware) return "UNVERIFIED";
  return passed ? "PASS" : "FAIL";
}

/** Exit code for a set of results: 0 all PASS, 1 any FAIL, 2 otherwise (unverified / not run). */
export function exitCode(results: readonly Result[]): number {
  if (results.includes("FAIL")) return 1;
  return results.length > 0 && results.every((r) => r === "PASS") ? 0 : 2;
}

/** Read a nested value of parsed JSON without trusting its shape (undefined if any step is missing). */
export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let v: unknown = value;
  for (const key of path) {
    if (typeof v !== "object" || v === null) return undefined;
    const next: unknown = Reflect.get(v, key);
    v = next;
  }
  return v;
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Chrome trace JSON (array or `{ traceEvents }`) → the event fields mainThreadBusy reads. */
export function traceEvents(trace: unknown): TraceEvent[] {
  const list = Array.isArray(trace) ? trace : at(trace, "traceEvents");
  if (!Array.isArray(list)) return [];
  return list.map((e: unknown) => {
    const event: TraceEvent = {};
    const name = str(at(e, "name"));
    const ph = str(at(e, "ph"));
    const ts = num(at(e, "ts"));
    const dur = num(at(e, "dur"));
    const pid = num(at(e, "pid"));
    const tid = num(at(e, "tid"));
    const threadName = str(at(e, "args", "name"));
    if (name !== undefined) event.name = name;
    if (ph !== undefined) event.ph = ph;
    if (ts !== undefined) event.ts = ts;
    if (dur !== undefined) event.dur = dur;
    if (pid !== undefined) event.pid = pid;
    if (tid !== undefined) event.tid = tid;
    if (threadName !== undefined) event.args = { name: threadName };
    return event;
  });
}

export interface LighthouseSummary {
  perf: number;
  a11y: number;
  bp: number;
  seo: number;
  /** URLs from the network-requests audit. */
  requests: string[];
}

/** Category scores (0–100) and requested URLs of a Lighthouse JSON report. */
export function lighthouseSummary(report: unknown): LighthouseSummary {
  const score = (k: string): number =>
    Math.round((num(at(report, "categories", k, "score")) ?? 0) * 100);
  const items = at(report, "audits", "network-requests", "details", "items");
  const requests = Array.isArray(items)
    ? items.map((item: unknown) => str(at(item, "url")) ?? "").filter(Boolean)
    : [];
  return {
    perf: score("performance"),
    a11y: score("accessibility"),
    bp: score("best-practices"),
    seo: score("seo"),
    requests,
  };
}

export interface TraceEvent {
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: { name?: string };
}

/**
 * Main-thread busy time (ms) in [startMs, endMs] of a Chrome trace: the summed duration of
 * top-level tasks on the renderer main threads (CrRendererMain), clipped to the window. `originUs`
 * is the trace timestamp of the page's time origin, so page times can be compared.
 */
export function mainThreadBusy(
  events: readonly TraceEvent[],
  originUs: number,
  startMs: number,
  endMs: number,
): number {
  const mains = new Set(
    events
      .filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain")
      .map((e) => `${e.pid}:${e.tid}`),
  );
  const from = originUs + startMs * 1000;
  const to = originUs + endMs * 1000;
  let busy = 0;
  for (const e of events) {
    if (e.ph !== "X" || !mains.has(`${e.pid}:${e.tid}`)) continue;
    if (e.name !== "RunTask" && e.name !== "ThreadControllerImpl::RunTask") continue;
    const s = e.ts ?? 0;
    const f = s + (e.dur ?? 0);
    busy += Math.max(0, Math.min(f, to) - Math.max(s, from));
  }
  return busy / 1000;
}

export const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits) : "–";
