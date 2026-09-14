import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type {
  CreateCategoryInput,
  UpdateCategoryInput
} from "../domain/category-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "category";

/** Same bound as `office-directory.ts`'s `OFFICE_LIST_LIMIT` — see its comment. */
export const CATEGORY_LIST_LIMIT = 100;

/**
 * `(tenant_id, slug)` is unique among LIVE categories
 * (`awcms_commerce_categories_tenant_slug_key`, `sql/153`). A collision is
 * caller-actionable (pick another slug), so it surfaces as 409, not an
 * unhandled `PostgresError` (500).
 */
export class DuplicateCategorySlugError extends Error {
  constructor(slug: string) {
    super(`A category with slug "${slug}" already exists for this tenant.`);
    this.name = "DuplicateCategorySlugError";
  }
}

/**
 * `parentId` did not resolve to a live category IN THE CALLER'S TENANT.
 * One error for three distinct causes — absent, another tenant's row, or
 * soft-deleted — same reasoning as `office-directory.ts`'s
 * `ParentOfficeNotFoundError`: telling them apart would be the cross-tenant
 * existence oracle GHSA-r7cx-c4jh-cvvw is about.
 */
export class ParentCategoryNotFoundError extends Error {
  constructor() {
    super("parentId does not reference a live category in this tenant.");
    this.name = "ParentCategoryNotFoundError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * The wire shape — exactly `CommerceCategory` from Issue #4's DTO contract
 * (shared verbatim with #5). No `createdAt`/`updatedAt`/`deletedAt`: those
 * exist on the row for auditing/soft-delete but are deliberately not part of
 * the contract, so `toRecord` below must not leak them.
 */
export type CategoryRecord = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
};

type CategoryRow = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  icon: string | null;
};

function toRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    icon: row.icon
  };
}

export type CategoryListPage = {
  items: CategoryRecord[];
  nextCursor: string | null;
};

/** One keyset-paginated page of live categories, newest first — see `office-directory.ts`'s `listOffices` for the full precision/tiebreaker rationale this copies. */
export async function listCategories(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null
): Promise<CategoryListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT id, parent_id, name, slug, icon,
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_categories
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${CATEGORY_LIST_LIMIT}
  `) as (CategoryRow & { created_at_cursor: string })[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === CATEGORY_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items: rows.map(toRecord), nextCursor };
}

export async function fetchCategoryById(
  tx: Bun.SQL,
  tenantId: string,
  categoryId: string
): Promise<CategoryRecord | null> {
  const rows = (await tx`
    SELECT id, parent_id, name, slug, icon
    FROM awcms_commerce_categories
    WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NULL
  `) as CategoryRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * @throws {ParentCategoryNotFoundError} `parentId` is not a live category in
 *   this tenant. Raised BEFORE the INSERT — ordering is load-bearing, same
 *   rule as `office-directory.ts`'s `createOffice` (a throw mapped to 4xx
 *   must precede the first write, or `withTenant`'s normal-return commit
 *   would persist it).
 * @throws {DuplicateCategorySlugError} `slug` is already taken in this tenant.
 */
export async function createCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: CreateCategoryInput,
  correlationId?: string
): Promise<CategoryRecord> {
  if (input.parentId !== null) {
    const parent = await fetchCategoryById(tx, tenantId, input.parentId);
    if (!parent) throw new ParentCategoryNotFoundError();
  }

  let rows: CategoryRow[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_categories (tenant_id, parent_id, name, slug, icon)
      VALUES (${tenantId}, ${input.parentId}, ${input.name}, ${input.slug}, ${input.icon})
      RETURNING id, parent_id, name, slug, icon
    `) as CategoryRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new DuplicateCategorySlugError(input.slug);
    }

    // Anything else — including a 23503 from the parent FK, which means the
    // parent was concurrently moved or hard-deleted between the check above
    // and this INSERT — propagates, same as `createOffice`'s equivalent
    // comment: the FK firing here is a race, not caller error.
    throw error;
  }

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: `Category created: ${record.name}.`,
    attributes: { slug: record.slug },
    correlationId
  });

  return record;
}

export async function updateCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  categoryId: string,
  input: UpdateCategoryInput,
  correlationId?: string
): Promise<CategoryRecord | null> {
  const existing = await fetchCategoryById(tx, tenantId, categoryId);
  if (!existing) return null;

  let rows: CategoryRow[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_categories
      SET
        name = ${input.name ?? existing.name},
        slug = ${input.slug ?? existing.slug},
        icon = ${input.icon === undefined ? existing.icon : input.icon},
        updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NULL
      RETURNING id, parent_id, name, slug, icon
    `) as CategoryRow[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new DuplicateCategorySlugError(input.slug ?? existing.slug);
    }

    throw error;
  }

  if (rows.length === 0) return null;

  const record = toRecord(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: record.id,
    message: "Category updated.",
    attributes: { fields: Object.keys(input) },
    correlationId
  });

  return record;
}

/**
 * Soft-deletes a live category: stamps `deleted_at` and audits the removal
 * (severity `warning`). Returns `false` when the id is absent, in another
 * tenant, or already soft-deleted. Soft delete, never a hard `DELETE`: child
 * categories and products keep a valid `parent_id`/`category_id` FK — this
 * slice does not cascade or re-parent on delete, same as
 * `office-directory.ts` does not walk `parent_office_id` on its own delete.
 *
 * No `reason`/`deleted_by` column, unlike `awcms_offices` — Issue #4's table
 * conventions list does not call for actor-stamp columns on the commerce
 * tables, and WHO deleted a category is already the audit event's
 * `actorTenantUserId`.
 */
export async function deleteCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  categoryId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = await tx`
    UPDATE awcms_commerce_categories
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NULL
    RETURNING id
  `;

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: categoryId,
    severity: "warning",
    message: "Category soft-deleted.",
    correlationId
  });

  return true;
}
