import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  attributeAppliesToTarget,
  MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT,
  type AttributeAppliesTo,
  type AttributeDefinitionInput,
  type AttributeDefinitionPatch
} from "../domain/attribute-definition";
import type {
  AttributeConstraints,
  AttributeValueType
} from "../domain/attribute-value";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "attribute_definition";

const POSTGRES_UNIQUE_VIOLATION = "23505";
const KEY_CONSTRAINT = "awcms_commerce_attribute_definitions_tenant_key_key";

/** `(tenant_id, key)` is unique among LIVE definitions (`sql/960`). */
export class DuplicateAttributeKeyError extends Error {
  constructor(key: string) {
    super(`An attribute with key "${key}" already exists for this tenant.`);
    this.name = "DuplicateAttributeKeyError";
  }
}

/** The tenant already holds {@link MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT} live definitions. */
export class AttributeDefinitionLimitError extends Error {
  constructor() {
    super(
      `A tenant may hold at most ${MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT} attribute definitions.`
    );
    this.name = "AttributeDefinitionLimitError";
  }
}

/** An enum option a stored value still uses cannot be removed. */
export class AttributeOptionInUseError extends Error {
  public readonly options: string[];

  constructor(options: string[]) {
    super(
      `These options are still used by stored values and cannot be removed: ${options.join(", ")}.`
    );
    this.name = "AttributeOptionInUseError";
    this.options = options;
  }
}

/** Narrowing `appliesTo` would strand stored values on the target it no longer covers. */
export class AttributeAppliesToInUseError extends Error {
  constructor() {
    super(
      "appliesTo cannot be narrowed while stored values exist on the excluded target."
    );
    this.name = "AttributeAppliesToInUseError";
  }
}

const DEFINITION_COLUMNS = `
  id, key, label, labels, value_type, constraints, applies_to,
  is_searchable, is_filterable, visible_admin, visible_public, sort_order
`;

type DefinitionRow = {
  id: string;
  key: string;
  label: string;
  labels: Record<string, string>;
  value_type: string;
  constraints: AttributeConstraints;
  applies_to: string;
  is_searchable: boolean;
  is_filterable: boolean;
  visible_admin: boolean;
  visible_public: boolean;
  sort_order: number;
};

export type AttributeDefinitionRecord = {
  id: string;
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

function toRecord(row: DefinitionRow): AttributeDefinitionRecord {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    labels: row.labels ?? {},
    valueType: row.value_type as AttributeValueType,
    constraints: row.constraints ?? {},
    appliesTo: row.applies_to as AttributeAppliesTo,
    isSearchable: row.is_searchable,
    isFilterable: row.is_filterable,
    visibleAdmin: row.visible_admin,
    visiblePublic: row.visible_public,
    sortOrder: row.sort_order
  };
}

export type AttributeDefinitionListOptions = {
  /** Keep only definitions that apply to this target. */
  target?: "product" | "variant";
  /** `public` keeps `visible_public` definitions; `admin` keeps `visible_admin` ones. */
  audience?: "admin" | "public";
};

/**
 * Every LIVE definition of the tenant, ordered `sort_order, key`. Bounded by
 * {@link MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT}, so it is never paginated and
 * every caller can safely load the whole schema once per request.
 */
export async function listAttributeDefinitions(
  tx: Bun.SQL,
  tenantId: string,
  options: AttributeDefinitionListOptions = {}
): Promise<AttributeDefinitionRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(DEFINITION_COLUMNS)}
    FROM awcms_commerce_attribute_definitions
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    ORDER BY sort_order ASC, key ASC
    LIMIT ${MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT + 1}
  `) as DefinitionRow[];

  return rows.map(toRecord).filter((definition) => {
    if (
      options.target &&
      !attributeAppliesToTarget(definition.appliesTo, options.target)
    ) {
      return false;
    }
    if (options.audience === "public" && !definition.visiblePublic) {
      return false;
    }
    if (options.audience === "admin" && !definition.visibleAdmin) {
      return false;
    }
    return true;
  });
}

export async function fetchAttributeDefinitionById(
  tx: Bun.SQL,
  tenantId: string,
  definitionId: string
): Promise<AttributeDefinitionRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(DEFINITION_COLUMNS)}
    FROM awcms_commerce_attribute_definitions
    WHERE tenant_id = ${tenantId} AND id = ${definitionId} AND deleted_at IS NULL
  `) as DefinitionRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * @throws {AttributeDefinitionLimitError} the tenant is at its definition cap.
 * @throws {DuplicateAttributeKeyError} the key is already taken by a live definition.
 */
