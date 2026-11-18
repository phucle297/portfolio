/**
 * Contact form behaviour (build plan Q8 / M3-AC8): client-side validation with the design.md §5
 * error strings, then a prefilled `mailto:` to the public address. While `PUBLIC_EMAIL` is null
 * the form explains that sending is not switched on yet instead of pretending to send.
 */
export type FieldName = "name" | "email" | "brief";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ["name", "email", "brief"] as const;

export interface ContactValues {
  name: string;
  email: string;
  /** PF-69: optional and never validated; an empty value adds no line to the mailto body. */
  phone?: string | undefined;
  brief: string;
}

const message = (form: HTMLFormElement, key: string): string =>
  form
    .querySelector<HTMLTemplateElement>("[data-form-messages]")
    ?.content.querySelector(`[data-msg="${key}"]`)
    ?.textContent?.trim() ?? "";

const value = (form: HTMLFormElement, name: string): string => {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
    ? field.value.trim()
    : "";
};

export const fieldValid = {
  name: (text: string): boolean => text.trim().length > 0,
  email: (text: string): boolean => EMAIL_PATTERN.test(text.trim()),
  brief: (text: string): boolean => text.trim().length > 0,
} as const;

export function valuesFromForm(form: HTMLFormElement): ContactValues {
  return {
    name: value(form, "name"),
    email: value(form, "email"),
    phone: value(form, "phone"),
    brief: value(form, "brief"),
  };
}

/**
 * PF-58 (Contact Option B, amends PF-13 AC3 / Q8): subject "Project: {name}", body Name/Email/brief.
 * PF-69: a non-empty (trimmed) phone adds a "Phone: …" line right after Email; empty adds nothing.
 */
