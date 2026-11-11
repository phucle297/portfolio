/**
 * Client entry for app-wide behaviour, loaded by the BaseLayout <script> on every page.
 * Kept as a module (not inline in the layout) so architecture tooling can see its imports.
 */
import { initReveal } from "@features/reveal-on-scroll";

export function startClient(): void {
  initReveal();
}
