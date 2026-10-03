/**
 * Catalog attribute DEFINITIONS (Issue #291) — the tenant-authored schema a
 * product's/variant's typed custom attributes are validated against. Pure.
 *
 * A definition is metadata, never a query fragment: its `key` is a stable
 * slug used on the wire (`attr:<key>` CSV columns, `attr=<key>:<op>:<value>`
 * filters), and every SQL statement that touches attribute values binds the
 * definition's `id` (resolved from the database) — a key, a label or a
 * constraint is never concatenated into SQL. See
 * `docs/adr/0027-catalog-custom-attributes-are-typed-and-allowlisted.md`.
 *
 * ## The closed constraint schema
 *
 * Which constraint keys exist depends on the value type
 * ({@link ALLOWED_CONSTRAINT_KEYS}); any other key is rejected rather than
 * stored. There is no `pattern`/regex, no expression language: the schema is
 * exactly what `attribute-value.ts` knows how to enforce.
 *
 * ## The `type` is immutable
 *
 * Stored values are typed columns; switching a definition from `text` to
 * `integer` would orphan every value. A different type means a new key.
 */
import {
  ATTRIBUTE_VALUE_TYPES,
  compareDecimal,
  ENUM_VALUE_PATTERN,
  HARD_TEXT_MAX_LENGTH,
  isAttributeValueType,
  isIsoCalendarDate,
  MAX_DECIMAL_SCALE,
  MAX_ENUM_OPTIONS,
  MAX_ENUM_VALUE_LENGTH,
  parseAttributeValue,
  type AttributeConstraints,
  type AttributeEnumOption,
  type AttributeValueType
} from "./attribute-value";

export type ValidationError = { field: string; message: string };
type ValidationResult<T> =
  { valid: true; value: T } | { valid: false; errors: ValidationError[] };

export const ATTRIBUTE_APPLIES_TO = ["product", "variant", "both"] as const;
export type AttributeAppliesTo = (typeof ATTRIBUTE_APPLIES_TO)[number];

export const ATTRIBUTE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_ATTRIBUTE_LABEL_LENGTH = 100;
export const MAX_ATTRIBUTE_LABEL_LOCALES = 10;
export const MAX_ATTRIBUTE_SORT_ORDER = 10000;
/** A tenant may hold at most this many LIVE definitions — bounds import headers and the per-request definition fetch. */
export const MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT = 100;

const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;

export const ALLOWED_CONSTRAINT_KEYS: Record<
  AttributeValueType,
  readonly (keyof AttributeConstraints)[]
> = {
  text: ["minLength", "maxLength"],
  integer: ["min", "max"],
  decimal: ["min", "max", "scale"],
  boolean: [],
  date: ["min", "max"],
  enum: ["options"]
};

export type AttributeDefinitionInput = {
  key: string;
  label: string;
  labels: Record<string, string>;
  valueType: AttributeValueType;
  constraints: AttributeConstraints;
  appliesTo: AttributeAppliesTo;
  isSearchable: boolean;
  isFilterable: boolean;
  visibleAdmin: boolean;
  visiblePublic: boolean;
  sortOrder: number;
};

