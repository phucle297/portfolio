/**
 * Shared measurement code for the PF-01 probe-cost specs (M3-AC6). Not a spec itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

export const RUNS = Number(process.env.PROBE_COST_RUNS ?? 5);
export const OUT = process.env.PROBE_COST_OUT ?? join(process.cwd(), "test-results", "probe-cost");
const PROBE_URL = /probe\.worker/u;
export const SWIFTSHADER = [
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--ignore-gpu-blocklist",
];

export interface Run {
  branch: string;
  hardware: boolean;
  /** Navigation start → tier decision (includes the load + idle wait before the probe starts). */
  navToDecisionMs: number;
  /** Probe start → decision. */
  probeMs: number;
  mainThreadMs: number;
  /** Long tasks that overlap the probe window. */
  longTasks: number[];
  /** Total blocking time from first paint to `tbtEndMs` (Σ max(0, task − 50 ms)). */
  tbtMs: number;
  bytes: number;
  probeRequests: number;
}

interface Collected {
  measure: {
    startTime: number;
    duration: number;
    detail: { branch: string; hardware: boolean; mainThreadMs: number };
  } | null;
  longTasks: { startTime: number; duration: number }[];
  fcp: number;
}

declare global {
  interface Window {
    probeCostLongTasks?: { startTime: number; duration: number }[];
  }
}

export type Setup = (page: Page) => Promise<void>;

export const fulfil =
  (body: string, status = 200): Setup =>
  async (page) => {
    await page.route(PROBE_URL, (route) =>
      route.fulfill({ status, contentType: "text/javascript", body }),
    );
  };

