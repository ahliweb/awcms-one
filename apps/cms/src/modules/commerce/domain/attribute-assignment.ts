/**
 * Validating a SET OF attribute assignments against a tenant's definitions
 * (Issue #291) — pure. The single validation path shared by the product/variant
 * attribute endpoints, the product edit form (which posts to those endpoints)
 * and the CSV import's dry-run AND apply: there is no second, "import-only"
 * parser to drift from the interactive one.
 *
 * An assignment map is `{ [definitionKey]: value | null }`:
 *   - a value sets (upserts) that attribute;
 *   - `null` (or, for a CSV cell, an empty string — the caller maps it) CLEARS it;
 *   - a key absent from the map is left untouched.
 */
import {
  attributeAppliesToTarget,
  ATTRIBUTE_KEY_PATTERN,
  type AttributeAppliesTo
} from "./attribute-definition";
import {
  parseAttributeValue,
  type AttributeConstraints,
  type AttributeValueType,
  type ParsedAttributeValue
} from "./attribute-value";

export type AssignableDefinition = {
  id: string;
  key: string;
  valueType: AttributeValueType;
  constraints: AttributeConstraints;
  appliesTo: AttributeAppliesTo;
};

export type AttributeAssignment = {
  definitionId: string;
  key: string;
  valueType: AttributeValueType;
  /** `null` clears the value. */
  value: ParsedAttributeValue | null;
};

export type AttributeAssignmentError = { field: string; message: string };

export type AttributeAssignmentResult =
  | { valid: true; assignments: AttributeAssignment[] }
  | { valid: false; errors: AttributeAssignmentError[] };

/** At most this many attributes may be set in one request/row — the tenant's whole schema. */
export const MAX_ATTRIBUTE_ASSIGNMENTS = 100;

export function validateAttributeAssignments(
  raw: unknown,
  definitions: readonly AssignableDefinition[],
  target: "product" | "variant",
  fieldPrefix = "attributes"
): AttributeAssignmentResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      errors: [
        { field: fieldPrefix, message: `${fieldPrefix} must be an object.` }
      ]
    };
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ATTRIBUTE_ASSIGNMENTS) {
    return {
      valid: false,
      errors: [
        {
          field: fieldPrefix,
          message: `${fieldPrefix} may carry at most ${MAX_ATTRIBUTE_ASSIGNMENTS} attributes.`
        }
      ]
    };
  }

  const byKey = new Map(
    definitions.map((definition) => [definition.key, definition])
  );
  const errors: AttributeAssignmentError[] = [];
  const assignments: AttributeAssignment[] = [];

  for (const [key, value] of entries) {
    const field = `${fieldPrefix}.${key}`;
    // A key that fails the slug grammar never reaches the lookup, and an
    // unknown key reads like a non-applicable one — no schema probing.
    const definition = ATTRIBUTE_KEY_PATTERN.test(key)
      ? byKey.get(key)
      : undefined;
    if (
      !definition ||
      !attributeAppliesToTarget(definition.appliesTo, target)
    ) {
      errors.push({
        field,
        message: `is not an attribute that can be set on a ${target}.`
      });
      continue;
    }

    if (value === null) {
      assignments.push({
        definitionId: definition.id,
        key,
        valueType: definition.valueType,
        value: null
      });
      continue;
    }

    const parsed = parseAttributeValue(definition, value);
    if (!parsed.valid) {
      errors.push({ field, message: parsed.message });
      continue;
    }
    assignments.push({
      definitionId: definition.id,
      key,
      valueType: definition.valueType,
      value: parsed.value
    });
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, assignments };
}
