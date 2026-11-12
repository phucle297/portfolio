/**
 * Keeps `aria-current` on the header nav and the section rail in sync with the section under
 * the scroll position (the same progress → section mapping as the scene timeline).
 */
import { SECTIONS, sectionAt } from "@shared/lib/timeline";

function progress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

export function initSectionTracker(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-section-link]"));
  if (links.length === 0) return;
  let current = "";
  let queued = false;

  const update = (): void => {
    queued = false;
    const id = SECTIONS[sectionAt(progress())]?.id ?? "";
    if (id === current) return;
    current = id;
    for (const link of links) {
      if (link.dataset.sectionLink === id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  };

  const queue = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };

  window.addEventListener("scroll", queue, { passive: true });
  window.addEventListener("resize", queue, { passive: true });
  update();
}