/** One load: wait for the probe's measure entry (or `waitMs` without one), then collect. */
export async function load(
  browser: Browser,
  setup: Setup | null,
  options: { waitMs?: number; tbtEndMs?: number; context?: BrowserContextOptions } = {},
): Promise<Run> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...options.context,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const list: { startTime: number; duration: number }[] = [];
    window.probeCostLongTasks = list;
    new PerformanceObserver((entries) => {
      for (const e of entries.getEntries())
        list.push({ startTime: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  let bytes = 0;
  let probeRequests = 0;
  page.on("response", (res) => {
    if (!PROBE_URL.test(res.url())) return;
    probeRequests += 1;
    void res
      .body()
      .then((b) => {
        bytes += b.length;
        return b.length;
      })
      .catch(() => undefined);
  });
  if (setup) await setup(page);
  await page.goto("/");
  if (options.waitMs === undefined) {
    await page.waitForFunction(
      () => performance.getEntriesByName("darkroom:probe").length > 0,
      null,
      {
        timeout: 15_000,
      },
    );
  } else {
    await page.waitForTimeout(options.waitMs);
  }
  // Let late long tasks land in the observer.
  await page.waitForTimeout(300);
  const got: Collected = await page.evaluate(() => {
    const m = performance.getEntriesByName("darkroom:probe")[0];
    const raw: unknown = m instanceof PerformanceMeasure ? m.detail : null;
    const field = (key: string): unknown =>
      raw !== null && typeof raw === "object" ? Reflect.get(raw, key) : undefined;
    const measure =
      m instanceof PerformanceMeasure
        ? {
            startTime: m.startTime,
            duration: m.duration,
            detail: {
              branch: String(field("branch")),
              hardware: field("hardware") === true,
              mainThreadMs: Number(field("mainThreadMs")),
            },
          }
        : null;
    const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0;
    return { measure, longTasks: window.probeCostLongTasks ?? [], fcp };
  });
  await context.close();
  const start = got.measure?.startTime ?? 0;
  const end = start + (got.measure?.duration ?? 0);
  const tbtEnd = options.tbtEndMs ?? end;
  return {
    branch: got.measure?.detail.branch ?? "none",
    hardware: got.measure?.detail.hardware ?? false,
    navToDecisionMs: end,
    probeMs: got.measure?.duration ?? 0,
    mainThreadMs: got.measure?.detail.mainThreadMs ?? 0,
    longTasks: got.longTasks
      .filter((t) => t.startTime < end && t.startTime + t.duration > start)
      .map((t) => Math.round(t.duration)),
    tbtMs: got.longTasks
      .filter((t) => t.startTime >= got.fcp && t.startTime < tbtEnd)
      .reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
    bytes,
    probeRequests,
  };
}

export async function repeat(runs: number, once: () => Promise<Run>): Promise<Run[]> {
  const out: Run[] = [];
  for (let i = 0; i < runs; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one browser page at a time on a shared box
    out.push(await once());
  }
  return out;
}

export const pct = (xs: number[], q: number): number => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] ?? 0;
};
const r1 = (x: number): string => x.toFixed(1);
export const tbt = (runs: Run[]): number =>
  pct(
    runs.map((r) => r.tbtMs),
    0.5,
  );

/** Collects table rows for one spec file and writes them as `<name>.md` / `<name>.json` in OUT. */
export class ProbeCostTable {
  private readonly rows: string[] = [];
  private readonly results: Record<string, Run[]> = {};

  constructor(private readonly name: string) {}

  record(label: string, runs: Run[]): void {
    this.results[label] = runs;
    const col = (f: (r: Run) => number): string =>
      `${r1(pct(runs.map(f), 0.5))} / ${r1(pct(runs.map(f), 0.95))}`;
    const maxLong = Math.max(0, ...runs.flatMap((r) => r.longTasks));
    const decisions = [
      ...new Set(runs.map((r) => `${r.branch}→${r.hardware ? "full" : "static"}`)),
    ];
    this.rows.push(
      `| ${label} | ${decisions.join(", ")} | ${col((r) => r.navToDecisionMs)} | ${col((r) => r.probeMs)} | ${col((r) => r.mainThreadMs)} | ${maxLong ? `${maxLong} ms` : "none"} | ${col((r) => r.tbtMs)} | ${Math.max(...runs.map((r) => r.bytes))} B (${Math.max(...runs.map((r) => r.probeRequests))} req) |`,
    );
  }

  note(line: string): void {
    this.rows.push(line);
  }

  write(): void {
    if (this.rows.length === 0) return;
    const header = [
      `Probe cost, ${RUNS} runs per branch, median / p95 (ms). Box: SwiftShader, no GPU.`,
      "",
      "| Branch | Decision | Nav → decision | Probe start → decision | Main-thread probe time | Longest task in probe window | TBT (FCP → decision / 6 s) | Probe bytes fetched |",
      "|---|---|---|---|---|---|---|---|",
    ];
    const md = [...header, ...this.rows].join("\n");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${this.name}.md`), `${md}\n`);
    writeFileSync(join(OUT, `${this.name}.json`), JSON.stringify(this.results, null, 1));
    process.stdout.write(`${md}\n`);
  }
}

/** Worker main-thread budget (M3-AC6): ≤ 5 ms. */
export const WORKER_MAIN_THREAD_BUDGET_MS = 5;

/**
 * Every run decided through one of `branches` with the expected result, and the median main-thread
 * time is within budget. The p95 / max is reported in the table: on a CPU-saturated shared box a
 * single run's wall-clock time includes preemption, so one slow run is noise, not probe work.
 */
export function expectBranch(runs: Run[], branches: readonly string[], hardware: boolean): void {
  for (const r of runs) {
    expect(branches, `branch ${r.branch}`).toContain(r.branch);
    expect(r.hardware).toBe(hardware);
  }
  const ms = runs.map((r) => r.mainThreadMs);
  expect(
    pct(ms, 0.5),
    `median main-thread ms (all: ${ms.map((x) => x.toFixed(1)).join(", ")})`,
  ).toBeLessThanOrEqual(WORKER_MAIN_THREAD_BUDGET_MS);
}
