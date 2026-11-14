/**
 * Client entry for app-wide behaviour, loaded by the BaseLayout <script> on every page.
 * Kept as a module (not inline in the layout) so architecture tooling can see its imports.
 */
import { initReveal } from "@features/reveal-on-scroll";

export function startClient(): void {
  // PF-49: the header Safelight toggle is gone; always use the default (on) and drop any
  // earlier stored "off" so a returning visitor does not keep a preference we no longer read.
  try {
    window.localStorage.removeItem("safelight");
  } catch {
    // Storage blocked: nothing to clear.
  }
  initReveal();
}
