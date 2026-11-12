/**
 * Mobile menu sheet (PF-11 / M3-AC3). The open control and the full-screen <dialog> are in
 * SiteHeader.astro. Native `showModal()` provides the focus trap and Escape-to-close; this
 * module wires the open/close controls, restores focus to MENU after Esc or the close button,
 * and closes the sheet when a section link is chosen so the hash navigation can land there.
 */
export function initMenuSheet(header: HTMLElement): void {
  const button = header.querySelector<HTMLButtonElement>("[data-menu-open]");
  const dialog = header.querySelector<HTMLDialogElement>("[data-menu-sheet]");
  const closeButton = header.querySelector<HTMLButtonElement>("[data-menu-close]");
  if (!button || !dialog) return;

  let restoreFocus = true;

  const open = (): void => {
    restoreFocus = true;
    if (!dialog.open) dialog.showModal();
    button.setAttribute("aria-expanded", "true");
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

  dialog.addEventListener("close", () => {
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
  });
}
