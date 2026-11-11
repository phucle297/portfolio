import { inView } from "motion";
import { animate } from "motion/mini";
import { prefersReducedMotion } from "./preferences";

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

/**
 * Scroll-reveal for every element marked with `data-reveal`.
 *
 * Elements are only hidden by CSS when `<html>` has the `motion-ok` class (set by an inline
 * script in the base layout when JS runs and the user has not asked for reduced motion), so
 * content is always visible without JS or under `prefers-reduced-motion: reduce`.
 */
export function initReveal(root: ParentNode = document): void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (elements.length === 0) return;

  if (prefersReducedMotion()) {
    for (const el of elements) el.dataset.revealed = "";
    return;
  }

  inView(
    elements,
    (element) => {
      const el = element as HTMLElement;
      const delay = Number(el.dataset.revealDelay ?? 0) / 1000;
      el.dataset.revealed = "";
      animate(
        el,
        { opacity: [0, 1], transform: ["translate3d(0, 24px, 0)", "translate3d(0, 0, 0)"] },
        { duration: 0.8, delay, ease: EASE_OUT_EXPO },
      );
    },
    { amount: 0.15 },
  );
}
