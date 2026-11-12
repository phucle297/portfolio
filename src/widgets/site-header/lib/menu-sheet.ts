/**
 * Mobile menu sheet (PF-11 / M3-AC3). The open control and the full-screen <dialog> are in
 * SiteHeader.astro. Native `showModal()` provides Escape-to-close and a UA focus trap; this
 * module also wraps Tab/Shift+Tab itself so focus cannot leave the sheet (Playwright and some
 * engines do not always honour the UA trap), restores focus to MENU after Esc or Close, and
 * closes the sheet when a section link is chosen so the hash navigation can land there.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusableIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
  );

export function initMenuSheet(header: HTMLElement): void {
  const button = header.querySelector<HTMLButtonElement>("[data-menu-open]");
  const dialog = header.querySelector<HTMLDialogElement>("[data-menu-sheet]");
  const closeButton = header.querySelector<HTMLButtonElement>("[data-menu-close]");
  if (!button || !dialog) return;

  let restoreFocus = true;

  // PF-27 (PR #18) sets --header-bottom from .site-header's box. Keep that box in sync after
  // open/close so a full-screen sheet cannot move the progress bar.
  const syncHeaderBottom = (): void => {
    const root = document.documentElement;
    if (!root.style.getPropertyValue("--header-bottom")) return;
    root.style.setProperty(
      "--header-bottom",
      `${Math.round(header.getBoundingClientRect().bottom)}px`,
    );
  };

  const open = (): void => {
    restoreFocus = true;
    if (!dialog.open) dialog.showModal();
    button.setAttribute("aria-expanded", "true");
    syncHeaderBottom();
  };

  const close = (returnFocus: boolean): void => {
    restoreFocus = returnFocus;
    if (dialog.open) dialog.close();
  };

  button.addEventListener("click", () => {
    if (dialog.open) close(true);
    else open();
  });

  closeButton?.addEventListener("click", () => {
    close(true);
  });

  dialog.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target === dialog) {
      close(true);
      return;
    }
    if (target.closest("a[href]")) close(false);
  });

  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !dialog.open) return;
    const items = focusableIn(dialog);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || active === dialog || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || active === dialog || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  });

  dialog.addEventListener("close", () => {
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
    syncHeaderBottom();
  });
}
