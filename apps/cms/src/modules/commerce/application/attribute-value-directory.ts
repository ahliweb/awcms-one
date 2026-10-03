import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_PRODUCT_AGGREGATE_TYPE,
  COMMERCE_PRODUCT_UPDATED_EVENT_TYPE
} from "../domain/commerce-events";
import {
  attributeCanonicalValue,
  attributeWireValue,
  type AttributeValueType,
  type StoredAttributeColumns
} from "../domain/attribute-value";
import {
  validateAttributeAssignments,
  type AttributeAssignment
} from "../domain/attribute-assignment";
import {
  listAttributeDefinitions,
  type AttributeDefinitionRecord
} from "./attribute-definition-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "product";
const PRODUCER_MODULE = "commerce";

/** The product/variant the caller named does not exist (live, in this tenant). */
export class AttributeTargetNotFoundError extends Error {
  constructor() {
    super("Product or variant not found.");
    this.name = "AttributeTargetNotFoundError";
  }
}

type ValueRow = {
  product_id: string;
  variant_id: string | null;
  definition_id: string;
  value_text: string | null;
  value_scaled: string | null;
  value_boolean: boolean | null;
  value_date: string | null;
};

/** One stored value, joined to its (live) definition and shaped for the wire. */
export type AttributeValueDTO = {
  key: string;
  label: string;
  labels: Record<string, string>;
  valueType: AttributeValueType;
  /** integer -> number, decimal/text/enum/date -> string, boolean -> boolean. */
  value: string | number | boolean;
  /** An enum value's display label (`null` for every other type). */
  valueLabel: string | null;
};

function columnsOf(row: ValueRow): StoredAttributeColumns {
  return {
    valueText: row.value_text,
    valueScaled: row.value_scaled,
    valueBoolean: row.value_boolean,
    valueDate: row.value_date
  };
}

function toDTO(
  definition: AttributeDefinitionRecord,
  row: ValueRow
): AttributeValueDTO | null {
  const value = attributeWireValue(definition.valueType, columnsOf(row));
  if (value === null) return null;
  const valueLabel =
    definition.valueType === "enum"
      ? (definition.constraints.options?.find(
          (option) => option.value === value
        )?.label ?? String(value))
      : null;
  return {
    key: definition.key,
    label: definition.label,
    labels: definition.labels,
    valueType: definition.valueType,
    value,
    valueLabel
  };
}

/**
 * Raw value rows for a batch of products (every product-level AND variant-level
 * value), restricted to LIVE definitions by the join. Batched with the
 * `tx.array(...)::uuid[]` binding — a bare JS array mis-binds two or more ids
 * (see `commerce/AGENTS`' `Bun.SQL` quirks).
 */
async function loadValueRows(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[]
): Promise<ValueRow[]> {
  if (productIds.length === 0) return [];
  return (await tx`
    SELECT v.product_id, v.variant_id, v.definition_id,
           v.value_text, v.value_scaled::text AS value_scaled,
           v.value_boolean, v.value_date::text AS value_date
    FROM awcms_commerce_product_attribute_values v
    JOIN awcms_commerce_attribute_definitions d
      ON d.tenant_id = v.tenant_id AND d.id = v.definition_id AND d.deleted_at IS NULL
    WHERE v.tenant_id = ${tenantId}
      AND v.deleted_at IS NULL
      AND v.product_id = ANY(${tx.array([...productIds], "uuid")}::uuid[])
  `) as ValueRow[];
}

export type AttributedEntity = {
  attributes: AttributeValueDTO[];
};

export type ProductAttributeSet = {
  /** Values set on the product itself. */
  product: AttributeValueDTO[];
  /** Values set on a variant, keyed by variant id. */
  variants: Record<string, AttributeValueDTO[]>;
};

/**
 * The attribute sets of a batch of products for ONE audience, in the
 * definitions' own `sort_order`. `public` returns only `visible_public`
 * definitions' values; `admin` returns every `visible_admin` definition's. One
 * definitions query plus one values query for the whole batch — never N+1.
 */
export async function loadAttributeSets(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[],
  audience: "admin" | "public"
): Promise<Map<string, ProductAttributeSet>> {
  const result = new Map<string, ProductAttributeSet>();
  for (const id of productIds) result.set(id, { product: [], variants: {} });
  if (productIds.length === 0) return result;

  const definitions = await listAttributeDefinitions(tx, tenantId, {
    audience
  });
  if (definitions.length === 0) return result;
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const order = new Map(
    definitions.map((definition, index) => [definition.id, index])
  );

  const rows = await loadValueRows(tx, tenantId, productIds);
  rows.sort(
    (a, b) =>
      (order.get(a.definition_id) ?? 0) - (order.get(b.definition_id) ?? 0)
  );

  for (const row of rows) {
    const definition = byId.get(row.definition_id);
    if (!definition) continue; // another audience's definition
    const dto = toDTO(definition, row);
    if (!dto) continue;
    const set = result.get(row.product_id);
    if (!set) continue;
    if (row.variant_id === null) {
      set.product.push(dto);
    } else {
      (set.variants[row.variant_id] ??= []).push(dto);
    }
  }
  return result;
}

