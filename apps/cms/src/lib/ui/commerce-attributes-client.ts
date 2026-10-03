/**
 * Client helpers for the catalog attribute screens (Issue #291). The pure
 * functions here (option-list text <-> JSON, constraint payloads, attribute form
 * values) have no DOM dependency so `tests/commerce-attributes-client.test.ts`
 * asserts them directly; the one DOM function, {@link initAttributeTypeToggle},
 * only shows/hides the constraint fields that belong to the selected type.
 *
 * Nothing here sends a value to the server that the server will not validate
 * again: the typed grammar in `domain/attribute-value.ts` is the authority, and
 * the inputs' own `pattern`/`inputmode` attributes are a convenience.
 */

export type AttributeOptionInput = { value: string; label: string };

/** `one option per line: value or value|Label` -> the option list the API takes. */
export function parseOptionsText(text: string): AttributeOptionInput[] {
  const options: AttributeOptionInput[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const separator = line.indexOf("|");
    if (separator === -1) {
      options.push({ value: line, label: line });
      continue;
    }
    const value = line.slice(0, separator).trim();
    const label = line.slice(separator + 1).trim();
    options.push({ value, label: label.length > 0 ? label : value });
  }
  return options;
}

/** The inverse of {@link parseOptionsText}, for prefilling an edit form. */
export function formatOptionsText(
  options: readonly AttributeOptionInput[]
): string {
  return options
    .map((option) =>
      option.label === option.value
        ? option.value
        : `${option.value}|${option.label}`
    )
    .join("\n");
}

/**
 * Builds the `constraints` object for a definition from the form's raw field
 * values. Only keys the type allows are produced, and an empty field is
 * omitted (never sent as `""`/`0`) so "no bound" stays "no bound".
 */
export function buildConstraintsPayload(
  valueType: string,
  read: (name: string) => string
): Record<string, unknown> {
  const constraints: Record<string, unknown> = {};
  const integerField = (name: string): void => {
    const raw = read(name);
    if (raw.length === 0) return;
    // A non-numeric entry is sent as-is: the server rejects it with a field error.
    constraints[name] = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : raw;
  };
  // `formName` differs from the constraint key only for dates, whose inputs
  // are named `dateMin`/`dateMax` so they cannot collide with the numeric
  // `min`/`max` inputs sitting in the same form.
  const textField = (name: string, formName = name): void => {
    const raw = read(formName);
    if (raw.length > 0) constraints[name] = raw;
  };

  switch (valueType) {
    case "text":
      integerField("minLength");
      integerField("maxLength");
      break;
    case "integer":
      textField("min");
      textField("max");
      break;
    case "decimal":
      textField("min");
      textField("max");
      integerField("scale");
      break;
    case "date":
      textField("min", "dateMin");
      textField("max", "dateMax");
      break;
    case "enum":
      constraints.options = parseOptionsText(read("options"));
      break;
    default:
      break;
  }
  return constraints;
}

/**
 * Reads the `attr:<key>` controls of one attribute form into the
 * `{ key: value | null }` body `PUT .../attributes` takes. A blank control
 * CLEARS the attribute (`null`); an `<input type="checkbox">` is not used for
 * booleans (a tri-state `<select>` is — not set / yes / no).
 */
export function collectAttributeValues(
  data: FormData
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const [name, raw] of data.entries()) {
    if (!name.startsWith("attr:") || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    values[name.slice("attr:".length)] = trimmed.length === 0 ? null : trimmed;
  }
  return values;
}

/**
 * Shows only the constraint fields that belong to the selected value type
 * (`data-constraint-for="text integer"` on a field wrapper) and keeps hidden
 * ones out of the tab order. Idempotent; safe to call for every form.
 */
export function initAttributeTypeToggle(form: HTMLFormElement): void {
  const select = form.querySelector<HTMLSelectElement>(
    "select[name='valueType']"
  );
  if (!select) return;

  const apply = (): void => {
    for (const wrapper of form.querySelectorAll<HTMLElement>(
      "[data-constraint-for]"
    )) {
      const types = (wrapper.dataset.constraintFor ?? "").split(" ");
      wrapper.hidden = !types.includes(select.value);
    }
  };
  select.addEventListener("change", apply);
  apply();
}
