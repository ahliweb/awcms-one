/**
 * `service_form` — a `type: "service"` product's booking/intake form,
 * BjekMart's `service_form` column re-expressed as `jsonb` (Issue #23). Pure
 * — no database, no I/O.
 *
 * Shape: an array of field descriptors, `[{id, type, label, required,
 * options}]`. Validated here (shape only — like every other `domain/`
 * validator in this module, existence/ownership checks that need a database
 * round trip do not belong in this file) and stored as-is; the storefront
 * renders one form control per entry, in array order, when it needs to
 * collect intake details before a service booking.
 */
export type ServiceFormFieldType =
  "text" | "textarea" | "select" | "number" | "date";

export const SERVICE_FORM_FIELD_TYPES: readonly ServiceFormFieldType[] = [
  "text",
  "textarea",
  "select",
  "number",
  "date"
];

export type ServiceFormField = {
  id: string;
  type: ServiceFormFieldType;
  label: string;
  required: boolean;
  /** Only meaningful (and only accepted) when `type === "select"`. */
  options: string[] | null;
};

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const MAX_FIELDS = 30;
const MAX_ID_LENGTH = 100;
const MAX_LABEL_LENGTH = 200;
const MAX_OPTIONS = 50;
const MAX_OPTION_LENGTH = 200;

/**
 * Validates `value` as either `null` (no service form) or an array of
 * {@link ServiceFormField}. `path` is prefixed onto every field name so a
 * caller embedding this inside a larger body (`serviceForm`) gets a message
 * that names the whole path, e.g. `serviceForm[2].label`.
 */
export function validateServiceForm(
  value: unknown,
  path = "serviceForm"
): ValidationResult<ServiceFormField[] | null> {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }

  if (!Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: path, message: `${path} must be an array or null.` }]
    };
  }

  if (value.length > MAX_FIELDS) {
    return {
      valid: false,
      errors: [
        {
          field: path,
          message: `${path} may carry at most ${MAX_FIELDS} fields.`
        }
      ]
    };
  }

  const errors: ValidationError[] = [];
  const seenIds = new Set<string>();
  const result: ServiceFormField[] = [];

  value.forEach((entry, index) => {
    const prefix = `${path}[${index}]`;
    const record = (entry ?? {}) as Record<string, unknown>;

    let id: string | null = null;
    if (
      typeof record.id !== "string" ||
      record.id.trim().length === 0 ||
      record.id.trim().length > MAX_ID_LENGTH
    ) {
      errors.push({
        field: `${prefix}.id`,
        message: `${prefix}.id is required and must be at most ${MAX_ID_LENGTH} characters.`
      });
    } else if (seenIds.has(record.id.trim())) {
      errors.push({
        field: `${prefix}.id`,
        message: `${prefix}.id "${record.id.trim()}" duplicates an earlier field id.`
      });
    } else {
      id = record.id.trim();
      seenIds.add(id);
    }

    let type: ServiceFormFieldType | null = null;
    if (
      typeof record.type !== "string" ||
      !(SERVICE_FORM_FIELD_TYPES as readonly string[]).includes(record.type)
    ) {
      errors.push({
        field: `${prefix}.type`,
        message: `${prefix}.type must be one of: ${SERVICE_FORM_FIELD_TYPES.join(", ")}.`
      });
    } else {
      type = record.type as ServiceFormFieldType;
    }

    let label: string | null = null;
    if (
      typeof record.label !== "string" ||
      record.label.trim().length === 0 ||
      record.label.trim().length > MAX_LABEL_LENGTH
    ) {
      errors.push({
        field: `${prefix}.label`,
        message: `${prefix}.label is required and must be at most ${MAX_LABEL_LENGTH} characters.`
      });
    } else {
      label = record.label.trim();
    }

    const required = record.required === true;

    let options: string[] | null = null;
    if (type === "select") {
      if (
        !Array.isArray(record.options) ||
        record.options.length === 0 ||
        record.options.length > MAX_OPTIONS ||
        !record.options.every(
          (option) =>
            typeof option === "string" &&
            option.trim().length > 0 &&
            option.trim().length <= MAX_OPTION_LENGTH
        )
      ) {
        errors.push({
          field: `${prefix}.options`,
          message: `${prefix}.options is required for a "select" field: a non-empty array of up to ${MAX_OPTIONS} non-empty strings.`
        });
      } else {
        options = (record.options as string[]).map((option) => option.trim());
      }
    } else if (record.options !== undefined && record.options !== null) {
      errors.push({
        field: `${prefix}.options`,
        message: `${prefix}.options is only accepted when type is "select".`
      });
    }

    if (id !== null && type !== null && label !== null) {
      result.push({ id, type, label, required, options });
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: result };
}