export async function createAttributeDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: AttributeDefinitionInput,
  correlationId?: string
): Promise<AttributeDefinitionRecord> {
  const countRows = (await tx`
    SELECT count(*)::int AS live_count
    FROM awcms_commerce_attribute_definitions
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { live_count: number }[];
  if (
    Number(countRows[0]?.live_count ?? 0) >=
    MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT
  ) {
    throw new AttributeDefinitionLimitError();
  }

  let rows: DefinitionRow[];
  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_attribute_definitions (
        tenant_id, key, label, labels, value_type, constraints, applies_to,
        is_searchable, is_filterable, visible_admin, visible_public, sort_order
      )
      VALUES (
        ${tenantId}, ${input.key}, ${input.label}, ${input.labels}::jsonb,
        ${input.valueType}, ${input.constraints}::jsonb, ${input.appliesTo},
        ${input.isSearchable}, ${input.isFilterable}, ${input.visibleAdmin},
        ${input.visiblePublic}, ${input.sortOrder}
      )
      RETURNING ${tx.unsafe(DEFINITION_COLUMNS)}
    `) as DefinitionRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === KEY_CONSTRAINT
    ) {
      throw new DuplicateAttributeKeyError(input.key);
    }
    throw error;
  }

  const record = toRecord(rows[0]!);
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "attribute_definition.create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Attribute definition created: ${record.key}.`,
    attributes: {
      key: record.key,
      valueType: record.valueType,
      appliesTo: record.appliesTo,
      visiblePublic: record.visiblePublic
    },
    correlationId
  });
  return record;
}

/**
 * Patches a definition. `key` and `valueType` are immutable (the validator
 * refuses them). Narrowing `constraints` does not rewrite stored values — a
 * value is validated when it is WRITTEN — with one exception that would orphan
 * data silently: an enum option that stored values still use cannot be removed.
 *
 * @throws {AttributeOptionInUseError}
 */
export async function updateAttributeDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  definitionId: string,
  patch: AttributeDefinitionPatch,
  correlationId?: string
): Promise<AttributeDefinitionRecord | null> {
  const existing = await fetchAttributeDefinitionById(
    tx,
    tenantId,
    definitionId
  );
  if (!existing) return null;

  if (patch.constraints?.options && existing.valueType === "enum") {
    const keep = new Set(
      patch.constraints.options.map((option) => option.value)
    );
    const removed = (existing.constraints.options ?? [])
      .map((option) => option.value)
      .filter((value) => !keep.has(value));
    if (removed.length > 0) {
      const inUse = (await tx`
        SELECT DISTINCT value_text
        FROM awcms_commerce_product_attribute_values
        WHERE tenant_id = ${tenantId}
          AND definition_id = ${definitionId}
          AND deleted_at IS NULL
          AND value_text = ANY(${tx.array(removed, "text")}::text[])
      `) as { value_text: string }[];
      if (inUse.length > 0) {
        throw new AttributeOptionInUseError(inUse.map((row) => row.value_text));
      }
    }
  }

  // Narrowing `appliesTo` must not strand values on a target the definition no
  // longer applies to.
  if (patch.appliesTo !== undefined && patch.appliesTo !== existing.appliesTo) {
    const strandedVariant = patch.appliesTo === "product";
    const strandedProduct = patch.appliesTo === "variant";
    if (strandedVariant || strandedProduct) {
      const stranded = (await tx`
        SELECT 1
        FROM awcms_commerce_product_attribute_values
        WHERE tenant_id = ${tenantId} AND definition_id = ${definitionId}
          AND deleted_at IS NULL
          AND (
            (${strandedVariant}::boolean AND variant_id IS NOT NULL)
            OR (${strandedProduct}::boolean AND variant_id IS NULL)
          )
        LIMIT 1
      `) as unknown[];
      if (stranded.length > 0) throw new AttributeAppliesToInUseError();
    }
  }

  const next = {
    label: patch.label ?? existing.label,
    labels: patch.labels ?? existing.labels,
    constraints: patch.constraints ?? existing.constraints,
    appliesTo: patch.appliesTo ?? existing.appliesTo,
    isSearchable: patch.isSearchable ?? existing.isSearchable,
    isFilterable: patch.isFilterable ?? existing.isFilterable,
    visibleAdmin: patch.visibleAdmin ?? existing.visibleAdmin,
    visiblePublic: patch.visiblePublic ?? existing.visiblePublic,
    sortOrder: patch.sortOrder ?? existing.sortOrder
  };

  const rows = (await tx`
    UPDATE awcms_commerce_attribute_definitions
    SET label = ${next.label},
        labels = ${next.labels}::jsonb,
        constraints = ${next.constraints}::jsonb,
        applies_to = ${next.appliesTo},
        is_searchable = ${next.isSearchable},
        is_filterable = ${next.isFilterable},
        visible_admin = ${next.visibleAdmin},
        visible_public = ${next.visiblePublic},
        sort_order = ${next.sortOrder},
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${definitionId} AND deleted_at IS NULL
    RETURNING ${tx.unsafe(DEFINITION_COLUMNS)}
  `) as DefinitionRow[];
  if (!rows[0]) return null;

  const record = toRecord(rows[0]);
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "attribute_definition.update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Attribute definition updated: ${record.key}.`,
    attributes: {
      key: record.key,
      changedFields: Object.keys(patch).sort(),
      visiblePublic: record.visiblePublic
    },
    correlationId
  });
  return record;
}

/** Soft delete. Stored values are kept but unreachable (every read joins a LIVE definition); the key is freed. */
export async function deleteAttributeDefinition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  definitionId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_commerce_attribute_definitions
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${definitionId} AND deleted_at IS NULL
    RETURNING key
  `) as { key: string }[];
  if (!rows[0]) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "attribute_definition.delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: definitionId,
    severity: "warning",
    message: `Attribute definition deleted: ${rows[0].key}.`,
    attributes: { key: rows[0].key },
    correlationId
  });
  return true;
}
