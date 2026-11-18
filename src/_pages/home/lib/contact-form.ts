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
 * PF-69 a2 (contact-v3 rev 3 safety net): while pinned, the Contact copy is a fixed layer. If the
 * error or success state makes it run under the footer (short viewports such as 1200×760), unpin
 * it: the layer becomes absolute at the exact spot it occupies now (no visual jump), so it scrolls
 * with the page, and the page scrolls just enough for the form to end 12 px above the footer.
 * A resize drops the override (the pinned layout is re-measured on the next state change).
 */
const FOOTER_GAP = 12;

export function unpinIfCovered(form: HTMLFormElement): boolean {
  const root = document.documentElement;
  const body = form.closest<HTMLElement>("[data-copy-body]");
  const section = body?.parentElement;
  const column = form.parentElement;
  if (root.dataset.pin !== "on" || !body || !section || !column) return false;
  const footerTop = document.querySelector("body > footer")?.getBoundingClientRect().top;
  const limit = (footerTop ?? window.innerHeight) - FOOTER_GAP;
  const overflow = column.getBoundingClientRect().bottom - limit;
  if (overflow <= 0) return false;
  if (!body.hasAttribute("data-unpinned")) {
    const top = body.getBoundingClientRect().top - section.getBoundingClientRect().top;
    body.style.setProperty("--unpin-top", `${top}px`);
    body.setAttribute("data-unpinned", "");
    window.addEventListener(
      "resize",
      () => {
        body.removeAttribute("data-unpinned");
        body.style.removeProperty("--unpin-top");
      },
      { once: true },
    );
  }
  window.scrollBy({ top: Math.ceil(overflow), behavior: "instant" });
  return true;
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
      form.querySelector<HTMLElement>(`[name="${invalid}"]`)?.focus();
      unpinIfCovered(form);
      return;
    }
    if (!email) {
      if (status) status.textContent = message(form, "no-email");
      unpinIfCovered(form);
      return;
    }
    window.location.href = buildMailto(email, form);
    if (status) status.textContent = message(form, "success");
    unpinIfCovered(form);
  });
}
