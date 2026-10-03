/**
 * The attribute-filter grammar (Issue #291) — pure.
 *
 * A filter travels on the wire as a repeated query parameter
 *
 *     attr=<key>:<operator>:<value>
 *
 * (`attr=color:eq:red`, `attr=weight:gte:1.5`, `attr=size:in:s,m,l`). It is
 * parsed in two stages, and neither stage can place caller text into SQL:
 *
 *   1. {@link parseAttributeFilterParams} — SHAPE only. `key` must match the
 *      slug grammar, `operator` must be a member of the CLOSED
 *      {@link ATTRIBUTE_FILTER_OPERATORS} set, the value must be non-empty and
 *      bounded. Anything else is rejected with one generic message.
 *   2. {@link resolveAttributeFilters} — binds each key to a definition the
 *      DATABASE returned (the caller passes the fetched definitions in), checks
 *      the operator is legal for that definition's type, and parses every
 *      operand through the same typed grammar a stored value uses
 *      (`attribute-value.ts`), so `attr=weight:gte:1,5` fails exactly like a
 *      decimal write of `1,5` does.
 *
 * What survives is a {@link ResolvedAttributeFilter}: a definition ID (a UUID
 * the database issued), a (type, operator) pair drawn from closed unions, and
 * typed operand values — nothing the application layer could mistake for an
 * identifier or an expression. `application/attribute-filter-sql.ts` maps each
 * (type, operator) pair to one LITERAL SQL template and binds the operands as
 * parameters.
 */
import {
  parseAttributeValue,
  type AttributeConstraints,
  type AttributeValueType,
  type ParsedAttributeValue
} from "./attribute-value";
import { ATTRIBUTE_KEY_PATTERN } from "./attribute-definition";

export const ATTRIBUTE_FILTER_OPERATORS = [
  "eq",
  "in",
  "gte",
  "lte",
  "contains"
] as const;
export type AttributeFilterOperator =
  (typeof ATTRIBUTE_FILTER_OPERATORS)[number];

export const MAX_ATTRIBUTE_FILTERS = 5;
export const MAX_ATTRIBUTE_FILTER_IN_VALUES = 20;
export const MAX_ATTRIBUTE_FILTER_PARAM_LENGTH = 400;

export type RawAttributeFilter = {
  key: string;
  operator: AttributeFilterOperator;
  /** Unparsed operand text (for `in`, the comma-separated list). */
  value: string;
};

/**
 * The single message every refusal shares where a distinction would let a
 * caller probe the tenant's schema: an unknown key, a key that exists but is
 * not filterable, and (for the public audience) a key that is not public all
 * read the same.
 */
export const ATTRIBUTE_FILTER_NOT_AVAILABLE =
  "attr filter references an attribute that is not available for filtering.";

export type AttributeFilterParseResult =
  | { valid: true; value: RawAttributeFilter[] }
  | { valid: false; message: string };

export function parseAttributeFilterParams(
  params: readonly string[]
): AttributeFilterParseResult {
  if (params.length > MAX_ATTRIBUTE_FILTERS) {
    return {
      valid: false,
      message: `at most ${MAX_ATTRIBUTE_FILTERS} attr filters are accepted per request.`
    };
  }

  const filters: RawAttributeFilter[] = [];
  const seen = new Set<string>();

  for (const param of params) {
    if (param.length > MAX_ATTRIBUTE_FILTER_PARAM_LENGTH) {
      return {
        valid: false,
        message: `an attr filter must be at most ${MAX_ATTRIBUTE_FILTER_PARAM_LENGTH} characters.`
      };
    }
    // Split on the FIRST TWO colons only: the operand may itself contain `:`.
    const firstColon = param.indexOf(":");
    const secondColon =
      firstColon === -1 ? -1 : param.indexOf(":", firstColon + 1);
    if (firstColon === -1 || secondColon === -1) {
      return {
        valid: false,
        message: "an attr filter must be written attr=<key>:<operator>:<value>."
      };
    }
    const key = param.slice(0, firstColon);
    const operator = param.slice(firstColon + 1, secondColon);
    const value = param.slice(secondColon + 1);

    if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
      // Deliberately the SAME message as an unknown key: a malformed key
      // never reaches the database, and the reply does not say which it was.
      return { valid: false, message: ATTRIBUTE_FILTER_NOT_AVAILABLE };
    }
    if (!(ATTRIBUTE_FILTER_OPERATORS as readonly string[]).includes(operator)) {
      return {
        valid: false,
        message: `an attr filter operator must be one of: ${ATTRIBUTE_FILTER_OPERATORS.join(", ")}.`
      };
    }
    if (value.trim().length === 0) {
      return { valid: false, message: "an attr filter needs a value." };
    }
    const identity = `${key}:${operator}`;
    if (seen.has(identity)) {
      return {
        valid: false,
        message: `attr filter ${identity} is repeated.`
      };
    }
    seen.add(identity);
    filters.push({
      key,
      operator: operator as AttributeFilterOperator,
      value
    });
  }

  return { valid: true, value: filters };
}