/** `valueType`/`key` are absent: both are immutable after creation. */
export type AttributeDefinitionPatch = Partial<
  Omit<AttributeDefinitionInput, "key" | "valueType">
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConstraints(
  valueType: AttributeValueType,
  raw: unknown,
  errors: ValidationError[]
): AttributeConstraints {
  const constraints: AttributeConstraints = {};
  if (raw === undefined || raw === null) {
    if (valueType === "enum") {
      errors.push({
        field: "constraints.options",
        message: `an enum attribute requires constraints.options: a non-empty array of at most ${MAX_ENUM_OPTIONS} options.`
      });
    }
    return constraints;
  }
  if (!isPlainObject(raw)) {
    errors.push({
      field: "constraints",
      message: "constraints must be an object."
    });
    return constraints;
  }

  const allowed = ALLOWED_CONSTRAINT_KEYS[valueType] as readonly string[];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      errors.push({
        field: `constraints.${key}`,
        message:
          allowed.length === 0
            ? `a ${valueType} attribute accepts no constraints.`
            : `${key} is not a constraint of a ${valueType} attribute (allowed: ${allowed.join(", ")}).`
      });
    }
  }

  const readLength = (name: "minLength" | "maxLength"): void => {
    const value = raw[name];
    if (value === undefined) return;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > HARD_TEXT_MAX_LENGTH
    ) {
      errors.push({
        field: `constraints.${name}`,
        message: `${name} must be an integer between 0 and ${HARD_TEXT_MAX_LENGTH}.`
      });
      return;
    }
    constraints[name] = value;
  };

  if (valueType === "text") {
    readLength("minLength");
    readLength("maxLength");
    if (
      constraints.minLength !== undefined &&
      constraints.maxLength !== undefined &&
      constraints.minLength > constraints.maxLength
    ) {
      errors.push({
        field: "constraints.minLength",
        message: "minLength must not exceed maxLength."
      });
    }
  }

  if (valueType === "decimal" && raw.scale !== undefined) {
    if (
      typeof raw.scale !== "number" ||
      !Number.isInteger(raw.scale) ||
      raw.scale < 1 ||
      raw.scale > MAX_DECIMAL_SCALE
    ) {
      errors.push({
        field: "constraints.scale",
        message: `scale must be an integer between 1 and ${MAX_DECIMAL_SCALE}.`
      });
    } else {
      constraints.scale = raw.scale;
    }
  }

  if (valueType === "integer" || valueType === "decimal") {
    const bound = {
      valueType,
      // A bound may use the full storage scale regardless of the value scale.
      constraints: { scale: MAX_DECIMAL_SCALE }
    } as const;
    for (const name of ["min", "max"] as const) {
      const value = raw[name];
      if (value === undefined) continue;
      // Bounds use the SAME grammar a value does — and are canonicalised by
      // it — so `min: "1,5"` can never be stored.
      const parsed =
        typeof value === "string" || typeof value === "number"
          ? parseAttributeValue(bound, value)
          : null;
      if (parsed === null || !parsed.valid || parsed.value.numeric === null) {
        errors.push({
          field: `constraints.${name}`,
          message: `${name} must be a valid ${valueType} (digits only, "." as the decimal separator).`
        });
        continue;
      }
      constraints[name] = parsed.value.numeric;
    }
    if (
      constraints.min !== undefined &&
      constraints.max !== undefined &&
      compareDecimal(constraints.min, constraints.max) > 0
    ) {
      errors.push({
        field: "constraints.min",
        message: "min must not exceed max."
      });
    }
  }

  if (valueType === "date") {
    for (const name of ["min", "max"] as const) {
      const value = raw[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isIsoCalendarDate(value)) {
        errors.push({
          field: `constraints.${name}`,
          message: `${name} must be a real calendar date written as YYYY-MM-DD.`
        });
        continue;
      }
      constraints[name] = value;
    }
    if (
      constraints.min !== undefined &&
      constraints.max !== undefined &&
      constraints.min > constraints.max
    ) {
      errors.push({
        field: "constraints.min",
        message: "min must not be after max."
      });
    }
  }

  if (valueType === "enum") {
    const options = raw.options;
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      options.length > MAX_ENUM_OPTIONS
    ) {
      errors.push({
        field: "constraints.options",
        message: `an enum attribute requires constraints.options: a non-empty array of at most ${MAX_ENUM_OPTIONS} options.`
      });
    } else {
      const seen = new Set<string>();
      const parsedOptions: AttributeEnumOption[] = [];
      options.forEach((option: unknown, index) => {
        const prefix = `constraints.options[${index}]`;
        if (!isPlainObject(option)) {
          errors.push({ field: prefix, message: "must be an object." });
          return;
        }
        for (const key of Object.keys(option)) {
          if (key !== "value" && key !== "label") {
            errors.push({
              field: `${prefix}.${key}`,
              message: "an option has only value and label."
            });
          }
        }
        const value = option.value;
        if (
          typeof value !== "string" ||
          value.length > MAX_ENUM_VALUE_LENGTH ||
          !ENUM_VALUE_PATTERN.test(value)
        ) {
          errors.push({
            field: `${prefix}.value`,
            message: `value must be 1-${MAX_ENUM_VALUE_LENGTH} characters: letters, digits, "_", "." or "-", starting with a letter or digit.`
          });
          return;
        }
        // Compared case-insensitively: enum filters match on the normalised
        // `value_search` column (one index serves text and enum), so two
        // options that differ only by case would be indistinguishable there.
        const folded = value.toLowerCase();
        if (seen.has(folded)) {
          errors.push({
            field: `${prefix}.value`,
            message: `duplicate option value "${value}" (option values are compared case-insensitively).`
          });
          return;
        }
        seen.add(folded);
        let label = value;
        if (option.label !== undefined) {
          if (
            typeof option.label !== "string" ||
            option.label.trim().length === 0 ||
            option.label.trim().length > MAX_ATTRIBUTE_LABEL_LENGTH
          ) {
            errors.push({
              field: `${prefix}.label`,
              message: `label must be a string of 1-${MAX_ATTRIBUTE_LABEL_LENGTH} characters.`
            });
            return;
          }
          label = option.label.trim();
        }
        parsedOptions.push({ value, label });
      });
      constraints.options = parsedOptions;
    }
  }

  return constraints;
}

