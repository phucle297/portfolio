/**
 * Copy-email button (build plan Q8). Progressive enhancement: the button ships `hidden` and is
 * revealed only when the async Clipboard API exists, so without JS (or without the API) the
 * mailto link and the plain, selectable address are all there is. Feedback goes to a polite live
 * region and to the button label for two seconds.
 */
const RESET_MS = 2000;

function selectText(el: Element): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function initCopyEmail(button: HTMLButtonElement): void {
  const email = button.dataset.copyEmail ?? "";
  const dd = button.closest("dd");
  const status = dd?.querySelector<HTMLElement>("[data-copy-status]") ?? null;
  const address = dd?.querySelector("[data-email-address]") ?? null;
  // `navigator.clipboard` is missing on insecure origins and some embedded browsers.
  if (!email || typeof navigator.clipboard?.writeText !== "function") return;

  const label = button.textContent?.trim() ?? "";
  let timer = 0;

  const announce = (text: string, state: "copied" | "failed"): void => {
    if (status) status.textContent = text;
    button.dataset.state = state;
    if (state === "copied") button.textContent = text;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      button.textContent = label;
      delete button.dataset.state;
      if (status) status.textContent = "";
    }, RESET_MS);
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(email);
      announce(button.dataset.copied ?? "", "copied");
    } catch {
      if (address) selectText(address);
      announce(button.dataset.copyFailed ?? "", "failed");
    }
  };

  button.hidden = false;
  button.addEventListener("click", () => {
    void copy();
  });
}
