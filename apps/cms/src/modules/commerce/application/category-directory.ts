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
 * The wire shape — `CommerceCategory` (Issue #4, extended by Issue #23).
 * `productCount` is COMPUTED (a correlated subquery in every SELECT below),
 * never a stored column — a denormalised counter would drift the moment a
 * product's `category_id`/`deleted_at`/`status` changes anywhere else in this
 * module, and this table's own row count never approaches a volume where the
 * subquery is expensive (see `module.ts`'s `dataLifecycle` partition
 * rationale: "even a large catalog's category count reaches the low
 * thousands"). No `createdAt`/`updatedAt`/`deletedAt`/`restoredAt`: those
 * exist on the row for auditing/soft-delete but are deliberately not part of
 * the contract.
 */
export type CategoryRecord = {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  icon: string | null;
  productCount: number;
};

type CategoryRow = {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  icon: string | null;
  product_count: string | number;
};

/**
 * Every SELECT below counts a category's LIVE products the same way — kept
 * as one string so the definition of "counts towards `productCount`" cannot
 * drift between the list and detail queries.
 */
const PRODUCT_COUNT_SUBQUERY = `(
    SELECT COUNT(*) FROM awcms_commerce_products p
    WHERE p.category_id = c.id AND p.deleted_at IS NULL
  ) AS product_count`;

function toRecord(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    // `COUNT(*)` comes back as a STRING from `Bun.SQL` (bigint-shaped), same
    // as every other aggregate in this codebase — `Number(...)` is safe here
    // specifically because a tenant's own category product count never
    // approaches `Number.MAX_SAFE_INTEGER`.
    productCount: Number(row.product_count)
  };
}

export type CategoryListFilters = {
  /**
   * `?parentId=` — omitted (`undefined`) means "no filter, every category".
   * A caller wanting only TOP-LEVEL categories has no way to ask for that in
   * this increment (there is no sentinel for "parent is null" — passing
   * `null` here means the same as omitting the field), which is a scope
   * limit worth naming rather than a value this filter secretly supports.
   */
  parentId?: string | null;
};

export type CategoryListPage = {
  items: CategoryRecord[];
  nextCursor: string | null;
};

/** One keyset-paginated page of live categories, newest first — see `office-directory.ts`'s `listOffices` for the full precision/tiebreaker rationale this copies. */
export async function listCategories(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null = null,
  filters: CategoryListFilters = {}
): Promise<CategoryListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const parentIdParam = filters.parentId ?? null;

  const rows = (await tx`
    SELECT c.id, c.parent_id, c.name, c.slug, c.icon,
           ${tx.unsafe(PRODUCT_COUNT_SUBQUERY)},
           ${tx.unsafe(keysetCursorCreatedAtSql("c"))} AS created_at_cursor
    FROM awcms_commerce_categories c
    WHERE c.tenant_id = ${tenantId}
      AND c.deleted_at IS NULL
      AND (${parentIdParam}::uuid IS NULL OR c.parent_id = ${parentIdParam}::uuid)
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (c.created_at, c.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY c.created_at DESC, c.id DESC
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
    SELECT c.id, c.parent_id, c.name, c.slug, c.icon,
           ${tx.unsafe(PRODUCT_COUNT_SUBQUERY)}
    FROM awcms_commerce_categories c
    WHERE c.tenant_id = ${tenantId} AND c.id = ${categoryId} AND c.deleted_at IS NULL
  `) as CategoryRow[];

  return rows[0] ? toRecord(rows[0]) : null;
}

