import { probeCanvas } from "./detect";

const PROBE_TIMEOUT_MS = 3000;

/**
 * Resolve whether hardware WebGL is available. Creating a WebGL context can block for 100 ms+
 * on low-end devices, so the probe runs in a Web Worker on an OffscreenCanvas when possible and
 * only falls back to the main thread where workers/OffscreenCanvas are unavailable.
 */
export function probeHardwareWebGL(): Promise<boolean> {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
    return Promise.resolve(probeCanvas(document.createElement("canvas")));
  }
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./probe.worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      resolve(probeCanvas(document.createElement("canvas")));
      return;
    }
    const finish = (result: boolean): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, PROBE_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      finish(event.data === true);
    });
    worker.addEventListener("error", () => {
      finish(false);
    });
  });
}
