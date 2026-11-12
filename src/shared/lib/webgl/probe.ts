import { probeCanvas } from "./detect";

/** The probe gives up (and the page keeps its poster stills) after this long. */
export const PROBE_TIMEOUT_MS = 3000;

/** How the probe reached its decision (reported for the probe-cost measurement, M3-AC6). */
export type ProbeBranch =
  | "worker"
  | "worker-error"
  | "worker-timeout"
  | "worker-unavailable"
  | "main-thread";

/** `performance.measure` name for one probe run; `detail` is a {@link ProbeReport}. */
export const PROBE_MEASURE = "darkroom:probe";

export interface ProbeReport {
  branch: ProbeBranch;
  hardware: boolean;
  /** Main-thread time spent inside probe code (synchronous parts only), in ms. */
  mainThreadMs: number;
}

/**
 * Resolve whether hardware WebGL is available. Creating a WebGL context can block for 100 ms+
 * on low-end devices, so the probe runs in a Web Worker on an OffscreenCanvas when possible and
 * only falls back to the main thread where workers/OffscreenCanvas are unavailable.
 *
 * Each run leaves one `performance.measure("darkroom:probe")` entry, from the probe start to the
 * decision, with the branch, the result and the main-thread time in its `detail`.
 */
export function probeHardwareWebGL(): Promise<boolean> {
  const start = performance.now();
  let mainThreadMs = 0;
  /** Run `fn` on the main thread and add its duration to the probe's main-thread time. */
  const timed = <T>(fn: () => T): T => {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      mainThreadMs += performance.now() - t0;
    }
  };
  const report = (branch: ProbeBranch, hardware: boolean): boolean => {
    const detail: ProbeReport = { branch, hardware, mainThreadMs };
    try {
      performance.measure(PROBE_MEASURE, { start, end: performance.now(), detail });
    } catch {
      // User Timing L3 unsupported: the decision stands, only the report is lost.
    }
    return hardware;
  };
  const onMainThread = (branch: ProbeBranch): boolean =>
    report(
      branch,
      timed(() => probeCanvas(document.createElement("canvas"))),
    );

  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return Promise.resolve(onMainThread("main-thread"));
  }
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = timed(
        () => new Worker(new URL("./probe.worker.ts", import.meta.url), { type: "module" }),
      );
    } catch {
      resolve(onMainThread("worker-unavailable"));
      return;
    }
    const finish = (branch: ProbeBranch, result: boolean): void => {
      timed(() => {
        clearTimeout(timer);
        worker.terminate();
      });
      resolve(report(branch, result));
    };
    const timer = setTimeout(() => {
      finish("worker-timeout", false);
    }, PROBE_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      finish("worker", event.data === true);
    });
    worker.addEventListener("error", () => {
      finish("worker-error", false);
    });
  });
}
