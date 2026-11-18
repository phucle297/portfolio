/**
 * Motion preferences: the OS `prefers-reduced-motion` setting. Decorative motion (and the
 * 3D scene) may run only when the OS does not ask for reduced motion. A leftover site
 * Motion-toggle value in localStorage is ignored (PF-66).
 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export function reducedMotionQuery(): MediaQueryList {
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery().matches;
}

/** Whether decorative motion (and the 3D scene) may run at all. */
export function motionAllowed(): boolean {
  return !prefersReducedMotion();
}

/** Call `listener` whenever the OS preference changes. */
export function onMotionChange(listener: () => void): () => void {
  const query = reducedMotionQuery();
  query.addEventListener("change", listener);
  return () => {
    query.removeEventListener("change", listener);
  };
}
