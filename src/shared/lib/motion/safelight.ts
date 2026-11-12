/**
 * The header's Safelight toggle: whether the darkroom scene's red safelight is on. Purely
 * decorative; persists in localStorage like the Motion toggle.
 */
export const SAFELIGHT_STORAGE_KEY = "safelight";
export const SAFELIGHT_CHANGE_EVENT = "safelightchange";

export function safelightOn(): boolean {
  try {
    return window.localStorage.getItem(SAFELIGHT_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSafelight(on: boolean): void {
  try {
    window.localStorage.setItem(SAFELIGHT_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  window.dispatchEvent(new CustomEvent(SAFELIGHT_CHANGE_EVENT));
}

export function onSafelightChange(listener: () => void): () => void {
  window.addEventListener(SAFELIGHT_CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener(SAFELIGHT_CHANGE_EVENT, listener);
  };
}