function validateLabels(
  raw: unknown,
  errors: ValidationError[]
): Record<string, string> {
  const labels: Record<string, string> = {};
  if (raw === undefined || raw === null) return labels;
  if (!isPlainObject(raw)) {
    errors.push({ field: "labels", message: "labels must be an object." });
    return labels;
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_ATTRIBUTE_LABEL_LOCALES) {
    errors.push({
      field: "labels",
      message: `labels may carry at most ${MAX_ATTRIBUTE_LABEL_LOCALES} locales.`
    });
    return labels;
  }
  for (const [locale, value] of entries) {
    if (!LOCALE_PATTERN.test(locale)) {
      errors.push({
        field: `labels.${locale}`,
        message: "the locale must look like en or pt-BR."
      });
      continue;
    }
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value.trim().length > MAX_ATTRIBUTE_LABEL_LENGTH
    ) {
      errors.push({
        field: `labels.${locale}`,
        message: `a label must be a string of 1-${MAX_ATTRIBUTE_LABEL_LENGTH} characters.`
      });
      continue;
    }
    labels[locale] = value.trim();
  }
  return labels;
}

function readBoolean(
  record: Record<string, unknown>,
  field: string,
  errors: ValidationError[]
): boolean | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    errors.push({ field, message: `${field} must be a boolean.` });
    return undefined;
  }
  return value;
}

function validateCommonFlags(
  record: Record<string, unknown>,
  errors: ValidationError[]
): {
  appliesTo?: AttributeAppliesTo;
  isSearchable?: boolean;
  isFilterable?: boolean;
  visibleAdmin?: boolean;
  visiblePublic?: boolean;
  sortOrder?: number;
  label?: string;
} {
  const result: ReturnType<typeof validateCommonFlags> = {};

  if (record.label !== undefined) {
    if (
      typeof record.label !== "string" ||
      record.label.trim().length === 0 ||
      record.label.trim().length > MAX_ATTRIBUTE_LABEL_LENGTH
    ) {
      errors.push({
        field: "label",
        message: `label must be a string of 1-${MAX_ATTRIBUTE_LABEL_LENGTH} characters.`
      });
    } else {
      result.label = record.label.trim();
    }
  }

  if (record.appliesTo !== undefined) {
    if (
      typeof record.appliesTo !== "string" ||
      !(ATTRIBUTE_APPLIES_TO as readonly string[]).includes(record.appliesTo)
    ) {
      errors.push({
        field: "appliesTo",
        message: `appliesTo must be one of: ${ATTRIBUTE_APPLIES_TO.join(", ")}.`
      });
    } else {
      result.appliesTo = record.appliesTo as AttributeAppliesTo;
    }
  }

  result.isSearchable = readBoolean(record, "isSearchable", errors);
  result.isFilterable = readBoolean(record, "isFilterable", errors);
  result.visibleAdmin = readBoolean(record, "visibleAdmin", errors);
  result.visiblePublic = readBoolean(record, "visiblePublic", errors);

  if (record.sortOrder !== undefined) {
    if (
      typeof record.sortOrder !== "number" ||
      !Number.isInteger(record.sortOrder) ||
      record.sortOrder < 0 ||
      record.sortOrder > MAX_ATTRIBUTE_SORT_ORDER
    ) {
      errors.push({
        field: "sortOrder",
        message: `sortOrder must be an integer between 0 and ${MAX_ATTRIBUTE_SORT_ORDER}.`
      });
    } else {
      result.sortOrder = record.sortOrder;
    }
  }

  return result;
}

