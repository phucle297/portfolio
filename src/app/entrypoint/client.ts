/**
 * Client entry for app-wide behaviour, loaded by the BaseLayout <script> on every page.
 * Kept as a module (not inline in the layout) so architecture tooling can see its imports.
 */
import { initReveal } from "@features/reveal-on-scroll";
import { motionAllowed, onMotionChange } from "@shared/lib/motion";

function syncMotionOk(): void {
  document.documentElement.classList.toggle("motion-ok", motionAllowed());
}

export function startClient(): void {
  // PF-49 / PF-66: the Safelight and Motion header toggles are gone. Always use the
  // designed defaults (safelight on; motion on unless the OS asks for reduced motion)
  // and drop any earlier stored values so a returning visitor does not keep a
  // preference we no longer read.
  try {
    window.localStorage.removeItem("safelight");
    window.localStorage.removeItem("motion");
  } catch {
    // Storage blocked: nothing to clear.
  }

  onMotionChange(syncMotionOk);
  syncMotionOk();
  initReveal();
}
