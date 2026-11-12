/**
 * Scroll progress bar (PF-27). A 2 px fixed line sits flush under the site header on every
 * tier, desktop and mobile. It takes no layout space. On the full tier the copy layer drives
 * it with the scene's smoothed progress (unchanged); otherwise it follows raw scroll.
 *
 * `--header-bottom` is measured from the header element's real bottom edge so the bar stays
 * correct if the header height changes (mobile wrap, scrolled state, later PF-11 sheet).
 */
import { clamp } from "@shared/lib/timeline";

export function scrollRatio(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? clamp(window.scrollY / max) : 0;
}

export function syncHeaderBottom(): void {
  const header = document.querySelector<HTMLElement>(".site-header");
  if (!header) return;
  document.documentElement.style.setProperty(
    "--header-bottom",
    `${Math.round(header.getBoundingClientRect().bottom)}px`,
  );
}

function paint(p: number): void {
  const bar = document.querySelector<HTMLElement>("[data-progress]");
  if (bar) bar.style.transform = `scaleX(${clamp(p).toFixed(4)})`;
}

let external = false;

/** Full-tier copy layer: keep the bar in lock-step with the scene's smoothed progress. */
export function driveProgress(p: number): void {
  external = true;
  paint(p);
}

/** Hand the bar back to raw scroll (stage disposed). */
export function releaseProgress(): void {
  external = false;
  paint(scrollRatio());
}

export function initProgressBar(): void {
  syncHeaderBottom();
  const header = document.querySelector(".site-header");
  const observer =
    header !== null && "ResizeObserver" in window
      ? new ResizeObserver(() => {
          syncHeaderBottom();
        })
      : null;
  if (header && observer) observer.observe(header);

  const onScroll = (): void => {
    if (!external) paint(scrollRatio());
  };
  paint(scrollRatio());
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      syncHeaderBottom();
      onScroll();
    },
    { passive: true },
  );
}
