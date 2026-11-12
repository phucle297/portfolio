/**
 * Full-tier hook for the scroll progress bar (PF-27). On the static tier the bar is driven by
 * CSS `animation-timeline: scroll()`, or by a tiny inline fallback in HomePage.astro; this
 * module is imported only by the lazy scene chunk, so it does not count toward initial JS.
 *
 * When the scene is running, the copy layer calls `driveProgress` with the smoothed p so the
 * bar stays in lock-step with the scene (unchanged full-tier behaviour).
 */
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

let cachedRoot: HTMLElement | null = null;
let cachedFill: HTMLElement | null = null;
const rootEl = (): HTMLElement | null =>
  cachedRoot?.isConnected === true
    ? cachedRoot
    : (cachedRoot = document.querySelector(".home-progress"));
const fillEl = (): HTMLElement | null =>
  cachedFill?.isConnected === true
    ? cachedFill
    : (cachedFill = document.querySelector("[data-progress]"));

function paint(p: number): void {
  const fill = fillEl();
  if (fill) fill.style.transform = `scaleX(${clamp01(p).toFixed(4)})`;
}

const supportsScrollTimeline = (): boolean =>
  typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()");

/** Full-tier copy layer: disable the CSS timeline and follow the scene's smoothed progress. */
export function driveProgress(p: number): void {
  const root = rootEl();
  if (root && !root.hasAttribute("data-progress-js")) root.setAttribute("data-progress-js", "");
  paint(p);
}

/** Hand the bar back to CSS scroll timeline, or to the inline JS fallback. */
export function releaseProgress(): void {
  const fill = fillEl();
  rootEl()?.removeAttribute("data-progress-js");
  if (supportsScrollTimeline()) {
    fill?.style.removeProperty("transform");
    return;
  }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  paint(max > 0 ? window.scrollY / max : 0);
}