/** What `resolveAttributeFilters` needs to know about a definition the database returned. */
export type FilterableDefinition = {
  id: string;
  key: string;
  valueType: AttributeValueType;
  constraints: AttributeConstraints;
  isFilterable: boolean;
  visiblePublic: boolean;
  appliesTo: "product" | "variant" | "both";
};

export type ResolvedAttributeFilter = {
  definitionId: string;
  valueType: AttributeValueType;
  operator: AttributeFilterOperator;
  operands: ParsedAttributeValue[];
};

export type AttributeFilterAudience = "admin" | "public";

export type AttributeFilterResolveResult =
  | { valid: true; value: ResolvedAttributeFilter[] }
  | { valid: false; message: string };

const ORDERED_TYPES: readonly AttributeValueType[] = [
  "integer",
  "decimal",
  "date"
];

function operatorAllowed(
  valueType: AttributeValueType,
  operator: AttributeFilterOperator
): boolean {
  switch (operator) {
    case "eq":
      return true;
    case "in":
      return valueType !== "boolean";
    case "gte":
    case "lte":
      return ORDERED_TYPES.includes(valueType);
    case "contains":
      return valueType === "text";
  }
}

export function resolveAttributeFilters(
  raw: readonly RawAttributeFilter[],
  definitions: readonly FilterableDefinition[],
  audience: AttributeFilterAudience
): AttributeFilterResolveResult {
  const byKey = new Map(
    definitions.map((definition) => [definition.key, definition])
  );
  const resolved: ResolvedAttributeFilter[] = [];

  for (const filter of raw) {
    const definition = byKey.get(filter.key);
    if (
      !definition ||
      !definition.isFilterable ||
      (audience === "public" && !definition.visiblePublic)
    ) {
      return { valid: false, message: ATTRIBUTE_FILTER_NOT_AVAILABLE };
    }

    if (!operatorAllowed(definition.valueType, filter.operator)) {
      return {
        valid: false,
        message: `operator ${filter.operator} cannot be used with a ${definition.valueType} attribute.`
      };
    }

    const operandTexts =
      filter.operator === "in"
        ? filter.value.split(",").map((item) => item.trim())
        : [filter.value];

    if (
      filter.operator === "in" &&
      (operandTexts.length > MAX_ATTRIBUTE_FILTER_IN_VALUES ||
        operandTexts.some((item) => item.length === 0))
    ) {
      return {
        valid: false,
        message: `an in filter takes 1-${MAX_ATTRIBUTE_FILTER_IN_VALUES} non-empty comma-separated values.`
      };
    }

    const operands: ParsedAttributeValue[] = [];
    for (const text of operandTexts) {
      // `contains` takes free text: it is matched as a substring, so it is
      // normalised like a text value but is not subject to the definition's
      // minLength/maxLength (a short needle is the whole point).
      const parsed =
        filter.operator === "contains"
          ? parseAttributeValue({ valueType: "text", constraints: {} }, text)
          : parseAttributeValue(
              {
                valueType: definition.valueType,
                // Range/enum constraints bound what can be STORED, not what
                // can be asked: filtering for `size:eq:xxl` on an enum without
                // that option simply matches nothing, but a filter value is
                // still parsed against the type's grammar and (for enums) its
                // option list, so a typo is a 400 rather than an empty page.
                constraints: stripRangeConstraints(definition)
              },
              text
            );
      if (!parsed.valid) {
        return {
          valid: false,
          message: `attr filter ${filter.key}: value ${parsed.message}`
        };
      }
      operands.push(parsed.value);
    }

    resolved.push({
      definitionId: definition.id,
      valueType: definition.valueType,
      operator: filter.operator,
      operands
    });
  }

  return { valid: true, value: resolved };
}

/**
 * A filter's operand is parsed against the type's grammar and, for an enum, its
 * option list — but NOT the stored-value bounds (`min`/`max`/lengths): asking
 * for "weight >= 0" on an attribute whose stored minimum is 1 is a legitimate
 * question.
 */
function stripRangeConstraints(
  definition: FilterableDefinition
): AttributeConstraints {
  const { options, scale } = definition.constraints;
  return {
    ...(options === undefined ? {} : { options }),
    ...(scale === undefined ? {} : { scale })
  };
}