/** Fetches a category regardless of `deleted_at` — `restoreCategory`'s own lookup, and nothing else. */
async function fetchCategoryRowIncludingDeleted(
  tx: Bun.SQL,
  tenantId: string,
  categoryId: string
): Promise<{ id: string; slug: string } | null> {
  const rows = (await tx`
    SELECT id, slug FROM awcms_commerce_categories
    WHERE tenant_id = ${tenantId} AND id = ${categoryId}
  `) as { id: string; slug: string }[];

  return rows[0] ?? null;
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

  let rows: {
    id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    icon: string | null;
  }[];

  try {
    rows = (await tx`
      INSERT INTO awcms_commerce_categories (tenant_id, parent_id, name, slug, icon)
      VALUES (${tenantId}, ${input.parentId}, ${input.name}, ${input.slug}, ${input.icon})
      RETURNING id, parent_id, name, slug, icon
    `) as {
      id: string;
      parent_id: string | null;
      name: string;
      slug: string;
      icon: string | null;
    }[];
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

  // A freshly created category has zero products by construction.
  const created: CategoryRecord = {
    id: rows[0]!.id,
    parentId: rows[0]!.parent_id,
    name: rows[0]!.name,
    slug: rows[0]!.slug,
    icon: rows[0]!.icon,
    productCount: 0
  };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: created.id,
    message: `Category created: ${created.name}.`,
    attributes: { slug: created.slug },
    correlationId
  });

  return created;
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

  let rows: {
    id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    icon: string | null;
  }[];

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
    `) as {
      id: string;
      parent_id: string | null;
      name: string;
      slug: string;
      icon: string | null;
    }[];
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

  const record: CategoryRecord = {
    id: rows[0]!.id,
    parentId: rows[0]!.parent_id,
    name: rows[0]!.name,
    slug: rows[0]!.slug,
    icon: rows[0]!.icon,
    // Update never changes `category_id` on any product, so the count carried
    // over from `existing` (already computed by `fetchCategoryById` above) is
    // still correct — no need for a second subquery round trip.
    productCount: existing.productCount
  };

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

/**
 * The tenant's soft-deleted categories, newest-deleted first — same shape as
 * `product-directory.ts`'s `listDeletedProductsForAdmin` / `office-directory.
 * ts`'s `listDeletedOffices`. `productCount` is always `0` here: a
 * soft-deleted category's own products were never cascaded, but a LIVE
 * product referencing a soft-deleted category is Issue #4's own accepted
 * dangling-reference shape (see this module's README), and this list is
 * about restoring the CATEGORY row, not auditing what still points at it.
 */
export async function listDeletedCategories(
  tx: Bun.SQL,
  tenantId: string
): Promise<CategoryRecord[]> {
  const rows = (await tx`
    SELECT id, parent_id, name, slug, icon
    FROM awcms_commerce_categories
    WHERE tenant_id = ${tenantId} AND deleted_at IS NOT NULL
    ORDER BY deleted_at DESC, id DESC
    LIMIT ${CATEGORY_LIST_LIMIT}
  `) as {
    id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    icon: string | null;
  }[];

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    productCount: 0
  }));
}

/**
 * Restores a soft-deleted category (Issue #23) — same shape as
 * `product-directory.ts`'s `restoreProduct`: no actor-stamp columns on this
 * table, so this only clears `deleted_at` and stamps `restored_at`. Returns
 * `null` when the id is absent, in another tenant, or NOT currently
 * soft-deleted.
 *
 * @throws {DuplicateCategorySlugError} another LIVE category has since taken
 *   this category's slug.
 */
export async function restoreCategory(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  categoryId: string,
  correlationId?: string
): Promise<CategoryRecord | null> {
  const existing = await fetchCategoryRowIncludingDeleted(
    tx,
    tenantId,
    categoryId
  );
  if (!existing) return null;

  let rows: {
    id: string;
    parent_id: string | null;
    name: string;
    slug: string;
    icon: string | null;
  }[];

  try {
    rows = (await tx`
      UPDATE awcms_commerce_categories
      SET deleted_at = NULL, restored_at = now(), updated_at = now()
      WHERE tenant_id = ${tenantId} AND id = ${categoryId} AND deleted_at IS NOT NULL
      RETURNING id, parent_id, name, slug, icon
    `) as {
      id: string;
      parent_id: string | null;
      name: string;
      slug: string;
      icon: string | null;
    }[];
  } catch (error) {
    if (
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new DuplicateCategorySlugError(existing.slug);
    }
    throw error;
  }

  if (rows.length === 0) return null;

  // A restored category's live product count is whatever it is right now —
  // cheap enough to compute once more rather than thread through the
  // restore's own RETURNING (which has no product join).
  const record = await fetchCategoryById(tx, tenantId, categoryId);

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: categoryId,
    message: "Category restored.",
    correlationId
  });

  return record;
}
