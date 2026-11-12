/**
 * Contact form behaviour (build plan Q8 default): client-side validation with the design.md
 * error strings, then a prefilled `mailto:` to the public address. While `PUBLIC_EMAIL` is null
 * the form explains that sending is not switched on yet instead of pretending to send.
 */
type FieldName = "name" | "email" | "brief";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function setError(form: HTMLFormElement, name: FieldName, invalid: boolean): void {
  const field = form.querySelector<HTMLElement>(`[name="${name}"]`);
  const error = form.querySelector<HTMLElement>(`[data-error-for="${name}"]`);
  field?.setAttribute("aria-invalid", String(invalid));
  if (error) error.hidden = !invalid;
}

function validate(form: HTMLFormElement): FieldName | null {
  const checks: [FieldName, boolean][] = [
    ["name", value(form, "name").length > 0],
    ["email", EMAIL_PATTERN.test(value(form, "email"))],
    ["brief", value(form, "brief").length > 0],
  ];
  let firstInvalid: FieldName | null = null;
  for (const [name, ok] of checks) {
    setError(form, name, !ok);
    if (!ok && firstInvalid === null) firstInvalid = name;
  }
  return firstInvalid;
}

function syncMode(form: HTMLFormElement): void {
  const projectType = form.querySelector<HTMLElement>("[data-project-type]");
  const fullTime = form.querySelector<HTMLInputElement>('input[data-mode="1"]')?.checked === true;
  if (projectType) projectType.hidden = fullTime;
}

export function buildMailto(email: string, form: HTMLFormElement): string {
  const mode = selectedMode(form);
  const name = value(form, "name");
  const lines = [`Name: ${name}`, `Email: ${value(form, "email")}`];
  if (mode !== "Full-time role") lines.push(`Project type: ${value(form, "project-type")}`);
  lines.push("", value(form, "brief"));
  const subject = `${mode}: ${name}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
}

export function initContactForm(form: HTMLFormElement): void {
  const status = form.querySelector<HTMLElement>("[data-form-status]");
  const email = form.dataset.email ?? "";

  for (const radio of form.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
    radio.addEventListener("change", () => {
      syncMode(form);
    });
  }
  syncMode(form);

  // "Start a project" / "Get a quote": preselect Freelance and move focus to the form.
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-start-project]")) {
    link.addEventListener("click", () => {
      const freelance = form.querySelector<HTMLInputElement>('input[data-mode="0"]');
      if (freelance) freelance.checked = true;
      syncMode(form);
      window.setTimeout(() => {
        form.querySelector<HTMLInputElement>("#contact-name")?.focus({ preventScroll: true });
      }, 0);
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