/** `searchable` needs a text-bearing type — only `text`/`enum` values carry the normalised search text. */
function checkSearchable(
  valueType: AttributeValueType,
  isSearchable: boolean,
  errors: ValidationError[]
): void {
  if (isSearchable && valueType !== "text" && valueType !== "enum") {
    errors.push({
      field: "isSearchable",
      message:
        "only text and enum attributes can be searchable (use isFilterable for typed range/equality filters)."
    });
  }
}

export function validateCreateAttributeDefinition(
  body: unknown
): ValidationResult<AttributeDefinitionInput> {
  const record = isPlainObject(body) ? body : {};
  const errors: ValidationError[] = [];

  if (
    typeof record.key !== "string" ||
    !ATTRIBUTE_KEY_PATTERN.test(record.key)
  ) {
    errors.push({
      field: "key",
      message:
        "key is required: a lowercase slug of 1-63 characters (a-z, 0-9, underscore), starting with a letter."
    });
  }

  let valueType: AttributeValueType = "text";
  if (!isAttributeValueType(record.valueType)) {
    errors.push({
      field: "valueType",
      message: `valueType is required and must be one of: ${ATTRIBUTE_VALUE_TYPES.join(", ")}.`
    });
  } else {
    valueType = record.valueType;
  }

  const common = validateCommonFlags(record, errors);
  if (common.label === undefined && record.label === undefined) {
    errors.push({ field: "label", message: "label is required." });
  }
  const labels = validateLabels(record.labels, errors);
  const constraints = validateConstraints(
    valueType,
    record.constraints,
    errors
  );
  checkSearchable(valueType, common.isSearchable ?? false, errors);

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    value: {
      key: record.key as string,
      label: common.label as string,
      labels,
      valueType,
      constraints,
      appliesTo: common.appliesTo ?? "product",
      isSearchable: common.isSearchable ?? false,
      isFilterable: common.isFilterable ?? false,
      visibleAdmin: common.visibleAdmin ?? true,
      visiblePublic: common.visiblePublic ?? false,
      sortOrder: common.sortOrder ?? 0
    }
  };
}

/**
 * `valueType` is required context for validating a patch's `constraints`
 * (its legal keys depend on it), but is never itself patchable — a body that
 * names `key` or `valueType` is rejected rather than silently ignored.
 */
export function validateUpdateAttributeDefinition(
  body: unknown,
  currentValueType: AttributeValueType
): ValidationResult<AttributeDefinitionPatch> {
  const record = isPlainObject(body) ? body : {};
  const errors: ValidationError[] = [];

  for (const immutable of ["key", "valueType"]) {
    if (record[immutable] !== undefined) {
      errors.push({
        field: immutable,
        message: `${immutable} cannot be changed after creation; create a new attribute instead.`
      });
    }
  }

  const common = validateCommonFlags(record, errors);
  const patch: AttributeDefinitionPatch = {};
  if (common.label !== undefined) patch.label = common.label;
  if (common.appliesTo !== undefined) patch.appliesTo = common.appliesTo;
  if (common.isSearchable !== undefined) {
    patch.isSearchable = common.isSearchable;
    checkSearchable(currentValueType, common.isSearchable, errors);
  }
  if (common.isFilterable !== undefined)
    patch.isFilterable = common.isFilterable;
  if (common.visibleAdmin !== undefined)
    patch.visibleAdmin = common.visibleAdmin;
  if (common.visiblePublic !== undefined) {
    patch.visiblePublic = common.visiblePublic;
  }
  if (common.sortOrder !== undefined) patch.sortOrder = common.sortOrder;
  if (record.labels !== undefined) {
    patch.labels = validateLabels(record.labels, errors);
  }
  if (record.constraints !== undefined) {
    patch.constraints = validateConstraints(
      currentValueType,
      record.constraints,
      errors
    );
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: patch };
}

/** The localized label for `locale`, falling back to the default `label`. */
export function resolveAttributeLabel(
  definition: { label: string; labels: Record<string, string> },
  locale: string | null | undefined
): string {
  if (!locale) return definition.label;
  return (
    definition.labels[locale] ??
    definition.labels[locale.split("-")[0] ?? ""] ??
    definition.label
  );
}

export function attributeAppliesToTarget(
  appliesTo: AttributeAppliesTo,
  target: "product" | "variant"
): boolean {
  return appliesTo === "both" || appliesTo === target;
}