/**
 * Additive: returns each product with an `attributes` array (public,
 * visible-only) and, when the item carries `variants`, an `attributes` array on
 * each variant too. Existing fields are untouched, so a consumer that predates
 * attributes keeps working.
 */
export async function attachPublicAttributes<
  T extends { id: string; variants?: { id: string }[] }
>(
  tx: Bun.SQL,
  tenantId: string,
  items: readonly T[]
): Promise<(T & AttributedEntity)[]> {
  const sets = await loadAttributeSets(
    tx,
    tenantId,
    items.map((item) => item.id),
    "public"
  );

  return items.map((item) => {
    const set = sets.get(item.id);
    const withAttributes: Record<string, unknown> = {
      ...item,
      attributes: set?.product ?? []
    };
    if (item.variants) {
      withAttributes.variants = item.variants.map((variant) => ({
        ...variant,
        attributes: set?.variants[variant.id] ?? []
      }));
    }
    return withAttributes;
  }) as never;
}

/** The current canonical string per (variant|product, definition key) — the "unchanged" comparison for assignments and the CSV export. */
export async function loadCanonicalProductValues(
  tx: Bun.SQL,
  tenantId: string,
  productIds: readonly string[],
  definitions: readonly AttributeDefinitionRecord[]
): Promise<Map<string, Map<string, string>>> {
  const byId = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const result = new Map<string, Map<string, string>>();
  const rows = await loadValueRows(tx, tenantId, productIds);
  for (const row of rows) {
    if (row.variant_id !== null) continue;
    const definition = byId.get(row.definition_id);
    if (!definition) continue;
    const canonical = attributeCanonicalValue(
      definition.valueType,
      columnsOf(row)
    );
    if (canonical === null) continue;
    const perProduct = result.get(row.product_id) ?? new Map<string, string>();
    perProduct.set(definition.key, canonical);
    result.set(row.product_id, perProduct);
  }
  return result;
}

async function assertTarget(
  tx: Bun.SQL,
  tenantId: string,
  productId: string,
  variantId: string | null
): Promise<void> {
  const products = (await tx`
    SELECT id FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId} AND id = ${productId} AND deleted_at IS NULL
  `) as { id: string }[];
  if (products.length === 0) throw new AttributeTargetNotFoundError();

  if (variantId !== null) {
    const variants = (await tx`
      SELECT id FROM awcms_commerce_product_variants
      WHERE tenant_id = ${tenantId} AND id = ${variantId}
        AND product_id = ${productId} AND deleted_at IS NULL
    `) as { id: string }[];
    if (variants.length === 0) throw new AttributeTargetNotFoundError();
  }
}

export type ApplyAssignmentsResult = {
  /** Keys whose stored value actually changed (set, replaced or cleared). */
  changedKeys: string[];
};

/**
 * Writes already-validated assignments for one product or one variant. Skips an
 * assignment whose canonical value equals the stored one (so a re-apply of the
 * same data writes nothing and reports no change — what makes an import replay
 * and a re-saved form idempotent), upserts a new/changed one, and hard-deletes a
 * cleared one. Every statement binds the definition id; no SQL text is built
 * from a key or value.
 *
 * Emits ONE `commerce.product.updated` event (`fields: ["attributes"]`) and one
 * audit event, only when something changed — keys only, never values.
 *
 * @throws {AttributeTargetNotFoundError}
 */