export function buildMailtoHref(to: string, values: ContactValues): string {
  const phone = values.phone?.trim() ?? "";
  const lines = [
    `Name: ${values.name}`,
    `Email: ${values.email}`,
    ...(phone ? [`Phone: ${phone}`] : []),
    "",
    values.brief,
  ];
  const subject = `Project: ${values.name}`;
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

export function buildMailto(email: string, form: HTMLFormElement): string {
  return buildMailtoHref(email, valuesFromForm(form));
}

function setError(form: HTMLFormElement, name: FieldName, invalid: boolean): void {
  const field = form.querySelector<HTMLElement>(`[name="${name}"]`);
  const error = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
  field?.setAttribute("aria-invalid", String(invalid));
  if (invalid && error?.id) field?.setAttribute("aria-describedby", error.id);
  else field?.removeAttribute("aria-describedby");
  if (error) error.hidden = !invalid;
}

function validate(form: HTMLFormElement): FieldName | null {
  const values = valuesFromForm(form);
  let firstInvalid: FieldName | null = null;
  for (const name of FIELDS) {
    const ok = fieldValid[name](values[name]);
    setError(form, name, !ok);
    if (!ok && firstInvalid === null) firstInvalid = name;
  }
  return firstInvalid;
}

function clearIfValid(form: HTMLFormElement, name: FieldName): void {
  if (fieldValid[name](value(form, name))) setError(form, name, false);
}

/**
 * PF-69 a3 (contact-v3 rev 3 safety net, state-based): while the form shows an error or the
 * success strip, `.contact[data-state=error|success]` is set. While pinned, the Contact copy is a
 * fixed layer; if that state makes it run under the footer (short viewports such as 1200×760),
 * the layer leaves its pinned slot (`data-unpinned`): it is moved up by the overflow, so the form
 * ends 12 px above the footer.
 *
 * PF-72: that lift is capped so the eyebrow stays 12 px below the live header bottom. If the
 * capped lift is not enough, `.contact[data-compact]` tightens the title and gaps (pinned widths
 * ≥1200 only) and the lift is recomputed. If it still does not fit, the copy body drops back
 * into normal flow (`data-flow`) and the page scrolls so the eyebrow sits 12 px below the
 * header. Compact and lift are removed when the state clears.
 */
export const FOOTER_GAP = 12;
export const HEADER_GAP = 12;

const formState = (form: HTMLFormElement): "error" | "success" | null =>
  form.querySelector(".field__error:not([hidden])")
    ? "error"
    : form.querySelector("[data-form-status]")?.textContent?.trim()
      ? "success"
      : null;

const headerBottom = (): number =>
  document.querySelector("body > header, header")?.getBoundingClientRect().bottom ?? 0;

const footerLimit = (): number => {
  const footerTop = document.querySelector("body > footer")?.getBoundingClientRect().top;
  return (footerTop ?? window.innerHeight) - FOOTER_GAP;
};

/**
 * How far the pinned layer may move up: the overflow needed to clear the footer, but never so
 * far that the eyebrow would sit closer than `gap` px below the header.
 */
export function cappedLift(
  needed: number,
  defaultEyebrowTop: number,
  headerBottomY: number,
  gap = HEADER_GAP,
): number {
  const cap = defaultEyebrowTop - (headerBottomY + gap);
  return Math.max(0, Math.min(needed, cap));
}

const eyebrowOf = (column: HTMLElement): HTMLElement | null =>
  column.querySelector<HTMLElement>(".eyebrow");

const measureNeeded = (column: HTMLElement): number =>
  Math.ceil(column.getBoundingClientRect().bottom - footerLimit());

const applyLift = (body: HTMLElement, lift: number): void => {
  if (lift <= 0) return;
  body.style.setProperty("--unpin-lift", `${Math.ceil(lift)}px`);
  body.setAttribute("data-unpinned", "");
};

/** Place with the current compact/default styles (no lift). Returns whether it now fits. */
const fitsAfterLift = (body: HTMLElement, column: HTMLElement): boolean => {
  const needed = measureNeeded(column);
  if (needed <= 0) return true;
  const eyebrowTop = eyebrowOf(column)?.getBoundingClientRect().top ?? 0;
  const lift = cappedLift(needed, eyebrowTop, headerBottom());
  if (lift >= needed) {
    applyLift(body, lift);
    return true;
  }
  return false;
};

/** In flow mode, nudge the page so a focused control sits between the header and footer. */
const ensureFocusedClear = (el: HTMLElement): void => {
  const body = el.closest<HTMLElement>("[data-copy-body]");
  if (!body?.hasAttribute("data-flow")) return;
  const footerTop =
    document.querySelector("body > footer")?.getBoundingClientRect().top ?? window.innerHeight;
  const head = headerBottom();
  const box = el.getBoundingClientRect();
  let delta = 0;
  if (box.bottom > footerTop - FOOTER_GAP) delta = box.bottom - (footerTop - FOOTER_GAP);
  if (box.top - delta < head + HEADER_GAP) delta = box.top - (head + HEADER_GAP);
  if (Math.abs(delta) < 1) return;
  window.scrollBy({ top: delta, behavior: "auto" });
};

const scrollEyebrowUnderHeader = (column: HTMLElement): void => {
  const eyebrow = eyebrowOf(column);
  if (!eyebrow) return;
  const delta = eyebrow.getBoundingClientRect().top - (headerBottom() + HEADER_GAP);
  if (Math.abs(delta) < 1) return;
  // Instant: the Contact section is thousands of pixels tall while pinned, so a smooth
  // scroll would take a long time; 'auto' also satisfies reduced motion.
  window.scrollBy({ top: delta, behavior: "auto" });
};

export interface UnpinOptions {
  /** When true (submit, or a heading that has gone under the header), scroll into place in flow mode. */
  scroll?: boolean;
}

/** Syncs `data-state` and the PF-69/PF-72 placement; returns whether the layer is unpinned. */
export function unpinIfCovered(form: HTMLFormElement, options: UnpinOptions = {}): boolean {
  const body = form.closest<HTMLElement>("[data-copy-body]");
  const column = form.parentElement;
  if (!body || !column) return false;
  const state = formState(form);
  if (state) column.dataset.state = state;
  else delete column.dataset.state;

  const wasFlow = body.hasAttribute("data-flow");
  body.removeAttribute("data-unpinned");
  body.removeAttribute("data-flow");
  body.style.removeProperty("--unpin-lift");
  delete column.dataset.compact;

  if (!state) return false;
  // 1024 / 390 (and any unpinned viewport): only CSS scroll-margin-top applies.
  if (document.documentElement.dataset.pin !== "on") return false;

  // Flush the cleared pinned layout, then try a capped lift at the default (PF-69) sizes.
  void column.offsetHeight;
  if (fitsAfterLift(body, column)) return body.hasAttribute("data-unpinned");

  // Still doesn't fit: compact at pinned widths ≥1200 (pin already implies this), recompute lift.
  column.dataset.compact = "";
  void column.offsetHeight;
  if (fitsAfterLift(body, column)) return body.hasAttribute("data-unpinned");

  // Still doesn't fit: drop the column back into normal flow and scroll to the heading.
  delete column.dataset.compact;
  body.setAttribute("data-flow", "");
  void column.offsetHeight;
  const eyebrowTop = eyebrowOf(column)?.getBoundingClientRect().top ?? 0;
  const headingCovered = eyebrowTop < headerBottom() + 8;
  // Scroll on submit, when first entering flow, or when the heading has gone under the header.
  if (options.scroll || !wasFlow || headingCovered) {
    scrollEyebrowUnderHeader(column);
  }
  return false;
}

export function initContactForm(form: HTMLFormElement): void {
  // Progressive enhancement: the form ships inert and the submit button disabled so a
  // no-JS submit cannot post back to the page. JS turns it on.
  form.removeAttribute("inert");
  const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
  if (submit) submit.disabled = false;

  const status = form.querySelector<HTMLElement>("[data-form-status]");
  const email = form.dataset.email ?? "";

  for (const name of FIELDS) {
    form.querySelector<HTMLElement>(`[name="${name}"]`)?.addEventListener("input", () => {
      clearIfValid(form, name);
    });
  }

  // Keep the layer's pinned/unpinned placement in step with the form's size and the viewport
  // (one rAF throttle); the state itself only changes on submit and when errors clear.
  let frame = 0;
  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      unpinIfCovered(form);
    });
  };
  new ResizeObserver(schedule).observe(form);
  window.addEventListener("resize", schedule);

  form.addEventListener("focusin", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      ensureFocusedClear(target);
    });
  });

  // "Start a project" / "Get a quote": land on Contact with focus on Name (nothing to preselect).
  // The jump to #contact is done here, not by the browser: Firefox runs the fragment navigation
  // after a 0 ms timeout and then clears focus (the section is not focusable), so Name lost focus.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-start-project]")) {
    link.addEventListener("click", (event) => {
      const modified = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey;
      const target = document.querySelector<HTMLElement>(link.hash || "#contact");
      if (event.defaultPrevented || modified || !target) return;
      event.preventDefault();
      if (location.hash !== link.hash) history.pushState(null, "", link.hash);
      target.scrollIntoView();
      form.querySelector<HTMLInputElement>("#contact-name")?.focus({ preventScroll: true });
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const invalid = validate(form);
    if (invalid) {
      unpinIfCovered(form, { scroll: true });
      form.querySelector<HTMLElement>(`[name="${invalid}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (!email) {
      if (status) status.textContent = message(form, "no-email");
      unpinIfCovered(form, { scroll: true });
      return;
    }
    window.location.href = buildMailto(email, form);
    if (status) status.textContent = message(form, "success");
    unpinIfCovered(form, { scroll: true });
  });
}
