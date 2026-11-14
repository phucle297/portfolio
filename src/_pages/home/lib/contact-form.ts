/**
 * Contact form behaviour (build plan Q8 / M3-AC8): client-side validation with the design.md §5
 * error strings, then a prefilled `mailto:` to the public address. While `PUBLIC_EMAIL` is null
 * the form explains that sending is not switched on yet instead of pretending to send.
 */
export type FieldName = "name" | "email" | "brief";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = ["name", "email", "brief"] as const;

export interface ContactValues {
  mode: string;
  name: string;
  email: string;
  projectType: string;
  brief: string;
}

const message = (form: HTMLFormElement, key: string): string =>
  form
    .querySelector<HTMLTemplateElement>("[data-form-messages]")
    ?.content.querySelector(`[data-msg="${key}"]`)
    ?.textContent?.trim() ?? "";

const value = (form: HTMLFormElement, name: string): string => {
  const field = form.elements.namedItem(name);
  return field instanceof HTMLInputElement ||
    field instanceof HTMLTextAreaElement ||
    field instanceof HTMLSelectElement
    ? field.value.trim()
    : "";
};

const selectedMode = (form: HTMLFormElement): string =>
  form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "";

export const fieldValid = {
  name: (text: string): boolean => text.trim().length > 0,
  email: (text: string): boolean => EMAIL_PATTERN.test(text.trim()),
  brief: (text: string): boolean => text.trim().length > 0,
} as const;

export function valuesFromForm(form: HTMLFormElement): ContactValues {
  return {
    mode: selectedMode(form),
    name: value(form, "name"),
    email: value(form, "email"),
    projectType: value(form, "project-type"),
    brief: value(form, "brief"),
  };
}

/** Subject and body follow build plan Q8: "Freelance project / Full-time role: {name}". */
export function buildMailtoHref(to: string, values: ContactValues): string {
  const lines = [`Name: ${values.name}`, `Email: ${values.email}`];
  if (values.mode !== "Full-time role") lines.push(`Project type: ${values.projectType}`);
  lines.push("", values.brief);
  const subject = `${values.mode}: ${values.name}`;
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

function syncMode(form: HTMLFormElement): void {
  const projectType = form.querySelector<HTMLElement>("[data-project-type]");
  const select = form.querySelector<HTMLSelectElement>("[name='project-type']");
  const fullTime = form.querySelector<HTMLInputElement>('input[data-mode="1"]')?.checked === true;
  if (projectType) projectType.hidden = fullTime;
  if (select) select.disabled = fullTime;
}

export function initContactForm(form: HTMLFormElement): void {
  // Progressive enhancement: the form ships inert and the submit button disabled so a
  // no-JS submit cannot post back to the page. JS turns it on.
  form.removeAttribute("inert");
  const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
  if (submit) submit.disabled = false;

  const status = form.querySelector<HTMLElement>("[data-form-status]");
  const email = form.dataset.email ?? "";

  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      syncMode(form);
    });
  }
  syncMode(form);

  for (const name of FIELDS) {
    form.querySelector<HTMLElement>(`[name="${name}"]`)?.addEventListener("input", () => {
      clearIfValid(form, name);
    });
  }

  // "Start a project" / "Get a quote": preselect Freelance and move focus to the form.
  // The jump to #contact is done here, not by the browser: Firefox runs the fragment navigation
  // after a 0 ms timeout and then clears focus (the section is not focusable), so Name lost focus.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-start-project]")) {
    link.addEventListener("click", (event) => {
      const freelance = form.querySelector<HTMLInputElement>('input[data-mode="0"]');
      if (freelance) freelance.checked = true;
      syncMode(form);
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
      return;
    }
    if (!email) {
      if (status) status.textContent = message(form, "no-email");
      return;
    }
    window.location.href = buildMailto(email, form);
    if (status) status.textContent = message(form, "success");
  });
}