export async function applyAttributeAssignments(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  target: { productId: string; variantId?: string | null },
  assignments: readonly AttributeAssignment[],
  correlationId?: string,
  options: { skipTargetCheck?: boolean } = {}
): Promise<ApplyAssignmentsResult> {
  const variantId = target.variantId ?? null;
  if (!options.skipTargetCheck) {
    await assertTarget(tx, tenantId, target.productId, variantId);
  }
  if (assignments.length === 0) return { changedKeys: [] };

  const existingRows = (await tx`
    SELECT definition_id, value_text, value_scaled::text AS value_scaled,
           value_boolean, value_date::text AS value_date
    FROM awcms_commerce_product_attribute_values
    WHERE tenant_id = ${tenantId} AND product_id = ${target.productId}
      AND variant_id IS NOT DISTINCT FROM ${variantId}::uuid
      AND deleted_at IS NULL
  `) as Omit<ValueRow, "product_id" | "variant_id">[];
  const existingByDefinition = new Map(
    existingRows.map((row) => [row.definition_id, row])
  );

  const changedKeys: string[] = [];

  for (const assignment of assignments) {
    const existing = existingByDefinition.get(assignment.definitionId);
    const existingCanonical = existing
      ? attributeCanonicalValue(assignment.valueType, {
          valueText: existing.value_text,
          valueScaled: existing.value_scaled,
          valueBoolean: existing.value_boolean,
          valueDate: existing.value_date
        })
      : null;

    if (assignment.value === null) {
      if (!existing) continue;
      // Clearing is a SOFT delete: the row ages out through the lifecycle
      // purge, and setting the attribute again inserts a fresh live row.
      await tx`
        UPDATE awcms_commerce_product_attribute_values
        SET deleted_at = now(), updated_at = now()
        WHERE tenant_id = ${tenantId} AND definition_id = ${assignment.definitionId}
          AND product_id = ${target.productId}
          AND variant_id IS NOT DISTINCT FROM ${variantId}::uuid
          AND deleted_at IS NULL
      `;
      changedKeys.push(assignment.key);
      continue;
    }

    if (existingCanonical === assignment.value.canonical) continue;

    const value = assignment.value;
    if (variantId === null) {
      await tx`
        INSERT INTO awcms_commerce_product_attribute_values (
          tenant_id, definition_id, product_id, variant_id,
          value_text, value_scaled, value_boolean, value_date, value_search
        )
        VALUES (
          ${tenantId}, ${assignment.definitionId}, ${target.productId}, NULL,
          ${value.text}, ${value.scaled}::bigint, ${value.boolean},
          ${value.date}::date, ${value.search}
        )
        ON CONFLICT (tenant_id, definition_id, product_id)
        WHERE variant_id IS NULL AND deleted_at IS NULL
        DO UPDATE SET
          value_text = EXCLUDED.value_text,
          value_scaled = EXCLUDED.value_scaled,
          value_boolean = EXCLUDED.value_boolean,
          value_date = EXCLUDED.value_date,
          value_search = EXCLUDED.value_search,
          updated_at = now()
      `;
    } else {
      await tx`
        INSERT INTO awcms_commerce_product_attribute_values (
          tenant_id, definition_id, product_id, variant_id,
          value_text, value_scaled, value_boolean, value_date, value_search
        )
        VALUES (
          ${tenantId}, ${assignment.definitionId}, ${target.productId}, ${variantId},
          ${value.text}, ${value.scaled}::bigint, ${value.boolean},
          ${value.date}::date, ${value.search}
        )
        ON CONFLICT (tenant_id, definition_id, variant_id)
        WHERE variant_id IS NOT NULL AND deleted_at IS NULL
        DO UPDATE SET
          value_text = EXCLUDED.value_text,
          value_scaled = EXCLUDED.value_scaled,
          value_boolean = EXCLUDED.value_boolean,
          value_date = EXCLUDED.value_date,
          value_search = EXCLUDED.value_search,
          updated_at = now()
      `;
    }
    changedKeys.push(assignment.key);
  }

  if (changedKeys.length > 0) {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action: "attributes.update",
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: target.productId,
      message: "Product attributes updated.",
      attributes: {
        keys: [...changedKeys].sort(),
        variantId
      },
      correlationId
    });
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_PRODUCT_UPDATED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_PRODUCT_AGGREGATE_TYPE,
      aggregateId: target.productId,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: { productId: target.productId, fields: ["attributes"] }
    });
  }

  return { changedKeys };
}

export type SetAttributesResult =
  | { ok: true; changedKeys: string[] }
  | { ok: false; errors: { field: string; message: string }[] };

/**
 * The single "validate then write" entry point the product/variant attribute
 * endpoints use: loads the tenant's definitions, validates `raw` through the
 * shared domain validator (`validateAttributeAssignments`) and — only when it is
 * valid — applies it. Nothing is written on a validation failure.
 *
 * @throws {AttributeTargetNotFoundError}
 */
export async function setAttributesForTarget(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  target: { productId: string; variantId?: string | null },
  raw: unknown,
  correlationId?: string
): Promise<SetAttributesResult> {
  await assertTarget(tx, tenantId, target.productId, target.variantId ?? null);

  const definitions = await listAttributeDefinitions(tx, tenantId);
  const validation = validateAttributeAssignments(
    raw,
    definitions,
    target.variantId ? "variant" : "product"
  );
  if (!validation.valid) return { ok: false, errors: validation.errors };

  const { changedKeys } = await applyAttributeAssignments(
    tx,
    tenantId,
    actorTenantUserId,
    target,
    validation.assignments,
    correlationId,
    { skipTargetCheck: true }
  );
  return { ok: true, changedKeys };
}
