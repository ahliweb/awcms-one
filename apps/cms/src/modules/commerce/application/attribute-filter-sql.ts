/**
 * The SQL side of attribute filtering (Issue #291).
 *
 * ## Why no SQL text can come from a request
 *
 * A {@link ResolvedAttributeFilter} reaching this file is already closed over:
 * `definitionId` is a uuid the DATABASE returned, `valueType` and `operator`
 * are members of closed unions, and every operand is a typed value produced by
 * `domain/attribute-value.ts`'s parser. Each (type, operator) pair below maps to
 * ONE literal template; the operands are BOUND PARAMETERS. The column a
 * template reads (`value_scaled`, `value_date`, `value_boolean`,
 * `value_search`) is written into the template itself — it is never a variable,
 * so there is no identifier, operator or expression position a caller can reach.
 *
 * `switch` is exhaustive over both unions: adding a new operator or type is a
 * compile error until it gets its own literal template.
 *
 * Every fragment is a `tx` tagged-template fragment embedded into the parent
 * statement by Bun.SQL's own composition (parameters stay parameters).
 */
import {
  resolveAttributeFilters,
  parseAttributeFilterParams,
  type AttributeFilterAudience,
  type FilterableDefinition,
  type ResolvedAttributeFilter
} from "../domain/attribute-filter";
import { listAttributeDefinitions } from "./attribute-definition-directory";

/** Escapes `\`, `%`, `_` so a `contains` needle cannot smuggle LIKE wildcards. */
export function escapeLikeNeedle(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function predicate(tx: Bun.SQL, filter: ResolvedAttributeFilter) {
  const operands = filter.operands;
  const first = operands[0];

  switch (filter.valueType) {
    case "integer":
    case "decimal": {
      // `value_scaled` is a bigint (value x 10^6): int8's comparison operators
      // are leakproof, so under FORCE RLS they can be index conditions —
      // `numeric`'s cannot (docs/adr/0027, measured).
      const scaled = operands.map((operand) => operand.scaled as string);
      switch (filter.operator) {
        case "eq":
          return tx`v.value_scaled = ${first?.scaled as string}::bigint`;
        case "in":
          return tx`v.value_scaled = ANY(${tx.array(scaled, "text")}::text[]::bigint[])`;
        case "gte":
          return tx`v.value_scaled >= ${first?.scaled as string}::bigint`;
        case "lte":
          return tx`v.value_scaled <= ${first?.scaled as string}::bigint`;
        case "contains":
          break;
      }
      break;
    }
    case "date": {
      const dates = operands.map((operand) => operand.date as string);
      switch (filter.operator) {
        case "eq":
          return tx`v.value_date = ${first?.date as string}::date`;
        case "in":
          return tx`v.value_date = ANY(${tx.array(dates, "text")}::text[]::date[])`;
        case "gte":
          return tx`v.value_date >= ${first?.date as string}::date`;
        case "lte":
          return tx`v.value_date <= ${first?.date as string}::date`;
        case "contains":
          break;
      }
      break;
    }
    case "boolean": {
      if (filter.operator === "eq") {
        return tx`v.value_boolean = ${first?.boolean as boolean}::boolean`;
      }
      break;
    }
    case "enum": {
      // Matched on the normalised `value_search` like text, so ONE b-tree
      // serves both; enum option values are unique case-insensitively
      // (`attribute-definition.ts`), so this equals an exact match.
      const searches = operands.map((operand) => operand.search as string);
      if (filter.operator === "eq") {
        return tx`v.value_search = ${first?.search as string}`;
      }
      if (filter.operator === "in") {
        return tx`v.value_search = ANY(${tx.array(searches, "text")}::text[])`;
      }
      break;
    }
    case "text": {
      const searches = operands.map((operand) => operand.search as string);
      switch (filter.operator) {
        case "eq":
          return tx`v.value_search = ${first?.search as string}`;
        case "in":
          return tx`v.value_search = ANY(${tx.array(searches, "text")}::text[])`;
        case "contains":
          return tx`v.value_search LIKE ${`%${escapeLikeNeedle(first?.search as string)}%`} ESCAPE '\\'`;
        case "gte":
        case "lte":
          break;
      }
      break;
    }
  }

  // Unreachable: `resolveAttributeFilters` only emits legal (type, operator)
  // pairs. Fail closed rather than emit a predicate that matches everything.
  throw new Error(
    `Unsupported attribute filter: ${filter.valueType}/${filter.operator}`
  );
}

/**
 * One `AND EXISTS (...)` fragment per filter, correlated on the OUTER query's
 * `p` alias (the products table). A variant-level value matches its product
 * because value rows carry `product_id` (`sql/960`).
 */
export function buildAttributeFilterFragment(
  tx: Bun.SQL,
  tenantId: string,
  filters: readonly ResolvedAttributeFilter[]
) {
  let fragment = tx``;
  for (const filter of filters) {
    fragment = tx`${fragment}
      AND EXISTS (
        SELECT 1
        FROM awcms_commerce_product_attribute_values v
        WHERE v.tenant_id = ${tenantId}
          AND v.definition_id = ${filter.definitionId}::uuid
          AND v.deleted_at IS NULL
          AND v.product_id = p.id
          AND ${predicate(tx, filter)}
      )`;
  }
  return fragment;
}

/**
 * The searchable-attribute branch of the free-text `q` match: `OR p.id IN (...)`
 * over the audience's searchable definitions (ids resolved from the database,
 * bound as a uuid array). An empty id list yields an empty fragment — the
 * classic name/sku search, byte-for-byte as before attributes existed.
 */
export function buildSearchableAttributeFragment(
  tx: Bun.SQL,
  tenantId: string,
  searchableDefinitionIds: readonly string[],
  qLike: string | null
) {
  if (qLike === null || searchableDefinitionIds.length === 0) return tx``;
  return tx`OR p.id IN (
    SELECT v.product_id
    FROM awcms_commerce_product_attribute_values v
    WHERE v.tenant_id = ${tenantId}
      AND v.deleted_at IS NULL
      AND v.definition_id = ANY(${tx.array([...searchableDefinitionIds], "uuid")}::uuid[])
      AND v.value_search ILIKE ${qLike} ESCAPE '\\'
  )`;
}

export type AttributeFilterRequestResult =
  | { valid: true; filters: ResolvedAttributeFilter[] }
  | { valid: false; message: string };

/**
 * Wire params -> resolved filters, for a route/screen. Loads the tenant's
 * definitions once (a bounded query) and delegates every decision to the pure
 * domain resolver, so the admin screen and both API audiences share one path.
 */
export async function resolveAttributeFilterRequest(
  tx: Bun.SQL,
  tenantId: string,
  params: readonly string[],
  audience: AttributeFilterAudience
): Promise<AttributeFilterRequestResult> {
  if (params.length === 0) return { valid: true, filters: [] };

  const parsed = parseAttributeFilterParams(params);
  if (!parsed.valid) return { valid: false, message: parsed.message };

  const definitions = await listAttributeDefinitions(tx, tenantId);
  const filterable: FilterableDefinition[] = definitions.map((definition) => ({
    id: definition.id,
    key: definition.key,
    valueType: definition.valueType,
    constraints: definition.constraints,
    isFilterable: definition.isFilterable,
    visiblePublic: definition.visiblePublic,
    appliesTo: definition.appliesTo
  }));

  const resolved = resolveAttributeFilters(parsed.value, filterable, audience);
  if (!resolved.valid) return { valid: false, message: resolved.message };
  return { valid: true, filters: resolved.value };
}
