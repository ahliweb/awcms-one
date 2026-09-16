/**
 * `variant_attributes` — the attribute GROUPS a product's variants are built
 * from (BjekMart's `variant_attributes` column, e.g. `[{name: "Size",
 * options: [{name: "M"}, {name: "L"}]}]`), re-expressed as `jsonb` (Issue
 * #23). Pure — no database, no I/O.
 *
 * This is DESCRIPTIVE metadata only — the set of attribute names/options a
 * merchant has defined for the product — not a constraint enforced against
 * `awcms_commerce_product_variants` rows. A variant's own `name`/`value` are
 * free text (`domain/product-variant-validation.ts`); nothing here rejects a
 * variant whose `value` is absent from its matching group's `options`, the
 * same "declare, do not enforce" choice `service-form-validation.ts` makes
 * for its own array shape.
 */
export type VariantAttributeOption = {
  name: string;
  description: string | null;
};

export type VariantAttributeGroup = {
  name: string;
  options: VariantAttributeOption[];
};

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

const MAX_GROUPS = 20;
const MAX_GROUP_NAME_LENGTH = 100;
const MAX_OPTIONS_PER_GROUP = 50;
const MAX_OPTION_NAME_LENGTH = 100;
const MAX_OPTION_DESCRIPTION_LENGTH = 500;

export function validateVariantAttributes(
  value: unknown,
  path = "variantAttributes"
): ValidationResult<VariantAttributeGroup[] | null> {
  if (value === null || value === undefined) {
    return { valid: true, value: null };
  }

  if (!Array.isArray(value)) {
    return {
      valid: false,
      errors: [{ field: path, message: `${path} must be an array or null.` }]
    };
  }

  if (value.length > MAX_GROUPS) {
    return {
      valid: false,
      errors: [
        {
          field: path,
          message: `${path} may carry at most ${MAX_GROUPS} groups.`
        }
      ]
    };
  }

  const errors: ValidationError[] = [];
  const result: VariantAttributeGroup[] = [];

  value.forEach((entry, groupIndex) => {
    const prefix = `${path}[${groupIndex}]`;
    const record = (entry ?? {}) as Record<string, unknown>;

    let name: string | null = null;
    if (
      typeof record.name !== "string" ||
      record.name.trim().length === 0 ||
      record.name.trim().length > MAX_GROUP_NAME_LENGTH
    ) {
      errors.push({
        field: `${prefix}.name`,
        message: `${prefix}.name is required and must be at most ${MAX_GROUP_NAME_LENGTH} characters.`
      });
    } else {
      name = record.name.trim();
    }

    if (
      !Array.isArray(record.options) ||
      record.options.length === 0 ||
      record.options.length > MAX_OPTIONS_PER_GROUP
    ) {
      errors.push({
        field: `${prefix}.options`,
        message: `${prefix}.options is required: a non-empty array of at most ${MAX_OPTIONS_PER_GROUP} entries.`
      });
      return;
    }

    const options: VariantAttributeOption[] = [];
    (record.options as unknown[]).forEach((optionEntry, optionIndex) => {
      const optionPrefix = `${prefix}.options[${optionIndex}]`;
      const optionRecord = (optionEntry ?? {}) as Record<string, unknown>;

      if (
        typeof optionRecord.name !== "string" ||
        optionRecord.name.trim().length === 0 ||
        optionRecord.name.trim().length > MAX_OPTION_NAME_LENGTH
      ) {
        errors.push({
          field: `${optionPrefix}.name`,
          message: `${optionPrefix}.name is required and must be at most ${MAX_OPTION_NAME_LENGTH} characters.`
        });
        return;
      }

      let description: string | null = null;
      if (
        optionRecord.description !== undefined &&
        optionRecord.description !== null
      ) {
        if (
          typeof optionRecord.description !== "string" ||
          optionRecord.description.trim().length > MAX_OPTION_DESCRIPTION_LENGTH
        ) {
          errors.push({
            field: `${optionPrefix}.description`,
            message: `${optionPrefix}.description must be a string of at most ${MAX_OPTION_DESCRIPTION_LENGTH} characters, or null.`
          });
          return;
        }
        const trimmed = optionRecord.description.trim();
        description = trimmed.length > 0 ? trimmed : null;
      }

      options.push({ name: optionRecord.name.trim(), description });
    });

    if (name !== null && options.length > 0) {
      result.push({ name, options });
    }
  });

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, value: result };
}
