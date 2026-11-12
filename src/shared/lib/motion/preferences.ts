/**
 * Motion preferences: the OS `prefers-reduced-motion` setting plus the site's own Motion toggle
 * (WCAG 2.2.2). Motion is allowed only when the OS does not ask for reduced motion AND the
 * visitor has not switched it off. The toggle's choice persists in localStorage.
 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const MOTION_STORAGE_KEY = "motion";
export const MOTION_CHANGE_EVENT = "motionchange";

export function reducedMotionQuery(): MediaQueryList {
  return window.matchMedia(REDUCED_MOTION_QUERY);
}

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery().matches;
}

function readStoredMotion(): string | null {
  try {
    return window.localStorage.getItem(MOTION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The visitor's own toggle: true unless they switched motion off. */
export function userMotionOn(): boolean {
  return readStoredMotion() !== "off";
}

/** Whether decorative motion (and the 3D scene) may run at all. */
export function motionAllowed(): boolean {
  return !prefersReducedMotion() && userMotionOn();
}

export function setUserMotion(on: boolean): void {
  try {
    window.localStorage.setItem(MOTION_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  window.dispatchEvent(new CustomEvent(MOTION_CHANGE_EVENT));
}

/** Call `listener` whenever the OS preference or the site toggle changes. */
export function onMotionChange(listener: () => void): () => void {
  const query = reducedMotionQuery();
  query.addEventListener("change", listener);
  window.addEventListener(MOTION_CHANGE_EVENT, listener);
  return () => {
    query.removeEventListener("change", listener);
    window.removeEventListener(MOTION_CHANGE_EVENT, listener);
  };
}
